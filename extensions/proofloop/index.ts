import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GitProofrunInspector, ProofrunLauncher } from "./launcher";
import { setProofloopStatus } from "./status-widget";
import { ProofloopSupervisor, type ProcessLifecycleEvent } from "./supervisor";
import type { Outcome, RunContract, RunView } from "./types";

const ACTIONS = ["start", "status", "check", "stop"] as const;
const URGENCIES = ["low", "normal", "high", "critical"] as const;

const ContractSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1, maxLength: 96 }),
    task: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        goal: Type.String({ minLength: 1 }),
        ownerTask: Type.String({ minLength: 1 }),
        requestedAction: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    target: Type.Object(
      {
        kind: Type.Literal("herdr-pane"),
        paneId: Type.String({ minLength: 1 }),
        expectedAgent: Type.Literal("pi"),
        sessionPath: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    git: Type.Object(
      {
        worktreeRoot: Type.String({ minLength: 1 }),
        expectedHead: Type.String({ pattern: "^[a-fA-F0-9]{40,64}$" }),
        allowedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        forbiddenPaths: Type.Array(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    validation: Type.Object(
      {
        tool: StringEnum(["bash", "process"] as const),
        cwd: Type.String({ minLength: 1 }),
        command: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    budgets: Type.Object(
      {
        checkpointSeconds: Type.Integer({ minimum: 30, maximum: 86_400 }),
        hardStopSeconds: Type.Integer({ minimum: 30, maximum: 604_800 }),
        maxMutationBatches: Type.Integer({ minimum: 0, maximum: 10_000 }),
      },
      { additionalProperties: false },
    ),
    routing: Type.Object(
      {
        mode: Type.Literal("record-only"),
        urgency: StringEnum(URGENCIES),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolParameters = Type.Object(
  {
    action: StringEnum(ACTIONS),
    contract: Type.Optional(ContractSchema),
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    reason: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export default function proofloopExtension(pi: ExtensionAPI): void {
  let supervisor: ProofloopSupervisor | undefined;
  let currentContext: ExtensionContext | undefined;
  let launcherRunId: string | undefined;
  let disposeProcessNotifications: (() => void) | undefined;

  function registerProcessNotifications(): void {
    disposeProcessNotifications?.();
    disposeProcessNotifications = pi.events.on("processes:notification", (payload) => {
      if (!isProcessLifecycleEvent(payload)) return;
      void supervisor?.observeProcessLifecycle(payload);
    });
  }

  function getSupervisor(): ProofloopSupervisor {
    if (supervisor) return supervisor;
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) throw new Error("Proofloop requires a Herdr-managed Pi session with HERDR_SOCKET_PATH");
    const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    supervisor = new ProofloopSupervisor({
      evidenceRoot: join(agentDirectory, "proofloop"),
      herdrSocketPath: socketPath,
      onStateChange: updateStatus,
    });
    return supervisor;
  }

  function updateStatus(view?: RunView): void {
    setProofloopStatus(currentContext, view);
  }

  pi.on("session_start", (_event, context) => {
    currentContext = context;
    registerProcessNotifications();
    updateStatus();
  });

  pi.on("session_shutdown", async (_event, context) => {
    disposeProcessNotifications?.();
    disposeProcessNotifications = undefined;
    await supervisor?.shutdown();
    supervisor = undefined;
    launcherRunId = undefined;
    setProofloopStatus(context);
    currentContext = undefined;
  });

  pi.registerCommand("proofrun", {
    description: "Baseline this tab and launch a task under Proofloop observation",
    handler: async (args, context) => {
      currentContext = context;
      if (!context.isIdle()) {
        context.ui.notify("Proofrun requires an idle agent", "warning");
        return;
      }
      const sessionPath = context.sessionManager.getSessionFile();
      const paneId = process.env.HERDR_PANE_ID;
      if (!sessionPath || !paneId) {
        context.ui.notify("Proofrun requires a persisted Pi session inside Herdr", "error");
        return;
      }

      try {
        const instance = getSupervisor();
        if (launcherRunId) {
          const existing = await instance.status(launcherRunId);
          if (existing.ok && !isTerminalStatus(existing.value.status)) {
            context.ui.notify(`Proofrun ${launcherRunId} is still active`, "warning");
            updateStatus(existing.value);
            return;
          }
          launcherRunId = undefined;
        }

        context.ui.notify("Capturing Proofloop baseline before dispatch…", "info");
        const launcher = new ProofrunLauncher({
          git: new GitProofrunInspector(),
          supervisor: instance,
          dispatch: (prompt) => pi.sendUserMessage(prompt),
        });
        const result = await launcher.launch({
          task: args,
          cwd: context.cwd,
          paneId,
          sessionPath,
        });
        if (!result.ok) {
          context.ui.notify(`Proofrun ${result.error.code}: ${result.error.message}`, "error");
          return;
        }
        launcherRunId = result.value.run.runId;
        updateStatus(result.value.run);
        context.ui.notify(`Proofrun ${launcherRunId} is observing this tab`, "info");
      } catch (error) {
        context.ui.notify(
          `Proofrun unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerTool({
    name: "proofloop",
    label: "Proofloop",
    description:
      "Start and inspect a record-only Proofloop run for an existing Herdr Pi target. It captures a stable Git baseline, preserves preexisting dirt, tails only new Pi session events, detects repeated validation without mutations, and records durable settlement evidence outside the product repository.",
    promptSnippet: "Observe implementation proof, Git attribution, and repeated validation",
    promptGuidelines: [
      "Use proofloop start before the first mutation when possible. An adopted active target proves only post-baseline changes.",
      "The pilot supports record-only routing: it never prompts, blocks, retries, edits, commits, or controls the writer.",
      "Use luna_heartbeat separately for external CI, deployment, queue, or repository status commands.",
      "Treat blocked and unknown targets as non-passing. Review durable evidence before starting an enforced or routed follow-up run.",
    ],
    parameters: ToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      currentContext = context;
      let result: Outcome<RunView> | undefined;
      try {
        const instance = getSupervisor();
        if (params.action === "start") {
          if (!params.contract) return toolResult("start requires contract.");
          result = await instance.start(params.contract as RunContract);
        }
        if (params.action !== "start" && !params.runId) {
          return toolResult(`${params.action} requires runId.`);
        }
        if (params.action === "status" && params.runId) result = await instance.status(params.runId);
        if (params.action === "check" && params.runId) result = await instance.check(params.runId);
        if (params.action === "stop" && params.runId) {
          result = await instance.stop(params.runId, params.reason ?? "Stopped by Root Sol");
        }
      } catch (error) {
        return toolResult(`Proofloop unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!result) return toolResult("Proofloop action could not be resolved.");
      if (!result.ok) {
        return toolResult(`Proofloop ${result.error.code}: ${result.error.message}`, { error: result.error });
      }
      updateStatus(result.value);
      return toolResult(formatView(result.value), { run: result.value });
    },
  });
}

function formatView(view: RunView): string {
  const violations = view.gate.violations.length > 0
    ? `\nFindings: ${view.gate.violations.map((violation) => violation.code).join(", ")}`
    : "";
  return [
    `Proofloop ${view.runId}: ${view.status}`,
    `Target: ${view.targetState}`,
    `Mutation batches: ${view.mutationBatchCount}`,
    `Active background Agents: ${view.activeBackgroundAgentCount}`,
    `Active background processes: ${view.activeBackgroundProcessCount}`,
    `Validation: ${formatValidation(view)}`,
    `Gate: ${view.gate.verdict}`,
    `Evidence: ${view.evidencePath}${violations}`,
  ].join("\n");
}

function formatValidation(view: RunView): string {
  if (!view.validation.observed) return "not observed";
  if (view.validation.repeatedWithoutMutation) return "repeated without mutation";
  if (view.validation.stale) return "stale";
  return view.validation.passed ? "passed" : "failed";
}

function isProcessLifecycleEvent(value: unknown): value is ProcessLifecycleEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!["success", "failure", "crash", "killed"].includes(String(event.kind ?? ""))) return false;
  return typeof event.processId === "string" && event.processId.length > 0;
}

function isTerminalStatus(status: RunView["status"]): boolean {
  return ["passed", "failed", "stopped"].includes(status);
}

function toolResult(
  content: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text" as const, text: content }],
    details,
  };
}
