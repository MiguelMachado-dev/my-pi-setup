import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

type EventHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => unknown;

type SideEffect = {
  kind: "session-name" | "herdr";
  value: unknown;
};

const modelCalls: unknown[][] = [];

function titleResponse() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Generated title" }],
    stopReason: "stop",
  };
}

let completeModelCall = async (..._args: unknown[]) => titleResponse();

mock.module("@earendil-works/pi-ai", () => ({
  completeSimple: async (...args: unknown[]) => {
    modelCalls.push(args);
    return completeModelCall(...args);
  },
}));

const { default: autoTabTitle } = await import(
  "../../extensions/auto-tab-title.ts"
);

const originalHerdrEnvironment = process.env.HERDR_ENV;
const originalHerdrTabId = process.env.HERDR_TAB_ID;

function userEntry(id: string, content: string, parentId: string | null = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content,
      timestamp: 0,
    },
  };
}

function createRuntime(entries: unknown[]) {
  const handlers = new Map<string, EventHandler[]>();
  const sideEffects: SideEffect[] = [];
  const pi = {
    on(eventName: string, handler: EventHandler) {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
    setSessionName(title: string) {
      sideEffects.push({ kind: "session-name", value: title });
    },
    async exec(command: string, args: string[]) {
      sideEffects.push({ kind: "herdr", value: { command, args } });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  const context = {
    modelRegistry: {
      find(provider: string, id: string) {
        return {
          id,
          name: id,
          provider,
          api: "test-api",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: {} };
      },
    },
    sessionManager: {
      getBranch() {
        return entries;
      },
    },
  };

  autoTabTitle(pi as never);

  return {
    sideEffects,
    async emit(eventName: string, event: Record<string, unknown>) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(event, context);
      }
    },
  };
}

async function flushTitleTask() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  modelCalls.length = 0;
  completeModelCall = async () => titleResponse();
  process.env.HERDR_ENV = "1";
  process.env.HERDR_TAB_ID = "workspace:tab";
});

afterAll(() => {
  process.env.HERDR_ENV = originalHerdrEnvironment;
  process.env.HERDR_TAB_ID = originalHerdrTabId;
});

describe("auto-tab-title", () => {
  test("applies the title once on the first prompt of a new session", async () => {
    const runtime = createRuntime([userEntry("current", "Build dashboard")]);

    await runtime.emit("session_start", { reason: "startup" });
    await runtime.emit("before_agent_start", { prompt: "Build dashboard" });
    await flushTitleTask();
    await runtime.emit("before_agent_start", { prompt: "Build dashboard" });
    await flushTitleTask();

    expect(modelCalls).toHaveLength(1);
    expect(runtime.sideEffects).toEqual([
      { kind: "session-name", value: "Generated title" },
      {
        kind: "herdr",
        value: {
          command: "herdr",
          args: [
            "tab",
            "rename",
            "workspace:tab",
            "Generated title",
          ],
        },
      },
    ]);
  });

  test("does not change the title after resuming a session", async () => {
    const runtime = createRuntime([userEntry("current", "Continue work")]);

    await runtime.emit("session_start", { reason: "resume" });
    await runtime.emit("before_agent_start", { prompt: "Continue work" });
    await flushTitleTask();

    expect(modelCalls).toHaveLength(0);
    expect(runtime.sideEffects).toHaveLength(0);
  });

  test("discards a title still generating when the session is replaced", async () => {
    let resolveTitle: ((response: ReturnType<typeof titleResponse>) => void) | undefined;
    completeModelCall = async () => {
      return new Promise((resolve) => {
        resolveTitle = resolve;
      });
    };
    const runtime = createRuntime([userEntry("current", "Build dashboard")]);

    await runtime.emit("session_start", { reason: "startup" });
    await runtime.emit("before_agent_start", { prompt: "Build dashboard" });
    await flushTitleTask();
    expect(modelCalls).toHaveLength(1);

    await runtime.emit("session_shutdown", { reason: "resume" });
    resolveTitle?.(titleResponse());
    await flushTitleTask();

    expect(runtime.sideEffects).toHaveLength(0);
  });
});
