export type Urgency = "low" | "normal" | "high" | "critical";
export type RoutingMode = "record-only";
export type RunStatus =
  | "starting"
  | "observing"
  | "waiting"
  | "attention"
  | "settling"
  | "passed"
  | "failed"
  | "stopped";
export type TargetState = "pending" | "working" | "blocked" | "idle" | "done" | "failed" | "unknown";

export interface RunContract {
  schemaVersion: 1;
  runId: string;
  task: {
    id: string;
    goal: string;
    ownerTask: string;
    requestedAction: string;
  };
  target: {
    kind: "herdr-pane";
    paneId: string;
    expectedAgent: "pi";
    sessionPath: string;
  };
  git: {
    worktreeRoot: string;
    expectedHead: string;
    allowedPaths: string[];
    forbiddenPaths: string[];
  };
  validation: {
    tool: "bash" | "process";
    cwd: string;
    command: string;
  };
  budgets: {
    checkpointSeconds: number;
    hardStopSeconds: number;
    maxMutationBatches: number;
  };
  routing: {
    mode: RoutingMode;
    urgency: Urgency;
  };
}

export type GateViolationCode =
  | "HEAD_CHANGED"
  | "OUT_OF_SCOPE_WRITE"
  | "FORBIDDEN_WRITE"
  | "MUTATION_BUDGET"
  | "CHECKPOINT_MISSED"
  | "DEADLINE_EXCEEDED"
  | "REPEATED_VALIDATION"
  | "VALIDATION_MISSING"
  | "VALIDATION_FAILED"
  | "VALIDATION_STALE"
  | "TARGET_BLOCKED"
  | "TARGET_UNKNOWN"
  | "TARGET_REPLACED"
  | "BACKGROUND_AGENT_FAILED"
  | "BACKGROUND_PROCESS_FAILED"
  | "OBSERVER_ERROR";

export interface GateViolation {
  code: GateViolationCode;
  detail: string;
  path?: string;
  recoveryKey?: string;
}

export interface ValidationView {
  observed: boolean;
  passed?: boolean;
  stale: boolean;
  repeatedWithoutMutation: boolean;
  completedAt?: string;
}

export interface RunView {
  runId: string;
  status: RunStatus;
  targetState: TargetState;
  contractDigest: string;
  baselineDigest?: string;
  mutationFingerprint?: string;
  mutationBatchCount: number;
  activeBackgroundAgentCount: number;
  activeBackgroundProcessCount: number;
  validation: ValidationView;
  gate: {
    verdict: "pending" | "pass" | "fail";
    violations: GateViolation[];
  };
  evidencePath: string;
  lastObservedAt?: string;
}

export interface ProofloopError {
  code:
    | "CONTRACT_INVALID"
    | "RUN_EXISTS"
    | "RUN_NOT_FOUND"
    | "TARGET_NOT_FOUND"
    | "TARGET_SESSION_MISMATCH"
    | "HERDR_PROTOCOL_MISMATCH"
    | "HERDR_DISCONNECTED"
    | "GIT_UNAVAILABLE"
    | "HEAD_MISMATCH"
    | "BASELINE_UNSTABLE"
    | "DIRTY_FORBIDDEN_PATH"
    | "SESSION_INVALID"
    | "SESSION_REPLACED"
    | "SESSION_TRUNCATED"
    | "SESSION_BATCH_TOO_LARGE"
    | "SESSION_RECORD_TOO_LARGE"
    | "SESSION_HISTORY_TOO_LARGE"
    | "EVIDENCE_IO"
    | "ROUTE_DELIVERY_FAILED";
  message: string;
  evidencePath?: string;
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProofloopError };

export interface GitFileFingerprint {
  status: string;
  worktree:
    | { kind: "missing" }
    | { kind: "file"; mode: number; size: number; sha256: string }
    | { kind: "symlink"; mode: number; target: string }
    | { kind: "other"; mode: number; size: number };
  index?: { mode: string; objectId: string; stage: string };
  renameSource?: string;
}

export interface GitSnapshot {
  head: string;
  entries: Record<string, GitFileFingerprint>;
  digest: string;
}

export interface GitBaseline extends GitSnapshot {
  capturedAt: string;
}

export interface HerdrAgentSnapshot {
  agent: string;
  state: TargetState;
  paneId: string;
  sessionPath?: string;
  stateChangeSequence?: number;
}

export interface JournalCursor {
  path: string;
  device: number;
  inode: number;
  offset: number;
}

export interface PendingToolCall {
  id: string;
  tool: string;
  command?: string;
  cwd?: string;
  mutationFingerprintBefore: string;
  validationKey?: string;
  description?: string;
  action?: string;
}

export interface BackgroundAgentRecord {
  id: string;
  description?: string;
  observedAt: string;
}

export interface BackgroundProcessRecord {
  id: string;
  name?: string;
  command: string;
  observedAt: string;
  validationKey?: string;
  mutationFingerprintBefore: string;
  toolCallId: string;
}

export interface ValidationRecord {
  key: string;
  command: string;
  mutationFingerprintBefore: string;
  mutationFingerprintAfter: string;
  passed: boolean;
  completedAt: string;
  toolCallId: string;
}

export interface DurableRunState {
  version: 1;
  runId: string;
  status: RunStatus;
  targetState: TargetState;
  contractDigest: string;
  baselineDigest: string;
  mutationFingerprint: string;
  mutationBatchCount: number;
  journal: JournalCursor;
  pendingTools: Record<string, PendingToolCall>;
  backgroundAgents: Record<string, BackgroundAgentRecord>;
  backgroundProcesses: Record<string, BackgroundProcessRecord>;
  validations: ValidationRecord[];
  validation: ValidationView;
  violations: GateViolation[];
  routeKeys: string[];
  activityObserved: boolean;
  eventSequence: number;
  startedAt: string;
  pausedMilliseconds: number;
  lastMaterialAt: string;
  lastObservedAt?: string;
  waitingSince?: string;
  stoppedAt?: string;
  stopReason?: string;
}
