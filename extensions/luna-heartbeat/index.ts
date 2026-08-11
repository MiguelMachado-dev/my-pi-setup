import { statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  classifyObservation,
  isActionableState,
  shouldAlert,
  type MonitorConditions,
  type MonitorConfig,
  type MonitorRecord,
  type ObservationState,
  type Urgency,
  validatePatterns,
  validateStatusCommand,
} from "./core";

const STATE_ENTRY_TYPE = "luna-heartbeat-state";
const MESSAGE_TYPE = "luna-heartbeat-alert";
const STATUS_KEY = "luna-heartbeat";
const SNAPSHOT_VERSION = 1;
const DEFAULT_CADENCE_SECONDS = 180;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_DEADLINE_RISK_SECONDS = 900;

const ACTIONS = ["register", "list", "check", "pause", "resume", "remove", "clear"] as const;
const URGENCIES = ["low", "normal", "high", "critical"] as const;

const ConditionsSchema = Type.Object({
  healthyPattern: Type.Optional(Type.String({ description: "Regex proving the item is healthy." })),
  attentionPattern: Type.Optional(Type.String({ description: "Regex proving failure, a blocker, or required input." })),
  stalledPattern: Type.Optional(Type.String({ description: "Regex proving a real stall. Time alone is not evidence." })),
  terminalPattern: Type.Optional(Type.String({ description: "Regex proving the work item reached a terminal state." })),
});

const MonitorSchema = Type.Object({
  id: Type.String({ description: "Stable monitor ID using letters, numbers, dots, underscores, or hyphens." }),
  workItem: Type.String({ description: "Canonical async work item name." }),
  statusSource: Type.String({ description: "Human-readable source being observed." }),
  responsibleAgentId: Type.Optional(Type.String({ description: "Agent ID returned by the background Agent call." })),
  responsibleTask: Type.String({ description: "Canonical task name owned by the responsible Sol worker." }),
  executable: Type.String({ description: "Read-only status executable. Shell interpreters and mutating commands are rejected." }),
  args: Type.Optional(Type.Array(Type.String(), { description: "Argument array passed without a shell.", maxItems: 100 })),
  cwd: Type.Optional(Type.String({ description: "Status command working directory. Defaults to the current project." })),
  cadenceSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 86_400, description: "Check cadence. Prefer 120 to 300 seconds." })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Per-check timeout." })),
  acceptedExitCodes: Type.Optional(
    Type.Array(Type.Integer({ minimum: -255, maximum: 255 }), {
      description: "Exit codes that represent an observable state rather than a check failure. Defaults to [0].",
      minItems: 1,
      maxItems: 16,
    }),
  ),
  conditions: Type.Optional(ConditionsSchema),
  requestedAction: Type.String({ description: "Specific action Root Sol should route when attention is required." }),
  urgency: Type.Optional(StringEnum(URGENCIES)),
  deadline: Type.Optional(Type.String({ description: "Optional ISO-8601 deadline." })),
  deadlineRiskSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604_800 })),
  notifyOnRecovery: Type.Optional(Type.Boolean({ description: "Alert when a prior actionable state returns to healthy. Defaults to true." })),
});

const ToolParameters = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.String({ description: "Monitor ID for check, pause, resume, or remove." })),
  monitor: Type.Optional(MonitorSchema),
});

interface Snapshot {
  version: number;
  records: MonitorRecord[];
}

interface AlertDetails {
  monitorId: string;
  workItem: string;
  targetAgentId?: string;
  targetTask: string;
  observedState: ObservationState;
  evidence: string;
  requestedAction: string;
  urgency: Urgency;
  transitionKey: string;
}

export default function lunaHeartbeatExtension(pi: ExtensionAPI) {
  const records = new Map<string, MonitorRecord>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const runningChecks = new Set<string>();
  let currentContext: ExtensionContext | undefined;
  let active = false;
  let generation = 0;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
  }

  function clearTimers(): void {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
  }

  function updateStatus(): void {
    const context = currentContext;
    if (!context?.hasUI) return;
    if (records.size === 0) {
      context.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const watching = [...records.values()].filter(
      (record) => !record.paused && record.state !== "terminal",
    ).length;
    const attention = [...records.values()].filter(
      (record) => record.state !== "terminal" && isActionableState(record.state),
    ).length;
    const suffix = attention > 0 ? ` · ${attention} attention` : "";
    context.ui.setStatus(STATUS_KEY, `Luna ${watching} watching${suffix}`);
  }

  function persist(): void {
    if (!active) return;
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      records: [...records.values()].map((record) => ({
        ...record,
        args: [...record.args],
        acceptedExitCodes: [...record.acceptedExitCodes],
        conditions: { ...record.conditions },
      })),
    };
    pi.appendEntry(STATE_ENTRY_TYPE, snapshot);
  }

  function restore(context: ExtensionContext): void {
    records.clear();
    const entries = context.sessionManager.getBranch() as Array<{
      type?: string;
      customType?: string;
      data?: unknown;
    }>;
    const entry = [...entries]
      .reverse()
      .find((candidate) => candidate.type === "custom" && candidate.customType === STATE_ENTRY_TYPE);
    if (!entry || !isSnapshot(entry.data)) return;

    for (const record of entry.data.records) {
      records.set(record.id, {
        ...record,
        args: [...record.args],
        acceptedExitCodes: [...record.acceptedExitCodes],
        conditions: { ...record.conditions },
      });
    }
  }

  function arm(record: MonitorRecord): void {
    clearTimer(record.id);
    if (!active || record.paused || record.state === "terminal") return;
    const timer = setInterval(() => {
      void runCheck(record.id, "timer");
    }, record.cadenceSeconds * 1_000);
    timer.unref?.();
    timers.set(record.id, timer);
  }

  function sendAlert(
    record: MonitorRecord,
    previousState: ObservationState | undefined,
    transitionKey: string,
  ): void {
    const recovered = previousState !== undefined && isActionableState(previousState) && record.state === "healthy";
    const requestedAction = recovered
      ? `The item recovered from ${previousState}. Verify dependent work and resume it when appropriate.`
      : record.requestedAction;
    const details: AlertDetails = {
      monitorId: record.id,
      workItem: record.workItem,
      targetAgentId: record.responsibleAgentId,
      targetTask: record.responsibleTask,
      observedState: record.state ?? "unknown",
      evidence: record.evidence ?? "No evidence.",
      requestedAction,
      urgency: recovered ? "normal" : record.urgency,
      transitionKey,
    };
    const target = record.responsibleAgentId ?? "root";
    const content = [
      "[LUNA-HEARTBEAT][ACTION]",
      `work_item: ${record.workItem}`,
      `target_agent_id: ${target}`,
      `target_task: ${record.responsibleTask}`,
      `observed_state: ${details.observedState}`,
      `evidence: ${details.evidence}`,
      `requested_action: ${requestedAction}`,
      `urgency: ${details.urgency}`,
      `transition_key: ${transitionKey}`,
      "routing: Inspect the target with get_subagent_result. If it is running, use steer_subagent. If an idle completed agent must continue, resume it with Agent. Escalate human decisions to the user.",
    ].join("\n");

    pi.sendMessage<AlertDetails>(
      {
        customType: MESSAGE_TYPE,
        content,
        display: true,
        details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  async function runCheck(id: string, source: "manual" | "timer"): Promise<MonitorRecord | undefined> {
    const record = records.get(id);
    if (!record) return undefined;
    if (source === "timer" && record.paused) return record;
    if (runningChecks.has(id)) return record;

    runningChecks.add(id);
    const checkGeneration = generation;
    try {
      let observation;
      try {
        observation = await pi.exec(record.executable, record.args, {
          cwd: record.cwd,
          timeout: record.timeoutSeconds * 1_000,
        });
      } catch (error) {
        observation = {
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          code: -1,
          killed: false,
        };
      }

      if (!active || generation !== checkGeneration || records.get(id) !== record) return record;

      const previousState = record.state;
      const previousAlertKey = record.lastAlertKey;
      const next = classifyObservation(record, observation);
      const alert = shouldAlert(previousState, next, previousAlertKey, record.notifyOnRecovery);

      record.state = next.state;
      record.reason = next.reason;
      record.evidence = next.evidence;
      record.lastCheckedAt = new Date().toISOString();

      if (alert) {
        record.lastAlertKey = next.transitionKey;
        sendAlert(record, previousState, next.transitionKey);
      }
      if (record.state === "terminal") clearTimer(record.id);

      const changed =
        previousState !== record.state || previousAlertKey !== record.lastAlertKey;
      if (changed) persist();
      updateStatus();
      return record;
    } finally {
      runningChecks.delete(id);
    }
  }

  pi.on("session_start", (_event, context) => {
    generation += 1;
    active = true;
    currentContext = context;
    restore(context);
    for (const record of records.values()) arm(record);
    updateStatus();
  });

  pi.on("session_shutdown", (_event, context) => {
    generation += 1;
    active = false;
    clearTimers();
    runningChecks.clear();
    context.ui.setStatus(STATUS_KEY, undefined);
    currentContext = undefined;
  });

  pi.registerTool({
    name: "luna_heartbeat",
    label: "Luna Heartbeat",
    description:
      "Register and manage session-scoped, read-only heartbeat monitors for async work. Checks run without a shell, compare declared state transitions, deduplicate unchanged alerts, persist across resume, and wake Root Sol only when routing is needed.",
    promptSnippet: "Monitor async status sources and route actionable transitions through Root Sol",
    promptGuidelines: [
      "Use luna_heartbeat after launching async workers when a read-only command can observe their CI, deployment, queue, or repository state.",
      "Use process instead of luna_heartbeat for local long-running commands whose logs or exit status can provide event-driven notifications.",
      "Pass the responsible background Agent ID to luna_heartbeat so Root Sol can inspect and steer that worker when an alert arrives.",
      "Never put credentials in luna_heartbeat arguments, patterns, status output, or requested actions.",
      "When a LUNA-HEARTBEAT alert arrives, Root Sol must inspect the target agent and route the requested action; the monitor cannot steer sibling workers directly.",
    ],
    parameters: ToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      currentContext = context;

      if (params.action === "list") {
        return toolResult(formatRecords(records), { action: params.action, records: [...records.values()] });
      }

      if (params.action === "clear") {
        clearTimers();
        records.clear();
        persist();
        updateStatus();
        return toolResult("Cleared all Luna heartbeat monitors.", { action: params.action, records: [] });
      }

      if (params.action === "register") {
        if (!params.monitor) return toolResult("register requires monitor.");
        const validationError = validateMonitorInput(params.monitor, context.cwd);
        if (validationError) return toolResult(`Monitor rejected: ${validationError}`);

        const record = buildRecord(params.monitor, context.cwd);
        clearTimer(record.id);
        records.set(record.id, record);
        persist();
        arm(record);
        await runCheck(record.id, "manual");
        return toolResult(`Registered Luna heartbeat monitor.\n${formatRecord(record)}`, {
          action: params.action,
          records: [record],
        });
      }

      if (!params.id) return toolResult(`${params.action} requires id.`);
      const record = records.get(params.id);
      if (!record) return toolResult(`Monitor not found: ${params.id}`);

      if (params.action === "check") {
        await runCheck(record.id, "manual");
        return toolResult(formatRecord(record), { action: params.action, records: [record] });
      }

      if (params.action === "pause") {
        record.paused = true;
        clearTimer(record.id);
        persist();
        updateStatus();
        return toolResult(`Paused ${record.id}.`, { action: params.action, records: [record] });
      }

      if (params.action === "resume") {
        record.paused = false;
        record.state = undefined;
        record.reason = undefined;
        record.lastAlertKey = undefined;
        persist();
        arm(record);
        await runCheck(record.id, "manual");
        return toolResult(`Resumed ${record.id}.\n${formatRecord(record)}`, {
          action: params.action,
          records: [record],
        });
      }

      clearTimer(record.id);
      records.delete(record.id);
      persist();
      updateStatus();
      return toolResult(`Removed ${record.id}.`, { action: params.action, records: [record] });
    },
  });
}

function buildRecord(input: Record<string, unknown>, defaultCwd: string): MonitorRecord {
  const conditions = (input.conditions ?? {}) as MonitorConditions;
  return {
    id: String(input.id),
    workItem: String(input.workItem),
    statusSource: String(input.statusSource),
    responsibleAgentId: optionalString(input.responsibleAgentId),
    responsibleTask: String(input.responsibleTask),
    executable: String(input.executable),
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    cwd: resolve(defaultCwd, optionalString(input.cwd) ?? "."),
    cadenceSeconds: optionalNumber(input.cadenceSeconds) ?? DEFAULT_CADENCE_SECONDS,
    timeoutSeconds: optionalNumber(input.timeoutSeconds) ?? DEFAULT_TIMEOUT_SECONDS,
    acceptedExitCodes: Array.isArray(input.acceptedExitCodes)
      ? input.acceptedExitCodes.map(Number)
      : [0],
    conditions: { ...conditions },
    requestedAction: String(input.requestedAction),
    urgency: (optionalString(input.urgency) ?? "normal") as Urgency,
    deadline: optionalString(input.deadline),
    deadlineRiskSeconds: optionalNumber(input.deadlineRiskSeconds) ?? DEFAULT_DEADLINE_RISK_SECONDS,
    notifyOnRecovery: typeof input.notifyOnRecovery === "boolean" ? input.notifyOnRecovery : true,
    paused: false,
  };
}

function validateMonitorInput(input: Record<string, unknown>, defaultCwd: string): string | undefined {
  const id = String(input.id ?? "");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    return "id must be 1-64 letters, numbers, dots, underscores, or hyphens";
  }

  for (const field of ["workItem", "statusSource", "responsibleTask", "executable", "requestedAction"] as const) {
    if (!optionalString(input[field])) return `${field} must not be empty`;
  }

  const conditions = (input.conditions ?? {}) as MonitorConditions;
  const patternError = validatePatterns(conditions);
  if (patternError) return `invalid condition regex: ${patternError}`;

  const executable = String(input.executable ?? "");
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const commandError = validateStatusCommand(executable, args);
  if (commandError) return commandError;

  if (input.deadline && !Number.isFinite(Date.parse(String(input.deadline)))) {
    return "deadline must be a valid ISO-8601 timestamp";
  }

  const cwd = resolve(defaultCwd, optionalString(input.cwd) ?? ".");
  try {
    if (!statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
  return undefined;
}

function formatRecords(records: Map<string, MonitorRecord>): string {
  if (records.size === 0) return "No Luna heartbeat monitors are registered.";
  return [...records.values()].map(formatRecord).join("\n");
}

function formatRecord(record: MonitorRecord): string {
  const state = record.paused ? "paused" : (record.state ?? "waiting");
  const target = record.responsibleAgentId ?? "root";
  const checked = record.lastCheckedAt ?? "not checked";
  const reason = record.reason ? ` · ${record.reason}` : "";
  return `- ${record.id}: ${state} · ${record.workItem} · target ${target} · checked ${checked}${reason}`;
}

function toolResult(content: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: content }],
    details,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!isRecord(value) || value.version !== SNAPSHOT_VERSION || !Array.isArray(value.records)) return false;
  return value.records.every(isMonitorRecord);
}

function isMonitorRecord(value: unknown): value is MonitorRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.workItem === "string" &&
    typeof value.statusSource === "string" &&
    typeof value.responsibleTask === "string" &&
    typeof value.executable === "string" &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    typeof value.cwd === "string" &&
    typeof value.cadenceSeconds === "number" &&
    typeof value.timeoutSeconds === "number" &&
    Array.isArray(value.acceptedExitCodes) &&
    value.acceptedExitCodes.every((code) => typeof code === "number") &&
    isRecord(value.conditions) &&
    typeof value.requestedAction === "string" &&
    URGENCIES.includes(value.urgency as Urgency) &&
    typeof value.deadlineRiskSeconds === "number" &&
    typeof value.notifyOnRecovery === "boolean" &&
    typeof value.paused === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
