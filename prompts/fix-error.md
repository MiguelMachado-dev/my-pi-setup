---
description: Diagnose and fix an error from pasted output, then verify the fix works
allowed-tools: Bash, Read, Edit, Glob, Grep
argument-hint: [paste the error output]
---

# Fix Error

Diagnose and fix the error in `$ARGUMENTS`.

## Process

1. **Parse the error** — Extract the root cause from the stack trace or log output. Ignore noise.

2. **Locate the source** — Find the exact file and line causing the error. Read surrounding context.

3. **Diagnose** — Identify why it fails. Check for:
   - Missing imports/dependencies
   - Type mismatches
   - Wrong API usage
   - Environment/config issues
   - Build/bundler issues

4. **Fix** — Apply the minimal fix. Do not refactor surrounding code.

5. **Verify** — Run the relevant command to confirm the fix works:
   - Build errors → run the build
   - Test failures → run the failing test
   - Runtime errors → check if the fix addresses the root cause
   - Type errors → run type checker

6. **If verification fails** — Read the new error, go back to step 1. Max 5 attempts.

## Output

```
## Fix: [one-line summary]

**Root cause:** [why it broke]
**Fix:** [what changed, file:line]
**Verified:** ✅ | ❌ (attempt N/5)
```
