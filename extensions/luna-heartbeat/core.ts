import { createHash } from "node:crypto";

export type ObservationState =
  | "healthy"
  | "attention"
  | "stalled"
  | "deadline-risk"
  | "terminal"
  | "unknown";

export type Urgency = "low" | "normal" | "high" | "critical";

export interface MonitorConditions {
  healthyPattern?: string;
  attentionPattern?: string;
  stalledPattern?: string;
  terminalPattern?: string;
}

export interface MonitorConfig {
  id: string;
  workItem: string;
  statusSource: string;
  responsibleAgentId?: string;
  responsibleTask: string;
  executable: string;
  args: string[];
  cwd: string;
  cadenceSeconds: number;
  timeoutSeconds: number;
  acceptedExitCodes: number[];
  conditions: MonitorConditions;
  requestedAction: string;
  urgency: Urgency;
  deadline?: string;
  deadlineRiskSeconds: number;
  notifyOnRecovery: boolean;
}

export interface MonitorRecord extends MonitorConfig {
  paused: boolean;
  state?: ObservationState;
  reason?: string;
  evidence?: string;
  lastCheckedAt?: string;
  lastAlertKey?: string;
}

export interface CommandObservation {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface Classification {
  state: ObservationState;
  reason: string;
  evidence: string;
  transitionKey: string;
}

const ACTIONABLE_STATES = new Set<ObservationState>([
  "attention",
  "stalled",
  "deadline-risk",
  "terminal",
]);

const SIMPLE_READ_ONLY_EXECUTABLES = new Set([
  "cat",
  "grep",
  "head",
  "jq",
  "ls",
  "pgrep",
  "printf",
  "ps",
  "rg",
  "stat",
  "test",
]);

export function validateStatusCommand(executable: string, args: string[]): string | undefined {
  const name = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (SIMPLE_READ_ONLY_EXECUTABLES.has(name)) return undefined;

  if (name === "find") {
    const unsafe = args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg));
    return unsafe ? "find mutation and execution flags are not allowed" : undefined;
  }

  if (name === "tail") {
    return args.some((arg) => arg === "-f" || arg === "--follow")
      ? "tail follow mode belongs in the process tool"
      : undefined;
  }
  if (name === "git") return validateGitArgs(args);
  if (name === "gh") return validateGitHubArgs(args);
  if (name === "kubectl") return validateKubectlArgs(args);
  if (name === "docker") return validateDockerArgs(args);

  return `executable "${executable}" is not in the read-only status allowlist`;
}

export function validatePatterns(conditions: MonitorConditions): string | undefined {
  for (const [name, pattern] of Object.entries(conditions)) {
    if (!pattern) continue;
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      return `${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

export function classifyObservation(
  config: MonitorConfig,
  observation: CommandObservation,
  now = new Date(),
): Classification {
  const evidence = normalizeEvidence(observation.stdout, observation.stderr);
  const searchable = `${observation.stdout}\n${observation.stderr}`;

  if (observation.killed) {
    return classification("attention", "status check timed out or was killed", evidence);
  }
  if (!config.acceptedExitCodes.includes(observation.code)) {
    return classification("attention", `status check exited with code ${observation.code}`, evidence);
  }

  const attention = matchingLine(config.conditions.attentionPattern, searchable);
  if (attention) return classification("attention", `attention condition: ${attention}`, evidence);

  const stalled = matchingLine(config.conditions.stalledPattern, searchable);
  if (stalled) return classification("stalled", `verified stall: ${stalled}`, evidence);

  const terminal = matchingLine(config.conditions.terminalPattern, searchable);
  if (terminal) return classification("terminal", `terminal condition: ${terminal}`, evidence);

  if (isDeadlineRisk(config, now)) {
    return classification("deadline-risk", `deadline risk: ${config.deadline}`, evidence);
  }

  const healthyPattern = config.conditions.healthyPattern;
  if (!healthyPattern) return classification("healthy", "status check succeeded", evidence);

  const healthy = matchingLine(healthyPattern, searchable);
  if (healthy) return classification("healthy", `healthy condition: ${healthy}`, evidence);

  return classification("unknown", "no declared condition matched", evidence);
}

export function shouldAlert(
  previousState: ObservationState | undefined,
  next: Classification,
  lastAlertKey: string | undefined,
  notifyOnRecovery: boolean,
): boolean {
  if (ACTIONABLE_STATES.has(next.state)) {
    return previousState !== next.state || next.transitionKey !== lastAlertKey;
  }

  const recovered =
    notifyOnRecovery &&
    previousState !== undefined &&
    ACTIONABLE_STATES.has(previousState) &&
    next.state === "healthy";

  return recovered && next.transitionKey !== lastAlertKey;
}

export function isActionableState(state: ObservationState | undefined): boolean {
  return state !== undefined && ACTIONABLE_STATES.has(state);
}

export function normalizeEvidence(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!combined) return "No output.";

  const redacted = combined
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]");
  const tail = redacted.split("\n").slice(-20).join("\n");
  if (tail.length <= 2_000) return tail;
  return tail.slice(-2_000);
}

function classification(
  state: ObservationState,
  reason: string,
  evidence: string,
): Classification {
  return {
    state,
    reason,
    evidence,
    transitionKey: createHash("sha256").update(`${state}\0${reason}`).digest("hex").slice(0, 16),
  };
}

function matchingLine(pattern: string | undefined, text: string): string | undefined {
  if (!pattern) return undefined;
  const expression = new RegExp(pattern, "i");
  const line = text.split("\n").find((candidate) => expression.test(candidate));
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed.length <= 400 ? trimmed : `${trimmed.slice(0, 397)}...`;
}

function isDeadlineRisk(config: MonitorConfig, now: Date): boolean {
  if (!config.deadline) return false;
  const deadline = Date.parse(config.deadline);
  if (!Number.isFinite(deadline)) return false;
  return deadline - now.getTime() <= config.deadlineRiskSeconds * 1_000;
}

function validateGitArgs(args: string[]): string | undefined {
  const command = args.find((arg) => !arg.startsWith("-"));
  const allowed = new Set([
    "describe",
    "diff",
    "log",
    "ls-files",
    "rev-parse",
    "show",
    "status",
  ]);
  if (command && allowed.has(command)) return undefined;
  if (command === "branch" && args.some((arg) => ["--list", "--show-current"].includes(arg))) {
    return undefined;
  }
  return `git subcommand "${command ?? ""}" is not allowed for status checks`;
}

function validateGitHubArgs(args: string[]): string | undefined {
  const [group, command] = args.filter((arg) => !arg.startsWith("-"));
  const allowed =
    (group === "run" && ["list", "view"].includes(command ?? "")) ||
    (group === "pr" && ["checks", "list", "status", "view"].includes(command ?? ""));
  if (allowed) return undefined;
  if (group !== "api") return `gh command "${group ?? ""} ${command ?? ""}" is not read-only`;

  const mutatingFlags = ["--field", "--input", "--method", "--raw-field", "-F", "-X", "-f"];
  const mutating = args.some((arg) =>
    mutatingFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)) ||
    /^-[FfX].+/.test(arg),
  );
  if (mutating) return "gh api status checks must use the default GET without request fields";
  return undefined;
}

function validateKubectlArgs(args: string[]): string | undefined {
  const command = args.find((arg) => !arg.startsWith("-"));
  if (command === "logs" && args.some((arg) => arg === "-f" || arg === "--follow")) {
    return "kubectl logs follow mode belongs in the process tool";
  }
  const allowed = new Set(["describe", "get", "logs", "version"]);
  if (command && allowed.has(command)) return undefined;
  if (command === "cluster-info") return undefined;
  if (command === "auth" && args.includes("can-i")) return undefined;
  return `kubectl subcommand "${command ?? ""}" is not allowed for status checks`;
}

function validateDockerArgs(args: string[]): string | undefined {
  const command = args.find((arg) => !arg.startsWith("-"));
  if (command === "logs" && args.some((arg) => arg === "-f" || arg === "--follow")) {
    return "docker logs follow mode belongs in the process tool";
  }
  if (command === "stats") {
    return args.includes("--no-stream")
      ? undefined
      : "docker stats status checks require --no-stream";
  }
  const allowed = new Set(["info", "inspect", "logs", "ps", "version"]);
  return command && allowed.has(command)
    ? undefined
    : `docker subcommand "${command ?? ""}" is not allowed for status checks`;
}

