// Apple Watch "pi finished" notification.
// Mirrors the Herdr desktop notification: when pi settles (same event Herdr
// uses to fire its "pi finished" notification), pushes via ntfy to your
// iPhone, which mirrors it to the Apple Watch.
// Only fires when the pane is NOT focused: skipped when this pane is focused
// in Herdr AND the terminal app (Ghostty) is the frontmost macOS app.
// ponytail: can't detect focus lost to another window of the SAME app (Ghostty
// exposes no per-window focus API); add window-title matching if that matters.
// Setup: install the ntfy iOS app and subscribe to the topic in
// watch-notify.json next to this file. Then /reload in pi.
// @ts-nocheck

import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEBUG_LOG_PATH = fileURLToPath(
  new URL("./watch-notify.debug.log", import.meta.url),
);

function debug(line) {
  try {
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort
  }
}

const CONFIG_PATH = fileURLToPath(
  new URL("./watch-notify.json", import.meta.url),
);
const FETCH_TIMEOUT_MS = 5000;
const FOCUS_CHECK_TIMEOUT_MS = 2000;

// TERM_PROGRAM values whose frontmost app process name differs.
const TERM_APP_ALIASES = {
  vscode: "code",
  "Apple_Terminal": "terminal",
  "iTerm.app": "iterm2",
};

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: FOCUS_CHECK_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function paneFocusedInHerdr() {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return false;
  const out = await run("herdr", ["pane", "get", paneId]);
  if (!out) return false;
  try {
    return JSON.parse(out)?.result?.pane?.focused === true;
  } catch {
    return false;
  }
}

async function terminalAppIsFrontmost() {
  const termProgram = process.env.TERM_PROGRAM;
  if (process.platform !== "darwin" || !termProgram) return true;
  const expected = (TERM_APP_ALIASES[termProgram] ?? termProgram).toLowerCase();
  const frontmost = await run("osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
  if (!frontmost) return true;
  debug(`frontmost=${frontmost.trim()} expected=${expected}`);
  return frontmost.trim().toLowerCase().replace(/\.app$/, "") === expected;
}

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const topic = typeof parsed.topic === "string" ? parsed.topic.trim() : "";
    if (!topic) return null;
    const server =
      (typeof parsed.server === "string" && parsed.server.trim()) ||
      "https://ntfy.sh";
    return { topic, server: server.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

export default function watchNotify(pi) {
  const config = loadConfig();
  if (!config) return;

  let rootSession = false;
  let working = false;
  let startedAt = 0;

  pi.on("session_start", (_event, ctx) => {
    // Match the Herdr integration gate: only the interactive TUI session
    // inside a Herdr pane notifies (headless children inherit the env).
    rootSession = ctx?.mode === "tui" && process.env.HERDR_ENV === "1";
  });

  pi.on("agent_start", () => {
    working = true;
    startedAt = Date.now();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!rootSession || !working || ctx?.isIdle?.() !== true) return;
    working = false;

    const [paneFocused, appFrontmost] = await Promise.all([
      paneFocusedInHerdr(),
      terminalAppIsFrontmost(),
    ]);
    if (paneFocused && appFrontmost) {
      debug(`skipped: pane=${paneFocused} frontmost-app=${appFrontmost}`);
      return;
    }
    debug(`notifying: pane=${paneFocused} frontmost-app=${appFrontmost}`);

    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    const name =
      pi.getSessionName() ||
      (process.cwd().split("/").pop() || "session");
    const body = `${name} · ${minutes}m`;

    fetch(`${config.server}/${config.topic}`, {
      method: "POST",
      headers: { Title: "pi finished", Tags: "white_check_mark" },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => {
      // Best-effort: notify failures must never disturb the agent turn.
    });
  });
}
