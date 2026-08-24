---
name: figma-fidelity-review
description: Compare a local web page or screenshot with a specific Figma frame and return measured, breakpoint-scoped CSS and layout fixes. Use for visual-fidelity reviews that need exact spacing, typography, sizing, or positioning changes rather than general design critique.
disable-model-invocation: true
---

# Figma Fidelity Review

Turn visual differences into a verified CSS handoff. Review is read-only by default; modify source only when the user separately asks for implementation.

## Establish a comparable view

Identify the exact Figma frame or node, local page state, and viewport. Use the Figma frame dimensions or the user's named device preset rather than a nearby responsive width. Match zoom, scroll position, content, fonts, assets, and interactive state before measuring.

If a Figma URL is available, load the Figma design-to-code guidance before fetching design context. Capture the design screenshot and node measurements. If a local URL is available, open it in a real browser at the same viewport and capture a fresh screenshot; otherwise use the supplied screenshot. Treat multiple annotated or cropped screenshots as separate evidence items while preserving any shared scope such as "mobile only."

When the two views cannot be normalized, report the mismatch in viewport or state and avoid presenting guessed pixel values as exact.

## Inspect element by element

Work top-to-bottom through corresponding Figma nodes and DOM elements. For each element, record:

- its parent and bounding box;
- padding, margin, gap, width, height, and alignment;
- font family, size, weight, line height, letter spacing, and wrapping;
- border, radius, color, shadow, and asset dimensions when relevant;
- positioned offsets and containing block for decorative or absolute elements;
- the active responsive rule and computed browser value.

Use the browser's element inspector or equivalent computed-style evidence. Map each visible difference to the source selector, component, utility class, or inline rule when the codebase is available.

## Isolate root causes

Resolve structural flow differences before downstream typography and decorative offsets. Compare coordinates relative to the same parent so an upstream spacing error is not repeated as several child fixes.

For each candidate change, temporarily apply the CSS in DevTools or through reversible browser style injection, recapture the affected view, and confirm that the measured gap closes without shifting an already-correct sibling. Keep independent offsets independent; for example, decorative text and its arrow may need different `top` values.

## Return an exact handoff

Lead with the smallest set of changes that closes the observed gaps. Report findings in cascade order using these fields:

| Scope | Element and evidence | Current implementation | Figma target | Exact fix | Confidence |
| ----- | -------------------- | ---------------------- | ------------ | --------- | ---------- |

For every row:

- name the viewport or breakpoint, such as base/mobile or `md` and above;
- cite the screenshot, Figma node, DOM element, or code location used as evidence;
- separate the current computed value from the measured Figma value;
- give a ready-to-apply declaration or utility-class replacement;
- state whether the candidate was live-tested or only measured.

Preserve matching values as "keep as is" when that prevents an implementer from changing a correct element. For utility CSS, prefer the repository's existing scale when it produces the exact target; otherwise use an arbitrary value consistent with repository conventions. Do not widen a mobile correction to desktop unless the comparison proves both breakpoints need it.

End with remaining uncertainty only when evidence is incomplete. Label visual estimates as estimates and state the measurement needed to make them exact.

## Completion bar

The review is complete when every visible mismatch in the supplied scope is either mapped to one root CSS change, marked as already correct, or explicitly left uncertain with a reason. When a live page is available, exact fixes must be verified in the target viewport before being called verified.
