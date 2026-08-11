# Luna Heartbeat

Session-scoped, root-routed monitoring for asynchronous work in Pi.

## Flow

1. Root Sol starts background workers and records their agent IDs.
2. Root registers observable work with `luna_heartbeat`.
3. The extension runs read-only status commands without a shell.
4. It classifies and deduplicates state transitions.
5. Actionable transitions wake Root Sol.
6. Root checks the responsible worker with `get_subagent_result`, then uses `steer_subagent` or resumes it with `Agent`.

Use the `process` tool instead when a local long-running process can report readiness, failure, or completion from logs and exit status.

## Example

```json
{
  "action": "register",
  "monitor": {
    "id": "pr-123-ci",
    "workItem": "PR 123 CI",
    "statusSource": "GitHub Actions run 123456",
    "responsibleAgentId": "agent-id-from-Agent",
    "responsibleTask": "Fix PR 123 CI",
    "executable": "gh",
    "args": [
      "run",
      "view",
      "123456",
      "--json",
      "status,conclusion",
      "--jq",
      ".status + \":\" + (.conclusion // \"\")"
    ],
    "cadenceSeconds": 180,
    "conditions": {
      "healthyPattern": "queued|in_progress",
      "attentionPattern": "completed:(failure|cancelled|timed_out|action_required)",
      "terminalPattern": "completed:success"
    },
    "requestedAction": "Inspect failed checks and fix the responsible code without expanding scope.",
    "urgency": "high"
  }
}
```

Manage monitors with `list`, `check`, `pause`, `resume`, `remove`, and `clear` actions.

## Luna agent

The global `heartbeat-monitor` agent uses `gpt-5.6-luna` for bounded semantic reviews of ambiguous or multi-source status. It returns routing packets to Root Sol. Cadence and deterministic checks remain in the extension so unchanged healthy states consume no model turns.

## Boundaries

- Monitors persist in the Pi session and restore on resume.
- They stop when that Pi session is not running.
- The extension routes through Root Sol because child agents cannot directly steer sibling workers in the installed subagent extension.
- Independent Pi processes require Herdr or another external bridge.
