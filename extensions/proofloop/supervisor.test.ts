import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProofloopSupervisor } from "./supervisor";
import type { RunContract } from "./types";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const supervisors: ProofloopSupervisor[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

function createRepository(): { root: string; head: string } {
  const root = temporaryDirectory("proofloop-repo-");
  git(root, "init");
  git(root, "config", "user.email", "proofloop@example.com");
  git(root, "config", "user.name", "Proofloop Test");
  writeFileSync(join(root, "feature.ts"), "export const value = 1;\n");
  git(root, "add", "feature.ts");
  git(root, "commit", "-m", "initial");
  writeFileSync(join(root, "feature.ts"), "export const value = 2;\n");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

interface HerdrServerController {
  server: Server;
  setState(state: "working" | "blocked" | "idle" | "done" | "unknown"): void;
}

async function createHerdrServer(socketPath: string, sessionPath: string): Promise<HerdrServerController> {
  const subscriptions = new Set<Socket>();
  let agentState: "working" | "blocked" | "idle" | "done" | "unknown" = "working";
  let stateChangeSequence = 1;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      if (request.method === "agent.get") {
        socket.end(`${JSON.stringify({
          id: request.id,
          result: {
            type: "agent_info",
            agent: {
              agent: "pi",
              agent_status: agentState,
              agent_session: { kind: "path", value: sessionPath },
              pane_id: "w-test:p1",
              state_change_seq: stateChangeSequence,
            },
          },
        })}\n`);
        return;
      }
      if (request.method === "events.subscribe") {
        subscriptions.add(socket);
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      }
    });
    socket.on("close", () => subscriptions.delete(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    server,
    setState(state) {
      agentState = state;
      stateChangeSequence += 1;
      const message = `${JSON.stringify({
        event: "pane.agent_status_changed",
        data: {
          pane_id: "w-test:p1",
          workspace_id: "w-test",
          agent: "pi",
          agent_status: state,
        },
      })}\n`;
      for (const socket of subscriptions) socket.write(message);
    },
  };
}

function appendTool(
  sessionPath: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
  isError = false,
): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: args }],
      },
    })}\n`,
  );
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: "" }],
        isError,
      },
    })}\n`,
  );
}

function appendValidation(sessionPath: string, id: string, command = "git diff --check"): void {
  appendTool(sessionPath, id, "bash", { command });
}

function appendBackgroundAgentStart(
  sessionPath: string,
  toolCallId: string,
  agentId: string,
  description: string,
): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "Agent",
            arguments: { run_in_background: true, description },
          },
        ],
      },
    })}\n`,
  );
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "Agent",
        content: [{ type: "text", text: `Agent started in background.\nAgent ID: ${agentId}` }],
        isError: false,
        details: { status: "background", agentId, description },
      },
    })}\n`,
  );
}

function appendBackgroundAgentCompletion(
  sessionPath: string,
  agentId: string,
  description: string,
  status = "completed",
): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "custom",
      customType: "subagents:record",
      data: { id: agentId, description, status },
    })}\n`,
  );
}

function appendBackgroundProcessStart(
  sessionPath: string,
  toolCallId: string,
  processId: string,
  command: string,
  name = "validation",
): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "process",
            arguments: { action: "start", name, command },
          },
        ],
      },
    })}\n`,
  );
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "process",
        content: [{ type: "text", text: `Started process ${name} (${processId})` }],
        isError: false,
        details: {
          action: "start",
          process: { id: processId, name, command, status: "running" },
        },
      },
    })}\n`,
  );
}

function appendBackgroundProcessCompletion(
  sessionPath: string,
  processId: string,
  command: string,
  kind = "success",
  name = "validation",
): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "custom_message",
      customType: "ad-process:notification",
      content: "process completed",
      details: {
        kind,
        processId,
        processName: name,
        command,
        status: kind === "success" ? "exited" : "failed",
        exitCode: kind === "success" ? 0 : 1,
      },
    })}\n`,
  );
}

function appendPendingHumanQuestion(sessionPath: string, toolCallId: string): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "ask_user_question",
            arguments: {
              questions: [
                {
                  header: "Decision",
                  question: "Continue?",
                  options: [
                    { label: "Yes", description: "Continue" },
                    { label: "No", description: "Stop" },
                  ],
                },
              ],
            },
          },
        ],
      },
    })}\n`,
  );
}

function appendHumanAnswer(sessionPath: string, toolCallId: string): void {
  appendFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "ask_user_question",
        content: [{ type: "text", text: "Yes" }],
        isError: false,
      },
    })}\n`,
  );
}

function contract(root: string, head: string, sessionPath: string): RunContract {
  return {
    schemaVersion: 1,
    runId: "pilot-start",
    task: {
      id: "TASK-1",
      goal: "Observe a real implementation",
      ownerTask: "Implement TASK-1",
      requestedAction: "Inspect the evidence and decide the next action.",
    },
    target: {
      kind: "herdr-pane",
      paneId: "w-test:p1",
      expectedAgent: "pi",
      sessionPath,
    },
    git: {
      worktreeRoot: root,
      expectedHead: head,
      allowedPaths: ["feature.ts"],
      forbiddenPaths: [".git", ".env", "node_modules"],
    },
    validation: {
      tool: "bash",
      cwd: root,
      command: "git diff --check",
    },
    budgets: {
      checkpointSeconds: 1200,
      hardStopSeconds: 2700,
      maxMutationBatches: 3,
    },
    routing: {
      mode: "record-only",
      urgency: "high",
    },
  };
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("ProofloopSupervisor", () => {
  test("starts an observation run without changing preexisting worktree dirt", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const before = readFileSync(join(repository.root, "feature.ts"), "utf8");
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);

    const result = await supervisor.start(contract(repository.root, repository.head, sessionPath));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("observing");
    expect(result.value.targetState).toBe("working");
    expect(result.value.baselineDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.evidencePath.startsWith(stateRoot)).toBe(true);
    expect(readdirSync(join(result.value.evidencePath, "blobs"))).toHaveLength(1);
    expect(result.value.gate.violations).toEqual([]);
    expect(readFileSync(join(repository.root, "feature.ts"), "utf8")).toBe(before);
    expect(git(repository.root, "status", "--short")).toBe("M feature.ts");

    await supervisor.shutdown();
  });

  test("starts before a fresh Pi session file is materialized", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "fresh-session.jsonl");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);

    const started = await supervisor.start(contract(repository.root, repository.head, sessionPath));

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.status).toBe("observing");

    appendValidation(sessionPath, "validation-1");
    herdr.setState("done");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.validation).toMatchObject({ observed: true, passed: true });
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("records repeated failing validation when the command and mutation fingerprint do not change", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const started = await supervisor.start(contract(repository.root, repository.head, sessionPath));
    expect(started.ok).toBe(true);

    appendTool(sessionPath, "validation-1", "bash", { command: "git diff --check" }, true);
    const first = await supervisor.check("pilot-start");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.validation).toMatchObject({
      observed: true,
      passed: false,
      repeatedWithoutMutation: false,
    });

    appendTool(sessionPath, "validation-2", "bash", { command: "git diff --check" }, true);
    const second = await supervisor.check("pilot-start");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.validation.repeatedWithoutMutation).toBe(true);
    expect(second.value.gate.violations.map((violation) => violation.code)).toContain("REPEATED_VALIDATION");
    expect(second.value.status).toBe("attention");

    await supervisor.shutdown();
  });

  test("keeps duplicate successful validation idempotent", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));
    appendValidation(sessionPath, "validation-1");
    await supervisor.check("pilot-start");

    appendValidation(sessionPath, "validation-2");
    herdr.setState("done");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.validation).toMatchObject({
      observed: true,
      passed: true,
      repeatedWithoutMutation: false,
    });
    expect(completed.value.gate.violations.map((violation) => violation.code)).not.toContain(
      "REPEATED_VALIDATION",
    );
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("allows the same validation after a real Git mutation", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));

    appendValidation(sessionPath, "validation-1");
    await supervisor.check("pilot-start");
    writeFileSync(join(repository.root, "feature.ts"), "export const value = 3;\n");
    appendTool(sessionPath, "mutation-1", "write", { path: join(repository.root, "feature.ts") });
    const changed = await supervisor.check("pilot-start");
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.mutationBatchCount).toBe(1);
    expect(changed.value.validation.stale).toBe(true);

    appendValidation(sessionPath, "validation-2");
    const validated = await supervisor.check("pilot-start");
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.validation).toMatchObject({
      observed: true,
      passed: true,
      stale: false,
      repeatedWithoutMutation: false,
    });
    expect(validated.value.gate.violations).toEqual([]);

    await supervisor.shutdown();
  });

  test("settles a naturally completed target only after fresh passing validation", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));
    appendValidation(sessionPath, "validation-1");

    herdr.setState("done");
    const result = await supervisor.check("pilot-start");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetState).toBe("done");
    expect(result.value.status).toBe("passed");
    expect(result.value.gate.verdict).toBe("pass");
    expect(result.value.validation).toMatchObject({ observed: true, passed: true, stale: false });

    await supervisor.shutdown();
  });

  test("does not settle a done parent while a background Pi child Agent is running", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));
    appendValidation(sessionPath, "validation-1");
    appendBackgroundAgentStart(sessionPath, "agent-call-1", "agent-1", "Review implementation");

    herdr.setState("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const parentDone = await supervisor.status("pilot-start");

    expect(parentDone.ok).toBe(true);
    if (!parentDone.ok) return;
    expect(parentDone.value.targetState).toBe("done");
    expect(parentDone.value.status).toBe("observing");
    expect(parentDone.value.activeBackgroundAgentCount).toBe(1);

    appendBackgroundAgentCompletion(sessionPath, "agent-1", "Review implementation");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.activeBackgroundAgentCount).toBe(0);
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("adopts a background Pi child Agent already running at attachment", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    appendBackgroundAgentStart(sessionPath, "agent-call-1", "agent-1", "Review implementation");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);

    const started = await supervisor.start(contract(repository.root, repository.head, sessionPath));

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.activeBackgroundAgentCount).toBe(1);

    appendValidation(sessionPath, "validation-1");
    herdr.setState("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const parentDone = await supervisor.status("pilot-start");
    expect(parentDone.ok).toBe(true);
    if (!parentDone.ok) return;
    expect(parentDone.value.status).toBe("observing");

    appendBackgroundAgentCompletion(sessionPath, "agent-1", "Review implementation");
    const completed = await supervisor.check("pilot-start");
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("waits for a background validation process before settling", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const processContract = contract(repository.root, repository.head, sessionPath);
    processContract.validation.tool = "process";
    await supervisor.start(processContract);
    appendBackgroundProcessStart(sessionPath, "process-call-1", "proc-1", "git diff --check");

    herdr.setState("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const parentDone = await supervisor.status("pilot-start");

    expect(parentDone.ok).toBe(true);
    if (!parentDone.ok) return;
    expect(parentDone.value.status).toBe("observing");
    expect(parentDone.value.activeBackgroundProcessCount).toBe(1);
    expect(parentDone.value.validation.observed).toBe(false);

    appendBackgroundProcessCompletion(sessionPath, "proc-1", "git diff --check");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.activeBackgroundProcessCount).toBe(0);
    expect(completed.value.validation).toMatchObject({ observed: true, passed: true, stale: false });
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("adopts a background validation process already running at attachment", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    appendBackgroundProcessStart(sessionPath, "process-call-1", "proc-1", "git diff --check");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const processContract = contract(repository.root, repository.head, sessionPath);
    processContract.validation.tool = "process";

    const started = await supervisor.start(processContract);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.activeBackgroundProcessCount).toBe(1);

    herdr.setState("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const parentDone = await supervisor.status("pilot-start");
    expect(parentDone.ok).toBe(true);
    if (!parentDone.ok) return;
    expect(parentDone.value.status).toBe("observing");

    appendBackgroundProcessCompletion(sessionPath, "proc-1", "git diff --check");
    const completed = await supervisor.check("pilot-start");
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.validation).toMatchObject({ observed: true, passed: true, stale: false });
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("fails settlement when a background validation process fails", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const processContract = contract(repository.root, repository.head, sessionPath);
    processContract.validation.tool = "process";
    await supervisor.start(processContract);
    appendBackgroundProcessStart(sessionPath, "process-call-1", "proc-1", "git diff --check");
    herdr.setState("done");
    await new Promise((resolve) => setTimeout(resolve, 50));

    appendBackgroundProcessCompletion(sessionPath, "proc-1", "git diff --check", "failure");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe("failed");
    expect(completed.value.validation).toMatchObject({ observed: true, passed: false });
    expect(completed.value.gate.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(["BACKGROUND_PROCESS_FAILED", "VALIDATION_FAILED"]),
    );

    await supervisor.shutdown();
  });

  test("clears a failed process finding after a successful named retry", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));
    appendBackgroundProcessStart(
      sessionPath,
      "process-call-1",
      "proc-1",
      "pnpm test",
      "ttpm-3048-clean-full-integration",
    );
    appendBackgroundProcessCompletion(
      sessionPath,
      "proc-1",
      "pnpm test",
      "failure",
      "ttpm-3048-clean-full-integration",
    );
    await supervisor.check("pilot-start");

    appendBackgroundProcessStart(
      sessionPath,
      "process-call-2",
      "proc-2",
      "pnpm test",
      "ttpm-3048-clean-full-integration-2",
    );
    appendBackgroundProcessCompletion(
      sessionPath,
      "proc-2",
      "pnpm test",
      "success",
      "ttpm-3048-clean-full-integration-2",
    );
    appendValidation(sessionPath, "validation-1");
    herdr.setState("done");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.gate.violations.map((violation) => violation.code)).not.toContain(
      "BACKGROUND_PROCESS_FAILED",
    );
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("accepts a direct process lifecycle event before journal persistence", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const processContract = contract(repository.root, repository.head, sessionPath);
    processContract.validation.tool = "process";
    await supervisor.start(processContract);
    appendBackgroundProcessStart(sessionPath, "process-call-1", "proc-1", "git diff --check");
    await supervisor.check("pilot-start");

    await supervisor.observeProcessLifecycle({
      kind: "success",
      processId: "proc-1",
      processName: "validation",
      command: "git diff --check",
      exitCode: 0,
    });
    herdr.setState("done");
    const completed = await supervisor.check("pilot-start");

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.activeBackgroundProcessCount).toBe(0);
    expect(completed.value.validation).toMatchObject({ observed: true, passed: true });
    expect(completed.value.status).toBe("passed");

    await supervisor.shutdown();
  });

  test("pauses checkpoint and hard-stop budgets while waiting for a user answer", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const waitingContract = contract(repository.root, repository.head, sessionPath);
    waitingContract.budgets.checkpointSeconds = 0.03;
    waitingContract.budgets.hardStopSeconds = 0.05;
    await supervisor.start(waitingContract);

    appendPendingHumanQuestion(sessionPath, "question-1");
    await supervisor.check("pilot-start");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waiting = await supervisor.status("pilot-start");

    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.value.status).toBe("waiting");
    expect(waiting.value.gate.violations.map((violation) => violation.code)).not.toEqual(
      expect.arrayContaining(["CHECKPOINT_MISSED", "DEADLINE_EXCEEDED"]),
    );

    appendHumanAnswer(sessionPath, "question-1");
    const resumed = await supervisor.check("pilot-start");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.status).toBe("observing");

    await supervisor.shutdown();
  });

  test("observes repeated failing validation from session file events while the target is working", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));

    appendTool(sessionPath, "validation-1", "bash", { command: "git diff --check" }, true);
    appendTool(sessionPath, "validation-2", "bash", { command: "git diff --check" }, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await supervisor.status("pilot-start");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.repeatedWithoutMutation).toBe(true);
    expect(result.value.gate.violations.map((violation) => violation.code)).toContain("REPEATED_VALIDATION");

    await supervisor.shutdown();
  });

  test("performs a final observation before stopping an active run", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));
    appendValidation(sessionPath, "validation-1");

    const result = await supervisor.stop("pilot-start", "Pilot complete");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("stopped");
    expect(result.value.validation).toMatchObject({ observed: true, passed: true, stale: false });

    await supervisor.shutdown();
  });

  test("records one Root route when the Herdr target becomes blocked", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    const herdr = await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const started = await supervisor.start(contract(repository.root, repository.head, sessionPath));
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    herdr.setState("blocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const blocked = await supervisor.status("pilot-start");
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.value.targetState).toBe("blocked");
    expect(blocked.value.status).toBe("attention");
    expect(blocked.value.gate.violations.map((violation) => violation.code)).toContain("TARGET_BLOCKED");

    herdr.setState("blocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const routes = readFileSync(join(started.value.evidencePath, "routes.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(routes).toHaveLength(1);

    herdr.setState("working");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recovered = await supervisor.status("pilot-start");
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.status).toBe("observing");
    expect(recovered.value.gate.violations).toEqual([]);

    await supervisor.shutdown();
  });

  test("attributes only post-baseline out-of-scope and forbidden changes to the run", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));

    writeFileSync(join(repository.root, "outside.ts"), "export const outside = true;\n");
    writeFileSync(join(repository.root, ".env"), "SECRET=value\n");
    appendTool(sessionPath, "mutation-1", "write", { path: join(repository.root, "outside.ts") });
    const result = await supervisor.check("pilot-start");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gate.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OUT_OF_SCOPE_WRITE", path: "outside.ts" }),
        expect.objectContaining({ code: "FORBIDDEN_WRITE", path: ".env" }),
      ]),
    );

    await supervisor.shutdown();
  });

  test("captures mutations completed by a tool that was already running at attachment", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    await supervisor.start(contract(repository.root, repository.head, sessionPath));

    writeFileSync(join(repository.root, "feature.ts"), "export const value = 4;\n");
    appendFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "started-before-attachment",
          toolName: "Agent",
          content: [{ type: "text", text: "completed" }],
          isError: false,
        },
      })}\n`,
    );
    const result = await supervisor.check("pilot-start");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mutationBatchCount).toBe(1);
    expect(result.value.mutationFingerprint).not.toBe(result.value.baselineDigest);

    await supervisor.shutdown();
  });

  test("fails the observation run when its hard-stop deadline elapses", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);
    const deadlineContract = contract(repository.root, repository.head, sessionPath);
    deadlineContract.budgets.hardStopSeconds = 0.05;
    await supervisor.start(deadlineContract);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await supervisor.status("pilot-start");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.gate.violations.map((violation) => violation.code)).toContain("DEADLINE_EXCEEDED");

    await supervisor.shutdown();
  });

  test("refuses to archive a forbidden dirty path", async () => {
    const repository = createRepository();
    const stateRoot = temporaryDirectory("proofloop-state-");
    const socketDirectory = temporaryDirectory("proofloop-socket-");
    const socketPath = join(socketDirectory, "herdr.sock");
    const sessionPath = join(stateRoot, "session.jsonl");
    writeFileSync(sessionPath, "");
    writeFileSync(join(repository.root, ".env"), "SECRET=value\n");
    await createHerdrServer(socketPath, sessionPath);
    const supervisor = new ProofloopSupervisor({ evidenceRoot: stateRoot, herdrSocketPath: socketPath });
    supervisors.push(supervisor);

    const result = await supervisor.start(contract(repository.root, repository.head, sessionPath));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "DIRTY_FORBIDDEN_PATH",
        message: "Cannot capture forbidden dirty path: .env",
      },
    });

    await supervisor.shutdown();
  });
});
