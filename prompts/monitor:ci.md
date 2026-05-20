---
description: Open the GitHub Actions CI monitor TUI
argument-hint: "[PR-NUMBER|BRANCH]"
---
Use the project-local `/monitor:ci` extension command to monitor GitHub Actions in a live TUI component instead of posting repeated status messages to chat history.

Target: `$ARGUMENTS`

Instructions:

1. If the extension is not loaded yet, tell the user to run `/reload` once.
2. Run the command:
   - `/monitor:ci $ARGUMENTS` when arguments are provided.
   - `/monitor:ci` when no arguments are provided; it will infer the current branch.
3. Do not start a shell polling loop unless the extension is unavailable.
4. The TUI component should update in-place every 10 seconds and show:
   - current UTC timestamp
   - repo and PR/branch target
   - run id/status/duration
   - each job/check status
   - each job/check duration
   - failure logs when a job fails
5. The component exits automatically when CI passes/fails. Users can press `q` or `Esc` to stop it manually.
