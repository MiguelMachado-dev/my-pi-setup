---
description: Stage, commit with conventional commits, push, and optionally create a PR
argument-hint: [optional: pr or PR title]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(open:*)
---

# Ship Changes

Stage, commit, push, and optionally open a PR.

## Request

$ARGUMENTS

## Process

1. **Check State**
   - Run `git branch --show-current`
   - Run `git status` and `git diff` (staged + unstaged)
   - Run `git log --oneline -5` to match commit style

2. **Stage**
   - Add relevant files by name (never `git add .`)
   - Skip secrets, `.env`, credentials

3. **Commit**
   - Use conventional commits format: `type(scope): description`
   - Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`
   - Never mention "Claude Code"
   - Use imperative mood
   - Keep under 72 characters

4. **Push**
   - Push to `origin <current-branch>` automatically
   - If no upstream exists, run `git push -u origin <current-branch>`
   - If current branch is `main`, ask for explicit user confirmation before pushing

5. **PR**
   - Create a PR only if the request above includes "pr" or a PR title
   - Follow the PR body standards from `open-pr.md`
   - Create PR with `gh pr create`
   - Include concise title, summary, mermaid diagram, test plan, and notes
   - Get the PR URL and run `open <pr-url>`
