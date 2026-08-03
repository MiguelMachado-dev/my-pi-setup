# kimi-usage-status

Shows your **Kimi (Moonshot AI) Coding Plan** usage in the pi status line — the
5-hour and weekly quota windows with reset times, plus max parallel sessions in
the detail panel. Footer shows remaining %, colored green/yellow/red by threshold
(same style as the `codex-usage-status` extension).

## Setup

### 1. Authenticate (usually already done)

The extension reads your Kimi Coding Plan key from **pi's own auth store**
(`~/.pi/agent/auth.json`) — the same place the built-in `kimi-coding` provider
stores it after you run `/login` and pick **Kimi**. If you already use Kimi
models in pi, **no extra setup is needed**.

You need a **Kimi Code console** API key (format `sk-kimi-xxx`) — not a Kimi Open
Platform key (`sk-xxx` from platform.kimi.com); the two are not interchangeable.

You can also supply the key via env var (checked after the auth store):

```sh
# fish
set -Ux KIMI_API_KEY "sk-kimi-..."

# bash / zsh
echo 'export KIMI_API_KEY="sk-kimi-..."' >> ~/.zshrc
```

### 2. Reload

Run `/reload` in pi (or restart). You should see a footer line like:

```
Kimi 5h 99% 7:54 PM | W 91% Jul 23
```

## Commands

| Command | Description |
| --- | --- |
| `/kimi` | Full breakdown panel (bars + reset countdowns + plan tier + parallel limit) above the editor. Dismisses on your next message, or `/kimi-usage:hide`. |
| `/kimi-usage:refresh` | Refresh the footer now. |
| `/kimi-usage:settings` | Change auto-refresh cadence. |
| `/kimi-usage:hide` | Hide the detail panel. |

## LLM tool

Registers `kimi_usage`, so you can ask the agent *"how much Kimi quota do I have left?"*.

## Auto-refresh

- On session start, plus a periodic timer (default 5 min) — the 5h window is
  time-based, so the % ticks down even when idle.
- After every N turns (default 5), for responsiveness while coding.
- Tune both via `/kimi-usage:settings`; persisted to `settings.json`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `KIMI_API_KEY` | — | Fallback key if not present in pi's auth store (`KIMI_CODING_API_KEY` also accepted). The auth store (`~/.pi/agent/auth.json`, `kimi-coding` entry) is checked **first**. |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding/v1` | Override the API base URL. |

## How it works

Hits the Kimi Code usage endpoint with `Authorization: Bearer <key>` and a
`KimiCLI` user agent:

- `GET /usages` — plan tier (`user.membership.level`), weekly window (`usage`),
  short rate windows (`limits[]`, e.g. the 300-minute / 5h window), and max
  parallel sessions (`parallel.limit`). Falls back to `GET /usage` on 404.

Quota values come back as 0–100 percentage points per window; the extension
derives remaining % and reset countdowns from `resetTime`.
