# My Pi Setup

Personal configuration for [Pi](https://github.com/mariozechner/pi-coding-agent), including model defaults, installed packages, MCP configuration, themes, and bundled workflow assets.

## What is included

- `settings.json` — main Pi settings:
  - default provider: `openai-codex`
  - default model: `gpt-5.6-sol`
  - thinking level: `max`
  - active theme: `ghostty-sync-545c9bd8`
  - installed Pi packages
- `mcp.json` — MCP server configuration, including Playwright browser automation.
- `themes/` — local Pi theme files.
- `skills/` — vendored Pi skills stored as regular directories so a clone does not depend on `~/.agents/skills`.
- `.gitignore` — excludes local auth, sessions, binaries, caches, logs, and OS files.

## Not included

The following are intentionally ignored and should not be committed:

- `auth.json`
- `sessions/`
- `bin/`
- `git/`
- `npm/`
- MCP cache/onboarding files
- logs and `.DS_Store`

## Restore this setup

Clone the repository into your Pi agent config directory:

```bash
git clone https://github.com/MiguelMachado-dev/my-pi-setup.git ~/.pi/agent
```

If `~/.pi/agent` already exists, back it up first:

```bash
mv ~/.pi/agent ~/.pi/agent.backup
git clone https://github.com/MiguelMachado-dev/my-pi-setup.git ~/.pi/agent
```

Then start Pi normally. Pi should read `settings.json`, `mcp.json`, packages, themes, and the vendored skills from this directory.

## Managing skills

Skills in `skills/` are committed as regular directories rather than symlinks. This keeps the setup portable: cloning or pulling the repository also restores the skill contents, without requiring a separate `~/.agents/skills` installation.

Install or refresh a skill specifically for Pi using copy mode:

```bash
npx skills@latest add <source> --global --agent pi --skill <skill-name> --copy --yes
```

After reviewing the resulting files, commit the skill directory normally. Avoid using a multi-agent symlink installation for repository-managed Pi skills, because it can replace these directories with links to files outside this repository.

## MCP setup

This repo configures the Playwright MCP server for browser automation:

```json
{
  "imports": [],
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

Local MCP cache and onboarding state are not tracked.

## Updating the repo

After changing Pi settings, themes, prompts, agents, extensions, skills, or workflows:

```bash
git status
git add .
git commit -m "Update pi setup"
git push
```

## Notes

This repository is intended as a portable backup of personal Pi configuration. Review changes before committing to avoid accidentally adding credentials or machine-specific cache files.
