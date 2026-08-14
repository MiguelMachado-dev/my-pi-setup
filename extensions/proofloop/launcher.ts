import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { sha256 } from "./canonical";
import type { Outcome, RunContract, RunView } from "./types";

const execFileAsync = promisify(execFile);
const FINAL_VALIDATION_COMMAND = "git diff --check";
const FORBIDDEN_PATHS = [
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  "node_modules",
];

export interface ProofrunWorkspace {
  root: string;
  head: string;
  allowedPaths: string[];
}

export interface ProofrunGitInspector {
  inspect(cwd: string): Promise<ProofrunWorkspace>;
}

export interface ProofrunSupervisor {
  start(contract: RunContract): Promise<Outcome<RunView>>;
  stop(runId: string, reason: string): Promise<Outcome<RunView>>;
}

export interface ProofrunLaunchRequest {
  task: string;
  cwd: string;
  paneId: string;
  sessionPath: string;
}

export interface ProofrunLaunchResult {
  contract: RunContract;
  prompt: string;
  run: RunView;
}

export type ProofrunLaunchErrorCode =
  | "INPUT_REQUIRED"
  | "CONTEXT_INVALID"
  | "WORKTREE_INVALID"
  | "START_FAILED"
  | "DISPATCH_FAILED";

export type ProofrunLaunchOutcome =
  | { ok: true; value: ProofrunLaunchResult }
  | {
      ok: false;
      error: {
        code: ProofrunLaunchErrorCode;
        message: string;
      };
    };

export interface ProofrunLauncherOptions {
  git: ProofrunGitInspector;
  supervisor: ProofrunSupervisor;
  dispatch(prompt: string): void | Promise<void>;
  now?: () => Date;
  nonce?: () => string;
}

export class ProofrunLauncher {
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(private readonly options: ProofrunLauncherOptions) {
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID;
  }

  async launch(request: ProofrunLaunchRequest): Promise<ProofrunLaunchOutcome> {
    const task = request.task.trim();
    if (!task) return launchFailure("INPUT_REQUIRED", "Usage: /proofrun <task-id or task description>");
    if (!request.paneId.trim() || !request.sessionPath.trim()) {
      return launchFailure("CONTEXT_INVALID", "Proofrun requires a persisted Pi session inside Herdr");
    }

    let workspace: ProofrunWorkspace;
    try {
      workspace = await this.options.git.inspect(request.cwd);
    } catch (error) {
      return launchFailure("WORKTREE_INVALID", errorMessage(error));
    }
    if (workspace.allowedPaths.length === 0) {
      return launchFailure("WORKTREE_INVALID", "The Git worktree has no policy roots to supervise");
    }

    const contract = buildContract(request, workspace, task, this.now(), this.nonce());
    const started = await this.options.supervisor.start(contract);
    if (!started.ok) {
      return launchFailure("START_FAILED", `${started.error.code}: ${started.error.message}`);
    }

    const prompt = buildWriterPrompt(contract, task);
    try {
      await this.options.dispatch(prompt);
    } catch (error) {
      await this.options.supervisor.stop(contract.runId, "Proofrun could not dispatch the writer task");
      return launchFailure("DISPATCH_FAILED", errorMessage(error));
    }

    return { ok: true, value: { contract, prompt, run: started.value } };
  }
}

export class GitProofrunInspector implements ProofrunGitInspector {
  async inspect(cwd: string): Promise<ProofrunWorkspace> {
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const head = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    const trackedRoots = splitNull(await runGit(root, ["ls-tree", "--name-only", "-z", "HEAD"]));
    const untrackedPaths = splitNull(
      await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    const allowedPaths = [...new Set([...trackedRoots, ...untrackedPaths.map(topLevelPath)])]
      .filter(Boolean)
      .sort();
    return { root, head, allowedPaths };
  }
}

function buildContract(
  request: ProofrunLaunchRequest,
  workspace: ProofrunWorkspace,
  task: string,
  now: Date,
  nonce: string,
): RunContract {
  const taskId = taskIdentifier(task);
  const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = sha256(`${request.sessionPath}:${task}:${now.toISOString()}:${nonce}`).slice(0, 8);
  const runId = `${taskId.toLowerCase()}-${timestamp}-${suffix}`.slice(0, 96);
  return {
    schemaVersion: 1,
    runId,
    task: {
      id: taskId,
      goal: task,
      ownerTask: `Complete ${taskId}`,
      requestedAction: "Inspect Proofloop evidence and decide the next action. Never retry automatically.",
    },
    target: {
      kind: "herdr-pane",
      paneId: request.paneId,
      expectedAgent: "pi",
      sessionPath: request.sessionPath,
    },
    git: {
      worktreeRoot: workspace.root,
      expectedHead: workspace.head,
      allowedPaths: workspace.allowedPaths,
      forbiddenPaths: FORBIDDEN_PATHS,
    },
    validation: {
      tool: "bash",
      cwd: workspace.root,
      command: FINAL_VALIDATION_COMMAND,
    },
    budgets: {
      checkpointSeconds: 600,
      hardStopSeconds: 14_400,
      maxMutationBatches: 100,
    },
    routing: {
      mode: "record-only",
      urgency: "high",
    },
  };
}

function buildWriterPrompt(contract: RunContract, task: string): string {
  const jiraInstruction = /\b[A-Z][A-Z0-9]+-\d+\b/i.test(task)
    ? "Read the Jira task and its parent before implementation."
    : "Treat the supplied description as the complete task request.";
  return [
    `Complete this supervised task: ${task}`,
    jiraInstruction,
    `Work only in ${contract.git.worktreeRoot}. Do not switch to another checkout or worktree.`,
    "Follow the repository instructions, keep unrelated dirty state intact, and run task-specific tests.",
    `After every final mutation, invoke the bash tool from the worktree root with exactly this command and no wrapper: ${contract.validation.command}`,
    "Do not claim completion until that exact final validation passes after the last mutation.",
    `Proofloop run: ${contract.runId}. It is observation-only and never retries automatically.`,
  ].join("\n\n");
}

function taskIdentifier(task: string): string {
  const jira = task.match(/\b([A-Za-z][A-Za-z0-9]+-\d+)\b/)?.[1];
  if (jira) return jira.toUpperCase();
  return `task-${sha256(task).slice(0, 10)}`;
}

function topLevelPath(path: string): string {
  return path.replace(/^\.\//, "").split("/")[0] ?? "";
}

function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(result.stdout);
}

function launchFailure(
  code: ProofrunLaunchErrorCode,
  message: string,
): ProofrunLaunchOutcome {
  return { ok: false, error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
