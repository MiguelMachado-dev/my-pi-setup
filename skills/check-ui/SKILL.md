---
name: check-ui
description: Verify changed web UI in a real browser with the agent-browser CLI, including rendering, interaction, navigation, screenshots, and console errors. Use after implementing or changing a frontend feature, when a user asks to browser-test a screen, or before claiming a UI issue is complete.
---

# Check UI in a real browser

Use this skill after a frontend change or whenever the user asks for a browser check. Code tests and a successful build do not replace a real-browser verification.

## Prepare the check

1. Read the repository's `AGENTS.md`, `CLAUDE.md`, package scripts, and the task description for the app, port, route, and expected behavior.
2. Verify the CLI: `agent-browser --version`. If missing, install with `bun install -g agent-browser`. For the full version-matched command reference, run `agent-browser skills get core`.
3. Start the smallest relevant dev server if one is not already listening. Prefer the repository's documented command, normally `bun dev` or `bun --filter @tt/<app> dev`. Known local defaults include:
   - FareTracker: `http://localhost:4001`
   - card-benefit-tracker: port `4100`, with `cardtracker.localhost`, `app.cardtracker.localhost`, and `backoffice.cardtracker.localhost`
   - ThriftyTraveler webapp: port `3000`; backoffice: port `3002`
4. Use the exact route named by the user or issue. If several routes are affected, check each one. Do not substitute a nearby route just because it is easier to open.

## Drive the browser

The CLI runs a background daemon, so consecutive commands share one live browser session — open once, then interact freely. Typical loop:

1. `agent-browser open <url>` — navigate and wait for load.
2. `agent-browser snapshot` — accessibility tree with refs (`@e1`, `@e2`...). Confirm the page reached the expected screen.
3. Exercise the changed behavior, not just the initial render. Interact using refs from the snapshot: `click @e1`, `fill @e2 "text"`, `select`, `press Enter`, `hover`, `check`. Also available: `upload`, `drag`, `scroll`, `tab` for multi-tab flows.
4. Re-snapshot after the interaction and verify the expected text, state, URL, visibility, or navigation result. `get text <sel>`, `get url`, and `is visible <sel>` are cheap point checks; `diff snapshot` compares against the previous snapshot.
5. `agent-browser screenshot <path>` — capture the verified result. When responsive behavior is part of the change, use `set viewport <w> <h>` to check a desktop and a mobile viewport.
6. Read `agent-browser console` and `agent-browser errors` and flag errors, uncaught exceptions, failed requests, and React hydration warnings. `network requests` lists outbound requests. Ignore only clearly unrelated known noise and name it in the report.
7. Check important outbound links and buttons for the expected destination and safe behavior when the feature changes navigation.
8. `agent-browser close` when done — it frees the daemon's session.

If authentication is required, use an existing local browser session. If the browser reaches an OIDC or login screen and no usable session exists, ask the user to complete the local login in that browser, then continue. Do not invent credentials, bypass authentication, or call a UI check successful without reaching the target screen.

## Handle failures

Treat a rendering error, failed interaction, incorrect state, unexpected navigation, console error, or hydration warning as a failed check. Inspect the browser evidence, fix the underlying issue when implementation is in scope, and repeat the same browser check. If the agent-browser CLI is unavailable or the daemon fails to launch, report the check as blocked and include the exact error; do not silently replace it with a static code inspection.

Do not use a screenshot alone as proof of behavior. Do not claim a feature is browser-verified when the app was never opened at the target route.

## Report

Return a concise evidence-based report:

- `PASS`, `FAIL`, or `BLOCKED`
- exact URL and viewport(s)
- interactions performed and observed result
- screenshot path or attachment
- console and network errors, or that none were observed
- any authentication, environment, or route limitation

For a `FAIL`, identify the first reproducible symptom and keep the feature unverified until a rerun passes.
