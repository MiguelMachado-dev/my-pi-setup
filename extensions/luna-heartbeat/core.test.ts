import { describe, expect, test } from "bun:test";
import {
  classifyObservation,
  normalizeEvidence,
  shouldAlert,
  type MonitorConfig,
  validatePatterns,
  validateStatusCommand,
} from "./core";

const baseConfig: MonitorConfig = {
  id: "ci",
  workItem: "CI run",
  statusSource: "GitHub Actions",
  responsibleTask: "fix-ci",
  executable: "printf",
  args: ["healthy"],
  cwd: "/tmp",
  cadenceSeconds: 180,
  timeoutSeconds: 30,
  acceptedExitCodes: [0],
  conditions: {},
  requestedAction: "Inspect the run",
  urgency: "high",
  deadlineRiskSeconds: 900,
  notifyOnRecovery: true,
};

const success = {
  stdout: "healthy",
  stderr: "",
  code: 0,
  killed: false,
};

describe("classifyObservation", () => {
  test("treats command failures as attention", () => {
    const result = classifyObservation(baseConfig, { ...success, code: 2, stderr: "failed" });
    expect(result.state).toBe("attention");
    expect(result.reason).toContain("code 2");
  });

  test("accepts declared nonzero status codes", () => {
    const config = { ...baseConfig, acceptedExitCodes: [0, 8] };
    const result = classifyObservation(config, { ...success, code: 8, stdout: "pending" });
    expect(result.state).toBe("healthy");
  });

  test("prioritizes attention over terminal", () => {
    const config = {
      ...baseConfig,
      conditions: { attentionPattern: "failed", terminalPattern: "completed" },
    };
    const result = classifyObservation(config, { ...success, stdout: "completed with failed checks" });
    expect(result.state).toBe("attention");
  });

  test("requires declared evidence for a stall", () => {
    const config = { ...baseConfig, conditions: { stalledPattern: "queue blocked" } };
    const stalled = classifyObservation(config, { ...success, stdout: "queue blocked by approval" });
    const healthy = classifyObservation(config, success);
    expect(stalled.state).toBe("stalled");
    expect(healthy.state).toBe("healthy");
  });

  test("detects terminal completion", () => {
    const config = { ...baseConfig, conditions: { terminalPattern: "status=done" } };
    const result = classifyObservation(config, { ...success, stdout: "status=done" });
    expect(result.state).toBe("terminal");
  });

  test("detects deadline risk after explicit states", () => {
    const config = {
      ...baseConfig,
      deadline: "2026-08-11T00:05:00.000Z",
      deadlineRiskSeconds: 600,
    };
    const result = classifyObservation(config, success, new Date("2026-08-11T00:00:00.000Z"));
    expect(result.state).toBe("deadline-risk");
  });

  test("returns unknown when a declared healthy condition is absent", () => {
    const config = { ...baseConfig, conditions: { healthyPattern: "status=ok" } };
    const result = classifyObservation(config, success);
    expect(result.state).toBe("unknown");
  });
});

describe("alert deduplication", () => {
  test("alerts once for an unchanged blocker", () => {
    const config = { ...baseConfig, conditions: { attentionPattern: "failed: database" } };
    const result = classifyObservation(config, { ...success, stdout: "failed: database" });
    expect(shouldAlert("healthy", result, undefined, true)).toBe(true);
    expect(shouldAlert("attention", result, result.transitionKey, true)).toBe(false);
  });

  test("alerts when blocker evidence materially changes", () => {
    const config = { ...baseConfig, conditions: { attentionPattern: "failed:" } };
    const first = classifyObservation(config, { ...success, stdout: "failed: database" });
    const second = classifyObservation(config, { ...success, stdout: "failed: cache" });
    expect(second.transitionKey).not.toBe(first.transitionKey);
    expect(shouldAlert("attention", second, first.transitionKey, true)).toBe(true);
  });

  test("alerts when a prior blocker returns after a non-actionable state", () => {
    const config = { ...baseConfig, conditions: { attentionPattern: "failed" } };
    const result = classifyObservation(config, { ...success, stdout: "failed" });
    expect(shouldAlert("unknown", result, result.transitionKey, true)).toBe(true);
  });

  test("alerts on actionable recovery when enabled", () => {
    const healthy = classifyObservation(baseConfig, success);
    expect(shouldAlert("stalled", healthy, undefined, true)).toBe(true);
    expect(shouldAlert("stalled", healthy, undefined, false)).toBe(false);
  });
});

test("redacts common credentials from evidence", () => {
  const evidence = normalizeEvidence("Authorization: bearer-secret", "token ghp_1234567890123456789012345");
  expect(evidence).not.toContain("bearer-secret");
  expect(evidence).not.toContain("ghp_1234567890123456789012345");
});

test("validates condition patterns", () => {
  expect(validatePatterns({ attentionPattern: "[" })).toContain("attentionPattern");
  expect(validatePatterns({ attentionPattern: "failed" })).toBeUndefined();
});

describe("read-only status commands", () => {
  test("accepts status-oriented commands", () => {
    expect(validateStatusCommand("git", ["status", "--short"])).toBeUndefined();
    expect(validateStatusCommand("gh", ["run", "view", "123"])).toBeUndefined();
    expect(validateStatusCommand("kubectl", ["get", "pods"])).toBeUndefined();
  });

  test("rejects mutating commands", () => {
    expect(validateStatusCommand("git", ["reset", "--hard"])).toContain("not allowed");
    expect(validateStatusCommand("gh", ["pr", "merge", "12"])).toContain("not read-only");
    expect(validateStatusCommand("find", [".", "-delete"])).toContain("not allowed");
    expect(validateStatusCommand("gh", ["api", "repos/example", "--method=POST"])).toContain("default GET");
    expect(validateStatusCommand("tail", ["-f", "worker.log"])).toContain("process tool");
    expect(validateStatusCommand("curl", ["https://example.com"])).toContain("allowlist");
    expect(validateStatusCommand("bash", ["-lc", "echo unsafe"])).toContain("allowlist");
  });
});
