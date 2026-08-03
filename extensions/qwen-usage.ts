/**
 * qwen-usage — exibe o consumo do Qwen Token Plan Individual no pi
 * (janela de 5 horas, janela semanal/7 dias, credit packs).
 *
 * Fonte: APIs internas do console QwenCloud (cs-data.qwencloud.com),
 * autenticadas pela sessão do browser.
 *
 * Setup (uma vez, repetir quando a sessão expirar):
 *   1. Abra https://home.qwencloud.com/billing/subscription/token-plan-individual
 *   2. F12 → Network → filtre "custom.json" → F5
 *   3. Botão direito num request → Copy → Copy as cURL (bash)
 *   4. No pi: /qwen-usage setup  → cole o cURL → Enter
 *
 * Uso:
 *   - Linha de status no footer (atualizada após cada turno do agente)
 *   - /qwen-usage → relatório detalhado
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_KEY = "qwen-usage";
const ENTRY_TYPE = "qwen-usage-report";
const SESSION_FILE = join(homedir(), ".pi", "agent", "qwencloud-session.json");
const MIN_REFRESH_MS = 90_000;
const FETCH_TIMEOUT_MS = 15_000;

const GATEWAY_URL = "https://cs-data.qwencloud.com/data/api.json";
const ZELDA_PREFIX = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Session {
  cookie: string;
  secToken: string;
  savedAt: number;
}

interface WindowQuota {
  label: string;
  usedPct: number; // fração consumida (0..1+) vindo da API
  limit: number;
  resetAt: number; // epoch ms
}

interface UsageSnapshot {
  fetchedAt: number;
  windows: WindowQuota[];
  plan?: string; // lite | standard | pro
  status?: string;
  remainingDays?: number;
  endTime?: number;
  addonQuota?: number;
  addonRemaining?: number;
}

interface ReportEntry extends Partial<UsageSnapshot> {
  error?: string;
  hint?: string;
}

type FetchState =
  | { kind: "ok"; snapshot: UsageSnapshot }
  | { kind: "no-session" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Sessão (cookie + sec_token)
// ---------------------------------------------------------------------------

function loadSession(): Session | undefined {
  try {
    if (!existsSync(SESSION_FILE)) return undefined;
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    if (typeof data.cookie === "string" && typeof data.secToken === "string" && data.cookie && data.secToken) {
      return { cookie: data.cookie, secToken: data.secToken, savedAt: data.savedAt ?? 0 };
    }
  } catch {}
  return undefined;
}

function saveSession(session: Session): void {
  const dir = join(homedir(), ".pi", "agent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { encoding: "utf-8", mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

/** Extrai cookie + sec_token de um cURL copiado do DevTools. */
function parseCurl(input: string): { cookie: string; secToken: string } | { error: string } {
  const s = input.replace(/\^/g, ""); // escapes do cmd (Copy as cURL cmd)

  let cookie = "";
  const cookieHeader =
    s.match(/(?:-H|--header)(?:\s+|=)['"](cookie:\s*[^'"]+)['"]/i) ??
    s.match(/(?:-b|--cookie)(?:\s+|=)['"]([^'"]+)['"]/i);
  if (cookieHeader) cookie = cookieHeader[1].replace(/^cookie:\s*/i, "").trim();

  let secToken = "";
  const tokenMatch = s.match(/sec_token=([A-Za-z0-9_-]+)/);
  if (tokenMatch) secToken = tokenMatch[1];

  if (!cookie && !secToken) {
    return { error: "Não achei cookie nem sec_token. Cole o cURL completo (Copy as cURL do DevTools)." };
  }
  if (!cookie) return { error: "Cookie não encontrado no cURL." };
  if (!secToken) return { error: "sec_token não encontrado no cURL." };
  return { cookie, secToken };
}

// ---------------------------------------------------------------------------
// Chamadas ao gateway do console
// ---------------------------------------------------------------------------

async function zeldaCall(session: Session, api: string, reqDTO: Record<string, unknown> = {}): Promise<unknown> {
  const cornerstoneParam = {
    domain: "home.qwencloud.com",
    consoleSite: "QWENCLOUD",
    console: "ONE_CONSOLE",
    xsp_lang: "en-US",
    protocol: "V2",
    productCode: "p_efm",
  };
  const params = JSON.stringify({
    Api: api,
    Data: { ...reqDTO, cornerstoneParam },
    V: "1.0",
  });
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: "IntlBroadScopeAspnGateway",
    sec_token: session.secToken,
    region: "ap-southeast-1",
    params,
  });
  const url = `${GATEWAY_URL}?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=${encodeURIComponent(api)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: session.cookie,
        Origin: "https://home.qwencloud.com",
        Referer: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const code = json.code as string | undefined;
  if (code === "ConsoleNeedLogin" || code === "AccessDenied") {
    throw new SessionExpiredError();
  }
  if (code !== undefined && code !== "200") {
    throw new Error(`${code}: ${String(json.message ?? "erro no gateway")}`);
  }

  const dataV2 = (json.data as Record<string, unknown> | undefined)?.DataV2 as Record<string, unknown> | undefined;
  const ret = Array.isArray(dataV2?.ret) ? String(dataV2?.ret[0] ?? "") : "";
  if (ret && !ret.startsWith("SUCCESS::")) throw new Error(`gateway: ${ret}`);

  const inner = dataV2?.data as Record<string, unknown> | undefined;
  if (inner && inner.success === false) {
    const msg = String(inner.msg ?? inner.message ?? "erro");
    if (/login|session|token/i.test(msg)) throw new SessionExpiredError();
    throw new Error(msg);
  }
  const payload = (inner?.data ?? inner) as Record<string, unknown> | undefined;
  return payload;
}

class SessionExpiredError extends Error {
  constructor() {
    super("sessão expirada");
    this.name = "SessionExpiredError";
  }
}

function isSessionExpired(e: unknown): boolean {
  return e instanceof SessionExpiredError;
}

// ---------------------------------------------------------------------------
// Montagem do snapshot
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function fetchSnapshot(session: Session): Promise<UsageSnapshot> {
  const [usage, quotaConfig, subscription, addon] = await Promise.all([
    zeldaCall(session, `${ZELDA_PREFIX}usage`),
    zeldaCall(session, `${ZELDA_PREFIX}quota-config`),
    zeldaCall(session, `${ZELDA_PREFIX}subscription`),
    zeldaCall(session, `${ZELDA_PREFIX}addon/list`, {
      commodityCode: "sfm_tokenplansoloaddon_public_intl",
      status: ["ACTIVE"],
      pageNum: 1,
      pageSize: 10,
    }).catch(() => undefined),
  ]);

  const u = usage as Record<string, unknown>;
  const q = quotaConfig as Record<string, unknown>;
  const sub = subscription as Record<string, unknown>;

  const plan = typeof sub.specCode === "string" ? sub.specCode.toLowerCase() : "pro";
  const limits = (q[plan] ?? q.standard ?? q.pro) as Record<string, unknown> | undefined;
  const fiveHourLimit = num(limits?.five_hour) ?? 3000;
  const weeklyLimit = num(limits?.weekly) ?? 10000;

  const windows: WindowQuota[] = [];
  const p5 = num(u.per5HourPercentage);
  const r5 = num(u.per5HourResetTime);
  if (p5 !== undefined && r5 !== undefined) {
    windows.push({ label: "5h", usedPct: p5, limit: fiveHourLimit, resetAt: r5 });
  }
  const pw = num(u.per1WeekPercentage);
  const rw = num(u.per1WeekResetTime);
  if (pw !== undefined && rw !== undefined) {
    windows.push({ label: "weekly", usedPct: pw, limit: weeklyLimit, resetAt: rw });
  }

  // Credit packs (addon)
  let addonQuota = num((q.addon_quota as Record<string, unknown> | undefined)?.extrabundle);
  let addonRemaining: number | undefined;
  const addonData = addon as Record<string, unknown> | undefined;
  const packs = Array.isArray(addonData?.items)
    ? (addonData!.items as Array<Record<string, unknown>>)
    : Array.isArray(addonData?.list)
      ? (addonData!.list as Array<Record<string, unknown>>)
      : [];
  if (packs.length > 0) {
    addonRemaining = packs.reduce(
      (sum, p) =>
        sum + (num(p.remainQuota) ?? num(p.remainingQuota) ?? num(p.remaining) ?? num(p.remain) ?? 0),
      0,
    );
  }

  return {
    fetchedAt: Date.now(),
    windows,
    plan,
    status: typeof sub.status === "string" ? sub.status : undefined,
    remainingDays: num(sub.remainingDays),
    endTime: num(sub.endTime),
    addonQuota,
    addonRemaining,
  };
}

// ---------------------------------------------------------------------------
// Cache + single-flight
// ---------------------------------------------------------------------------

let lastFetchAt = 0;
let lastState: FetchState | undefined;
let inFlight: Promise<FetchState> | undefined;

async function fetchUsage(force = false): Promise<FetchState> {
  if (!force && lastState && Date.now() - lastFetchAt < MIN_REFRESH_MS) return lastState;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<FetchState> => {
    let state: FetchState;
    const session = loadSession();
    if (!session) {
      state = { kind: "no-session" };
    } else {
      try {
        state = { kind: "ok", snapshot: await fetchSnapshot(session) };
      } catch (e) {
        state = isSessionExpired(e)
          ? { kind: "expired" }
          : { kind: "error", message: String(e instanceof Error ? e.message : e) };
      }
    }
    lastFetchAt = Date.now();
    lastState = state;
    return state;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms <= 0) return "agora";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function remainingInfo(w: WindowQuota): { pct: number; credits: number } {
  const usedFrac = Math.max(0, Math.min(1.5, w.usedPct));
  const pct = Math.max(0, Math.min(100, Math.round((1 - usedFrac) * 100)));
  const credits = Math.max(0, Math.round(w.limit * (1 - usedFrac)));
  return { pct, credits };
}

function bar(pctRemaining: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pctRemaining / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function statusColor(pctRemaining: number): "success" | "warning" | "error" {
  // mesmo semáforo da extensão codex-usage-status
  if (pctRemaining <= 10) return "error";
  if (pctRemaining <= 20) return "warning";
  return "success";
}

interface ThemeLike {
  fg(color: string, text: string): string;
}

function buildStatusText(snapshot: UsageSnapshot, theme: ThemeLike): string {
  const parts: string[] = [];
  for (const w of snapshot.windows) {
    const { pct } = remainingInfo(w);
    const reset = formatDuration(w.resetAt - Date.now());
    parts.push(
      theme.fg("muted", `${w.label} `) +
        theme.fg(statusColor(pct), `${pct}%`) +
        theme.fg("dim", ` ${reset}`),
    );
  }
  if (parts.length === 0) return "";
  const planTag = snapshot.plan ? theme.fg("muted", `${snapshot.plan} `) : "";
  return theme.fg("dim", "| Qwen ") + planTag + parts.join(theme.fg("dim", " · "));
}

function buildReportLines(snapshot: UsageSnapshot): string[] {
  const title =
    `Qwen Token Plan Individual — ${snapshot.plan ?? "?"}` +
    (snapshot.status ? ` (${snapshot.status})` : "") +
    (typeof snapshot.remainingDays === "number" ? ` · ${snapshot.remainingDays} dias restantes` : "");
  const lines: string[] = [title, ""];

  for (const w of snapshot.windows) {
    const { pct, credits } = remainingInfo(w);
    const label = `${w.label} window`.padEnd(14, " ");
    const reset = formatDuration(w.resetAt - Date.now());
    lines.push(
      `${label} ${bar(pct)}  ${String(pct).padStart(3)}% left  ${fmt(credits)} / ${fmt(w.limit)} cr  resets in ${reset}`,
    );
  }

  if (snapshot.addonRemaining !== undefined && snapshot.addonRemaining > 0) {
    lines.push(`credit packs     ${fmt(snapshot.addonRemaining)} cr extras (fora das janelas)`);
  } else if (snapshot.addonQuota !== undefined && snapshot.addonQuota > 0) {
    lines.push(`credit packs    ${fmt(snapshot.addonQuota)} cr (limite configurado)`);
  }

  lines.push("");
  lines.push(`updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`);
  return lines;
}

const SETUP_INSTRUCTIONS = [
  "Como capturar a sessão:",
  "1. Abra https://home.qwencloud.com/billing/subscription/token-plan-individual",
  "2. F12 → aba Network → filtre por: custom.json",
  "3. F5 para recarregar; botão direito em qualquer request custom.json",
  "   → Copy → Copy as cURL (bash)",
  "4. Cole o cURL completo abaixo (Ctrl+S para confirmar no editor):",
].join("\n");

// ---------------------------------------------------------------------------
// Extensão
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  function updateStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void; theme: ThemeLike } }, snapshot: UsageSnapshot): void {
    const text = buildStatusText(snapshot, ctx.ui.theme);
    ctx.ui.setStatus(STATUS_KEY, text || undefined);
  }

  async function refreshAndShow(ctx: { ui: { setStatus(key: string, text: string | undefined): void; theme: ThemeLike } }, force: boolean): Promise<FetchState> {
    const state = await fetchUsage(force);
    if (state.kind === "ok") updateStatus(ctx, state.snapshot);
    return state;
  }

  // Relatório detalhado como entry persistido (não vai para o contexto do LLM)
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _opts, theme) => {
    const data = (entry.data ?? {}) as ReportEntry;
    const lines: string[] = [];

    if (data.error) {
      lines.push(theme.fg("error", `✗ ${data.error}`));
      if (data.hint) lines.push(theme.fg("dim", data.hint));
    } else if (data.fetchedAt) {
      const snapshot = data as UsageSnapshot;
      buildReportLines(snapshot).forEach((line, i) => {
        if (i === 0) {
          lines.push(theme.bold(line));
        } else if (line.startsWith("updated")) {
          lines.push(theme.fg("dim", line));
        } else {
          const match = line.match(/(\d+)% left/);
          lines.push(match ? theme.fg(statusColor(Number(match[1])), line) : line);
        }
      });
    }

    const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  // ------------------------- /qwen-usage setup -------------------------
  pi.registerCommand("qwen-usage-setup", {
    description: "Configure a sessão do QwenCloud (colar cURL do DevTools)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("qwen-usage setup precisa do modo interativo", "warning");
        return;
      }
      ctx.ui.notify(SETUP_INSTRUCTIONS, "info");
      const pasted = await ctx.ui.editor("Cole o cURL copiado do DevTools:", "");
      if (!pasted || !pasted.trim()) {
        ctx.ui.notify("Setup cancelado.", "warning");
        return;
      }
      const parsed = parseCurl(pasted);
      if ("error" in parsed) {
        pi.appendEntry(ENTRY_TYPE, { error: parsed.error });
        return;
      }
      saveSession({ cookie: parsed.cookie, secToken: parsed.secToken, savedAt: Date.now() });
      lastState = undefined;
      lastFetchAt = 0;
      const state = await fetchUsage(true);
      if (state.kind === "ok") {
        updateStatus(ctx, state.snapshot);
        pi.appendEntry(ENTRY_TYPE, state.snapshot);
        ctx.ui.notify("Sessão salva! Qwen usage ativo.", "info");
      } else if (state.kind === "expired") {
        pi.appendEntry(ENTRY_TYPE, {
          error: "A sessão do cURL já está expirada.",
          hint: "Recarregue a página do console e copie um cURL novo.",
        });
      } else if (state.kind === "error") {
        pi.appendEntry(ENTRY_TYPE, { error: state.message });
      }
    },
  });

  // --------------------------- /qwen-usage -----------------------------
  pi.registerCommand("qwen-usage", {
    description: "Mostra o consumo do Qwen Token Plan (janelas 5h / semanal)",
    handler: async (args, ctx) => {
      if (args.trim() === "setup") {
        ctx.ui.notify("Use /qwen-usage-setup para configurar a sessão.", "info");
        return;
      }
      const state = await refreshAndShow(ctx, true);
      if (state.kind === "ok") {
        pi.appendEntry(ENTRY_TYPE, state.snapshot);
        return;
      }
      if (state.kind === "no-session") {
        pi.appendEntry(ENTRY_TYPE, {
          error: "Sessão do QwenCloud não configurada.",
          hint: "Rode /qwen-usage-setup e cole o cURL copiado do DevTools do console.",
        });
        return;
      }
      if (state.kind === "expired") {
        pi.appendEntry(ENTRY_TYPE, {
          error: "Sessão do QwenCloud expirada.",
          hint: "Rode /qwen-usage-setup e cole um cURL novo (passo a passo no comando).",
        });
        return;
      }
      pi.appendEntry(ENTRY_TYPE, { error: state.message });
    },
  });

  // Status inicial na sessão
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!loadSession()) return; // silencioso até configurar
    void refreshAndShow(ctx, false).catch(() => {});
  });

  // Atualiza após cada run do agente (respeita o TTL)
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!loadSession()) return;
    void refreshAndShow(ctx, false).catch(() => {});
  });
}
