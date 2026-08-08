import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const SUPPORTED_MODELS = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.5",
  "openai/gpt-5.6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
]);
export const TARGET_PROVIDER = "openai-codex";
export const TARGET_MODEL = "gpt-5.6";
export const FAST_SERVICE_TIER = "priority";
export const CONFIG_FIELD = "pi-gpt-fast-mode";
export const KEYBINDING_FIELD = CONFIG_FIELD;
export const DEFAULT_SHORTCUT = "ctrl+alt+m";
export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

const RAINBOW_COLORS = [
  [255, 95, 95],
  [255, 135, 95],
  [255, 215, 95],
  [95, 215, 135],
  [95, 175, 255],
  [135, 95, 255],
  [215, 95, 255],
] as const;
const RAINBOW_INTERVAL_MS = 120;
const RESET_FOREGROUND = "\x1b[39m";

type PiModel = { provider?: string; id?: string; reasoning?: boolean };
type ProviderPayload = Record<string, unknown>;
type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};
type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};
type PiConfig = Record<string, unknown>;
type ReadTextFile = (path: string, encoding: "utf8") => string;

type PiFileLoadOptions = {
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: ReadTextFile;
};

/**
 * True when this request is for a supported GPT model this extension knows how to speed up.
 * The payload check makes tests and future provider edge-cases less dependent on ctx.model.
 */
export function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

export function isSupportedModel(model: PiModel | undefined): boolean {
  if (!model?.provider || !model.id) return false;
  return SUPPORTED_MODELS.has(modelKey(model));
}

export function shouldApplyFastMode(model: PiModel | undefined, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const requestModel = (payload as ProviderPayload).model;
  return isSupportedModel(model) && requestModel === model?.id;
}

/** Return a patched provider payload that asks Codex for the Fast service tier. */
export function withFastServiceTier(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as ProviderPayload),
    service_tier: FAST_SERVICE_TIER,
  };
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/**
 * Resolve a global Pi config file path for this extension to read.
 * Order: PI_CODING_AGENT_DIR, then XDG config locations if present, then Pi's default.
 */
export function resolvePiFilePath(fileName: string, options: PiFileLoadOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;

  const piDir = env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return join(resolve(expandHome(piDir, home)), fileName);

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
    ? resolve(expandHome(env.XDG_CONFIG_HOME, home))
    : join(home, ".config");

  const xdgCandidates = [join(xdgConfigHome, "pi", "agent", fileName), join(xdgConfigHome, "pi", fileName)];

  for (const candidate of xdgCandidates) {
    if (exists(candidate)) return candidate;
  }

  return join(home, ".pi", "agent", fileName);
}

/** Resolve the global Pi keybindings file this extension should read. */
export function resolveKeybindingsPath(options: PiFileLoadOptions = {}): string {
  return resolvePiFilePath("keybindings.json", options);
}

/** Resolve the global Pi settings file this extension should read. */
export function resolveSettingsPath(options: PiFileLoadOptions = {}): string {
  return resolvePiFilePath("settings.json", options);
}

function normalizeShortcutList(values: unknown[]): string[] {
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shortcut) => !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()));
}

export function normalizeShortcutSetting(value: unknown): string[] {
  if (value === false || value === null) return [];
  if (Array.isArray(value)) return normalizeShortcutList(value);

  const shortcuts = normalizeShortcutList([value]);
  return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

function readPiJson(path: string, readFile: ReadTextFile): PiConfig | undefined {
  try {
    const raw = readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PiConfig) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read shortcuts from the global Pi keybindings JSON.
 * Uses the field `pi-gpt-fast-mode`. Missing or invalid config falls back to ctrl+alt+m.
 * Set the field to false or null to disable the shortcut entirely.
 */
export function loadShortcuts(options: PiFileLoadOptions = {}): string[] {
  const readFile: ReadTextFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const parsed = readPiJson(resolveKeybindingsPath(options), readFile);
  return parsed ? normalizeShortcutSetting(parsed[KEYBINDING_FIELD]) : [DEFAULT_SHORTCUT];
}

/**
 * Read the default Fast mode state from global Pi settings.
 * `{ "pi-gpt-fast-mode": { "enabled": true } }` starts sessions enabled.
 */
export function loadDefaultEnabled(options: PiFileLoadOptions = {}): boolean {
  const readFile: ReadTextFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const parsed = readPiJson(resolveSettingsPath(options), readFile);
  const extensionConfig = parsed?.[CONFIG_FIELD];

  if (!extensionConfig || typeof extensionConfig !== "object" || Array.isArray(extensionConfig)) return false;
  return (extensionConfig as { enabled?: unknown }).enabled === true;
}

function isSupportedModelContext(ctx: unknown): boolean {
  const model = (ctx as { model?: PiModel } | undefined)?.model;
  return isSupportedModel(model);
}

function currentModelLabel(ctx: unknown): string {
  const model = (ctx as { model?: PiModel } | undefined)?.model;
  return model?.provider && model.id ? modelKey(model) : "unknown model";
}

function notify(ctx: unknown, message: string, level: "info" | "warning" | "error" = "info"): void {
  const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } } | undefined)?.ui;
  ui?.notify?.(message, level);
}

function announceState(ctx: unknown, enabled: boolean): void {
  if (!enabled) {
    notify(ctx, "GPT Fast mode disabled.");
    return;
  }

  if (isSupportedModelContext(ctx)) {
    notify(ctx, `GPT Fast mode enabled (service_tier: ${FAST_SERVICE_TIER}).`);
    return;
  }

  notify(ctx, `GPT Fast mode enabled, but ${currentModelLabel(ctx)} is not supported.`, "warning");
}

function rainbow(text: string, frame: number): string {
  const coloredText = [...text]
    .map((character, index) => {
      const colorIndex = (index + frame) % RAINBOW_COLORS.length;
      const [red, green, blue] = RAINBOW_COLORS[colorIndex]!;
      return `\x1b[38;2;${red};${green};${blue}m${character}`;
    })
    .join("");

  return `${coloredText}${RESET_FOREGROUND}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatProjectPath(cwd: string): string {
  const home = homedir();
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function readUsage(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;

  if (record.type === "message" && record.message && typeof record.message === "object") {
    const message = record.message as Record<string, unknown>;
    if (message.role !== "assistant" && message.role !== "toolResult") return undefined;
    return message.usage as UsageLike | undefined;
  }

  if (record.type !== "branch_summary" && record.type !== "compaction") return undefined;
  return record.usage as UsageLike | undefined;
}

function calculateUsage(entries: readonly unknown[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  for (const entry of entries) {
    const usage = readUsage(entry);
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }

  return totals;
}

function alignLine(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "...");

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");

  const leftWidth = Math.max(0, width - rightWidth - 2);
  const truncatedLeft = truncateToWidth(left, leftWidth, "...");
  const padding = " ".repeat(Math.max(2, width - visibleWidth(truncatedLeft) - rightWidth));
  return truncateToWidth(`${truncatedLeft}${padding}${right}`, width, "");
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function updateFooter(ctx: ExtensionContext, enabled: boolean): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    const animated = enabled && isSupportedModelContext(ctx);
    let rainbowFrame = 0;
    const animationTimer = animated
      ? setInterval(() => {
          rainbowFrame = (rainbowFrame + 1) % RAINBOW_COLORS.length;
          tui.requestRender();
        }, RAINBOW_INTERVAL_MS)
      : undefined;

    return {
      dispose(): void {
        unsubscribe();
        if (animationTimer) clearInterval(animationTimer);
      },
      invalidate(): void {},
      render(width: number): string[] {
        let projectPath = formatProjectPath(ctx.cwd);
        const branch = footerData.getGitBranch();
        const sessionName = ctx.sessionManager.getSessionName();

        if (branch) projectPath = `${projectPath} (${branch})`;
        if (sessionName) projectPath = `${projectPath} • ${sessionName}`;

        let fastLabel = "";
        if (enabled && isSupportedModelContext(ctx)) {
          fastLabel = `⚡ ${theme.bold(rainbow("FAST", rainbowFrame))}`;
        }
        if (enabled && !isSupportedModelContext(ctx)) {
          fastLabel = theme.fg("muted", "⚡ FAST · unsupported");
        }

        const projectLine = alignLine(theme.fg("dim", projectPath), fastLabel, width);
        const usage = calculateUsage(ctx.sessionManager.getEntries());
        const stats: string[] = [];

        if (usage.input) stats.push(`↑${formatTokens(usage.input)}`);
        if (usage.output) stats.push(`↓${formatTokens(usage.output)}`);
        if (usage.cacheRead) stats.push(`R${formatTokens(usage.cacheRead)}`);
        if (usage.cacheWrite) stats.push(`W${formatTokens(usage.cacheWrite)}`);
        if (usage.cost) stats.push(`$${usage.cost.toFixed(3)}`);

        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercent = contextUsage?.percent;
        const contextLabel = contextPercent === null || contextPercent === undefined
          ? `?/${formatTokens(contextWindow)}`
          : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
        stats.push(contextLabel);

        const modelName = ctx.model?.id ?? "no-model";
        const thinking = ctx.model?.reasoning ? ` • ${ctx.thinkingLevel ?? "off"}` : "";
        const provider = footerData.getAvailableProviderCount() > 1 && ctx.model ? `(${ctx.model.provider}) ` : "";
        const statsLine = alignLine(
          theme.fg("dim", stats.join(" ")),
          theme.fg("dim", `${provider}${modelName}${thinking}`),
          width,
        );
        const lines = [projectLine, statsLine];
        const statuses = [...footerData.getExtensionStatuses().entries()]
          .filter(([key]) => key !== "gpt-fast-mode")
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, text]) => sanitizeStatus(text));

        if (statuses.length > 0) {
          lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
        }

        return lines;
      },
    };
  });
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = loadDefaultEnabled();

  async function toggle(ctx: ExtensionContext): Promise<void> {
    enabled = !enabled;
    updateFooter(ctx, enabled);
    announceState(ctx, enabled);
  }

  pi.registerCommand("fast", {
    description: "Toggle GPT Fast mode (service_tier: priority)",
    handler: async (_args, ctx) => {
      await toggle(ctx);
    },
  });

  for (const shortcut of loadShortcuts()) {
    pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: "Toggle GPT Fast mode",
      handler: async (ctx) => {
        await toggle(ctx);
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = loadDefaultEnabled();
    updateFooter(ctx, enabled);
  });

  pi.on("model_select", (_event, ctx) => {
    updateFooter(ctx, enabled);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return undefined;
    if (!shouldApplyFastMode(ctx.model, event.payload)) return undefined;
    return withFastServiceTier(event.payload);
  });
}
