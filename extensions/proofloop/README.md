# Pi Proofloop Pilot

A record-only, cross-tab implementation observer for Pi sessions managed by Herdr.

## What it proves

- The exact Git state present at attachment becomes the immutable baseline.
- Existing staged, unstaged, deleted, renamed, and untracked changes remain preexisting.
- Later fingerprint changes are attributed to the observed run.
- A configured validation is tied to the Git mutation fingerprint at which it ran.
- Repeating a failing validation without a mutation produces `REPEATED_VALIDATION`; duplicate successful validation is idempotent.
- Herdr `blocked` is actionable; `idle` or `done` settles only after post-baseline activity and every observed background Pi Agent and managed process is terminal.
- Contracts, evidence, routes, and settlement records live under `~/.pi/agent/proofloop/runs/`.

## Launcher

Run this in a new Pi tab dedicated to one task:

```text
/proofrun TTPM-3048
```

The command resolves the current Git worktree, captures its baseline, attaches Proofloop to the current Herdr pane and Pi session, and only then dispatches the task to the same agent. No separate `proofwatch` tab is required.

The generated writer prompt requires task-specific checks plus one final exact `bash` validation after the last mutation:

```text
git diff --check
```

The current tab owns the observer. Keep it open until settlement; closing or reloading it stops live supervision.

## Interface

The `proofloop` tool supports:

- `start`: attach, verify target identity, capture a stable baseline, and begin observation.
- `status`: read the current materialized state.
- `check`: force one journal, Git, and lifecycle observation.
- `stop`: perform a final observation and stop the observer.

Session-file and Herdr events trigger observations automatically after `start`.

## Evidence

Each run writes:

```text
contract.json
baseline.json
blobs/
events.jsonl
routes.jsonl
state.json
settlement.json
```

`routes.jsonl` contains would-route packets. The pilot never delivers them.

## Safety

- Only `record-only` routing is accepted.
- The observer never writes to the product worktree.
- Git commands are read-only and use `GIT_OPTIONAL_LOCKS=0`.
- The observer never prompts, steers, resumes, retries, stops, or otherwise controls the writer.
- A run attached after work began proves only post-baseline activity.
- No rollback or sandbox is provided.

## Pilot limits

- One Pi session owns the live run; automatic crash recovery and a standalone daemon are not implemented.
- Background Pi Agent and managed `process` starts and terminal records are reconstructed from the parent journal, including work already active at attachment. Child transcripts and live internal progress are not inspected.
- A configured `process` validation passes or fails only when its lifecycle notification arrives; the immediate start result never counts as completion.
- Process lifecycle events are consumed directly from the process extension and persisted journal records remain a recovery fallback.
- A successful named retry clears the matching recoverable process failure; unrelated failures remain blocking.
- An active `ask_user_question` puts the run into `waiting` and pauses checkpoint and hard-stop budgets until an answer arrives.
- Asynchronous work owned by other extensions is not part of terminal settlement unless it emits one of the supported journal protocols.
- Validation matching is exact after conservative whitespace normalization; a larger composite shell command does not satisfy a shorter configured command.
- The pilot does not run validation commands or implement BUILD/HARDEN test admission.
- Luna Heartbeat remains responsible for external CI, deployment, queue, and repository status checks.
