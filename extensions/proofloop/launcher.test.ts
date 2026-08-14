import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitProofrunInspector,
  ProofrunLauncher,
  type ProofrunSupervisor,
} from "./launcher";
import type { Outcome, RunContract, RunView } from "./types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProofrunLauncher", () => {
  test("captures the run before dispatching the task to the same pane", async () => {
    const events: string[] = [];
    let capturedContract: RunContract | undefined;
    const supervisor = supervisorStub({
      start: async (contract) => {
        capturedContract = contract;
        events.push("start");
        return { ok: true, value: runView(contract.runId) };
      },
    });
    const launcher = new ProofrunLauncher({
      git: {
        inspect: async () => {
          events.push("git");
          return {
            root: "/repo/task",
            head: "a".repeat(40),
            allowedPaths: ["apps", "libs", "package.json"],
          };
        },
      },
      supervisor,
      dispatch: async (prompt) => {
        events.push("dispatch");
        expect(capturedContract).toBeDefined();
        expect(prompt).toContain("Complete this supervised task: TTPM-3048");
        expect(prompt).toContain("git diff --check");
      },
      now: () => new Date("2026-08-12T10:11:12.000Z"),
    });

    const result = await launcher.launch({
      task: "TTPM-3048",
      cwd: "/repo/task/apps/api",
      paneId: "w8:p2",
      sessionPath: "/sessions/task.jsonl",
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(["git", "start", "dispatch"]);
    expect(capturedContract?.runId).toMatch(/^ttpm-3048-20260812101112-[a-f0-9]{8}$/);
    expect(capturedContract).toMatchObject({
      task: { id: "TTPM-3048" },
      target: { paneId: "w8:p2", sessionPath: "/sessions/task.jsonl" },
      git: {
        worktreeRoot: "/repo/task",
        expectedHead: "a".repeat(40),
        allowedPaths: ["apps", "libs", "package.json"],
      },
      validation: {
        tool: "bash",
        cwd: "/repo/task",
        command: "git diff --check",
      },
      routing: { mode: "record-only" },
    });
  });

  test("extracts a Jira key embedded in natural-language instructions", async () => {
    let capturedContract: RunContract | undefined;
    const launcher = new ProofrunLauncher({
      git: workspaceInspector(),
      supervisor: supervisorStub({
        start: async (contract) => {
          capturedContract = contract;
          return { ok: true, value: runView(contract.runId) };
        },
      }),
      dispatch: () => {},
    });

    const result = await launcher.launch({
      ...validRequest(),
      task: "Continue a TTPM-3048: finalize o suporte de staging",
    });

    expect(result.ok).toBe(true);
    expect(capturedContract?.task.id).toBe("TTPM-3048");
    expect(capturedContract?.runId).toStartWith("ttpm-3048-");
  });

  test("does not inspect or dispatch an empty task", async () => {
    let inspected = false;
    let dispatched = false;
    const launcher = new ProofrunLauncher({
      git: {
        inspect: async () => {
          inspected = true;
          throw new Error("unexpected");
        },
      },
      supervisor: supervisorStub(),
      dispatch: () => {
        dispatched = true;
      },
    });

    const result = await launcher.launch({
      task: "   ",
      cwd: "/repo",
      paneId: "w1:p1",
      sessionPath: "/sessions/task.jsonl",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INPUT_REQUIRED", message: "Usage: /proofrun <task-id or task description>" },
    });
    expect(inspected).toBe(false);
    expect(dispatched).toBe(false);
  });

  test("never dispatches when Proofloop cannot capture the baseline", async () => {
    let dispatched = false;
    const launcher = new ProofrunLauncher({
      git: workspaceInspector(),
      supervisor: supervisorStub({
        start: async () => ({
          ok: false,
          error: { code: "BASELINE_UNSTABLE", message: "baseline changed" },
        }),
      }),
      dispatch: () => {
        dispatched = true;
      },
    });

    const result = await launcher.launch(validRequest());

    expect(result).toEqual({
      ok: false,
      error: { code: "START_FAILED", message: "BASELINE_UNSTABLE: baseline changed" },
    });
    expect(dispatched).toBe(false);
  });

  test("stops the observer when task dispatch fails", async () => {
    const events: string[] = [];
    let startedRunId = "";
    const supervisor = supervisorStub({
      start: async (contract) => {
        startedRunId = contract.runId;
        events.push("start");
        return { ok: true, value: runView(contract.runId) };
      },
      stop: async (runId) => {
        events.push(`stop:${runId}`);
        return { ok: true, value: { ...runView(runId), status: "stopped" } };
      },
    });
    const launcher = new ProofrunLauncher({
      git: workspaceInspector(),
      supervisor,
      dispatch: () => {
        events.push("dispatch");
        throw new Error("message rejected");
      },
    });

    const result = await launcher.launch(validRequest());

    expect(result).toEqual({
      ok: false,
      error: { code: "DISPATCH_FAILED", message: "message rejected" },
    });
    expect(events).toEqual(["start", "dispatch", `stop:${startedRunId}`]);
  });
});

describe("GitProofrunInspector", () => {
  test("derives policy roots from tracked and preexisting untracked paths", async () => {
    const root = temporaryDirectory();
    git(root, ["init"]);
    git(root, ["config", "user.email", "proofrun@example.com"]);
    git(root, ["config", "user.name", "Proofrun"]);
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "apps", "api", "index.ts"), "export {};\n");
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "baseline"]);
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "draft.md"), "draft\n");

    const workspace = await new GitProofrunInspector().inspect(join(root, "apps", "api"));

    expect(workspace.root).toBe(realpathSync(root));
    expect(workspace.head).toMatch(/^[a-f0-9]{40}$/);
    expect(workspace.allowedPaths).toEqual([".github", "apps", "notes", "package.json"]);
  });
});

function supervisorStub(
  overrides: Partial<ProofrunSupervisor> = {},
): ProofrunSupervisor {
  return {
    start: overrides.start ?? (async (contract) => ({ ok: true, value: runView(contract.runId) })),
    stop:
      overrides.stop ??
      (async (runId) => ({ ok: true, value: { ...runView(runId), status: "stopped" } })),
  };
}

function workspaceInspector() {
  return {
    inspect: async () => ({
      root: "/repo",
      head: "b".repeat(40),
      allowedPaths: ["src"],
    }),
  };
}

function validRequest() {
  return {
    task: "TTPM-3048",
    cwd: "/repo",
    paneId: "w1:p1",
    sessionPath: "/sessions/task.jsonl",
  };
}

function runView(runId: string): RunView {
  return {
    runId,
    status: "observing",
    targetState: "idle",
    contractDigest: "contract",
    baselineDigest: "baseline",
    mutationFingerprint: "baseline",
    mutationBatchCount: 0,
    activeBackgroundAgentCount: 0,
    activeBackgroundProcessCount: 0,
    validation: {
      observed: false,
      stale: false,
      repeatedWithoutMutation: false,
    },
    gate: { verdict: "pending", violations: [] },
    evidencePath: `/evidence/${runId}`,
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "proofrun-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
