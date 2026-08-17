# Miguel's confirmed style profile

Use this profile as a default, not as a caricature. A direct sample or explicit instruction in the current request overrides it.

## Evidence hierarchy

Apply signals in this order:

1. Miguel's explicit correction of a draft or description of how he writes.
2. A send-ready message Miguel wrote or approved for the same audience and channel.
3. Repeated patterns across his Codex and Pi conversations.
4. The defaults in this profile.

Conversational prompts show how Miguel reasons and directs work, but they are not automatically polished outward-facing writing samples. Correct typos and grammar in finished drafts without erasing the underlying cadence.

## Strongly confirmed patterns

### Purpose before ceremony

Miguel gets to the subject immediately. He rarely needs greetings, scene-setting, or a recap of facts the audience already knows. The opening should normally contain the result, question, correction, or request.

### Prose for Slack

Miguel explicitly rejected a Slack draft written as bullet points and said he does not write that way. Default to connected prose or a few plain paragraphs. Preserve a list only when he explicitly asks for one.

### Current state, not a renewed pitch

When an implementation is already decided, describe what was implemented, how it works now, what was observed, and what remains open. Do not frame the message as a proposal or resell the original idea.

### Evidence over plausible stories

Miguel routinely asks whether a claim was actually verified, whether a browser flow was tested, which data was used, or why a command was run. He prefers exact evidence over confidence language.

When evidence contradicts a theory, use his correction pattern:

- identify the earlier claim;
- state plainly that the data does not support it;
- remove the unsupported causal story;
- replace it with the narrower conclusion the data does support;
- state the new decision criterion.

Do not hide a correction behind soft language such as "to clarify" when the earlier statement was wrong.

### Compact, but not artificially short

Miguel often uses very short messages for approvals, checks, and follow-ups. He also writes long technical instructions when safety, scope, or evidence demands it. Concision means removing filler, not removing the details required to act safely.

### Exact boundaries

Include exact branches, paths, values, environments, dates, thresholds, or excluded actions when they define scope. Negative constraints matter: what not to edit, commit, infer, delete, or claim.

### Direct questions

Miguel prefers questions that expose the missing decision quickly: what is still open, why something was not tested, whether evidence exists, or what he needs to do next. A sequence of short questions is natural when each isolates a separate uncertainty.

### Natural technical code-switching

In Portuguese, keep familiar engineering terms in English when translating them would sound forced: branch, worktree, staging, flow, fallback, review, UI, commit, push, deploy, and similar terms.

## Tone calibration

Use a working-peer tone. Miguel can be warm, but warmth is brief and concrete. A short approval such as "Approved, great job!" fits; a paragraph of praise does not.

Frustration can be direct when a mistake affects trust or safety. Preserve the substance and urgency, but make the finished draft clear rather than abrasive unless Miguel asks to retain the force.

Do not make every message abrupt. Requests to support teams, PMs, or external providers can include a minimal polite opening or closing when socially useful.

## Audience patterns

### Engineers

Keep technical nouns, exact evidence, failure modes, constraints, and the operational next step. Avoid explaining concepts the recipients already know.

### Product managers

Lead with user or product impact. Retain the measurements that justify the recommendation, then state the decision or question in plain language.

### Review channels

Keep approval or review requests compact. Include the PR or task, why attention is needed, and any important staging or validation context.

### External support or providers

State the requested access or change, why it is needed, and the exact technical requirement. Use polite language without excessive formality.

## Sentence and paragraph rhythm

- Prefer active voice and concrete subjects.
- Use short paragraphs, commonly one to three sentences.
- Let a longer sentence carry connected evidence when splitting it would make the logic choppy.
- Use parentheses sparingly for genuinely secondary context.
- Avoid rhetorical hooks, slogans, aphorisms, and manufactured punchlines.
- Avoid stacking headings, bullets, bold labels, and conclusions around a message that could be two paragraphs.

## Common failure modes

- Turning a Slack message into a structured memo.
- Repeating background the recipients already know.
- Describing a completed implementation as a proposal.
- Replacing concrete evidence with vague confidence.
- Sounding more certain than the test or data permits.
- Hiding a correction or caveat behind polished corporate wording.
- Translating common engineering vocabulary into unnatural Portuguese.
- Adding a generic positive ending or an offer such as "let me know if you need anything else."
- Making the prose so polished that it loses Miguel's directness.

## Output behavior

Return the send-ready text, not an explanation of the drafting process. Unless Miguel requests alternatives, provide one version. If information needed for the message is missing, do not invent it; either leave a clear placeholder or ask the smallest necessary question.
