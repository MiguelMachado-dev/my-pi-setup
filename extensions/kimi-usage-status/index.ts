import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = "kimi-usage-status";
const STATUS_KEY = "kimi-usage";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "extensions", ID, "settings.json");
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_BASE = "https://api.kimi.com/coding/v1";
const USER_AGENT = "KimiCLI/1.6";
const BAR_WIDTH = 12;
const FETCH_TIMEOUT_MS = 8_000;
const SIX_HOURS_MIN = 6 * 60;

type Json = Record<string, unknown>;
type Window = { label: string; usedPct: number | null; reset: Date | null };
type KimiQuota = { level: string | null; fiveHour: Window | null; weekly: Window | null; parallel: number | null };
type Settings = { everyTurns: number; refreshMs: number };
type Snapshot = { quota: KimiQuota | null; at: number };

const DEFAULT_SETTINGS: Settings = { everyTurns: 5, refreshMs: 300_000 };
const CADENCE_PRESETS: Array<{ label: string; value: Settings }> = [
	{ label: "Balanced — every 5 turns + 5m timer (default)", value: { everyTurns: 5, refreshMs: 300_000 } },
	{ label: "Each turn + 5m timer", value: { everyTurns: 1, refreshMs: 300_000 } },
	{ label: "Every 10 turns + 5m timer", value: { everyTurns: 10, refreshMs: 300_000 } },
	{ label: "Timer only — 1m", value: { everyTurns: 0, refreshMs: 60_000 } },
	{ label: "Off — manual /kimi only", value: { everyTurns: 0, refreshMs: 0 } },
];

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const obj = (parent: Json | null, key: string): Json | null => (parent && isJson(parent[key]) ? parent[key] : null);
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
const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

function parseReset(value: unknown): Date | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(value > 1e10 ? value : value * 1000);
		return Number.isFinite(date.getTime()) ? date : null;
	}
	if (typeof value === "string" && value) {
		const date = new Date(value);
		if (Number.isFinite(date.getTime())) return date;
		const asNumber = Number(value);
		if (Number.isFinite(asNumber)) return parseReset(asNumber);
	}
	return null;
}

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
	const override = process.env.KIMI_BASE_URL;
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
	const entry = obj(readAuth(), providerId);
	if (!entry) return null;
	const type = typeof entry.type === "string" ? entry.type : "api_key";
	if (type !== "api_key") return null;
	const key = entry.key;
	return typeof key === "string" && key ? key : null;
}
function getToken(): string | null {
	return keyFromAuth("kimi-coding") ?? process.env.KIMI_API_KEY ?? process.env.KIMI_CODING_API_KEY ?? null;
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
				Authorization: `Bearer ${getToken() as string}`,
				"User-Agent": USER_AGENT,
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

/** Used % from a {limit, used, remaining} detail object (Kimi reports 0–100 percentage points as strings). */
function usedPctFrom(detail: Json | null): number | null {
	if (!detail) return null;
	const limit = finite(detail.limit ?? detail.limit_amount);
	const used = finite(detail.used ?? detail.used_amount);
	if (used !== null && limit !== null && limit > 0) return clamp((used / limit) * 100, 0, 100);
	const remaining = finite(detail.remaining);
	if (remaining !== null && limit !== null && limit > 0) return clamp(((limit - remaining) / limit) * 100, 0, 100);
	return null;
}

function windowMinutes(window: Json | null): number | null {
	const duration = finite(window?.duration);
	if (duration === null || duration <= 0) return null;
	const unit = (typeof window?.timeUnit === "string" ? window.timeUnit : "").toUpperCase();
	if (unit.includes("MINUTE")) return duration;
	if (unit.includes("HOUR")) return duration * 60;
	if (unit.includes("DAY")) return duration * 1440;
	if (unit.includes("MONTH")) return duration * 43_200;
	return duration;
}

function windowLabel(window: Json | null, fallback: string): string {
	const minutes = windowMinutes(window);
	if (minutes === null) return fallback;
	if (minutes % 43_200 === 0) return `${minutes / 43_200}mo`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function windowFromDetail(detail: Json | null, label: string): Window {
	return {
		label,
		usedPct: usedPctFrom(detail),
		reset: parseReset(detail?.resetTime ?? detail?.reset_at ?? detail?.reset_time),
	};
}

function extractQuota(json: Json | null): KimiQuota | null {
	if (!json) return null;
	const data = obj(json, "data");
	const payload = data && ("usage" in data || "limits" in data || "user" in data) ? data : json;

	const levelRaw = obj(obj(payload, "user"), "membership")?.level;
	const level = typeof levelRaw === "string" && levelRaw ? levelRaw.replace(/^LEVEL_/, "").toLowerCase() : null;

	const parallel = finite(obj(payload, "parallel")?.limit);

	// `usage` is the weekly quota window; `limits[]` holds shorter rate windows (e.g. 300 min = 5h).
	const usageDetail = obj(payload, "usage");
	let weekly = usageDetail ? windowFromDetail(usageDetail, "Week") : null;
	let fiveHour: Window | null = null;

	const limitsRaw = Array.isArray(payload.limits) ? payload.limits.filter(isJson) : [];
	for (const entry of limitsRaw) {
		const detail = obj(entry, "detail") ?? entry;
		const window = obj(entry, "window");
		const minutes = windowMinutes(window);
		const label = windowLabel(window, "Limit");
		const candidate = windowFromDetail(detail, label);
		if (minutes !== null && minutes <= SIX_HOURS_MIN) {
			if (!fiveHour) fiveHour = candidate;
		} else if (!weekly) {
			weekly = { ...candidate, label: "Week" };
		}
	}

	if (weekly && weekly.usedPct === null && !weekly.reset) weekly = null;
	if (fiveHour && fiveHour.usedPct === null && !fiveHour.reset) fiveHour = null;
	if (!fiveHour && !weekly && !level) return null;
	return { level, fiveHour, weekly, parallel };
}

async function fetchQuota(signal?: AbortSignal): Promise<KimiQuota | null> {
	const primary = await getJson("/usages", signal).catch(() => null);
	const quota = extractQuota(primary);
	if (quota) return quota;
	const fallback = await getJson("/usage", signal).catch(() => null);
	return extractQuota(fallback);
}
async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
	const quota = await fetchQuota(signal).catch(() => null);
	return { quota, at: Date.now() };
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
	return level.charAt(0).toUpperCase() + level.slice(1);
}

function footer(ctx: ExtensionContext, quota: KimiQuota): string {
	const theme = ctx.ui.theme;
	const five = remainingPct(quota.fiveHour?.usedPct ?? null);
	const week = remainingPct(quota.weekly?.usedPct ?? null);
	const fiveLabel = quota.fiveHour?.label ?? "5h";
	return [
		theme.fg("dim", "Kimi "),
		theme.fg("muted", `${fiveLabel} `),
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
	const resetStr = resetText(window.reset);
	const reset = window.reset ? ` · resets ${countdown(window.reset)} (${/[AP]M$/i.test(resetStr) ? resetStr.toLowerCase() : resetStr})` : "";
	return `${label} ${used.toFixed(1).padStart(5)}% ${barStr} ${Math.round(100 - used)}% left${reset}`;
}
function detailLines(snapshot: Snapshot): string[] {
	const { quota } = snapshot;
	const lines: string[] = [];
	lines.push(`📊 Kimi Coding Plan${quota?.level ? ` — ${planLabel(quota.level)}` : ""}`);
	lines.push(bar(`⏱️ ${(quota?.fiveHour?.label ?? "5h").padEnd(5)}`, quota?.fiveHour ?? null));
	lines.push(bar("📅 Week  ", quota?.weekly ?? null));
	if (quota?.parallel !== null && quota?.parallel !== undefined) {
		lines.push(`⚡ Parallel  ${quota.parallel} max concurrent`);
	}
	lines.push(updatedLine(snapshot.at));
	return lines;
}
function updatedLine(at: number): string {
	const when = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return `updated ${when} · /kimi-usage:refresh`;
}
function detailText(snapshot: Snapshot): string {
	return detailLines(snapshot).join("\n");
}

export default function (pi: ExtensionAPI) {
	let settings = DEFAULT_SETTINGS;
	let turns = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight: { sessionId: number; promise: Promise<boolean> } | undefined;
	let activeSessionId = 0;
	let sessionAbort: AbortController | undefined;

	const isStaleCtxError = (error: unknown): boolean =>
		error instanceof Error && error.message.includes("extension ctx is stale");

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const endSession = () => {
		activeSessionId += 1;
		sessionAbort?.abort();
		sessionAbort = undefined;
		inFlight = undefined;
		stopTimer();
	};

	const beginSession = (): number => {
		endSession();
		sessionAbort = new AbortController();
		return activeSessionId;
	};

	const isCurrentSession = (sessionId: number): boolean =>
		sessionId === activeSessionId && !(sessionAbort?.signal.aborted ?? true);

	const handleStaleCtx = (error: unknown): boolean => {
		if (!isStaleCtxError(error)) return false;
		endSession();
		return true;
	};

	const runWithLiveCtx = (sessionId: number, action: () => void): void => {
		if (!isCurrentSession(sessionId)) return;
		try {
			action();
		} catch (error) {
			if (!handleStaleCtx(error)) throw error;
		}
	};

	const setLoadingStatus = (ctx: ExtensionContext, sessionId = activeSessionId) => {
		runWithLiveCtx(sessionId, () => {
			if (!ctx.hasUI) return;
			if (!getToken()) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Kimi: log in via /login or set KIMI_API_KEY"));
				return;
			}
			const cadence = settings.everyTurns > 0 ? (settings.everyTurns === 1 ? "each turn" : `every ${settings.everyTurns} turns`) : null;
			const timerLabel = settings.refreshMs > 0 ? `+ ${(settings.refreshMs / 60_000).toFixed(0)}m timer` : null;
			const label = [cadence, timerLabel].filter(Boolean).join(" ") || "on-demand";
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Kimi usage · ${label}`));
		});
	};

	const refreshStatus = (ctx: ExtensionContext, sessionId = activeSessionId): Promise<boolean> => {
		if (!isCurrentSession(sessionId)) return Promise.resolve(false);
		if (inFlight?.sessionId === sessionId) return inFlight.promise;

		const promise = (async () => {
			try {
				if (!isCurrentSession(sessionId) || !ctx.hasUI) return false;
				if (!getToken()) {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Kimi: log in via /login or set KIMI_API_KEY"));
					return false;
				}
				const quota = await fetchQuota(sessionAbort?.signal);
				if (!isCurrentSession(sessionId)) return false;
				if (quota) {
					ctx.ui.setStatus(STATUS_KEY, footer(ctx, quota));
					return true;
				}
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Kimi usage unavailable"));
				return false;
			} catch (error) {
				if (handleStaleCtx(error) || !isCurrentSession(sessionId)) return false;
				runWithLiveCtx(sessionId, () => {
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Kimi usage unavailable"));
				});
				return false;
			}
		})().catch((error) => {
			if (!handleStaleCtx(error)) console.error(`[${ID}] refresh failed`, error);
			return false;
		});

		inFlight = { sessionId, promise };
		void promise.finally(() => {
			if (inFlight?.sessionId === sessionId && inFlight.promise === promise) inFlight = undefined;
		});
		return promise;
	};

	const showDetail = async (ctx: ExtensionContext, sessionId = activeSessionId) => {
		try {
			if (!isCurrentSession(sessionId) || !ctx.hasUI) return;
			if (!getToken()) {
				ctx.ui.notify("Kimi: log in via /login or set KIMI_API_KEY to check usage", "error");
				return;
			}
			ctx.ui.setWidget(STATUS_KEY, [ctx.ui.theme.fg("dim", "Kimi usage loading…")]);
			const snapshot = await fetchSnapshot(sessionAbort?.signal).catch(() => ({ quota: null, at: Date.now() }) as Snapshot);
			if (!isCurrentSession(sessionId)) return;
			if (snapshot.quota) {
				ctx.ui.setStatus(STATUS_KEY, footer(ctx, snapshot.quota));
				ctx.ui.setWidget(STATUS_KEY, detailLines(snapshot));
				ctx.ui.notify("Kimi usage refreshed", "info");
			} else {
				ctx.ui.setWidget(STATUS_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "Kimi usage unavailable"));
				ctx.ui.notify("Kimi usage unavailable — check KIMI_API_KEY / network", "error");
			}
		} catch (error) {
			if (!handleStaleCtx(error)) throw error;
		}
	};

	const startTimer = (ctx: ExtensionContext, sessionId = activeSessionId) => {
		stopTimer();
		if (!isCurrentSession(sessionId) || settings.refreshMs <= 0) return;
		timer = setInterval(() => {
			if (!isCurrentSession(sessionId)) {
				stopTimer();
				return;
			}
			void refreshStatus(ctx, sessionId).catch((error) => {
				if (!handleStaleCtx(error)) console.error(`[${ID}] refresh failed`, error);
			});
		}, settings.refreshMs);
	};

	pi.registerCommand("kimi", {
		description: "Show Kimi Coding Plan usage (5h + weekly quota windows)",
		handler: async (_args, ctx) => {
			await showDetail(ctx, activeSessionId);
		},
	});

	pi.registerCommand("kimi-usage:refresh", {
		description: "Refresh the Kimi usage footer now",
		handler: async (_args, ctx) => {
			const sessionId = activeSessionId;
			const ok = await refreshStatus(ctx, sessionId);
			runWithLiveCtx(sessionId, () => {
				if (ctx.hasUI) ctx.ui.notify(ok ? "Kimi usage refreshed" : "Kimi usage unavailable", ok ? "info" : "error");
			});
		},
	});

	pi.registerCommand("kimi-usage:hide", {
		description: "Hide the Kimi usage detail panel",
		handler: async (_args, ctx) => {
			runWithLiveCtx(activeSessionId, () => {
				if (ctx.hasUI) ctx.ui.setWidget(STATUS_KEY, undefined);
			});
		},
	});

	pi.registerCommand("kimi-usage:settings", {
		description: "Configure Kimi usage auto-refresh cadence",
		handler: async (_args, ctx) => {
			const sessionId = activeSessionId;
			try {
				if (!isCurrentSession(sessionId) || !ctx.hasUI) return;
				const current = settings.everyTurns > 0
					? settings.everyTurns === 1 ? "Each turn" : `Every ${settings.everyTurns} turns`
					: "Off";
				const choice = await ctx.ui.select(`Kimi usage auto-refresh (now: ${current})`, CADENCE_PRESETS.map((preset) => preset.label));
				if (!choice || !isCurrentSession(sessionId)) return;
				const preset = CADENCE_PRESETS.find((item) => item.label === choice);
				if (!preset) return;
				settings = { ...preset.value };
				turns = 0;
				await writeSettings(settings);
				if (!isCurrentSession(sessionId)) return;
				startTimer(ctx, sessionId);
				setLoadingStatus(ctx, sessionId);
				void refreshStatus(ctx, sessionId);
				ctx.ui.notify(`Kimi usage auto-refresh: ${choice}`, "info");
			} catch (error) {
				if (!handleStaleCtx(error)) throw error;
			}
		},
	});

	pi.registerTool({
		name: "kimi_usage",
		label: "Kimi Usage",
		description: "Check the user's Kimi (Moonshot AI) Coding Plan usage: 5-hour and weekly quota windows remaining, reset times, and max parallel sessions. Use when the user asks about their Kimi quota, rate limits, or how much usage they have left.",
		promptSnippet: "Check Kimi Coding Plan quota (5h / weekly remaining)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			if (!getToken()) {
				return { content: [{ type: "text" as const, text: "KIMI_API_KEY is not set. Log in via /login (Kimi) or set KIMI_API_KEY to check Kimi usage." }], details: undefined };
			}
			try {
				const snapshot = await fetchSnapshot(signal);
				if (!snapshot.quota) {
					return { content: [{ type: "text" as const, text: "Could not fetch Kimi usage (check KIMI_API_KEY / network)." }], details: undefined };
				}
				return { content: [{ type: "text" as const, text: detailText(snapshot) }], details: undefined };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Kimi usage request failed: ${message}`);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = beginSession();
		cachedAuth = undefined;
		settings = await readSettings();
		if (!isCurrentSession(sessionId)) return;
		turns = 0;
		setLoadingStatus(ctx, sessionId);
		startTimer(ctx, sessionId);
		void refreshStatus(ctx, sessionId);
	});

	pi.on("turn_end", (_event, ctx) => {
		const sessionId = activeSessionId;
		if (!isCurrentSession(sessionId)) return;
		turns += 1;
		if (settings.everyTurns <= 0 || turns < settings.everyTurns) return;
		turns = 0;
		void refreshStatus(ctx, sessionId);
	});

	pi.on("input", (_event, ctx) => {
		runWithLiveCtx(activeSessionId, () => {
			if (ctx.hasUI) ctx.ui.setWidget(STATUS_KEY, undefined);
		});
	});

	pi.on("session_shutdown", () => {
		endSession();
	});
}
