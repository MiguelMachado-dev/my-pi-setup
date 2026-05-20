import {
  DynamicBorder,
  type ExtensionAPI,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Container, Key, Loader, matchesKey, Text } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Check = {
  name: string;
  status: string;
  duration: string;
  url: string;
};

type Run = {
  status: string;
  conclusion: string;
  name: string;
  workflow: string;
  branch: string;
  event: string;
  id: string;
  duration: string;
  createdAt: string;
};

type JobStep = {
  number: number;
  name: string;
  status: string;
  conclusion?: string;
  duration: string;
  startedAt?: string;
  completedAt?: string;
};

type JobDetail = {
  name: string;
  status: string;
  conclusion?: string;
  duration: string;
  startedAt?: string;
  completedAt?: string;
  url?: string;
  steps: JobStep[];
};

type MonitorState = {
  repo: string;
  target: string;
  mode: "pr" | "branch";
  pr?: string;
  branch?: string;
  startedAt: Date;
  updatedAt?: Date;
  checks: Check[];
  runs: Run[];
  jobDetails: Record<string, JobDetail>;
  jobDetailsByRunId: Record<string, Record<string, JobDetail>>;
  run?: Run;
  previousSuccessRun?: Run;
  failedLog?: string;
  error?: string;
  stopped?: boolean;
  complete?: boolean;
  failed?: boolean;
  pollCount: number;
};

const PASSING_CHECK_STATUSES = new Set(["pass", "skipping"]);
const FAILURE_STATUSES = new Set([
  "fail",
  "failure",
  "cancel",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

async function gh(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return String(stdout).trim();
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (stdout) return String(stdout).trim();
    throw error;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return String(stdout).trim();
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (stdout) return String(stdout).trim();
    throw error;
  }
}

function parseChecks(output: string): Check[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", status = "", duration = "", url = ""] =
        line.split("\t");
      return { name, status, duration, url };
    });
}

function parseRuns(output: string): Run[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [
        status = "",
        conclusion = "",
        name = "",
        workflow = "",
        branch = "",
        event = "",
        id = "",
        duration = "",
        createdAt = "",
      ] = line.split("\t");
      return {
        status,
        conclusion,
        name,
        workflow,
        branch,
        event,
        id,
        duration,
        createdAt,
      };
    });
}

function isPassingCheckStatus(status: string): boolean {
  return PASSING_CHECK_STATUSES.has(status);
}

function isFailureStatus(status?: string): boolean {
  return status ? FAILURE_STATUSES.has(status) : false;
}

function hasFailure(checks: Check[]): boolean {
  return checks.some((check) => isFailureStatus(check.status));
}

type CiListItem = {
  key: string;
  kind: "run" | "job" | "step" | "info";
  text: string;
  indent: number;
  selectable: boolean;
  status?: string;
  url?: string;
  expandable?: boolean;
  expanded?: boolean;
  runId?: string;
};

const MAX_VISIBLE_ROWS = 18;

class GhCiMonitorComponent implements Component {
  private container = new Container();
  private loader: Loader;
  private summary = new Text("", 1, 0);
  private run = new Text("", 1, 0);
  private list = new Text("", 1, 0);
  private failedLog = new Text("", 1, 0);
  private help = new Text("", 1, 0);
  private selectedKey?: string;
  private scrollOffset = 0;
  private expandedKeys = new Set<string>();
  private collapsedKeys = new Set<string>();
  private loadingRunIds = new Set<string>();

  constructor(
    private state: MonitorState,
    private onStop: () => void,
    private tui: TUI,
    private theme: Theme,
    private onLoadRunJobs: (runId: string) => Promise<void>,
  ) {
    this.loader = new Loader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("dim", text),
      this.loaderMessage(),
      undefined,
    );
    this.loader.start();

    this.container.addChild(
      new DynamicBorder((text) => theme.fg("borderAccent", text)),
    );
    this.container.addChild(this.loader);
    this.container.addChild(this.summary);
    this.container.addChild(this.run);
    this.container.addChild(this.list);
    this.container.addChild(this.failedLog);
    this.container.addChild(this.help);
    this.container.addChild(
      new DynamicBorder((text) => theme.fg("borderAccent", text)),
    );
    this.updateChildren();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "q") ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.state.stopped = true;
      this.loader.stop();
      this.updateChildren();
      this.onStop();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.expandSelected();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.collapseSelected();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleSelected();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.openSelectedUrl();
    }
  }

  render(width: number): string[] {
    this.updateChildren();
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  dispose(): void {
    this.loader.stop();
  }

  private updateChildren(): void {
    this.loader.setMessage(this.loaderMessage());
    if (this.state.complete || this.state.failed || this.state.stopped)
      this.loader.stop();

    const updated = this.state.updatedAt?.toISOString() ?? "waiting";
    this.summary.setText(
      [
        this.theme.fg("accent", this.theme.bold("GitHub CI monitor")),
        this.theme.fg(
          "dim",
          `${this.state.repo} • ${this.state.mode}:${this.state.target}`,
        ),
        this.theme.fg(
          "dim",
          `updated ${updated} • polls ${this.state.pollCount}`,
        ),
      ].join("\n"),
    );

    if (this.state.run) {
      const conclusion = this.state.run.conclusion
        ? `/${this.state.run.conclusion}`
        : "";
      const previous = this.state.previousSuccessRun
        ? `\nprevious pass on this PR/branch: run ${this.state.previousSuccessRun.id} • ${this.state.previousSuccessRun.duration} • ${this.state.previousSuccessRun.createdAt}`
        : "\nprevious pass on this PR/branch: none in last 10 runs";
      this.run.setText(
        `current run ${this.state.run.id} • ${this.state.run.status}${conclusion} • ${this.state.run.duration}${previous}`,
      );
    } else {
      this.run.setText(this.theme.fg("dim", "run: waiting for GitHub"));
    }

    this.list.setText(this.renderCiWindow());
    this.failedLog.setText(this.renderFailureLog());
    this.help.setText(
      this.theme.fg(
        "dim",
        "↑↓ select • ←/→/space expand/minimize • enter open URL • q/esc stop • updates every 10s",
      ),
    );
  }

  private loaderMessage(): string {
    if (this.state.failed) return "CI failed";
    if (this.state.complete) return "CI passed";
    if (this.state.stopped) return "monitor stopped";
    if (!this.state.checks.length) return "waiting for checks";
    const pending = this.state.checks.filter(
      (check) => check.status === "pending",
    ).length;
    if (pending) return `${pending} job${pending === 1 ? "" : "s"} pending`;
    return "monitoring checks";
  }

  private renderCiWindow(): string {
    const rows = this.buildRows();
    const selectedRowIndex = this.ensureSelection(rows);
    this.adjustScroll(rows, selectedRowIndex);

    const visibleRows = rows.slice(
      this.scrollOffset,
      this.scrollOffset + MAX_VISIBLE_ROWS,
    );
    const lines = [
      this.theme.fg("accent", this.theme.bold("Recent Actions / jobs")),
    ];
    if (this.scrollOffset > 0) {
      lines.push(this.theme.fg("dim", `  … ${this.scrollOffset} above`));
    }
    lines.push(
      ...visibleRows.map((row, index) =>
        this.renderRow(row, this.scrollOffset + index === selectedRowIndex),
      ),
    );
    const below = rows.length - (this.scrollOffset + visibleRows.length);
    if (below > 0) {
      lines.push(this.theme.fg("dim", `  … ${below} below`));
    }
    return lines.join("\n");
  }

  private buildRows(): CiListItem[] {
    const rows: CiListItem[] = [];
    const runs = this.displayRuns();
    if (!runs.length) {
      if (!this.state.checks.length) {
        return [this.infoRow("waiting for GitHub Actions runs")];
      }
      return this.state.checks.map((check) => ({
        key: `check:${check.name}`,
        kind: "job",
        text: `${statusIcon(check.status)} job ${check.name} • ${check.status}${formatTimingSuffix(formatStartAndDuration(undefined, check.duration))}`,
        indent: 0,
        selectable: true,
        status: check.status,
        url: check.url,
      }));
    }

    for (const run of runs) {
      const runStatus = normalizeRunStatus(run);
      const runKeyValue = runKey(run.id);
      const expanded = this.isExpanded(
        runKeyValue,
        run.id === this.state.run?.id,
      );
      const current = run.id === this.state.run?.id ? " • current" : "";
      const workflow = run.workflow || run.name || "GitHub Actions";
      rows.push({
        key: runKeyValue,
        kind: "run",
        text: `${expanded ? "▾" : "▸"} ${statusIcon(runStatus)} action ${run.id} • ${workflow} • ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}${formatTimingSuffix(formatStartAndDuration(run.createdAt, run.duration))}${current}`,
        indent: 0,
        selectable: true,
        status: runStatus,
        url: runUrl(this.state.repo, run.id),
        expandable: true,
        expanded,
        runId: run.id,
      });

      if (!expanded) continue;

      const jobs = this.jobsForRun(run.id);
      if (jobs.length === 0) {
        const loading = this.loadingRunIds.has(run.id);
        rows.push(
          this.infoRow(
            loading ? "loading jobs…" : "no jobs loaded yet",
            2,
            `info:${run.id}`,
          ),
        );
        continue;
      }

      for (const job of jobs) {
        const jobStatus = normalizeJobCheckStatus(job.status, job.conclusion);
        const jobKeyValue = jobKey(run.id, job.name);
        const jobDefaultExpanded =
          run.id === this.state.run?.id && isImportantJob(job);
        const jobExpanded = this.isExpanded(jobKeyValue, jobDefaultExpanded);
        rows.push({
          key: jobKeyValue,
          kind: "job",
          text: `${jobExpanded ? "▾" : "▸"} ${statusIcon(jobStatus)} job ${job.name} • ${jobStatus}${formatTimingSuffix(formatStartAndDuration(job.startedAt, job.duration))}`,
          indent: 2,
          selectable: true,
          status: jobStatus,
          url: job.url ?? runUrl(this.state.repo, run.id),
          expandable: true,
          expanded: jobExpanded,
          runId: run.id,
        });

        if (!jobExpanded) continue;
        if (!job.steps.length) {
          rows.push(
            this.infoRow("no steps reported", 4, `info:${run.id}:${job.name}`),
          );
          continue;
        }
        for (const step of job.steps) {
          const stepStatus = normalizeStepStatus(step);
          rows.push({
            key: stepKey(run.id, job.name, step.number),
            kind: "step",
            text: `${statusIcon(stepStatus)} step #${step.number} ${step.name} • ${stepStatus}${formatTimingSuffix(formatStartAndDuration(step.startedAt, step.duration))}`,
            indent: 4,
            selectable: true,
            status: stepStatus,
            url:
              stepUrl(job.url, step.number) ??
              job.url ??
              runUrl(this.state.repo, run.id),
            runId: run.id,
          });
        }
      }
    }
    return rows;
  }

  private infoRow(text: string, indent = 0, key = "info"): CiListItem {
    return { key, kind: "info", text, indent, selectable: false };
  }

  private displayRuns(): Run[] {
    const runs = [...this.state.runs];
    if (this.state.run && !runs.some((run) => run.id === this.state.run?.id)) {
      runs.unshift(this.state.run);
    }
    return runs.filter((run) => run.id);
  }

  private jobsForRun(runId: string): JobDetail[] {
    const details =
      this.state.jobDetailsByRunId[runId] ??
      (runId === this.state.run?.id ? this.state.jobDetails : undefined);
    return Object.values(details ?? {});
  }

  private renderRow(row: CiListItem, selected: boolean): string {
    const marker = selected ? "› " : "  ";
    const text = `${marker}${" ".repeat(row.indent)}${row.text}`;
    const colored = row.status
      ? colorByStatus(this.theme, row.status, text)
      : this.theme.fg("dim", text);
    return selected ? this.theme.bg("selectedBg", colored) : colored;
  }

  private ensureSelection(rows: CiListItem[]): number {
    const selectedIndex = rows.findIndex(
      (row) => row.selectable && row.key === this.selectedKey,
    );
    if (selectedIndex >= 0) return selectedIndex;

    const firstSelectableIndex = rows.findIndex((row) => row.selectable);
    this.selectedKey =
      firstSelectableIndex >= 0 ? rows[firstSelectableIndex]?.key : undefined;
    return firstSelectableIndex;
  }

  private adjustScroll(rows: CiListItem[], selectedIndex: number): void {
    if (selectedIndex < 0) {
      this.scrollOffset = 0;
      return;
    }
    if (selectedIndex < this.scrollOffset) this.scrollOffset = selectedIndex;
    if (selectedIndex >= this.scrollOffset + MAX_VISIBLE_ROWS) {
      this.scrollOffset = selectedIndex - MAX_VISIBLE_ROWS + 1;
    }
    const maxOffset = Math.max(0, rows.length - MAX_VISIBLE_ROWS);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
  }

  private moveSelection(delta: number): void {
    const rows = this.buildRows();
    const selectableIndexes = rows
      .map((row, index) => (row.selectable ? index : -1))
      .filter((index) => index >= 0);
    if (!selectableIndexes.length) return;

    const selectedIndex = this.ensureSelection(rows);
    const currentSelectableIndex = Math.max(
      0,
      selectableIndexes.indexOf(selectedIndex),
    );
    const nextSelectableIndex = Math.min(
      selectableIndexes.length - 1,
      Math.max(0, currentSelectableIndex + delta),
    );
    const nextIndex = selectableIndexes[nextSelectableIndex];
    this.selectedKey = rows[nextIndex]?.key;
    this.invalidate();
    this.tui.requestRender();
  }

  private expandSelected(): void {
    const row = this.selectedItem();
    if (!row?.expandable || row.expanded) return;
    this.setExpanded(row, true);
  }

  private collapseSelected(): void {
    const row = this.selectedItem();
    if (!row?.expandable || !row.expanded) return;
    this.setExpanded(row, false);
  }

  private toggleSelected(): void {
    const row = this.selectedItem();
    if (!row?.expandable) return;
    this.setExpanded(row, !row.expanded);
  }

  private selectedItem(): CiListItem | undefined {
    const rows = this.buildRows();
    const selectedIndex = this.ensureSelection(rows);
    return selectedIndex >= 0 ? rows[selectedIndex] : undefined;
  }

  private setExpanded(row: CiListItem, expanded: boolean): void {
    if (expanded) {
      this.expandedKeys.add(row.key);
      this.collapsedKeys.delete(row.key);
      if (row.kind === "run" && row.runId) this.loadJobsForRun(row.runId);
    } else {
      this.collapsedKeys.add(row.key);
      this.expandedKeys.delete(row.key);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private isExpanded(key: string, defaultValue: boolean): boolean {
    if (this.collapsedKeys.has(key)) return false;
    if (this.expandedKeys.has(key)) return true;
    return defaultValue;
  }

  private loadJobsForRun(runId: string): void {
    if (this.state.jobDetailsByRunId[runId] || this.loadingRunIds.has(runId))
      return;
    this.loadingRunIds.add(runId);
    this.invalidate();
    this.tui.requestRender();
    void this.onLoadRunJobs(runId)
      .catch((error) => {
        this.state.error =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.loadingRunIds.delete(runId);
        this.invalidate();
        this.tui.requestRender();
      });
  }

  private async openSelectedUrl(): Promise<void> {
    const row = this.selectedItem();
    if (!row?.url) {
      this.state.error = "selected CI item has no URL";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    try {
      await openUrl(row.url);
      this.state.error = undefined;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private renderFailureLog(): string {
    if (this.state.error)
      return this.theme.fg("error", `error: ${this.state.error}`);
    if (!this.state.failedLog) return "";
    const tail = this.state.failedLog.split("\n").slice(-8).join("\n");
    return [this.theme.fg("error", this.theme.bold("failed log:")), tail].join(
      "\n",
    );
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "pass":
      return "✓";
    case "fail":
    case "failure":
    case "cancel":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "✗";
    case "skipping":
      return "-";
    case "pending":
      return "…";
    default:
      return "•";
  }
}

function colorByStatus(theme: Theme, status: string, text: string): string {
  switch (status) {
    case "pass":
      return theme.fg("success", text);
    case "fail":
    case "failure":
    case "cancel":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return theme.fg("error", text);
    case "pending":
      return theme.fg("warning", text);
    case "skipping":
      return theme.fg("dim", text);
    default:
      return theme.fg("text", text);
  }
}

function normalizeRunStatus(run: Run): string {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "pass";
    case "skipped":
    case "neutral":
      return "skipping";
    case "failure":
      return "fail";
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return run.conclusion;
    default:
      return run.conclusion || run.status;
  }
}

function normalizeStepStatus(step: JobStep): string {
  return normalizeJobCheckStatus(step.status, step.conclusion);
}

function isImportantJob(job: JobDetail): boolean {
  const status = normalizeJobCheckStatus(job.status, job.conclusion);
  return (
    status === "pending" ||
    isFailureStatus(status) ||
    getActiveStep(job.steps)?.status !== "completed"
  );
}

function runKey(runId: string): string {
  return `run:${runId}`;
}

function jobKey(runId: string, jobName: string): string {
  return `job:${runId}:${jobName}`;
}

function stepKey(runId: string, jobName: string, stepNumber: number): string {
  return `step:${runId}:${jobName}:${stepNumber}`;
}

function runUrl(repo: string, runId: string): string {
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

function stepUrl(
  jobUrl: string | undefined,
  stepNumber: number,
): string | undefined {
  if (!jobUrl) return undefined;
  return `${jobUrl.split("#")[0]}#step:${stepNumber}:1`;
}

async function openUrl(url: string): Promise<void> {
  const { command, args } = openUrlCommand(url);
  await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
}

function openUrlCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32")
    return { command: "cmd", args: ["/c", "start", "", url] };
  if (
    process.env.TERMUX_VERSION ||
    process.env.PREFIX?.includes("com.termux")
  ) {
    return { command: "termux-open-url", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

function getActiveStep(steps: JobStep[]): JobStep | undefined {
  return (
    steps.find((step) => step.status !== "completed") ??
    [...steps]
      .reverse()
      .find((step) => step.conclusion && step.conclusion !== "success") ??
    [...steps].reverse().find((step) => step.status === "completed")
  );
}

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "0s";
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "0s";
  return formatSeconds(Math.round((end - start) / 1000));
}

function formatStartAndDuration(
  startedAt: string | undefined,
  duration: string,
): string {
  const parts: string[] = [];
  const started = formatDateTime(startedAt);
  const elapsed = formatDurationText(duration);
  if (started) parts.push(`started ${started}`);
  if (elapsed) parts.push(`took ${elapsed}`);
  return parts.join(" • ");
}

function formatDurationText(duration: string): string {
  const trimmed = duration.trim();
  if (!trimmed) return "";

  const seconds = parseDurationSeconds(trimmed);
  return seconds === undefined ? trimmed : formatSeconds(seconds);
}

function parseDurationSeconds(duration: string): number | undefined {
  const regex = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
  let total = 0;
  let matched = false;

  for (const match of duration.matchAll(regex)) {
    const rawValue = match[1];
    const rawUnit = match[2];
    if (!rawValue || !rawUnit) continue;

    const value = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(value)) continue;

    matched = true;
    const unit = rawUnit.toLowerCase();
    if (unit.startsWith("h")) total += value * 3600;
    else if (unit.startsWith("m")) total += value * 60;
    else total += value;
  }

  return matched ? total : undefined;
}

function formatSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const parts: string[] = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}min`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatTimingSuffix(timing: string): string {
  return timing ? ` • ${timing}` : "";
}

function formatDateTime(value?: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeJobCheckStatus(status: string, conclusion?: string): string {
  if (status !== "completed") return "pending";

  switch (conclusion) {
    case "success":
      return "pass";
    case "skipped":
    case "neutral":
      return "skipping";
    case "failure":
      return "fail";
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return conclusion;
    default:
      return conclusion || status;
  }
}

function jobDetailToCheck(job: JobDetail): Check {
  return {
    name: job.name,
    status: normalizeJobCheckStatus(job.status, job.conclusion),
    duration: job.duration,
    url: job.url ?? "",
  };
}

function runIdFromChecks(checks: Check[]): string | undefined {
  for (const check of checks) {
    const match = check.url.match(/actions\/runs\/(\d+)/);
    if (match?.[1]) return match[1];
  }
}

async function fetchJobDetails(
  repo: string,
  runId: string,
  cwd: string,
): Promise<Record<string, JobDetail>> {
  const jobsOutput = await gh(
    ["run", "view", runId, "--repo", repo, "--json", "jobs"],
    cwd,
  );
  return parseJobDetails(jobsOutput);
}

function parseJobDetails(output: string): Record<string, JobDetail> {
  if (!output) return {};
  const parsed = JSON.parse(output) as {
    jobs?: Array<{
      name: string;
      status: string;
      conclusion?: string;
      startedAt?: string;
      completedAt?: string;
      url?: string;
      steps?: Array<{
        number: number;
        name: string;
        status: string;
        conclusion?: string;
        startedAt?: string;
        completedAt?: string;
      }>;
    }>;
  };
  return Object.fromEntries(
    (parsed.jobs ?? []).map((job) => [
      job.name,
      {
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        duration: formatDuration(job.startedAt, job.completedAt),
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        url: job.url,
        steps: (job.steps ?? []).map((step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
          duration: formatDuration(step.startedAt, step.completedAt),
          startedAt: step.startedAt,
          completedAt: step.completedAt,
        })),
      },
    ]),
  );
}

async function resolveTarget(
  args: string,
  cwd: string,
): Promise<Pick<MonitorState, "repo" | "target" | "mode" | "pr" | "branch">> {
  const repo = await gh(
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  const target = args.trim() || (await git(["branch", "--show-current"], cwd));
  if (/^\d+$/.test(target)) {
    const branch = await gh(
      [
        "pr",
        "view",
        target,
        "--repo",
        repo,
        "--json",
        "headRefName",
        "-q",
        ".headRefName",
      ],
      cwd,
    ).catch(() => undefined);
    return { repo, target, mode: "pr", pr: target, branch };
  }
  const prInfo = await gh(
    [
      "pr",
      "view",
      target,
      "--repo",
      repo,
      "--json",
      "number,headRefName",
      "-q",
      '.number + "\\t" + .headRefName',
    ],
    cwd,
  ).catch(() => "");
  const [pr, branch] = prInfo.split("\t");
  return pr
    ? { repo, target, mode: "pr", pr, branch }
    : { repo, target, mode: "branch", branch: target };
}

async function poll(state: MonitorState, cwd: string): Promise<void> {
  state.pollCount++;
  state.updatedAt = new Date();
  state.error = undefined;

  try {
    if (state.mode === "pr" && state.pr) {
      state.checks = parseChecks(
        await gh(["pr", "checks", state.pr, "--repo", state.repo], cwd).catch(
          (error) => {
            state.error =
              error instanceof Error ? error.message : String(error);
            return "";
          },
        ),
      );
    }
    const previousRunId = state.run?.id;
    const runs = parseRuns(
      await gh(
        [
          "run",
          "list",
          "--repo",
          state.repo,
          "--branch",
          state.branch ?? "HEAD",
          "--limit",
          "10",
        ],
        cwd,
      ).catch((error) => {
        state.error = error instanceof Error ? error.message : String(error);
        return "";
      }),
    );
    state.runs = runs;
    state.run = runs[0];
    const checksRunId = runIdFromChecks(state.checks);
    if (checksRunId && state.run?.id !== checksRunId) {
      state.run = state.run
        ? { ...state.run, id: checksRunId }
        : {
            id: checksRunId,
            status: "in_progress",
            conclusion: "",
            name: "",
            workflow: "",
            branch: state.branch ?? "",
            event: "",
            duration: "0s",
            createdAt: "",
          };
    }

    if (state.run?.id !== previousRunId) {
      state.jobDetails = {};
      state.failedLog = undefined;
      if (state.mode === "branch") state.checks = [];
    }
    state.previousSuccessRun = runs.find(
      (run) =>
        run.id !== state.run?.id &&
        run.status === "completed" &&
        run.conclusion === "success",
    );

    if (state.run?.id) {
      state.jobDetails = await fetchJobDetails(
        state.repo,
        state.run.id,
        cwd,
      ).catch((error) => {
        state.error = error instanceof Error ? error.message : String(error);
        return {};
      });
      state.jobDetailsByRunId[state.run.id] = state.jobDetails;
      if (state.mode === "branch") {
        state.checks = Object.values(state.jobDetails).map(jobDetailToCheck);
      }
    }
    state.failed =
      hasFailure(state.checks) || isFailureStatus(state.run?.conclusion);
    state.complete =
      !state.failed &&
      state.checks.length > 0 &&
      state.checks.every((check) => isPassingCheckStatus(check.status));

    if (state.failed && state.run?.id && !state.failedLog) {
      state.failedLog = await gh(
        ["run", "view", state.run.id, "--repo", state.repo, "--log-failed"],
        cwd,
      ).catch((error) =>
        error instanceof Error ? error.message : String(error),
      );
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
}

export default function ghCiMonitorExtension(pi: ExtensionAPI) {
  pi.registerCommand("monitor:ci", {
    description: "Monitor GitHub Actions in an updating TUI component.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("monitor:ci requires interactive TUI mode", "error");
        return;
      }

      const target = await resolveTarget(args, ctx.cwd);
      const state: MonitorState = {
        ...target,
        startedAt: new Date(),
        checks: [],
        runs: [],
        jobDetails: {},
        jobDetailsByRunId: {},
        pollCount: 0,
      };
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        let interval: ReturnType<typeof setInterval> | undefined;
        let closed = false;
        let polling = false;

        const close = () => {
          if (closed) return;
          closed = true;
          if (interval) clearInterval(interval);
          done(undefined);
        };

        let component: GhCiMonitorComponent;
        const renderNow = () => {
          component.invalidate();
          tui.requestRender();
        };
        const loadRunJobs = async (runId: string) => {
          const details = await fetchJobDetails(state.repo, runId, ctx.cwd);
          state.jobDetailsByRunId[runId] = details;
          if (state.run?.id === runId) {
            state.jobDetails = details;
            if (state.mode === "branch") {
              state.checks = Object.values(state.jobDetails).map(
                jobDetailToCheck,
              );
            }
          }
          renderNow();
        };
        component = new GhCiMonitorComponent(
          state,
          close,
          tui,
          _theme,
          loadRunJobs,
        );

        const tick = async () => {
          if (closed || polling) return;
          polling = true;

          try {
            const pollPromise = poll(state, ctx.cwd);
            renderNow();
            await pollPromise;
          } catch (error) {
            state.error =
              error instanceof Error ? error.message : String(error);
          } finally {
            polling = false;
          }

          if (closed) return;
          renderNow();
        };

        interval = setInterval(tick, 10_000);
        void tick();

        return {
          render: (width: number) => component.render(width),
          handleInput: (data: string) => component.handleInput(data),
          invalidate: () => component.invalidate(),
          dispose: () => {
            component.dispose();
            if (interval) clearInterval(interval);
          },
        };
      });

      if (state.failed) {
        ctx.ui.notify(
          "GitHub CI failed. See monitor output/logs for details.",
          "error",
        );
      } else if (state.complete) {
        ctx.ui.notify("GitHub CI passed.", "info");
      } else {
        ctx.ui.notify("GitHub CI monitor stopped.", "info");
      }
    },
  });
}
