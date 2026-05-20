import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const UPDATE_INTERVAL_MS = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / UPDATE_INTERVAL_MS);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;
	const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);

	if (totalMinutes === 0) return `${seconds}s`;

	const minutes = totalMinutes % MINUTES_PER_HOUR;
	const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
	const paddedSeconds = seconds.toString().padStart(2, "0");

	if (hours === 0) return `${minutes}m ${paddedSeconds}s`;

	const paddedMinutes = minutes.toString().padStart(2, "0");
	return `${hours}h ${paddedMinutes}m ${paddedSeconds}s`;
}

function workingMessage(startedAt: number): string {
	return `Working... (${formatElapsed(Date.now() - startedAt)})`;
}

export default function (pi: ExtensionAPI) {
	let interval: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;

	function stopTimer(ctx?: ExtensionContext): void {
		if (interval) clearInterval(interval);
		interval = undefined;
		startedAt = 0;
		if (ctx?.hasUI) ctx.ui.setWorkingMessage();
	}

	function updateMessage(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(workingMessage(startedAt));
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer();
		if (!ctx.hasUI) return;
		startedAt = Date.now();
		updateMessage(ctx);
		interval = setInterval(() => updateMessage(ctx), UPDATE_INTERVAL_MS);
	}

	pi.on("agent_start", async (_event, ctx) => {
		startTimer(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer(ctx);
	});
}
