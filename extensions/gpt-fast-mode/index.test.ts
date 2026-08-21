import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastModeExtension, { CONFIG_FIELD, FAST_SERVICE_TIER } from "./index";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("loops its styled status without replacing the footer", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "gpt-fast-mode-"));
  const previousConfigDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDirectory;
  writeFileSync(
    join(configDirectory, "settings.json"),
    JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }),
  );

  try {
    const handlers = new Map<string, Array<(event: any, context: any) => any>>();
    const statuses: Array<{ key: string; value: string | undefined }> = [];
    const notifications: string[] = [];
    const widgetContents: unknown[] = [];
    let footerCalls = 0;
    let fastCommand: { handler: (args: string, context: any) => Promise<void> } | undefined;

    const pi = {
      on(name: string, handler: (event: any, context: any) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand(
        name: string,
        command: { handler: (args: string, context: any) => Promise<void> },
      ) {
        if (name === "fast") fastCommand = command;
      },
      registerShortcut() {},
    };
    const context = {
      hasUI: true,
      mode: "tui",
      model: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setFooter() {
          footerCalls += 1;
        },
        setStatus(key: string, value: string | undefined) {
          statuses.push({ key, value });
        },
        setWidget(key: string, content: unknown) {
          expect(key).toBe(CONFIG_FIELD);
          widgetContents.push(content);
        },
      },
    };

    fastModeExtension(pi as any);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);

    const firstFrame = statuses.at(-1);
    expect(firstFrame?.key).toBe(CONFIG_FIELD);
    expect(stripAnsi(firstFrame?.value ?? "")).toBe("⚡ FAST");
    expect(firstFrame?.value).toContain("\x1b[38;2;");
    expect(footerCalls).toBe(0);

    await wait(1_200);
    const animationFrames = statuses.map(({ value }) => value).filter((value): value is string => Boolean(value));
    expect(animationFrames.length).toBeGreaterThanOrEqual(8);
    expect(new Set(animationFrames.slice(0, 7)).size).toBe(7);
    expect(animationFrames[7]).toBe(animationFrames[0]);

    const request = { payload: { model: "gpt-5.6-sol" } };
    const requestHandler = handlers.get("before_provider_request")?.[0];
    expect(await requestHandler?.(request, context)).toEqual({
      model: "gpt-5.6-sol",
      service_tier: FAST_SERVICE_TIER,
    });

    context.model = { provider: "anthropic", id: "claude-sonnet-4", reasoning: true };
    for (const handler of handlers.get("model_select") ?? []) await handler({}, context);
    expect(statuses.at(-1)).toEqual({ key: CONFIG_FIELD, value: "⚡ FAST · unsupported" });

    const statusCountAfterUnsupportedModel = statuses.length;
    await wait(150);
    expect(statuses).toHaveLength(statusCountAfterUnsupportedModel);

    await fastCommand?.handler("", context);
    expect(statuses.at(-1)).toEqual({ key: CONFIG_FIELD, value: undefined });
    expect(notifications.at(-1)).toBe("GPT Fast mode disabled.");

    context.model = { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true };
    await fastCommand?.handler("", context);
    expect(stripAnsi(statuses.at(-1)?.value ?? "")).toBe("⚡ FAST");

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    expect(statuses.at(-1)).toEqual({ key: CONFIG_FIELD, value: undefined });
    const statusCountAfterShutdown = statuses.length;
    await wait(150);
    expect(statuses).toHaveLength(statusCountAfterShutdown);
    expect(widgetContents.every((content) => content === undefined)).toBe(true);
    expect(footerCalls).toBe(0);
  } finally {
    if (previousConfigDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    if (previousConfigDirectory !== undefined) process.env.PI_CODING_AGENT_DIR = previousConfigDirectory;
    rmSync(configDirectory, { recursive: true, force: true });
  }
});
