---
description: Capture a pi session retrospective into Obsidian
argument-hint: "[optional notes]"
---
# Done — Pi Session Capture

## Overview

Write a retrospective of the current pi conversation to the user's Obsidian vault so it can be mined later for self-reviews and brag documents. One file per session, organized per project, named by date + branch + session id.

Destination: `~/Documents/personal/pi-sessions/<project-folder>/<filename>.md`

Invocation notes from the user, if any: $ARGUMENTS

## When to use

- The user ran `/done` at the end of a pi working session.
- Never run this workflow unprompted — it is explicit.

## Steps

### 1. Gather metadata with shell commands

Run these commands before writing the retrospective; ground facts in command output rather than memory.

- **Project folder**: `basename "$PWD"` — this becomes the subfolder name.
- **Branch**: `git rev-parse --abbrev-ref HEAD 2>/dev/null` (blank if not a git repo).
- **Pi session file / id**: the most recently modified `.jsonl` in the pi session directory for the current cwd. Pi stores sessions in `~/.pi/agent/sessions/--<cwd-with-leading-slash-removed-and-slashes-colons-replaced-by-dashes>--/`.

  Use this shell snippet:

  ```bash
  session_dir="$HOME/.pi/agent/sessions/--$(pwd | sed 's#^/##; s#[/:]#-#g')--"
  session_file="$(ls -t "$session_dir"/*.jsonl 2>/dev/null | head -1)"
  if [ -n "$session_file" ]; then
    session_name="$(basename "$session_file" .jsonl)"
    session_id="$(printf '%s\n' "$session_name" | sed 's/^.*_//')"
  else
    session_id="$(date +%s)"
  fi
  printf '%s\n' "$session_id"
  ```

  If nothing comes back, fall back to `date +%s` so the filename is still unique.
- **Date**: `date +%Y-%m-%d`.
- **Git state for the body**: `git status --short`, `git log --oneline -20`, and `git diff --stat` — use these to populate "Files touched" and "Commits" accurately rather than relying on memory.

### 2. Build the filename

Pattern: `<date>_<branch-sanitized>_<short-session-id>.md`

- Sanitize branch: replace `/` with `-`. If no branch, use `no-git`.
- Short session id: first 8 chars of the session id.
- Example: `2026-04-14_TTPM-2635-back-office-add-an-update-metrics-subhead_019e4713.md`

If the file already exists, append `_2`, `_3`, etc. Never overwrite.

### 3. Create the directory

```bash
mkdir -p ~/Documents/personal/pi-sessions/<project-folder>
```

### 4. Write the markdown file

Use this exact structure. Keep bullets terse and factual.

```markdown
---
date: YYYY-MM-DD
project: <project folder>
branch: <branch or "none">
session_id: <full session id>
cwd: <absolute path>
---

# Session <date> — <branch>

## Summary
<2–4 sentences on what this session was about and what got accomplished. Concrete, not ceremonial.>

## Decisions
- <choice made> — <why>

## Questions raised
- <open question — answered or still open>

## Follow-ups
- [ ] <next action the user or a future session should pick up>

## Files touched
- `path/to/file.ts` — <what changed and why>

## Commits
- `<sha>` — <message>

## Problems hit & how solved
- **Problem**: <symptom or confusion>
  **Fix**: <what actually resolved it>
```

For any section with nothing real to report, write `- None.` — do not pad.

### 5. Report back

Print the absolute path of the file you wrote and a one-line summary, for example: "wrote 6 decisions, 3 follow-ups". Do not paste the full file contents back into the chat.

## Rules

- **Never invent content.** Only include things that actually happened in *this* conversation. Empty section → `- None.`
- **Never commit or push this file.** It lives in the user's personal vault, outside any repo.
- **Never overwrite** an existing file — suffix with `_2`, `_3`, etc.
- **Ground git claims in commands**, not memory. Run `git log`/`git status`/`git diff --stat` before filling "Files touched" and "Commits".
- If the user has uncommitted work in progress, list those files under "Files touched" with a `(uncommitted)` tag so the retrospective isn't misleading.

## Common mistakes

- Writing a task list for *future* work — this is a retrospective, not a plan.
- Padding sections with vague wins ("improved code quality", "refactored for clarity") instead of specifics or `None.`
- Echoing the whole markdown back to the user — just report the path.
- Forgetting the session id lookup and using a timestamp when a real id was available.
- Dropping the file in the repo's `docs/` instead of the Obsidian vault path.
