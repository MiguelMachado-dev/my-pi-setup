import { afterEach, describe, expect, test } from "bun:test";
import lunaHeartbeatExtension from "./index";

const shutdowns: Array<() => void> = [];

afterEach(() => {
  while (shutdowns.length > 0) shutdowns.pop()?.();
});

function createHarness(
  initialEntries: Array<{ type: string; customType: string; data: unknown }> = [],
) {
  const handlers = new Map<string, Array<(event: unknown, context: any) => unknown>>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [...initialEntries];
  const messages: Array<{ message: any; options: any }> = [];
  let tool: any;
  let execution = { stdout: "failed: database", stderr: "", code: 0, killed: false };
  let executionCount = 0;

  const pi = {
    on(name: string, handler: (event: unknown, context: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: any) {
      tool = definition;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
    async exec() {
      executionCount += 1;
      return execution;
    },
  };

  const context = {
    cwd: "/tmp",
    hasUI: false,
    mode: "tui",
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      setStatus() {},
    },
  };

  lunaHeartbeatExtension(pi as any);
  for (const handler of handlers.get("session_start") ?? []) handler({}, context);
  shutdowns.push(() => {
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, context);
  });

  return {
    context,
    entries,
    get executionCount() {
      return executionCount;
    },
    messages,
    setExecution(next: typeof execution) {
      execution = next;
    },
    tool,
  };
}

function monitor(attentionPattern = "failed:") {
  return {
    id: "ci",
    workItem: "PR CI",
    statusSource: "GitHub Actions",
    responsibleAgentId: "agent-123",
    responsibleTask: "Fix CI",
    executable: "printf",
    args: ["status"],
    cadenceSeconds: 300,
    conditions: { attentionPattern },
    requestedAction: "Inspect the failing check.",
    urgency: "high",
  };
}

describe("luna_heartbeat", () => {
  test("registers, checks, persists, and routes a new blocker", async () => {
    const harness = createHarness();
    const result = await harness.tool.execute(
      "call-1",
      { action: "register", monitor: monitor() },
      undefined,
      undefined,
      harness.context,
    );

    expect(result.content[0].text).toContain("Registered");
    expect(harness.executionCount).toBe(1);
    expect(harness.entries.length).toBeGreaterThan(0);
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0].message.content).toContain("target_agent_id: agent-123");
    expect(harness.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  test("deduplicates unchanged alerts and routes changed blockers", async () => {
    const harness = createHarness();
    await harness.tool.execute(
      "call-1",
      { action: "register", monitor: monitor() },
      undefined,
      undefined,
      harness.context,
    );
    await harness.tool.execute(
      "call-2",
      { action: "check", id: "ci" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.messages).toHaveLength(1);

    harness.setExecution({ stdout: "failed: cache", stderr: "", code: 0, killed: false });
    await harness.tool.execute(
      "call-3",
      { action: "check", id: "ci" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.messages).toHaveLength(2);
  });

  test("restores monitors from the session branch", async () => {
    const first = createHarness();
    await first.tool.execute(
      "call-1",
      { action: "register", monitor: monitor() },
      undefined,
      undefined,
      first.context,
    );
    const persisted = first.entries.at(-1);
    expect(persisted).toBeDefined();

    const resumed = createHarness(persisted ? [persisted] : []);
    const result = await resumed.tool.execute(
      "call-2",
      { action: "list" },
      undefined,
      undefined,
      resumed.context,
    );
    expect(result.content[0].text).toContain("ci: attention");
  });

  test("rejects shell interpreters before execution", async () => {
    const harness = createHarness();
    const unsafe = { ...monitor(), executable: "bash", args: ["-lc", "rm -rf /tmp/example"] };
    const result = await harness.tool.execute(
      "call-1",
      { action: "register", monitor: unsafe },
      undefined,
      undefined,
      harness.context,
    );

    expect(result.content[0].text).toContain("rejected");
    expect(harness.executionCount).toBe(0);
    expect(harness.messages).toHaveLength(0);
  });
});
