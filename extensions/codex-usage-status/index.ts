import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const ID = "codex-usage-status";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "extensions", ID, "settings.json");
const TIMEOUT_MS = 8_000;
const CODEX_APP = "/Applications/Codex.app/Contents/Resources/codex";
const TURN_OPTIONS = [5, 10, 20, 50] as const;

type Json = Record<string, unknown>;
type Window = { label: string; remaining: number | null; reset: Date | null };
type Limits = { session: Window | null; weekly: Window | null };
type Settings = { everyTurns: 1 | (typeof TURN_OPTIONS)[number] };

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const obj = (parent: Json, key: string) => (isJson(parent[key]) ? parent[key] : null);
const str = (parent: Json, key: string) => (typeof parent[key] === "string" && parent[key] ? parent[key] : null);
const num = (parent: Json, key: string) => {
	const value = parent[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Number(value.replace(/%$/, ""));
	return Number.isFinite(parsed) ? parsed : null;
};
function first<T>(reader: (parent: Json, key: string) => T | null, parent: Json, ...keys: string[]) {
	for (const key of keys) {
		const value = reader(parent, key);
		if (value !== null) return value;
	}
	return null;
}
const parse = (text: string) => {
	try {
		const value: unknown = JSON.parse(text);
		return value;
	} catch {
		return null;
	}
};

const DEFAULT_SETTINGS: Settings = { everyTurns: 5 };
const isEveryTurns = (value: unknown): value is Settings["everyTurns"] => value === 1 || TURN_OPTIONS.includes(value as (typeof TURN_OPTIONS)[number]);
const settingsText = (settings: Settings) => (settings.everyTurns === 1 ? "each turn" : `every ${settings.everyTurns} turns`);
async function readSettings() {
	try {
		const parsed = parse(await readFile(SETTINGS_PATH, "utf8"));
		return isJson(parsed) && isEveryTurns(parsed.everyTurns) ? { everyTurns: parsed.everyTurns } : DEFAULT_SETTINGS;
	} catch {
		return DEFAULT_SETTINGS;
	}
}
async function writeSettings(settings: Settings) {
	await mkdir(dirname(SETTINGS_PATH), { recursive: true });
	await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

const percent = (value: number | null) => {
	if (value === null) return null;
	const normalized = value > 0 && value < 1 ? value * 100 : value;
	return Math.max(0, Math.min(100, Math.round(normalized * 100) / 100));
};
const remainingFromUsed = (used: number | null) => (used === null ? null : percent(100 - used));
const epochDate = (value: number | null) => {
	if (value === null) return null;
	const date = new Date(value > 10_000_000_000 ? value : value * 1000);
	return Number.isFinite(date.getTime()) ? date : null;
};
const fromNow = (seconds: number | null) => (seconds === null ? null : new Date(Date.now() + seconds * 1000));
const fallbackReset = (minutes: number | null) => (minutes && minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null);
const labelFor = (minutes: number | null, fallback: string) => (minutes === null ? fallback : minutes <= 360 ? "5h" : minutes >= 9_000 ? "Weekly" : fallback);

function windowFrom(payload: Json | null, fallbackLabel: string) {
	if (!payload) return null;
	const used = percent(first(num, payload, "usedPercent", "used_percent"));
	const remaining = percent(first(num, payload, "remainingPercent", "remaining_percent"));
	const seconds = first(num, payload, "limitWindowSeconds", "limit_window_seconds");
	const minutes = first(num, payload, "windowDurationMins", "window_minutes") ?? (seconds === null ? null : seconds / 60);
	const reset =
		epochDate(first(num, payload, "resetsAt", "resets_at", "resetAt", "reset_at")) ??
		fromNow(first(num, payload, "resetsInSeconds", "resets_in_seconds", "resetAfterSeconds", "reset_after_seconds")) ??
		fallbackReset(minutes);
	return used === null && remaining === null && reset === null && minutes === null
		? null
		: { label: str(payload, "label") ?? labelFor(minutes, fallbackLabel), remaining: remaining ?? remainingFromUsed(used), reset };
}
const limitsFrom = (payload: Json): Limits | null => {
	const session = windowFrom(first(obj, payload, "primary", "primary_window"), "5h");
	const weekly = windowFrom(first(obj, payload, "secondary", "secondary_window"), "Weekly");
	return session || weekly ? { session, weekly } : null;
};

function appServerLimits(payload: Json) {
	const wham = obj(payload, "rate_limit");
	if (wham) return limitsFrom(wham);

	const single = first(obj, payload, "rateLimits", "rate_limits");
	const byId = first(obj, payload, "rateLimitsByLimitId", "rate_limits_by_limit_id");
	if (!byId) return single ? limitsFrom(single) : null;
	const codex = obj(byId, "codex");
	if (codex) return limitsFrom(codex);
	if (single) return limitsFrom(single);
	const fallback = Object.values(byId).find(isJson);
	return fallback ? limitsFrom(fallback) : null;
}

function jsonObjectIn(text: string) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) {
			const parsed = parse(text.slice(start, index + 1));
			return isJson(parsed) ? parsed : null;
		}
	}
	return null;
}
const whamErrorLimits = (message: string) => {
	const body = message.indexOf("body=");
	const payload = body < 0 ? null : jsonObjectIn(message.slice(body + 5));
	return payload ? appServerLimits(payload) : null;
};

async function executable(path: string) {
	try {
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function fetchLimits() {
	const command = (await executable(CODEX_APP)) ? CODEX_APP : "codex";
	const child = spawn(command, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
	const lines = createInterface({ input: child.stdout });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => (stderr += chunk));
	const send = (payload: Json) => child.stdin.write(`${JSON.stringify(payload)}\n`);

	try {
		return await new Promise<Limits>((resolve, reject) => {
			const fail = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error("Timed out waiting for Codex rate limits")), TIMEOUT_MS);
			child.once("error", fail);
			child.once("exit", (code) => fail(new Error(`Codex app-server exited with code ${code ?? "unknown"}: ${stderr.trim()}`)));
			lines.on("line", (line) => {
				const message = parse(line);
				if (!isJson(message) || message.id !== 1) return;
				clearTimeout(timer);

				const error = obj(message, "error");
				if (error) {
					const text = str(error, "message") ?? JSON.stringify(error);
					const limits = whamErrorLimits(text);
					limits ? resolve(limits) : reject(new Error(text));
					return;
				}

				const result = obj(message, "result");
				const limits = result ? appServerLimits(result) : null;
				limits ? resolve(limits) : reject(new Error("Codex returned no usable rate limit data"));
			});

			send({ method: "initialize", id: 0, params: { clientInfo: { name: "pi-codex-usage-status", title: "Pi Codex Usage Status", version: "0.1.0" } } });
			send({ method: "initialized", params: {} });
			send({ method: "account/rateLimits/read", id: 1, params: null });
		});
	} finally {
		lines.close();
		if (!child.killed) child.kill();
	}
}

const pct = (value: number | null) => (value === null ? "--%" : `${Math.round(value)}%`);
function resetText(date: Date | null) {
	if (!date) return "--";
	const now = new Date();
	return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function color(ctx: ExtensionContext, value: number | null, text: string) {
	if (value === null) return ctx.ui.theme.fg("dim", text);
	return ctx.ui.theme.fg(value <= 10 ? "error" : value <= 20 ? "warning" : "success", text);
}
function status(ctx: ExtensionContext, limits: Limits) {
	const theme = ctx.ui.theme;
	return [
		theme.fg("dim", "Codex "),
		theme.fg("muted", `${limits.session?.label ?? "5h"} `),
		color(ctx, limits.session?.remaining ?? null, pct(limits.session?.remaining ?? null)),
		theme.fg("dim", ` ${resetText(limits.session?.reset ?? null)} | W `),
		color(ctx, limits.weekly?.remaining ?? null, pct(limits.weekly?.remaining ?? null)),
		theme.fg("dim", ` ${resetText(limits.weekly?.reset ?? null)}`),
	].join("");
}

export default function (pi: ExtensionAPI) {
	let settings = DEFAULT_SETTINGS;
	let turns = 0;
	let inFlight: Promise<boolean> | undefined;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return Promise.resolve(false);
		if (inFlight) return inFlight;
		inFlight = fetchLimits()
			.then((limits) => {
				ctx.ui.setStatus(ID, status(ctx, limits));
				return true;
			})
			.catch(() => {
				ctx.ui.setStatus(ID, ctx.ui.theme.fg("error", "Codex usage unavailable"));
				return false;
			})
			.finally(() => (inFlight = undefined));
		return inFlight;
	};
	const setLoadingStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(ID, ctx.ui.theme.fg("dim", `Codex usage updates ${settingsText(settings)}`));
	};

	pi.registerCommand("codex-usage:refresh", {
		description: "Refresh Codex usage status now",
		handler: async (_args, ctx) => {
			const refreshed = await refresh(ctx);
			if (ctx.hasUI) ctx.ui.notify(refreshed ? "Codex usage refreshed" : "Codex usage unavailable", refreshed ? "info" : "error");
		},
	});

	pi.registerCommand("codex-usage-status:settings", {
		description: "Configure Codex usage status-line refresh cadence",
		handler: async (_args, ctx) => {
			const choices = ["Each turn", ...TURN_OPTIONS.map((option) => `Every ${option} turns`)];
			const current = settings.everyTurns === 1 ? "Each turn" : `Every ${settings.everyTurns} turns`;
			const choice = await ctx.ui.select(`Codex usage status refresh (${current})`, choices);
			if (!choice) return;
			const everyTurns = choice === "Each turn" ? 1 : Number(choice.match(/\d+/)?.[0] ?? 5);
			if (!isEveryTurns(everyTurns)) return;
			settings = { everyTurns };
			turns = 0;
			await writeSettings(settings);
			ctx.ui.notify(`Codex usage status updates ${settingsText(settings)}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		settings = await readSettings();
		turns = 0;
		setLoadingStatus(ctx);
		void refresh(ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		turns++;
		if (turns < settings.everyTurns) return;
		turns = 0;
		void refresh(ctx);
	});
}
