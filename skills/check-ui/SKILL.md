---
name: check-ui
description: Verify changed web UI in a real browser with the configured Playwright MCP, including rendering, interaction, navigation, screenshots, and console errors. Use after implementing or changing a frontend feature, when a user asks to browser-test a screen, or before claiming a UI issue is complete.
---

# Check UI in a real browser

Use this skill after a frontend change or whenever the user asks for a browser check. Code tests and a successful build do not replace a real-browser verification.

## Prepare the check

1. Read the repository's `AGENTS.md`, `CLAUDE.md`, package scripts, and the task description for the app, port, route, and expected behavior.
2. Inspect the repository `.mcp.json`. Use its `playwright` MCP server; the configured command is `npx -y @playwright/mcp@latest`.
3. Start the smallest relevant dev server if one is not already listening. Prefer the repository's documented command, normally `bun dev` or `bun --filter @tt/<app> dev`. Known local defaults include:
   - FareTracker: `http://localhost:4001`
   - card-benefit-tracker: port `4100`, with `cardtracker.localhost`, `app.cardtracker.localhost`, and `backoffice.cardtracker.localhost`
   - ThriftyTraveler webapp: port `3000`; backoffice: port `3002`
4. Use the exact route named by the user or issue. If several routes are affected, check each one. Do not substitute a nearby route just because it is easier to open.

## Drive the browser

Use the Playwright MCP tools exposed in the current Codex session. Typical operations are `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_wait_for`, `browser_take_screenshot`, and `browser_console_messages`.

1. Navigate to the target URL.
2. Take an accessibility snapshot and confirm the page reached the expected screen.
3. Exercise the changed behavior, not just the initial render. Click, type, submit, navigate, dismiss, or otherwise use the control affected by the change.
4. Re-snapshot after the interaction and verify the expected text, state, URL, visibility, or navigation result.
5. Take a screenshot of the verified result. Use a desktop and mobile viewport when responsive behavior is part of the change.
6. Read console messages and flag errors, uncaught exceptions, failed requests, and React hydration warnings. Ignore only clearly unrelated known noise and name it in the report.
7. Check important outbound links and buttons for the expected destination and safe behavior when the feature changes navigation.

If authentication is required, use an existing local browser session. If the browser reaches an OIDC or login screen and no usable session exists, ask the user to complete the local login in that browser, then continue. Do not invent credentials, bypass authentication, or call a UI check successful without reaching the target screen.

## Handle failures

Treat a rendering error, failed interaction, incorrect state, unexpected navigation, console error, or hydration warning as a failed check. Inspect the browser evidence, fix the underlying issue when implementation is in scope, and repeat the same browser check. If the Playwright MCP is unavailable, report the check as blocked and include the exact unavailable tool or connection error; do not silently replace it with a static code inspection.

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
