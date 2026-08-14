import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PROOFLOOP_STATUS_KEY, setProofloopStatus } from "./status-widget";
import type { RunView } from "./types";

function runView(): RunView {
  return {
    runId: "ttpm-3048-shadow-v2",
    status: "observing",
    targetState: "working",
    contractDigest: "contract",
    baselineDigest: "baseline",
    mutationFingerprint: "mutation",
    mutationBatchCount: 2,
    activeBackgroundAgentCount: 1,
    activeBackgroundProcessCount: 1,
    validation: {
      observed: false,
      stale: false,
      repeatedWithoutMutation: false,
    },
    gate: {
      verdict: "pending",
      violations: [],
    },
    evidencePath: "/tmp/evidence",
  };
}

function createHarness(): {
  context: any;
  statuses: Array<{ key: string; value: string | undefined }>;
  widgets: Array<{ key: string; value: unknown; options: unknown }>;
} {
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const widgets: Array<{ key: string; value: unknown; options: unknown }> = [];
  return {
    statuses,
    widgets,
    context: {
      hasUI: true,
      ui: {
        setStatus(key: string, value: string | undefined) {
          statuses.push({ key, value });
        },
        setWidget(key: string, value: unknown, options: unknown) {
          widgets.push({ key, value, options });
        },
      },
    },
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("Proofloop status widget", () => {
  test("renders Proofloop on a dedicated row below the editor", () => {
    const harness = createHarness();

    setProofloopStatus(harness.context, runView());

    expect(harness.statuses).toEqual([{ key: PROOFLOOP_STATUS_KEY, value: undefined }]);
    expect(harness.widgets).toHaveLength(1);
    expect(harness.widgets[0].options).toEqual({ placement: "belowEditor" });
    const factory = harness.widgets[0].value as (_tui: unknown, theme: typeof theme) => {
      render(width: number): string[];
    };
    const component = factory({}, theme);
    const wideLine = component.render(200)[0];
    expect(wideLine).toContain("Proofloop observing");
    expect(wideLine).toContain("target working");
    expect(wideLine).toContain("1 background Agents");
    expect(wideLine).toContain("1 background processes");
    const narrowLine = component.render(40)[0];
    expect(visibleWidth(narrowLine)).toBeLessThanOrEqual(40);
  });

  test("renders the human-input pause state", () => {
    const harness = createHarness();
    const waiting = runView();
    waiting.status = "waiting";

    setProofloopStatus(harness.context, waiting);

    const factory = harness.widgets[0].value as (_tui: unknown, theme: typeof theme) => {
      render(width: number): string[];
    };
    expect(factory({}, theme).render(200)[0]).toContain("Proofloop waiting");
  });

  test("clears both the legacy footer status and dedicated row", () => {
    const harness = createHarness();

    setProofloopStatus(harness.context);

    expect(harness.statuses).toEqual([{ key: PROOFLOOP_STATUS_KEY, value: undefined }]);
    expect(harness.widgets).toEqual([
      { key: PROOFLOOP_STATUS_KEY, value: undefined, options: undefined },
    ]);
  });
});
