---
name: code-review
description: "Review the current diff for correctness bugs at the given effort level (low/medium: fewer, high-confidence findings; high→max: broader coverage, may include uncertain findings). Pass --comment to post findings as inline PR comments."
argument-hint: "[low|medium|high|xhigh|max] [--fix] [--comment] [<target>]. low/medium favor precision (fewer, high-confidence findings); high through max favor recall (broader coverage, may include uncertain findings). --fix applies findings to the working tree; --comment posts inline PR comments."
---

# Code Review

Review the change under review for **correctness bugs** and for
**reuse / simplification / efficiency / altitude** cleanups, then report (or
apply / post) findings.

## How to run

Parse the invocation argument:

1. **Effort level** — the first token, one of `low | medium | high | xhigh | max`.
   If omitted or unrecognized, default to **`medium`** (note the substitution to
   the user). `ultra` is not supported locally — tell the user it is the cloud
   multi-agent review (`/code-review ultra`) and fall back to `max`.
2. **`--fix`** — after producing findings, apply them (see _Applying fixes_).
3. **`--comment`** — after producing findings, post them to the PR (see
   _Posting to GitHub_).
4. **`<target>`** — any remaining text is the review target (a PR number,
   branch name, or file path). If present, prepend a `` Review target: `<target>` ``
   line to your working notes and review that target instead of the local diff.

Then jump to the section for the chosen effort level and follow it exactly. The
**Building Blocks** below are referenced by name from each level — read them
first.

---

# Building Blocks

## BLOCK: Gather the diff (Phase 0)

If a PR number, branch name, or file path was passed as an argument, review that
target instead of the local diff. For a PR target, prefer the PR's own base/head
range (for example, `gh pr diff <target>`) rather than guessing locally.

For a local branch, identify the review base before diffing. Prefer, in order:
the current PR's base branch (`gh pr view --json baseRefName`), the remote
default branch (`git symbolic-ref refs/remotes/origin/HEAD --short`), then
`origin/main`, `main`, or `master`. Use `git diff <base>...HEAD` against that
base. Do **not** default to `@{upstream}`: on pushed feature branches it often
means `origin/<current-branch>` and can hide the entire PR diff.

If there are uncommitted changes, or the range diff is empty, also run
`git diff HEAD` and include the working-tree changes in scope — the review often
runs before the commit. Treat the combined diff as the review scope.

## BLOCK: Correctness angles A–C

### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing `await`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.

### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.

### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?

## BLOCK: Correctness angles D–E (recall levels only)

### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, `==` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.

### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
`delegate` field that resolves IDs via `session.get(...)` instead of
`delegate.get(...)` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.

## BLOCK: Cleanup angles

### Reuse

The angles above hunt for bugs; this one and the next two hunt for cleanup in
the changed code. Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Name the cheaper alternative.

## BLOCK: Altitude angle

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.

## BLOCK: Candidate shape note

Cleanup and altitude candidates use the same `file`/`line`/`summary` shape; in
`failure_scenario`, state the concrete cost (what is duplicated, wasted, or
harder to maintain) instead of a crash. Correctness bugs always outrank
cleanup and altitude findings when the output cap forces a cut.

## BLOCK: Verify — 1-vote, 3-state (precision)

Dedup candidates that point at the same line/mechanism, keeping the one with
the most concrete failure scenario. For each remaining candidate, run **one
verifier** (a fresh sub-agent): give it the diff, the relevant file(s), and the
candidate, and have it return exactly one of:

- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.

Keep candidates where the vote is CONFIRMED or PLAUSIBLE.

## BLOCK: Verify — 1-vote, recall-biased

Dedup near-duplicates (same defect, same location, same reason → keep one). For
each remaining candidate, run **one verifier** (a fresh sub-agent): give it the
diff, the relevant file(s), and the candidate; it returns exactly one of
**CONFIRMED / PLAUSIBLE / REFUTED**.

**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.

Keep **CONFIRMED and PLAUSIBLE**. Drop REFUTED.

## BLOCK: Sweep for gaps (recall levels only)

Run **one more finder** as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there — the job is gaps. Focus
on what the first pass tends to miss: moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, `hash()`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return an empty sweep — do not pad.

## BLOCK: Output (cap = N)

Keep the verified findings in an internal structured list of at most **N**
objects while reasoning. Each object should have:

```json
{
  "priority": "high | medium | low | nit",
  "file": "path/to/file.ext",
  "line": 123,
  "summary": "one-sentence statement of the issue",
  "failure_scenario": "concrete inputs/state → wrong output/crash or concrete maintenance cost"
}
```

Assign priority before ranking:

- **High** — likely user-blocking, data-loss/security, silent wrong result, or
  crash in a common path.
- **Medium** — real correctness bug or meaningful maintainability/performance
  issue, but limited to less-common state or has an obvious workaround.
- **Low** — edge-case bug, confusing UX, minor inefficiency, or small cleanup
  with limited impact.
- **Nit** — style, naming, local readability, or tiny duplication with no clear
  runtime/user-facing impact.

Rank by priority (`high` → `medium` → `low` → `nit`) and severity within each
priority. If more than N survive, keep the N most severe. Correctness bugs
outrank cleanup and altitude findings when the output cap forces a cut.

Do **not** return the raw JSON; use it only as internal structure. Instead,
render a concise Markdown report:

```markdown
## Code review findings

### High
1. `path/to/file.ext:123` — Summary. **Scenario:** concrete trigger and impact.

### Medium
1. `path/to/file.ext:456` — Summary. **Scenario:** concrete trigger and impact.

### Low / Nit
1. `path/to/file.ext:789` — Summary. **Scenario:** concrete trigger and impact.
```

Omit empty priority sections. Use `Low / Nit` for low-priority cleanup/nit
items, or split into separate `Low` and `Nit` sections if both contain multiple
items. If nothing survives verification, return exactly `(none)`.

> Note: the recall-level flows dispatch finder/verifier work to parallel
> sub-agents (e.g. the Task/Agent tool). If sub-agents are unavailable, perform
> each angle and verification yourself as separate, focused passes.

---

# Effort Levels

## LEVEL: low — `1 diff pass → no verify → ≤4 findings`

### Turn 1 — read

One tool call: read the unified diff from the explicit target or from the local
review base chosen by **BLOCK: Gather the diff (Phase 0)**, plus `git diff HEAD`
to cover committed and uncommitted changes. Skip test/fixture hunks (`test/`, `spec/`,
`__tests__/`, `*_test.*`, `*.test.*`, `fixtures/`, `testdata/`) — test-file
changes are not reviewed at this level. No subagents, no full-file reads.

### Turn 2 — findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing `await`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag — still from the hunk alone — new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the hunk.

Normalize each finding with a priority and do **BLOCK: Output (cap = 4)**. If
nothing qualifies, output exactly `(none)`.

## LEVEL: medium — `3+4 angles × 6 candidates → 1-vote verify → ≤8 findings`

You are reviewing for **precision**: every finding you surface should be one a
maintainer would act on.

1. Do **BLOCK: Gather the diff (Phase 0)**.
2. **Phase 1 — Find candidates** (3 correctness + 3 cleanup + 1 altitude angle,
   up to **6 each**). Run **7 independent finder angles**, each returning up to
   6 candidates with `file`, `line`, one-line `summary`, concrete
   `failure_scenario`:
   - **BLOCK: Correctness angles A–C**
   - **BLOCK: Cleanup angles** (Reuse, Simplification, Efficiency)
   - **BLOCK: Altitude angle**
   - **BLOCK: Candidate shape note**
   - Pass every candidate with a nameable failure scenario through — finders that
     silently drop half-believed candidates bypass the verify step and are the
     dominant cause of misses.
3. **Phase 2** — do **BLOCK: Verify — 1-vote, 3-state (precision)**.
4. **Output** — do **BLOCK: Output (cap = 8)**.

## LEVEL: high — `3+4 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10 findings`

You are reviewing for **recall**: catch every real bug a careful reviewer would
catch in one sitting. Catching real bugs matters more than avoiding false
positives. Err on the side of surfacing.

1. Do **BLOCK: Gather the diff (Phase 0)**.
2. **Phase 1 — Find candidates** (3 correctness + 3 cleanup + 1 altitude angle,
   up to **6 each**). Run **7 independent finder angles**:
   - **BLOCK: Correctness angles A–C**
   - **BLOCK: Cleanup angles**
   - **BLOCK: Altitude angle**
   - **BLOCK: Candidate shape note**
   - Pass every candidate with a nameable failure scenario through.
3. **Phase 2** — do **BLOCK: Verify — 1-vote, recall-biased**.
4. **Output** — do **BLOCK: Output (cap = 10)**.

## LEVEL: xhigh — `5+4 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings`

You are reviewing for **recall** at extra-high effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.

1. Do **BLOCK: Gather the diff (Phase 0)**.
2. **Phase 1 — Find candidates** (5 correctness + 3 cleanup + 1 altitude angle,
   up to **8 each**). Run **9 independent finder angles**, each up to 8
   candidates. Do NOT let one angle's conclusions suppress another's — if two
   angles flag the same line for different reasons, record both:
   - **BLOCK: Correctness angles A–C**
   - **BLOCK: Correctness angles D–E**
   - **BLOCK: Cleanup angles**
   - **BLOCK: Altitude angle**
   - **BLOCK: Candidate shape note**
3. **Phase 2** — do **BLOCK: Verify — 1-vote, 3-state (precision)**. This is
   recall mode — a single non-REFUTED vote carries the finding. Do NOT drop on
   uncertainty.
4. **Phase 3** — do **BLOCK: Sweep for gaps**.
5. **Output** — do **BLOCK: Output (cap = 15)**.

## LEVEL: max — `5+4 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings`

Identical to **xhigh**, but you are reviewing at **maximum** effort. Follow the
xhigh steps exactly, with the same caps (9 angles × 8 candidates, Phase 3 sweep,
≤15 findings).

---

# Modifiers

## Posting to GitHub (`--comment`)

After producing the findings list, if the review target is a GitHub PR, post
each finding as an inline PR comment via
`gh api` (one call per finding;
include a suggestion block only when it fully fixes the issue). If
the target is not a PR, print the findings to the terminal and note that
`--comment` was ignored.

## Applying fixes (`--fix`)

After producing the findings list, apply the findings to the working tree
instead of stopping at the report: fix each one directly — correctness bugs and
reuse/simplification/efficiency cleanups alike. Skip any finding whose fix would
change intended behavior, require changes well outside the reviewed diff, or
that you judge to be a false positive — note the skip rather than arguing with
it. Finish with a brief summary of what was fixed and what was skipped.
