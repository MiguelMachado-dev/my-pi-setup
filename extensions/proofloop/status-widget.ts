import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RunView } from "./types";

export const PROOFLOOP_STATUS_KEY = "proofloop";

export function setProofloopStatus(context: ExtensionContext | undefined, view?: RunView): void {
  if (!context?.hasUI) return;
  context.ui.setStatus(PROOFLOOP_STATUS_KEY, undefined);
  if (!view) {
    context.ui.setWidget(PROOFLOOP_STATUS_KEY, undefined);
    return;
  }
  context.ui.setWidget(
    PROOFLOOP_STATUS_KEY,
    (_tui, theme) => ({
      render(width: number): string[] {
        let marker = theme.fg("accent", "●");
        let status = theme.fg("accent", view.status);
        if (view.status === "passed") {
          marker = theme.fg("success", "●");
          status = theme.fg("success", view.status);
        }
        if (view.status === "waiting") {
          marker = theme.fg("warning", "●");
          status = theme.fg("warning", view.status);
        }
        if (view.status === "attention") {
          marker = theme.fg("warning", "●");
          status = theme.fg("warning", view.status);
        }
        if (view.status === "failed") {
          marker = theme.fg("error", "●");
          status = theme.fg("error", view.status);
        }
        const details = [
          `target ${view.targetState}`,
          `${view.mutationBatchCount} mutations`,
          `validation ${formatValidation(view)}`,
        ];
        if (view.activeBackgroundAgentCount > 0) {
          details.push(`${view.activeBackgroundAgentCount} background Agents`);
        }
        if (view.activeBackgroundProcessCount > 0) {
          details.push(`${view.activeBackgroundProcessCount} background processes`);
        }
        if (view.gate.violations.length > 0) {
          details.push(`${view.gate.violations.length} findings`);
        }
        const trailing = `· ${details.join(" · ")} · ${view.runId}`;
        const line = `${marker} ${theme.bold("Proofloop")} ${status} ${theme.fg("dim", trailing)}`;
        return [truncateToWidth(line, width)];
      },
      invalidate(): void {},
    }),
    { placement: "belowEditor" },
  );
}

function formatValidation(view: RunView): string {
  if (!view.validation.observed) return "pending";
  if (view.validation.repeatedWithoutMutation) return "repeated";
  if (view.validation.stale) return "stale";
  return view.validation.passed ? "passed" : "failed";
}
