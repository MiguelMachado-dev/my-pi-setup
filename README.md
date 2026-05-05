# My Pi Setup

Personal configuration for [Pi](https://github.com/mariozechner/pi-coding-agent), including model defaults, installed packages, MCP configuration, themes, and bundled workflow assets.

## What is included

- `settings.json` — main Pi settings:
  - default provider: `openai-codex`
  - default model: `gpt-5.5`
  - thinking level: `high`
  - active theme: `ghostty-sync-545c9bd8`
  - installed Pi packages
- `mcp.json` — MCP imports and server configuration, including Atlassian MCP.
- `themes/` — local Pi theme files.
- `.pi/gsd/` — GSD workflow package assets, prompts, agents, templates, hooks, and references.
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

Then start Pi normally. Pi should read `settings.json`, `mcp.json`, packages, and theme configuration from this directory.

## MCP setup

This repo imports MCP configuration from Claude tools and defines an Atlassian server:

```json
{
  "imports": ["claude-code", "claude-desktop"],
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://mcp.atlassian.com/v1/mcp/authv2"]
    }
  }
}
```

Authentication and local onboarding state are not tracked. Re-authenticate MCP servers locally when needed.

## Updating the repo

After changing Pi settings, themes, prompts, agents, or workflows:

```bash
git status
git add .
git commit -m "Update pi setup"
git push
```

## Notes

This repository is intended as a portable backup of personal Pi configuration. Review changes before committing to avoid accidentally adding credentials or machine-specific cache files.
