import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  completeSimple,
  type Model,
  type ModelThinkingLevel,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TITLE_SYSTEM_PROMPT = `You generate concise titles for coding-agent sessions.

Rules:
- Output only the title.
- Use 2 to 5 words.
- Stay under 40 characters.
- Prefer concrete project/task nouns.
- No quotes, markdown, trailing punctuation, or explanations.`;

const HERDR_TIMEOUT_MS = 3000;
const DEFAULT_TITLE_MODEL_PROVIDER = "openai-codex";
const DEFAULT_TITLE_MODEL_ID = "gpt-5.6-luna";
const TITLE_MODEL_ENV = "PI_AUTO_TAB_TITLE_MODEL";
const CONFIG_PATH = fileURLToPath(
  new URL("./auto-tab-title.json", import.meta.url),
);
const TITLE_MAX_CHARS = 40;
const FALLBACK_TITLE = "Pi Session";

type TitleConfig = {
  enabled?: boolean;
  model?: string;
  reasoningEffort?: ModelThinkingLevel;
};

type ResolvedTitleConfig = {
  enabled: boolean;
  model: string;
  reasoningEffort: ModelThinkingLevel;
};

const DEFAULT_CONFIG: ResolvedTitleConfig = {
  enabled: true,
  model: `${DEFAULT_TITLE_MODEL_PROVIDER}/${DEFAULT_TITLE_MODEL_ID}`,
  reasoningEffort: "low",
};

function isDisabledByEnv(): boolean {
  const value = process.env.PI_AUTO_TAB_TITLE?.trim().toLowerCase();
  return (
    value === "0" ||
    value === "false" ||
    value === "off" ||
    value === "disabled"
  );
}

function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function ensureConfigFile(): void {
  if (existsSync(CONFIG_PATH)) return;

  try {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Best-effort only. If another Pi process created it first, or the directory is read-only, use defaults.
  }
}

function readConfig(): ResolvedTitleConfig {
  ensureConfigFile();

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as TitleConfig;
    const envModel = process.env[TITLE_MODEL_ENV]?.trim();
    return {
      enabled:
        typeof parsed.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_CONFIG.enabled,
      model:
        envModel ||
        (typeof parsed.model === "string" && parsed.model.trim()
          ? parsed.model.trim()
          : DEFAULT_CONFIG.model),
      reasoningEffort: isModelThinkingLevel(parsed.reasoningEffort)
        ? parsed.reasoningEffort
        : DEFAULT_CONFIG.reasoningEffort,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function resolveTitleModel(
  ctx: ExtensionContext,
  configured: string,
): Model<any> | null {
  if (configured.includes("/")) {
    const [provider, ...modelParts] = configured.split("/");
    const modelId = modelParts.join("/");
    if (provider && modelId) {
      return ctx.modelRegistry.find(provider, modelId) ?? null;
    }
  }

  return (
    ctx.modelRegistry.find(DEFAULT_TITLE_MODEL_PROVIDER, configured) ?? null
  );
}

function firstTextPart(
  response: Awaited<ReturnType<typeof completeSimple>>,
): string {
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join(" ");
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string"
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function isUserMessageEntry(
  entry: unknown,
): entry is { type: "message"; message: { role: "user"; content?: unknown } } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "message" &&
    typeof (entry as { message?: unknown }).message === "object" &&
    (entry as { message?: { role?: unknown } }).message?.role === "user"
  );
}

function isFirstUserMessage(ctx: ExtensionContext, prompt: string): boolean {
  const branch = ctx.sessionManager.getBranch();
  const userMessages = branch.filter(isUserMessageEntry);

  if (userMessages.length === 0) return true;
  if (userMessages.length > 1) return false;

  const onlyUserMessage = userMessages[0]!;
  const lastEntry = branch.at(-1);
  return (
    lastEntry === onlyUserMessage &&
    messageText(onlyUserMessage.message).trim() === prompt
  );
}

function sanitizeTitle(rawTitle: string): string {
  const firstLine =
    rawTitle
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  const cleaned = firstLine
    .replace(/^[-*•\s]+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[.!?;:,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return FALLBACK_TITLE;
  if (cleaned.length <= TITLE_MAX_CHARS) return cleaned;

  const truncated = cleaned.slice(0, TITLE_MAX_CHARS + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (
    (lastSpace > 12
      ? truncated.slice(0, lastSpace)
      : cleaned.slice(0, TITLE_MAX_CHARS)
    ).trim() || FALLBACK_TITLE
  );
}

function addTitlePrefix(title: string): string {
  const unprefixed = title.replace(/^π\s*-\s*/u, "").trim() || FALLBACK_TITLE;
  return `${unprefixed}`;
}

async function inferTitle(
  modelRegistry: ExtensionContext["modelRegistry"],
  model: Model<any>,
  prompt: string,
  reasoningEffort: ModelThinkingLevel,
): Promise<string | null> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  const message: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Infer a short tab title for this first user request:\n\n${prompt}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await completeSimple(
    model,
    {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [message],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 24,
      reasoning: reasoningEffort === "off" ? undefined : reasoningEffort,
    },
  );

  if (response.stopReason === "aborted" || response.stopReason === "error")
    return null;
  return addTitlePrefix(sanitizeTitle(firstTextPart(response)));
}

async function renameHerdrTab(pi: ExtensionAPI, title: string): Promise<void> {
  if (process.env.HERDR_ENV !== "1") return;

  const tabId = process.env.HERDR_TAB_ID?.trim();
  if (!tabId) return;

  await pi.exec("herdr", ["tab", "rename", tabId, title], {
    timeout: HERDR_TIMEOUT_MS,
  });
}

export default function autoTabTitle(pi: ExtensionAPI) {
  let launchedForThisRuntime = false;

  pi.on("before_agent_start", (event, ctx) => {
    const config = readConfig();
    if (launchedForThisRuntime || !config.enabled || isDisabledByEnv()) return;

    const prompt = event.prompt.trim();
    const model = resolveTitleModel(ctx, config.model);
    const modelRegistry = ctx.modelRegistry;
    if (!prompt || !model) return;

    if (!isFirstUserMessage(ctx, prompt)) {
      launchedForThisRuntime = true;
      return;
    }

    launchedForThisRuntime = true;

    void (async () => {
      const title = await inferTitle(
        modelRegistry,
        model,
        prompt,
        config.reasoningEffort,
      );
      if (!title) return;

      pi.setSessionName(title);
      await renameHerdrTab(pi, title);
    })().catch(() => {
      // Best-effort only: auto-title failures must never affect the main agent turn.
    });
  });
}
