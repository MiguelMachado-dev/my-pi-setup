---
description: Watch CI, diagnose failures, fix them, push changes, and repeat until green
allowed-tools: Bash(gh:*), Bash(git:*), Read, Edit, Glob, Grep
---

# Fix CI

Watch CI runs on the current branch. If CI fails, diagnose the failure, fix it, push, and wait again. Max 10 attempts.

## Process

1. **Get Current Branch**
   - Run `git branch --show-current`

2. **Check for Running CI**
   - Run `gh run list --branch <branch> --limit 1`
   - If a run is in progress, wait for it: `gh run watch <run-id>`

3. **Evaluate Result**
   - If CI passes: report success and stop
   - If CI fails: go to step 4

4. **Diagnose Failure**
   - Get failed job logs: `gh run view <run-id> --log-failed`
   - Parse error output to identify root cause

5. **Fix the Error**
   - Read the relevant files
   - Apply the fix

6. **Commit and Push the Fix**
   - Run `git status` and `git diff` (staged + unstaged)
   - Run `git log --oneline -5` to match commit style
   - Stage only relevant files by name (never `git add .`)
   - Skip secrets, `.env`, credentials
   - Commit with `fix: <what was fixed>` (conventional commit)
   - Push to remote

7. **Loop**
   - Go back to step 2
   - Repeat until CI passes or 10 attempts exhausted

## Output

```
## CI Fix

### Result: ✅ Green after N attempts | ❌ Failed after 10 attempts

### Fixes Applied
- Attempt N: [file:line] — [what was fixed]

### Final CI Run
- [link to run]
```
