# glm-usage-status

Shows your **Z.AI GLM Coding Plan** usage in the pi status line — the 5-hour and
weekly quota windows, plus MCP usage and 24h token/call counts. Mirrors the
`codex-usage-status` extension's footer style (remaining %, green/yellow/red by
threshold, reset times).

## Setup

### 1. Authenticate (usually already done)

The extension reads your Z.AI key from **pi's own auth store** (`~/.pi/agent/auth.json`) —
the same place the built-in `zai` provider stores it after you run `/login` and pick
**Z.AI**. If you already use GLM models in pi, **no extra setup is needed**.

You can also supply the key via env var (checked after the auth store):

```sh
# fish
set -Ux ZAI_API_KEY "your-zai-api-key"

# bash / zsh
echo 'export ZAI_API_KEY="your-zai-api-key"' >> ~/.zshrc
```

### 2. Reload

Run `/reload` in pi (or restart). You should see a footer line like:

```
GLM 5h 59% 3:45 PM | W 48% Sat 13
```

## Commands

| Command | Description |
| --- | --- |
| `/glm` | Full breakdown panel (bars + reset countdowns + MCP + 24h tokens) above the editor. Dismisses on your next message, or `/glm-usage:hide`. |
| `/glm-usage:refresh` | Refresh the footer now. |
| `/glm-usage:settings` | Change auto-refresh cadence. |
| `/glm-usage:hide` | Hide the detail panel. |

## LLM tool

Registers `glm_usage`, so you can ask the agent *"how much GLM quota do I have left?"*.

## Auto-refresh

- On session start, plus a periodic timer (default 5 min) — the 5h window is
  time-based, so the % ticks down even when idle.
- After every N turns (default 5), for responsiveness while coding.
- Tune both via `/glm-usage:settings`; persisted to `settings.json`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `ZAI_API_KEY` | — | Fallback key if not present in pi's auth store. (`ZAI_TOKEN` / `ZHIPU_API_KEY` also accepted.) The auth store (`~/.pi/agent/auth.json`, `zai`/`zai-coding-cn` entries) is checked **first**. |
| `ZAI_BASE_URL` | `https://api.z.ai` | Override the API base (e.g. CN: `https://open.bigmodel.cn` — then the `zai-coding-cn` auth entry is used). |

## How it works

Hits Z.AI's monitor endpoints (token sent as a raw `Authorization` header, no
`Bearer` prefix):

- `GET /api/monitor/usage/quota/limit` — 5h / weekly / MCP percentages + reset times + plan tier
- `GET /api/monitor/usage/model-usage?startTime&endTime` — 24h tokens / calls
- `GET /api/monitor/usage/tool-usage?startTime&endTime` — 24h search / web-read / zread counts
