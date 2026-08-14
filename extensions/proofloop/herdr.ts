import net from "node:net";
import type { HerdrAgentSnapshot, TargetState } from "./types";

interface JsonObject {
  [key: string]: unknown;
}

export interface HerdrSubscription {
  close(): void;
}

export class HerdrObserver {
  constructor(private readonly socketPath: string) {}

  async getAgent(target: string): Promise<HerdrAgentSnapshot> {
    const response = await this.request("agent.get", { target });
    const result = asObject(response.result);
    const agent = asObject(result.agent);
    const session = asObject(agent.agent_session);
    return {
      agent: String(agent.agent ?? ""),
      state: normalizeState(agent.agent_status),
      paneId: String(agent.pane_id ?? ""),
      sessionPath: session.kind === "path" || session.source === "herdr:pi" ? optionalString(session.value) : undefined,
      stateChangeSequence: optionalNumber(agent.state_change_seq),
    };
  }

  async subscribe(target: string, onHint: () => void, onDisconnect: (error?: Error) => void): Promise<HerdrSubscription> {
    const socket = net.createConnection(this.socketPath);
    let buffer = "";
    let started = false;
    let closed = false;
    let disconnectReported = false;
    const requestId = `proofloop-subscribe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;

    const ready = new Promise<void>((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error("Herdr subscription timed out")), 5_000);
      startupTimer.unref?.();
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          id: requestId,
          method: "events.subscribe",
          params: {
            subscriptions: [{ type: "pane.agent_status_changed", pane_id: target }],
          },
        })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: JsonObject;
          try {
            message = asObject(JSON.parse(line));
          } catch (error) {
            if (!started) {
              reject(error);
              return;
            }
            reportDisconnect(error instanceof Error ? error : new Error(String(error)));
            socket.destroy();
            return;
          }
          if (!started && message.id === requestId) {
            if (message.error) {
              reject(new Error(JSON.stringify(message.error)));
              return;
            }
            const result = asObject(message.result);
            if (result.type !== "subscription_started") {
              reject(new Error("Herdr returned an unexpected subscription response"));
              return;
            }
            started = true;
            socket.removeListener("error", reject);
            resolve();
            continue;
          }
          if (started) onHint();
        }
      });
    });

    const reportDisconnect = (error?: Error) => {
      if (closed || disconnectReported || !started) return;
      disconnectReported = true;
      onDisconnect(error);
    };
    socket.on("close", () => reportDisconnect());
    socket.on("error", (error) => reportDisconnect(error));

    try {
      await ready;
    } catch (error) {
      closed = true;
      socket.destroy();
      throw error;
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
    return {
      close() {
        closed = true;
        socket.destroy();
      },
    };
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const id = `proofloop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let buffer = "";
      let done = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: JsonObject) => {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(value ?? {});
      };
      timeout = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), 5_000);
      timeout.unref?.();
      socket.once("error", (error) => finish(error));
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = asObject(JSON.parse(buffer.slice(0, newline)));
          if (response.error) {
            finish(new Error(JSON.stringify(response.error)));
            return;
          }
          finish(undefined, response);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}

function normalizeState(value: unknown): TargetState {
  const state = String(value ?? "unknown");
  if (["pending", "working", "blocked", "idle", "done", "failed", "unknown"].includes(state)) {
    return state as TargetState;
  }
  return "unknown";
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
