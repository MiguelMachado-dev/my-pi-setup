import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = "glm-usage-status";
const STATUS_KEY = "glm-usage";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "extensions", ID, "settings.json");
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_BASE = "https://api.z.ai";
const BAR_WIDTH = 12;
const FETCH_TIMEOUT_MS = 8_000;

const TOKEN_LIMIT_TYPE = "TOKENS_LIMIT";
const TIME_LIMIT_TYPE = "TIME_LIMIT";
const FIVE_HOUR = { unit: 3, number: 5 };
const WEEKLY = { unit: 6, number: 1 };

type Json = Record<string, unknown>;
type Window = { label: string; usedPct: number | null; reset: Date | null };
type Mcp = { usedPct: number | null; current: number | null; total: number | null };
type GlmQuota = { level: string | null; fiveHour: Window | null; weekly: Window | null; mcp: Mcp | null };
type ModelUsage = { tokens: number | null; calls: number | null };
type ToolUsage = { searches: number | null; webReads: number | null; zreads: number | null };
type Settings = { everyTurns: number; refreshMs: number };
type Snapshot = { quota: GlmQuota | null; model: ModelUsage | null; tool: ToolUsage | null; at: number };

const DEFAULT_SETTINGS: Settings = { everyTurns: 5, refreshMs: 300_000 };
const CADENCE_PRESETS: Array<{ label: string; value: Settings }> = [
	{ label: "Balanced — every 5 turns + 5m timer (default)", value: { everyTurns: 5, refreshMs: 300_000 } },
	{ label: "Each turn + 5m timer", value: { everyTurns: 1, refreshMs: 300_000 } },
	{ label: "Every 10 turns + 5m timer", value: { everyTurns: 10, refreshMs: 300_000 } },
	{ label: "Timer only — 1m", value: { everyTurns: 0, refreshMs: 60_000 } },
	{ label: "Off — manual /glm only", value: { everyTurns: 0, refreshMs: 0 } },
];

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const obj = (parent: Json, key: string) => (isJson(parent[key]) ? parent[key] : null);
const finite = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value) {
		const parsed = Number(value.replace(/%$/, ""));
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const remainingPct = (usedPct: number | null): number | null =>
	usedPct === null ? null : clamp(Math.round((100 - usedPct) * 100) / 100, 0, 100);
const epochDate = (value: number | null): Date | null => {
	if (value === null) return null;
	const date = new Date(value > 1e10 ? value : value * 1000);
	return Number.isFinite(date.getTime()) ? date : null;
};
const fmtNum = (value: number | null): string => (value === null ? "—" : value.toLocaleString("en-US"));
const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

async function readSettings(): Promise<Settings> {
	try {
		const parsed = parse(await readFile(SETTINGS_PATH, "utf8"));
		if (!isJson(parsed)) return DEFAULT_SETTINGS;
		const everyTurns = finite(parsed.everyTurns);
		const refreshMs = finite(parsed.refreshMs);
		return {
			everyTurns: everyTurns === null ? DEFAULT_SETTINGS.everyTurns : Math.max(0, Math.round(everyTurns)),
			refreshMs: refreshMs === null ? DEFAULT_SETTINGS.refreshMs : Math.max(0, Math.round(refreshMs)),
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}
async function writeSettings(settings: Settings): Promise<void> {
	await mkdir(dirname(SETTINGS_PATH), { recursive: true });
	await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function getBaseUrl(): string {
	const override = process.env.ZAI_BASE_URL || process.env.ZHIPU_BASE_URL;
	return override ? override.replace(/\/$/, "") : DEFAULT_BASE;
}
let cachedAuth: Json | null | undefined;
function readAuth(): Json | null {
	if (cachedAuth !== undefined) return cachedAuth;
	try {
		const parsed = parse(readFileSync(AUTH_PATH, "utf8"));
		cachedAuth = isJson(parsed) ? parsed : null;
	} catch {
		cachedAuth = null;
	}
	return cachedAuth;
}
function keyFromAuth(providerId: string): string | null {
	const entry = obj(readAuth() ?? {}, providerId);
	if (!entry) return null;
	const type = typeof entry.type === "string" ? entry.type : "api_key";
	if (type !== "api_key") return null;
	const key = entry.key;
	return typeof key === "string" && key ? key : null;
}
function getToken(): string | null {
	const authId = getBaseUrl().includes("bigmodel.cn") ? "zai-coding-cn" : "zai";
	return keyFromAuth(authId) ?? process.env.ZAI_API_KEY ?? process.env.ZAI_TOKEN ?? process.env.ZHIPU_API_KEY ?? process.env.ZHIPUAI_API_KEY ?? null;
}

async function getJson(path: string, signal: AbortSignal | undefined): Promise<Json | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onParentAbort = () => controller.abort();
	signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const response = await fetch(`${getBaseUrl()}${path}`, {
			method: "GET",
			signal: controller.signal,
			headers: {
				Authorization: getToken() as string,
				"Accept-Language": "en-US,en",
				"Content-Type": "application/json",
			},
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		const text = await response.text();
		const parsed = parse(text);
		return isJson(parsed) ? parsed : null;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onParentAbort);
	}
}

function classifyTokenWindow(limit: Json): "fiveHour" | "weekly" | null {
	const unit = finite(limit.unit);
	const number = finite(limit.number);
	if (unit === FIVE_HOUR.unit && number === FIVE_HOUR.number) return "fiveHour";
	if (unit === WEEKLY.unit && number === WEEKLY.number) return "weekly";
	return null;
}
function windowFromLimit(limit: Json, fallbackLabel: string): Window {
	return {
		label: fallbackLabel,
		usedPct: finite(limit.percentage),
		reset: epochDate(finite(limit.nextResetTime) ?? finite(limit.resetTime)),
	};
}
function extractQuota(json: Json | null): GlmQuota | null {
	if (!json) return null;
	const payload = isJson(json.data) ? json.data : json;
	const limitsRaw = Array.isArray(payload.limits) ? payload.limits.filter(isJson) : [];
	if (limitsRaw.length === 0 && payload.level == null) return null;

	const level = typeof payload.level === "string" && payload.level ? payload.level : null;
	let fiveHour: Window | null = null;
	let weekly: Window | null = null;
	let mcp: Mcp | null = null;

	for (const limit of limitsRaw) {
		const type = typeof limit.type === "string" ? limit.type : null;
		if (type === TIME_LIMIT_TYPE) {
			mcp = { usedPct: finite(limit.percentage), current: finite(limit.currentValue), total: finite(limit.usage) };
			continue;
		}
		if (type !== TOKEN_LIMIT_TYPE) continue;
		const slot = classifyTokenWindow(limit);
		if (slot === "fiveHour" && !fiveHour) fiveHour = windowFromLimit(limit, "5h");
		else if (slot === "weekly" && !weekly) weekly = windowFromLimit(limit, "Weekly");
	}

	for (const limit of limitsRaw) {
		if (typeof limit.type !== "string" || limit.type !== TOKEN_LIMIT_TYPE) continue;
		if (classifyTokenWindow(limit)) continue;
		const reset = epochDate(finite(limit.nextResetTime) ?? finite(limit.resetTime));
		const withinFiveHours = reset ? reset.getTime() - Date.now() <= 6 * 3_600_000 : true;
		if (!fiveHour && withinFiveHours) fiveHour = windowFromLimit(limit, "5h");
		else if (!weekly) weekly = windowFromLimit(limit, "Weekly");
	}

	if (!fiveHour && !weekly && !mcp && !level) return null;
	return { level, fiveHour, weekly, mcp };
}
function extractModelUsage(json: Json | null): ModelUsage | null {
	if (!json) return null;
	const payload = isJson(json.data) ? json.data : json;
	const total = obj(payload, "totalUsage");
	if (!total) return null;
	return { tokens: finite(total.totalTokensUsage), calls: finite(total.totalModelCallCount) };
}
function extractToolUsage(json: Json | null): ToolUsage | null {
	if (!json) return null;
	const payload = isJson(json.data) ? json.data : json;
	const total = obj(payload, "totalUsage");
	if (!total) return null;
	return {
		searches: finite(total.totalNetworkSearchCount),
		webReads: finite(total.totalWebReadMcpCount),
		zreads: finite(total.totalZreadMcpCount),
	};
}

function timeWindowQuery(): string {
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);
	const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
	return `startTime=${encodeURIComponent(iso(start))}&endTime=${encodeURIComponent(iso(end))}`;
}

async function fetchQuota(signal?: AbortSignal): Promise<GlmQuota | null> {
	return extractQuota(await getJson("/api/monitor/usage/quota/limit", signal));
}
async function fetchModel(signal?: AbortSignal): Promise<ModelUsage | null> {
	return extractModelUsage(await getJson(`/api/monitor/usage/model-usage?${timeWindowQuery()}`, signal));
}
async function fetchTool(signal?: AbortSignal): Promise<ToolUsage | null> {
	return extractToolUsage(await getJson(`/api/monitor/usage/tool-usage?${timeWindowQuery()}`, signal));
}
async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
	const [quota, model, tool] = await Promise.all([
		fetchQuota(signal).catch(() => null),
		fetchModel(signal).catch(() => null),
		fetchTool(signal).catch(() => null),
	]);
	return { quota, model, tool, at: Date.now() };
}

function resetText(date: Date | null): string {
	if (!date) return "--";
	const now = new Date();
	return date.toDateString() === now.toDateString()
		? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
		: date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function countdown(date: Date | null): string {
	if (!date) return "—";
	const minutes = Math.floor((date.getTime() - Date.now()) / 60_000);
	if (minutes <= 0) return "now";
	if (minutes >= 1440) {
		const hours = Math.floor(minutes / 60);
		return `${Math.floor(hours / 24)}d ${hours % 24}h`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
const fmtPct = (value: number | null): string => (value === null ? "--%" : `${Math.round(value)}%`);
function colorByRemaining(ctx: ExtensionContext, remaining: number | null, text: string): string {
	if (remaining === null) return ctx.ui.theme.fg("dim", text);
	return ctx.ui.theme.fg(remaining <= 10 ? "error" : remaining <= 20 ? "warning" : "success", text);
}
function planLabel(level: string | null): string {
	if (!level) return "";
	const lower = level.toLowerCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function footer(ctx: ExtensionContext, quota: GlmQuota): string {
	const theme = ctx.ui.theme;
	const five = remainingPct(quota.fiveHour?.usedPct ?? null);
	const week = remainingPct(quota.weekly?.usedPct ?? null);
	return [
		theme.fg("dim", "GLM "),
		theme.fg("muted", "5h "),
		colorByRemaining(ctx, five, fmtPct(five)),
		theme.fg("dim", ` ${resetText(quota.fiveHour?.reset ?? null)} | W `),
		colorByRemaining(ctx, week, fmtPct(week)),
		theme.fg("dim", ` ${resetText(quota.weekly?.reset ?? null)}`),
	].join("");
}
function bar(label: string, window: Window | null): string {
	if (!window || window.usedPct === null) return `${label} --`;
	const used = clamp(window.usedPct, 0, 100);
	const filled = Math.round((used / 100) * BAR_WIDTH);
	const barStr = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
	const reset = window.reset ? ` · resets ${countdown(window.reset)} (${resetText(window.reset).toLowerCase()})` : "";
	return `${label} ${used.toFixed(1).padStart(5)}% ${barStr} ${Math.round(100 - used)}% left${reset}`;
}
function detailLines(snapshot: Snapshot): string[] {
	const { quota, model, tool } = snapshot;
	const lines: string[] = [];
	lines.push(`📊 GLM Coding Plan${quota?.level ? ` — ${planLabel(quota.level)}` : ""}`);
	lines.push(bar("⏱️ 5h    ", quota?.fiveHour ?? null));
	lines.push(bar("📅 Week  ", quota?.weekly ?? null));
	if (quota?.mcp) {
		const mcpPct = quota.mcp.usedPct;
		const pctStr = mcpPct === null ? "--" : `${mcpPct.toFixed(1)}%`;
		const usage = quota.mcp.current !== null && quota.mcp.total !== null ? `  ${fmtNum(quota.mcp.current)} / ${fmtNum(quota.mcp.total)}` : "";
		lines.push(`🔌 MCP    ${pctStr}${usage}  (1 month)`);
	}
	if (model && (model.tokens !== null || model.calls !== null)) {
		const parts: string[] = [];
		if (model.tokens !== null) parts.push(`${fmtNum(model.tokens)} tokens`);
		if (model.calls !== null) parts.push(`${fmtNum(model.calls)} calls`);
		lines.push(`🔢 24h    ${parts.join(" · ")}`);
	}
	if (tool) {
		const parts: string[] = [];
		if (tool.searches !== null) parts.push(`${fmtNum(tool.searches)} searches`);
		if (tool.webReads !== null) parts.push(`${fmtNum(tool.webReads)} web reads`);
		if (tool.zreads !== null) parts.push(`${fmtNum(tool.zreads)} zreads`);
		if (parts.length) lines.push(`🛠️ Tools  ${parts.join(" · ")}`);
	}
	lines.push(updatedLine(snapshot.at));
	return lines;
}
function updatedLine(at: number): string {
	const when = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return `updated ${when} · /glm-usage:refresh`;
}
function detailText(snapshot: Snapshot): string {
	return detailLines(snapshot).join("\n");
}

export default function (pi: ExtensionAPI) {
	let settings = DEFAULT_SETTINGS;
	let turns = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight: Promise<boolean> | undefined;
	let latestCtx: ExtensionContext | undefined;

	const setLoadingStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!getToken()) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "GLM: log in via /login or set ZAI_API_KEY"));
			return;
		}
		const cadence = settings.everyTurns > 0 ? (settings.everyTurns === 1 ? "each turn" : `every ${settings.everyTurns} turns`) : null;
		const timerLabel = settings.refreshMs > 0 ? `+ ${(settings.refreshMs / 60_000).toFixed(0)}m timer` : null;
		const label = [cadence, timerLabel].filter(Boolean).join(" ") || "on-demand";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `GLM usage · ${label}`));
	};

	const refreshStatus = (ctx: ExtensionContext): Promise<boolean> => {
		if (!ctx.hasUI) return Promise.resolve(false);
		if (!getToken()) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "GLM: log in via /login or set ZAI_API_KEY"));
			return Promise.resolve(false);
		}
		if (inFlight) return inFlight;
		inFlight = fetchQuota(ctx.signal)
			.then((quota) => {
				if (quota) {
					ctx.ui.setStatus(STATUS_KEY, footer(ctx, quota));
					return true;
				}
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "GLM usage unavailable"));
				return false;
			})
			.catch(() => {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "GLM usage unavailable"));
				return false;
			})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};

	const showDetail = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!getToken()) {
			ctx.ui.notify("GLM: log in via /login or set ZAI_API_KEY to check usage", "error");
			return;
		}
		ctx.ui.setWidget(STATUS_KEY, [ctx.ui.theme.fg("dim", "GLM usage loading…")]);
		const snapshot = await fetchSnapshot(ctx.signal).catch(() => ({ quota: null, model: null, tool: null, at: Date.now() }) as Snapshot);
		if (snapshot.quota) {
			ctx.ui.setStatus(STATUS_KEY, footer(ctx, snapshot.quota));
			ctx.ui.setWidget(STATUS_KEY, detailLines(snapshot));
			ctx.ui.notify("GLM usage refreshed", "info");
		} else {
			ctx.ui.setWidget(STATUS_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "GLM usage unavailable"));
			ctx.ui.notify("GLM usage unavailable — check ZAI_API_KEY / network", "error");
		}
	};

	const startTimer = (ctx: ExtensionContext) => {
		if (timer) clearInterval(timer);
		if (settings.refreshMs <= 0) return;
		timer = setInterval(() => {
			if (latestCtx) void refreshStatus(latestCtx);
		}, settings.refreshMs);
	};

	pi.registerCommand("glm", {
		description: "Show Z.AI GLM Coding Plan usage (5h + weekly + MCP + 24h tokens)",
		handler: async (_args, ctx) => {
			await showDetail(ctx);
		},
	});

	pi.registerCommand("glm-usage:refresh", {
		description: "Refresh the GLM usage footer now",
		handler: async (_args, ctx) => {
			const ok = await refreshStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(ok ? "GLM usage refreshed" : "GLM usage unavailable", ok ? "info" : "error");
		},
	});

	pi.registerCommand("glm-usage:hide", {
		description: "Hide the GLM usage detail panel",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.setWidget(STATUS_KEY, undefined);
		},
	});

	pi.registerCommand("glm-usage:settings", {
		description: "Configure GLM usage auto-refresh cadence",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const current = settings.everyTurns > 0
				? settings.everyTurns === 1 ? "Each turn" : `Every ${settings.everyTurns} turns`
				: "Off";
			const choice = await ctx.ui.select(`GLM usage auto-refresh (now: ${current})`, CADENCE_PRESETS.map((preset) => preset.label));
			if (!choice) return;
			const preset = CADENCE_PRESETS.find((item) => item.label === choice);
			if (!preset) return;
			settings = { ...preset.value };
			turns = 0;
			await writeSettings(settings);
			startTimer(ctx);
			setLoadingStatus(ctx);
			void refreshStatus(ctx);
			ctx.ui.notify(`GLM usage auto-refresh: ${choice}`, "info");
		},
	});

	pi.registerTool({
		name: "glm_usage",
		label: "GLM Usage",
		description: "Check the user's Z.AI GLM Coding Plan usage: 5-hour and weekly quota remaining, MCP usage, and 24h token/call counts. Use when the user asks about their GLM quota, rate limits, or how much usage they have left.",
		promptSnippet: "Check Z.AI GLM Coding Plan quota (5h / weekly remaining + 24h tokens)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			if (!getToken()) {
				return { content: [{ type: "text", text: "ZAI_API_KEY is not set. Configure it to check GLM usage." }] };
			}
			try {
				const snapshot = await fetchSnapshot(signal);
				if (!snapshot.quota) {
					return { content: [{ type: "text", text: "Could not fetch GLM usage (check ZAI_API_KEY / network)." }] };
				}
				return { content: [{ type: "text", text: detailText(snapshot) }] };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `GLM usage request failed: ${message}` }], isError: true };
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		cachedAuth = undefined;
		settings = await readSettings();
		turns = 0;
		setLoadingStatus(ctx);
		startTimer(ctx);
		void refreshStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		latestCtx = ctx;
		turns += 1;
		if (settings.everyTurns <= 0 || turns < settings.everyTurns) return;
		turns = 0;
		void refreshStatus(ctx);
	});

	pi.on("input", (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.hasUI) ctx.ui.setWidget(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		latestCtx = undefined;
	});
}
