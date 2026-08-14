import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { digestValue, isPathInside, normalizeCommand } from "./canonical";
import { EvidenceStore } from "./evidence";
import { GitObserver, GitObserverError } from "./git";
import { HerdrObserver, type HerdrSubscription } from "./herdr";
import { JournalObserverError, PiJournalObserver } from "./journal";
import type {
  DurableRunState,
  GateViolationCode,
  GitBaseline,
  Outcome,
  ProofloopError,
  RunContract,
  RunView,
} from "./types";

export interface ProofloopSupervisorOptions {
  evidenceRoot: string;
  herdrSocketPath: string;
  onStateChange?: (view: RunView) => void;
}

export interface ProcessLifecycleEvent {
  kind: "success" | "failure" | "crash" | "killed";
  processId: string;
  processName?: string;
  command?: string;
  exitCode?: number | null;
}

interface ActiveRun {
  contract: RunContract;
  baseline: GitBaseline;
  state: DurableRunState;
  evidencePath: string;
  subscription: HerdrSubscription;
  watcher?: FSWatcher;
  checkpointTimer?: ReturnType<typeof setInterval>;
  hardStopTimer?: ReturnType<typeof setTimeout>;
  observation?: Promise<void>;
  observationPending?: boolean;
}

export class ProofloopSupervisor {
  private readonly evidence: EvidenceStore;
  private readonly git = new GitObserver();
  private readonly herdr: HerdrObserver;
  private readonly journal = new PiJournalObserver();
  private readonly onStateChange?: (view: RunView) => void;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(options: ProofloopSupervisorOptions) {
    this.evidence = new EvidenceStore(options.evidenceRoot);
    this.herdr = new HerdrObserver(options.herdrSocketPath);
    this.onStateChange = options.onStateChange;
  }

  async start(contract: RunContract): Promise<Outcome<RunView>> {
    const validationError = validateContract(contract);
    if (validationError) return failure("CONTRACT_INVALID", validationError);
    if (this.runs.has(contract.runId) || this.evidence.exists(contract.runId)) {
      return failure("RUN_EXISTS", `Run already exists: ${contract.runId}`);
    }

    let subscription: HerdrSubscription | undefined;
    let evidenceCreated = false;
    let pendingHint = false;
    try {
      subscription = await this.herdr.subscribe(
        contract.target.paneId,
        () => {
          if (!this.runs.has(contract.runId)) {
            pendingHint = true;
            return;
          }
          this.requestObservation(contract.runId);
        },
        (error) => this.recordObserverFailure(contract.runId, error),
      );
      const agent = await this.herdr.getAgent(contract.target.paneId);
      if (agent.paneId !== contract.target.paneId || agent.agent !== contract.target.expectedAgent) {
        subscription.close();
        return failure("TARGET_NOT_FOUND", `Herdr target identity did not match ${contract.target.paneId}`);
      }
      if (agent.sessionPath !== contract.target.sessionPath) {
        subscription.close();
        return failure("TARGET_SESSION_MISMATCH", "Herdr target session did not match the contract");
      }

      const captured = await this.git.captureBracketedBaseline(
        contract.git.worktreeRoot,
        contract.git.expectedHead,
        async () => this.journal.captureWatermark(contract.target.sessionPath),
      );
      const baseline = captured.baseline;
      const sessionWatermark = captured.watermark;
      if (!sessionWatermark.isFile) {
        subscription.close();
        return failure("SESSION_INVALID", `Session is not a file: ${contract.target.sessionPath}`);
      }
      const forbiddenBaselinePath = Object.keys(baseline.entries).find((path) =>
        contract.git.forbiddenPaths.some((parent) => isPathInside(path, parent)),
      );
      if (forbiddenBaselinePath) {
        subscription.close();
        return failure(
          "DIRTY_FORBIDDEN_PATH",
          `Cannot capture forbidden dirty path: ${forbiddenBaselinePath}`,
        );
      }

      const contractDigest = digestValue(contract);
      const now = new Date().toISOString();
      const backgroundProcesses = Object.fromEntries(
        Object.entries(sessionWatermark.backgroundProcesses).map(([processId, process]) => [
          processId,
          {
            ...process,
            mutationFingerprintBefore: baseline.digest,
            validationKey: validationKeyFor(contract, "process", process.command),
          },
        ]),
      );
      const state: DurableRunState = {
        version: 1,
        runId: contract.runId,
        status: "observing",
        targetState: agent.state,
        contractDigest,
        baselineDigest: baseline.digest,
        mutationFingerprint: baseline.digest,
        mutationBatchCount: 0,
        journal: sessionWatermark.cursor,
        pendingTools: {},
        backgroundAgents: sessionWatermark.backgroundAgents,
        backgroundProcesses,
        validations: [],
        validation: {
          observed: false,
          stale: false,
          repeatedWithoutMutation: false,
        },
        violations: [],
        routeKeys: [],
        activityObserved: false,
        eventSequence: 1,
        startedAt: now,
        pausedMilliseconds: 0,
        lastMaterialAt: now,
        lastObservedAt: now,
      };
      const evidencePath = this.evidence.create(contract.runId);
      evidenceCreated = true;
      this.evidence.archiveBaseline(contract.runId, contract.git.worktreeRoot, baseline);
      this.evidence.writeJson(contract.runId, "contract.json", contract);
      this.evidence.writeJson(contract.runId, "baseline.json", baseline);
      this.evidence.writeJson(contract.runId, "state.json", state);
      this.evidence.appendJson(contract.runId, "events.jsonl", {
        sequence: 1,
        type: "run-started",
        observedAt: now,
        targetState: agent.state,
        baselineDigest: baseline.digest,
        activeBackgroundAgentCount: Object.keys(state.backgroundAgents).length,
        activeBackgroundProcessCount: Object.keys(state.backgroundProcesses).length,
      });

      const run: ActiveRun = { contract, baseline, state, evidencePath, subscription };
      const sessionName = basename(contract.target.sessionPath);
      run.watcher = watch(dirname(contract.target.sessionPath), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== sessionName) return;
        this.requestObservation(contract.runId);
      });
      run.watcher.on("error", (error) => this.recordObserverFailure(contract.runId, error));
      run.checkpointTimer = setInterval(
        () => this.handleCheckpoint(contract.runId),
        contract.budgets.checkpointSeconds * 1_000,
      );
      run.checkpointTimer.unref?.();
      run.hardStopTimer = setTimeout(
        () => this.handleHardStop(contract.runId),
        contract.budgets.hardStopSeconds * 1_000,
      );
      run.hardStopTimer.unref?.();
      this.runs.set(contract.runId, run);
      this.requestObservation(contract.runId);
      if (pendingHint) this.requestObservation(contract.runId);
      return success(toView(run));
    } catch (error) {
      subscription?.close();
      if (evidenceCreated && !this.runs.has(contract.runId)) this.evidence.remove(contract.runId);
      return failureFromError(error);
    }
  }

  async status(runId: string): Promise<Outcome<RunView>> {
    const run = this.runs.get(runId);
    if (!run) return failure("RUN_NOT_FOUND", `Run not found: ${runId}`);
    return success(toView(run));
  }

  async check(runId: string): Promise<Outcome<RunView>> {
    const run = this.runs.get(runId);
    if (!run) return failure("RUN_NOT_FOUND", `Run not found: ${runId}`);
    if (isTerminal(run.state.status)) return success(toView(run));
    try {
      await this.observe(runId);
      return success(toView(run));
    } catch (error) {
      if (error instanceof JournalObserverError) {
        this.failRun(run, "OBSERVER_ERROR", `${error.code}: ${error.message}`);
        return success(toView(run));
      }
      return failureFromError(error);
    }
  }

  async observeProcessLifecycle(event: ProcessLifecycleEvent): Promise<void> {
    for (const run of this.runs.values()) {
      if (isTerminal(run.state.status) || !run.state.backgroundProcesses[event.processId]) continue;
      await this.processBackgroundProcessRecord(run, { ...event });
      this.persistState(run);
      this.settleIfReady(run);
    }
  }

  async stop(runId: string, reason: string): Promise<Outcome<RunView>> {
    const run = this.runs.get(runId);
    if (!run) return failure("RUN_NOT_FOUND", `Run not found: ${runId}`);
    await this.observe(runId);
    if (isTerminal(run.state.status)) return success(toView(run));
    this.closeRunResources(run);
    run.state.status = "stopped";
    run.state.stoppedAt = new Date().toISOString();
    run.state.stopReason = reason;
    run.state.eventSequence += 1;
    this.persistState(run);
    this.evidence.appendJson(runId, "events.jsonl", {
      sequence: run.state.eventSequence,
      type: "run-stopped",
      observedAt: run.state.stoppedAt,
      reason,
    });
    return success(toView(run));
  }

  async shutdown(): Promise<void> {
    for (const run of this.runs.values()) this.closeRunResources(run);
    this.runs.clear();
  }

  private requestObservation(runId: string): void {
    void this.observe(runId).catch((error) => {
      this.recordObserverFailure(runId, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async observe(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.state.status)) return;
    if (run.observation) {
      run.observationPending = true;
      await run.observation;
      return;
    }
    run.observation = this.drainObservations(run);
    try {
      await run.observation;
    } finally {
      run.observation = undefined;
    }
  }

  private async drainObservations(run: ActiveRun): Promise<void> {
    do {
      run.observationPending = false;
      await this.performObservation(run);
    } while (run.observationPending && !isTerminal(run.state.status));
  }

  private async performObservation(run: ActiveRun): Promise<void> {
    await this.observeJournal(run);
    if (isTerminal(run.state.status)) return;
    await this.reconcileLifecycle(run.contract.runId);
    if (isTerminal(run.state.status)) return;
    this.settleIfReady(run);
  }

  private async observeJournal(run: ActiveRun): Promise<void> {
    const batch = await this.journal.drain(run.state.journal);
    run.state.journal = batch.cursor;
    if (batch.records.length === 0) {
      this.persistState(run);
      return;
    }

    run.state.activityObserved = true;
    for (const record of batch.records) await this.processJournalRecord(run, record);
    run.state.lastObservedAt = new Date().toISOString();
    this.persistState(run);
  }

  private async processJournalRecord(run: ActiveRun, record: unknown): Promise<void> {
    const envelope = asObject(record);
    if (envelope.type === "custom" && envelope.customType === "subagents:record") {
      this.processBackgroundAgentRecord(run, asObject(envelope.data));
      return;
    }
    if (envelope.type === "custom_message" && envelope.customType === "ad-process:notification") {
      await this.processBackgroundProcessRecord(run, asObject(envelope.details));
      return;
    }
    if (envelope.type !== "message") return;
    const message = asObject(envelope.message);
    const role = String(message.role ?? "");

    if (role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const value of content) {
        const item = asObject(value);
        if (item.type !== "toolCall") continue;
        const id = String(item.id ?? "");
        const tool = String(item.name ?? "");
        if (!id || !tool) continue;
        const argumentsValue = parseArguments(item.arguments);
        const command = commandFromTool(tool, argumentsValue);
        const validationKey = validationKeyFor(run.contract, tool, command);
        run.state.pendingTools[id] = {
          id,
          tool,
          command,
          mutationFingerprintBefore: run.state.mutationFingerprint,
          validationKey,
          description: optionalString(argumentsValue.description),
          action: optionalString(argumentsValue.action),
        };
        if (tool === "ask_user_question") this.beginHumanWait(run);
      }
      return;
    }

    if (role !== "toolResult") return;
    const toolCallId = String(message.toolCallId ?? "");
    const pending = run.state.pendingTools[toolCallId];
    if (pending) delete run.state.pendingTools[toolCallId];
    if (pending?.tool === "ask_user_question") this.resumeFromHumanWait(run);
    const details = asObject(message.details);
    this.processBackgroundAgentStart(run, pending, details);
    const processState = this.processBackgroundProcessStart(run, pending, details);

    const observation = await this.captureMutation(run);
    if (pending?.tool === "process" && pending.action === "start") {
      if (processState === "running") return;
      const process = asObject(details.process);
      this.recordValidation(
        run,
        pending,
        toolCallId,
        message.isError !== true && process.success === true,
        observation.snapshot,
        observation.mutationChanged,
      );
      return;
    }
    this.recordValidation(
      run,
      pending,
      toolCallId,
      message.isError !== true,
      observation.snapshot,
      observation.mutationChanged,
    );
  }

  private beginHumanWait(run: ActiveRun): void {
    if (run.state.status === "waiting") return;
    const waitingSince = new Date().toISOString();
    run.state.status = "waiting";
    run.state.waitingSince = waitingSince;
    this.appendEvent(run, "human-input-waiting", { waitingSince });
  }

  private resumeFromHumanWait(run: ActiveRun): void {
    if (!run.state.waitingSince) return;
    const resumedAt = new Date().toISOString();
    const waitedMilliseconds = Math.max(0, Date.parse(resumedAt) - Date.parse(run.state.waitingSince));
    run.state.pausedMilliseconds += waitedMilliseconds;
    run.state.lastMaterialAt = new Date(Date.parse(run.state.lastMaterialAt) + waitedMilliseconds).toISOString();
    run.state.status = run.state.violations.length > 0 ? "attention" : "observing";
    const waitingSince = run.state.waitingSince;
    run.state.waitingSince = undefined;
    this.resetHardStopTimer(run);
    this.appendEvent(run, "human-input-resumed", { waitingSince, resumedAt, waitedMilliseconds });
  }

  private resetHardStopTimer(run: ActiveRun): void {
    if (run.hardStopTimer) clearTimeout(run.hardStopTimer);
    const activeElapsedMilliseconds =
      Date.now() - Date.parse(run.state.startedAt) - run.state.pausedMilliseconds;
    const budgetMilliseconds = run.contract.budgets.hardStopSeconds * 1_000;
    const remainingMilliseconds = Math.max(1, budgetMilliseconds - activeElapsedMilliseconds);
    run.hardStopTimer = setTimeout(
      () => this.handleHardStop(run.contract.runId),
      remainingMilliseconds,
    );
    run.hardStopTimer.unref?.();
  }

  private processBackgroundAgentStart(
    run: ActiveRun,
    pending: DurableRunState["pendingTools"][string] | undefined,
    details: Record<string, unknown>,
  ): void {
    if (pending?.tool !== "Agent" || details.status !== "background") return;
    const agentId = optionalString(details.agentId);
    if (!agentId || run.state.backgroundAgents[agentId]) return;
    const observedAt = new Date().toISOString();
    run.state.backgroundAgents[agentId] = {
      id: agentId,
      description: optionalString(details.description) ?? pending.description,
      observedAt,
    };
    this.appendEvent(run, "background-agent-started", {
      agentId,
      description: run.state.backgroundAgents[agentId].description,
    });
  }

  private processBackgroundAgentRecord(run: ActiveRun, data: Record<string, unknown>): void {
    const agentId = optionalString(data.id);
    if (!agentId || !run.state.backgroundAgents[agentId]) return;
    const status = optionalString(data.status);
    if (!status || !isTerminalBackgroundAgentStatus(status)) return;
    const description = optionalString(data.description) ?? run.state.backgroundAgents[agentId].description;
    delete run.state.backgroundAgents[agentId];
    this.appendEvent(run, "background-agent-finished", { agentId, description, status });
    if (status === "failed") {
      this.recordViolation(run, "BACKGROUND_AGENT_FAILED", `Background Agent failed: ${description ?? agentId}`);
    }
  }

  private processBackgroundProcessStart(
    run: ActiveRun,
    pending: DurableRunState["pendingTools"][string] | undefined,
    details: Record<string, unknown>,
  ): "running" | "terminal" | undefined {
    if (pending?.tool !== "process" || pending.action !== "start" || details.action !== "start") return undefined;
    const process = asObject(details.process);
    const processId = optionalString(process.id);
    const command = optionalString(process.command) ?? pending.command;
    if (!processId || !command) return undefined;
    if (process.status !== "running") return "terminal";
    if (run.state.backgroundProcesses[processId]) return "running";
    run.state.backgroundProcesses[processId] = {
      id: processId,
      name: optionalString(process.name),
      command,
      observedAt: new Date().toISOString(),
      validationKey: pending.validationKey,
      mutationFingerprintBefore: pending.mutationFingerprintBefore,
      toolCallId: pending.id,
    };
    this.appendEvent(run, "background-process-started", {
      processId,
      name: run.state.backgroundProcesses[processId].name,
      command,
    });
    return "running";
  }

  private async processBackgroundProcessRecord(
    run: ActiveRun,
    details: Record<string, unknown>,
  ): Promise<void> {
    const processId = optionalString(details.processId);
    if (!processId || !isTerminalProcessNotificationKind(details.kind)) return;
    const process = run.state.backgroundProcesses[processId];
    if (!process) return;
    const observation = await this.captureMutation(run);
    delete run.state.backgroundProcesses[processId];
    const kind = String(details.kind);
    const passed = kind === "success";
    const recoveryKey = processRecoveryKey(process.name, process.command);
    this.appendEvent(run, "background-process-finished", {
      processId,
      name: process.name,
      command: process.command,
      kind,
      exitCode: details.exitCode,
    });
    if (!passed) {
      this.recordViolation(
        run,
        "BACKGROUND_PROCESS_FAILED",
        `Background process failed: ${process.name ?? processId}`,
        undefined,
        recoveryKey,
      );
    }
    if (passed) {
      this.clearViolations(
        run,
        (violation) =>
          violation.code === "BACKGROUND_PROCESS_FAILED" && violation.recoveryKey === recoveryKey,
      );
    }
    this.recordValidation(
      run,
      process,
      process.toolCallId,
      passed,
      observation.snapshot,
      observation.mutationChanged,
    );
  }

  private async captureMutation(
    run: ActiveRun,
  ): Promise<{
    snapshot: Awaited<ReturnType<GitObserver["capture"]>>;
    mutationChanged: boolean;
  }> {
    const snapshot = await this.git.capture(run.contract.git.worktreeRoot);
    const previousMutation = run.state.mutationFingerprint;
    const mutationChanged = snapshot.digest !== previousMutation;
    if (!mutationChanged) return { snapshot, mutationChanged };
    run.state.mutationFingerprint = snapshot.digest;
    run.state.mutationBatchCount += 1;
    run.state.lastMaterialAt = new Date().toISOString();
    run.state.violations = run.state.violations.filter(
      (violation) => violation.code !== "CHECKPOINT_MISSED",
    );
    if (run.state.status === "attention" && run.state.violations.length === 0) {
      run.state.status = "observing";
    }
    if (run.state.validation.observed) run.state.validation.stale = true;
    this.appendEvent(run, "mutation", {
      mutationFingerprint: snapshot.digest,
      mutationBatchCount: run.state.mutationBatchCount,
    });
    this.evaluateMutationPolicy(run, snapshot);
    return { snapshot, mutationChanged };
  }

  private recordValidation(
    run: ActiveRun,
    pending: {
      validationKey?: string;
      command?: string;
      mutationFingerprintBefore: string;
    } | undefined,
    toolCallId: string,
    passed: boolean,
    snapshot: Awaited<ReturnType<GitObserver["capture"]>>,
    mutationChanged: boolean,
  ): void {
    if (!pending?.validationKey) return;
    const previousAtFingerprint = [...run.state.validations]
      .reverse()
      .find(
        (validation) =>
          validation.key === pending.validationKey &&
          validation.mutationFingerprintAfter === pending.mutationFingerprintBefore &&
          snapshot.digest === pending.mutationFingerprintBefore,
      );
    const repeated = previousAtFingerprint !== undefined && !previousAtFingerprint.passed && !passed;
    const completedAt = new Date().toISOString();
    run.state.validations.push({
      key: pending.validationKey,
      command: pending.command ?? "",
      mutationFingerprintBefore: pending.mutationFingerprintBefore,
      mutationFingerprintAfter: snapshot.digest,
      passed,
      completedAt,
      toolCallId,
    });
    run.state.validation = {
      observed: true,
      passed,
      stale: mutationChanged,
      repeatedWithoutMutation: repeated,
      completedAt,
    };
    this.appendEvent(run, "validation", {
      toolCallId,
      command: pending.command,
      passed,
      repeatedWithoutMutation: repeated,
      mutationFingerprint: snapshot.digest,
    });
    if (repeated) {
      this.recordViolation(
        run,
        "REPEATED_VALIDATION",
        "Failing validation repeated without a change to the Git mutation fingerprint",
      );
      return;
    }
    this.clearViolations(run, (violation) => violation.code === "REPEATED_VALIDATION");
  }

  private evaluateMutationPolicy(run: ActiveRun, snapshot: Awaited<ReturnType<GitObserver["capture"]>>): void {
    if (snapshot.head !== run.baseline.head) {
      this.recordViolation(run, "HEAD_CHANGED", `HEAD changed from ${run.baseline.head} to ${snapshot.head}`);
    }

    for (const path of changedSinceBaseline(run.baseline, snapshot)) {
      const forbidden = run.contract.git.forbiddenPaths.some((parent) => isPathInside(path, parent));
      if (forbidden) {
        this.recordViolation(run, "FORBIDDEN_WRITE", `Run changed forbidden path ${path}`, path);
        continue;
      }
      const allowed = run.contract.git.allowedPaths.some((parent) => isPathInside(path, parent));
      if (!allowed) this.recordViolation(run, "OUT_OF_SCOPE_WRITE", `Run changed out-of-scope path ${path}`, path);
    }

    if (run.state.mutationBatchCount > run.contract.budgets.maxMutationBatches) {
      this.recordViolation(
        run,
        "MUTATION_BUDGET",
        `${run.state.mutationBatchCount} mutation batches exceed ${run.contract.budgets.maxMutationBatches}`,
      );
    }
  }

  private appendEvent(run: ActiveRun, type: string, details: Record<string, unknown>): void {
    run.state.eventSequence += 1;
    this.evidence.appendJson(run.contract.runId, "events.jsonl", {
      sequence: run.state.eventSequence,
      type,
      observedAt: new Date().toISOString(),
      ...details,
    });
  }

  private settleIfReady(run: ActiveRun): void {
    if (isTerminal(run.state.status) || run.state.status === "waiting") return;
    if (run.state.targetState === "blocked") {
      this.recordViolation(run, "TARGET_BLOCKED", "Target requires attention");
      return;
    }
    if (run.state.targetState === "unknown") {
      this.recordViolation(run, "TARGET_UNKNOWN", "Herdr cannot classify the target state confidently");
      return;
    }
    if (!run.state.activityObserved) return;
    if (run.state.targetState !== "idle" && run.state.targetState !== "done") return;
    if (Object.keys(run.state.backgroundAgents).length > 0) return;
    if (Object.keys(run.state.backgroundProcesses).length > 0) return;

    run.state.status = "settling";
    if (!run.state.validation.observed) {
      this.recordViolation(run, "VALIDATION_MISSING", "No configured validation was observed after the baseline");
    }
    if (run.state.validation.observed && !run.state.validation.passed) {
      this.recordViolation(run, "VALIDATION_FAILED", "The latest configured validation failed");
    }
    if (run.state.validation.stale) {
      this.recordViolation(run, "VALIDATION_STALE", "The latest passing validation predates the final mutation fingerprint");
    }

    run.state.status = run.state.violations.length > 0 ? "failed" : "passed";
    run.state.lastObservedAt = new Date().toISOString();
    run.state.eventSequence += 1;
    this.persistState(run);
    const settlement = {
      runId: run.contract.runId,
      status: run.state.status,
      targetState: run.state.targetState,
      mutationFingerprint: run.state.mutationFingerprint,
      validation: run.state.validation,
      violations: run.state.violations,
      settledAt: run.state.lastObservedAt,
    };
    this.evidence.writeJson(run.contract.runId, "settlement.json", settlement);
    this.evidence.appendJson(run.contract.runId, "events.jsonl", {
      sequence: run.state.eventSequence,
      type: "run-settled",
      ...settlement,
    });
    this.closeRunResources(run);
  }

  private handleCheckpoint(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.state.status) || run.state.status === "waiting") return;
    const asynchronousWork =
      Object.keys(run.state.backgroundAgents).length > 0 ||
      Object.keys(run.state.backgroundProcesses).length > 0;
    if (run.state.targetState !== "working" && !asynchronousWork) return;
    const elapsed = Date.now() - Date.parse(run.state.lastMaterialAt);
    if (elapsed < run.contract.budgets.checkpointSeconds * 1_000) return;
    this.recordViolation(
      run,
      "CHECKPOINT_MISSED",
      "No Git mutation was observed during the configured checkpoint window",
    );
  }

  private handleHardStop(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.state.status)) return;
    if (run.state.status === "waiting") {
      if (run.hardStopTimer) clearTimeout(run.hardStopTimer);
      run.hardStopTimer = undefined;
      return;
    }
    this.failRun(run, "DEADLINE_EXCEEDED", "Proofloop hard-stop deadline elapsed");
  }

  private closeRunResources(run: ActiveRun): void {
    run.subscription.close();
    run.watcher?.close();
    if (run.checkpointTimer) clearInterval(run.checkpointTimer);
    if (run.hardStopTimer) clearTimeout(run.hardStopTimer);
    run.checkpointTimer = undefined;
    run.hardStopTimer = undefined;
  }

  private async reconcileLifecycle(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.state.status)) return;
    try {
      const agent = await this.herdr.getAgent(run.contract.target.paneId);
      if (agent.sessionPath !== run.contract.target.sessionPath) {
        this.failRun(run, "TARGET_REPLACED", "Herdr target session changed");
        return;
      }
      if (agent.state === run.state.targetState) return;
      run.state.targetState = agent.state;
      if (agent.state !== "blocked" && agent.state !== "unknown") {
        run.state.violations = run.state.violations.filter(
          (violation) => violation.code !== "TARGET_BLOCKED" && violation.code !== "TARGET_UNKNOWN",
        );
        if (run.state.status === "attention" && run.state.violations.length === 0) {
          run.state.status = "observing";
        }
      }
      run.state.lastObservedAt = new Date().toISOString();
      run.state.eventSequence += 1;
      this.persistState(run);
      this.evidence.appendJson(runId, "events.jsonl", {
        sequence: run.state.eventSequence,
        type: "target-state",
        observedAt: run.state.lastObservedAt,
        state: agent.state,
        stateChangeSequence: agent.stateChangeSequence,
      });
    } catch (error) {
      this.recordObserverFailure(runId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private recordObserverFailure(runId: string, error?: Error): void {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.state.status)) return;
    this.failRun(run, "OBSERVER_ERROR", error?.message ?? "Herdr disconnected");
  }

  private failRun(run: ActiveRun, code: GateViolationCode, detail: string): void {
    if (isTerminal(run.state.status)) return;
    this.recordViolation(run, code, detail);
    run.state.status = "failed";
    run.state.stoppedAt = new Date().toISOString();
    run.state.stopReason = detail;
    this.persistState(run);
    this.evidence.writeJson(run.contract.runId, "settlement.json", {
      runId: run.contract.runId,
      status: "failed",
      targetState: run.state.targetState,
      mutationFingerprint: run.state.mutationFingerprint,
      validation: run.state.validation,
      violations: run.state.violations,
      settledAt: run.state.stoppedAt,
    });
    this.closeRunResources(run);
  }

  private clearViolations(
    run: ActiveRun,
    predicate: (violation: DurableRunState["violations"][number]) => boolean,
  ): void {
    const cleared = run.state.violations.filter(predicate);
    if (cleared.length === 0) return;
    run.state.violations = run.state.violations.filter((violation) => !predicate(violation));
    if (run.state.status === "attention" && run.state.violations.length === 0) {
      run.state.status = "observing";
    }
    this.appendEvent(run, "violations-cleared", {
      codes: cleared.map((violation) => violation.code),
      recoveryKeys: cleared.map((violation) => violation.recoveryKey).filter(Boolean),
    });
  }

  private recordViolation(
    run: ActiveRun,
    code: GateViolationCode,
    detail: string,
    path?: string,
    recoveryKey?: string,
  ): void {
    if (run.state.violations.some((violation) => violation.code === code && violation.detail === detail)) return;
    run.state.violations.push({ code, detail, path, recoveryKey });
    run.state.status = "attention";
    run.state.eventSequence += 1;
    run.state.lastObservedAt = new Date().toISOString();
    this.persistState(run);
    this.evidence.appendJson(run.contract.runId, "events.jsonl", {
      sequence: run.state.eventSequence,
      type: "violation",
      observedAt: run.state.lastObservedAt,
      code,
      detail,
      path,
      recoveryKey,
    });
    const routeKey = digestValue({
      runId: run.contract.runId,
      code,
      detail,
      path,
      recoveryKey,
      mutationFingerprint: run.state.mutationFingerprint,
      eventSequence: run.state.eventSequence,
    });
    if (run.state.routeKeys.includes(routeKey)) return;
    run.state.routeKeys.push(routeKey);
    this.evidence.appendJson(run.contract.runId, "routes.jsonl", {
      schemaVersion: 1,
      kind: "proofloop/root-route",
      runId: run.contract.runId,
      taskId: run.contract.task.id,
      observedState: "attention",
      violationCodes: [code],
      requestedAction: run.contract.task.requestedAction,
      urgency: run.contract.routing.urgency,
      transitionKey: routeKey,
      delivery: "root",
      mode: run.contract.routing.mode,
      evidence: {
        directory: run.evidencePath,
        eventSequence: run.state.eventSequence,
        mutationFingerprint: run.state.mutationFingerprint,
        sessionOffset: run.state.journal.offset,
      },
    });
    this.persistState(run);
  }

  private persistState(run: ActiveRun): void {
    this.evidence.writeJson(run.contract.runId, "state.json", run.state);
    this.onStateChange?.(toView(run));
  }
}

function validateContract(contract: RunContract): string | undefined {
  if (contract.schemaVersion !== 1) return "schemaVersion must be 1";
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(contract.runId)) return "runId is invalid";
  if (
    !contract.task.id.trim() ||
    !contract.task.goal.trim() ||
    !contract.task.ownerTask.trim() ||
    !contract.task.requestedAction.trim()
  ) {
    return "task fields are required";
  }
  if (contract.target.kind !== "herdr-pane") return "only herdr-pane targets are supported by the pilot";
  if (!contract.target.paneId.trim() || !isAbsolute(contract.target.sessionPath)) return "target paths are invalid";
  if (!isAbsolute(contract.git.worktreeRoot)) return "worktreeRoot must be absolute";
  if (!/^[a-fA-F0-9]{40,64}$/.test(contract.git.expectedHead)) return "expectedHead is invalid";
  if (contract.git.allowedPaths.length === 0) return "at least one allowed path is required";
  if (![...contract.git.allowedPaths, ...contract.git.forbiddenPaths].every(isValidPolicyPath)) {
    return "policy paths must be normalized project-relative descendants";
  }
  if (contract.validation.cwd !== resolve(contract.validation.cwd)) return "validation cwd must be absolute";
  if (!contract.validation.command.trim()) return "validation command is required";
  if (contract.routing.mode !== "record-only") return "the pilot supports record-only routing";
  if (
    contract.budgets.checkpointSeconds <= 0 ||
    contract.budgets.hardStopSeconds <= 0 ||
    contract.budgets.maxMutationBatches < 0
  ) {
    return "budgets are invalid";
  }
  return undefined;
}

function isValidPolicyPath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const segments = path.replace(/^\.\//, "").split("/");
  return !segments.some((segment) => !segment || segment === "." || segment === "..");
}

function toView(run: ActiveRun): RunView {
  return {
    runId: run.state.runId,
    status: run.state.status,
    targetState: run.state.targetState,
    contractDigest: run.state.contractDigest,
    baselineDigest: run.state.baselineDigest,
    mutationFingerprint: run.state.mutationFingerprint,
    mutationBatchCount: run.state.mutationBatchCount,
    activeBackgroundAgentCount: Object.keys(run.state.backgroundAgents).length,
    activeBackgroundProcessCount: Object.keys(run.state.backgroundProcesses).length,
    validation: { ...run.state.validation },
    gate: {
      verdict: gateVerdict(run.state),
      violations: run.state.violations.map((violation) => ({ ...violation })),
    },
    evidencePath: run.evidencePath,
    lastObservedAt: run.state.lastObservedAt,
  };
}

function gateVerdict(state: DurableRunState): "pending" | "pass" | "fail" {
  if (state.status === "passed") return "pass";
  if (state.status === "failed" || state.violations.length > 0) return "fail";
  return "pending";
}

function success<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function failure(code: ProofloopError["code"], message: string): Outcome<never> {
  return { ok: false, error: { code, message } };
}

function failureFromError(error: unknown): Outcome<never> {
  if (error instanceof GitObserverError || error instanceof JournalObserverError) {
    return failure(error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Baseline changed before archival")) return failure("BASELINE_UNSTABLE", message);
  if (message.includes("ENOENT")) return failure("SESSION_INVALID", message);
  if (message.includes("Baseline archive") || message.includes("Git baseline path")) return failure("EVIDENCE_IO", message);
  return failure("HERDR_DISCONNECTED", message);
}

function isTerminal(status: DurableRunState["status"]): boolean {
  return ["passed", "failed", "stopped"].includes(status);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asObject(value);
}

function commandFromTool(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "bash" && typeof args.command === "string") return args.command;
  if (tool === "process" && args.action === "start" && typeof args.command === "string") return args.command;
  return undefined;
}

function validationKeyFor(
  contract: RunContract,
  tool: string,
  command: string | undefined,
): string | undefined {
  if (!isValidation(contract, tool, command)) return undefined;
  return digestValue({
    tool,
    cwd: resolve(contract.validation.cwd),
    command: normalizeCommand(command ?? ""),
  });
}

function isValidation(contract: RunContract, tool: string, command: string | undefined): boolean {
  if (!command || tool !== contract.validation.tool) return false;
  return normalizeCommand(command) === normalizeCommand(contract.validation.command);
}

function changedSinceBaseline(
  baseline: GitBaseline,
  current: Awaited<ReturnType<GitObserver["capture"]>>,
): string[] {
  const paths = new Set([...Object.keys(baseline.entries), ...Object.keys(current.entries)]);
  return [...paths]
    .filter((path) => digestValue(baseline.entries[path] ?? null) !== digestValue(current.entries[path] ?? null))
    .sort();
}

function isTerminalBackgroundAgentStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "killed"].includes(status);
}

function isTerminalProcessNotificationKind(value: unknown): boolean {
  return ["success", "failure", "crash", "killed"].includes(String(value ?? ""));
}

function processRecoveryKey(name: string | undefined, command: string): string {
  const tokens = (name ?? "process").toLowerCase().split(/[-_]+/).filter(Boolean);
  const hasTaskPrefix =
    tokens.length > 2 && /^[a-z]+$/i.test(tokens[0] ?? "") && /^\d+$/.test(tokens[1] ?? "");
  const withoutTaskPrefix = hasTaskPrefix ? tokens.slice(2) : tokens;
  const qualifiers = new Set(["clean", "staging", "final", "settled", "retry", "rerun", "attempt"]);
  const family = withoutTaskPrefix
    .filter((token, index) => !qualifiers.has(token) && !(index === withoutTaskPrefix.length - 1 && /^\d+$/.test(token)))
    .join("-");
  return digestValue({ family: family || normalizeCommand(command) });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
