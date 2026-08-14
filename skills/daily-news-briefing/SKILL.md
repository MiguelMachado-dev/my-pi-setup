---
name: daily-news-briefing
description: Use when the user asks for a daily news briefing, today's news, hot topics, current events, or "what's happening" on any combination of Brazil, politics (world/US/Brazil), technology, AI, programming, or science. Triggers on phrases like "give me today's news", "daily briefing", "news update", "/daily-news-briefing", and Portuguese equivalents like "notícias de hoje", "briefing diário", "atualização de notícias", "o que está rolando".
---

# Daily News Briefing

> Aggregates daily news across multiple themes into the user's Obsidian vault, grouped by **run date** (not publication date), with multi-perspective coverage, bias notes, historical parallels, and follow-up questions.

## When to Use

Activate when the user:
- Asks for "today's news", "daily briefing", "news update", "what's happening", "hot topics"
- Names one or more of: Brazil, politics, world politics, US politics, Brazilian politics, tech, technology, AI, programming, science
- Invokes `/daily-news-briefing` (or close variants)

**Do NOT use** for: one-off news lookups about a single named event ("what happened with X?"), historical research, or non-news queries.

## Topics → Files

The vault root is **`~/Documents/personal/News/`** (already exists). Each theme writes to its own file:

| Topic | File |
|---|---|
| Brazil (economy, society, culture, non-political) | `Brazil.md` |
| World Politics | `Politics-World.md` |
| US Politics | `Politics-US.md` |
| Brazil Politics | `Politics-Brazil.md` |
| Technology | `Technology.md` |
| AI | `AI.md` |
| Programming | `Programming.md` |
| Science | `Science.md` |

If the user names a subset (e.g. "just AI and Brazil"), only update those files. If unspecified, do **all eight**.

## Per-topic Language

Files have fixed output languages:

| File | Language |
|---|---|
| `Brazil.md` | Brazilian Portuguese |
| `Politics-Brazil.md` | Brazilian Portuguese |
| All other files | English |

This applies to **all** prose, headings, callout titles, lede abstracts, follow-up questions, and tags. The Obsidian callout *type* (`[!info]+`, `[!abstract]+`, etc.) stays as syntax — only user-visible labels translate. Example PT callout: `> [!abstract]+ Manchete do dia`.

The skill itself can be invoked in either language — both `/daily-news-briefing` and "me dá o briefing de hoje" / "notícias de hoje" / "atualização de notícias" should activate it.

## The Run-Date Rule (CRITICAL)

Stories are filed under the **date the skill is run**, NOT the date the news was published. A 3-day-old hot topic surfaced today goes under today's heading.

**Why:** Lets the user reason chronologically about *when they learned* something, not *when it happened*. Avoids retroactively editing prior days.

**How to apply:**
1. Get today's date with `date +%Y-%m-%d` via Bash. Don't trust prior context — always fetch fresh.
2. Read the target file. If it already starts with `## 📅 <today>`, **append** new items under that heading (don't duplicate the date heading).
3. If today's heading is absent, **prepend** a fresh `## 📅 <today>` section above the most recent existing date, separated by `---`.
4. Newest dates always at the top of the file.

## Workflow

```
1. Resolve topics + today's date
2. Per topic, gather (WebSearch + WebFetch) — see Source Map below
3. Filter: last 24–72h, dedupe, prioritize substance over churn
3.5. Verify each cited source is real, current, and the URL resolves. If a search snippet is the only basis for a claim, fetch the article (web_fetch, with paywall-bypass fallback if needed) to confirm the framing — search snippets misrepresent context often enough to matter.
4. Synthesize: multi-perspective, bias notes, parallels, connections
5. Format: Obsidian callouts (see Output Template)
6. Write: prepend or append-under-today per file
7. Surface: 3–5 line summary in chat + invitation to discuss
```

Run gathering steps **in parallel** across topics (one WebSearch call per topic in a single message) — Search results are cheap; the bottleneck is article fetches.

### Paywalled sources

Many high-quality outlets (FT, NYT, WSJ, The Information, Stratechery, etc.) are paywalled. The skill does not avoid them — they're often the best source. Instead:

1. **Note paywalled sources inline** in the source block: `[FT — Title](url) — 2026-04-28 (paywalled) [bypass: sempaywall, removepaywall]`
2. **Provide bypass URLs** when noting a paywalled source. The two bypass services to suggest:
   - `https://sempaywall.com/<URL>`
   - `https://www.removepaywall.com/search?url=<URL>`
3. **For analysis**, attempt `web_fetch` on the original URL first. If the fetch returns a paywall stub or truncated content, retry via `https://sempaywall.com/<original-URL>` before falling back to other sources.
4. **Never paraphrase a paywall stub as if it were the article** — if you can't get the body, either bypass it or pick a different source.

## Source Map

The lists below are **starting points, not a closed set**. They give a fast, diverse default. If a story would benefit from perspectives the listed sources don't cover — a regional outlet for a regional story, an ideological pole missing from the default list, a domain expert for a niche topic, or a primary source (filing, paper, transcript) — search beyond the list. The map is a fast default, not a constraint.

When a topic has a political dimension, **deliberately pull from across the spectrum** rather than letting one perspective dominate. Always label each source's country/leaning when framing matters.

When using state-affiliated outlets (TASS, RT, Xinhua, Press TV), always frame them explicitly as such — they're useful for *how a state narrates itself*, not as standalone fact.

**Cross-topic radar.** `news.ycombinator.com` (Hacker News) is worth checking for *any* technical or science-adjacent topic, not just Technology and Programming. It frequently surfaces AI releases, security incidents, science papers, and infrastructure stories hours-to-days before mainstream press picks them up. Use it as a leading indicator, but treat it as a *pointer to primary sources*, not a primary source itself. Always follow the link to the underlying article/paper/post and cite that.

### Brazil (general — economy, society, culture, non-political)
- Centrist mainstream: folha.uol.com.br, oglobo.globo.com, g1.globo.com, estadao.com.br
- Right-leaning: gazetadopovo.com.br, veja.abril.com.br
- Left-leaning: cartacapital.com.br, revistaforum.com.br, brasil247.com
- Federal-capital lens: correiobraziliense.com.br
- Investigative / long-form: piaui.folha.uol.com.br, crusoe.com.br
- Foreign perspective on Brazil: bbc.com/portuguese, reuters.com/world/americas, apnews.com/hub/brazil, en.mercopress.com/brazil, riotimesonline.com

### Politics – Brazil
All Brazil-general sources above, plus:
- Legislative / legal specialist: poder360.com.br, jota.info, congressoemfoco.uol.com.br
- Data-driven explainer: nexojornal.com.br
- Spectrum picks for contested stories:
  - Left: Carta Capital, Revista Forum, Brasil 247
  - Center: Folha, Estadão, Nexo, Poder360
  - Right: Gazeta do Povo, Crusoé, O Antagonista

### Politics – US
- Wires / center: reuters.com, apnews.com, bloomberg.com, axios.com, thehill.com, politico.com, csmonitor.com
- Public broadcasting (center, slight left): npr.org, pbs.org/newshour
- Center-left / left: nytimes.com, washingtonpost.com, theatlantic.com, theguardian.com/us-news, msnbc.com, motherjones.com
- Center-right / right: wsj.com (news side rated balanced), foxnews.com, nationalreview.com, thedispatch.com, washingtonexaminer.com, reason.com (libertarian), thebulwark.com (anti-populist conservative)
- Raw / primary: c-span.org

### Politics – World
- Wires & flagships: reuters.com, apnews.com, afp.com, bbc.com/news, theguardian.com/world
- Europe: lemonde.fr/en, ft.com, economist.com, dw.com/en, euronews.com, politico.eu, spiegel.de/international
- Middle East / Africa: aljazeera.com, haaretz.com/english, timesofisrael.com, middleeasteye.net, theafricareport.com, allafrica.com, mg.co.za
- Asia: asia.nikkei.com, scmp.com, thediplomat.com, asiatimes.com, thehindu.com, indianexpress.com, japantimes.co.jp, koreatimes.co.kr
- Latin America: en.mercopress.com, buenosairesherald.com, americasquarterly.org
- State-affiliated (frame explicitly as such): tass.com, rt.com, xinhuanet.com/english, presstv.ir
- Analysis weeklies: foreignpolicy.com, foreignaffairs.com

### Technology
- US flagships: arstechnica.com, theverge.com, techcrunch.com, wired.com, technologyreview.com, theinformation.com, bloomberg.com/technology
- Independent / accountability: 404media.co, themarkup.org, restofworld.org, platformer.news, stratechery.com, pivot-to-ai.com
- Europe: theregister.com, heise.de, tech.eu, sifted.eu
- Asia: techinasia.com, asia.nikkei.com/Business/Technology, technode.com, pandaily.com, krasia.com
- Aggregators: news.ycombinator.com, techmeme.com

### AI
See the existing `daily-ai-news` skill for the canonical AI source list. Do not duplicate it here.

### Programming
- Aggregators / community: news.ycombinator.com, lobste.rs, tildes.net, daily.dev
- Vendor / engineering blogs: github.blog, stackoverflow.blog, cloudflare.com/blog, vercel.com/blog, anthropic.com/engineering, netflixtechblog.com, eng.uber.com
- Magazines / long-form: infoq.com, queue.acm.org, spectrum.ieee.org/computing
- Individual voices: pragmaticengineer.com, jvns.ca, martinfowler.com, danluu.com, codinghorror.com, simonwillison.net
- Newsletters (use as pointers): javascriptweekly.com, bytes.dev, tldr.tech
- Brazilian dev community: tabnews.com.br, imasters.com.br
- Releases & primary: language/framework GitHub releases, RFC repos, official changelogs

### Science
- Peer-reviewed news desks: nature.com/news, science.org/news, newscientist.com, scientificamerican.com
- Science journalism: quantamagazine.org, sciencedaily.com, sciencealert.com, phys.org, sciencenews.org, knowablemagazine.org, undark.org, theconversation.com
- Beat-specific: statnews.com (health/biotech), eos.org (earth/space), spectrumnews.org (neurodevelopment)
- Mainstream science sections: nytimes.com/section/science, bbc.com/science, theguardian.com/science
- Brazilian science: revistapesquisa.fapesp.br
- Cross-topic radar: news.ycombinator.com (often surfaces papers and deep-dives before the science press; treat as pointer, not primary source)
- Press releases (primary but PR-spun, treat with skepticism): eurekalert.org

## Required Analysis Dimensions

Each major story MUST include — when material exists, otherwise omit the callout entirely (no filler):

1. **Multiple Perspectives** — contrast how ≥2 outlets framed it (different country/political leaning preferred)
2. **Bias & Media Literacy** — note framing patterns, omissions, ownership/funding incentives, when non-trivial
3. **Connecting Patterns** — link to other stories in the same briefing or recent threads
4. **Historical Parallels** — only when a *real* parallel exists (with year), not pop-history filler
5. **Follow-up Questions** — 2–4 angles the user could explore next
6. **Citation Transparency** — every factual claim traceable to a sourced link

Skip any callout where you'd be inventing content to fill it. Empty callouts erode trust faster than missing ones.

**Source diversity (HARD RULE).** Don't fill a section with a single outlet's coverage. For any story with a political dimension, the "Multiple perspectives" callout MUST include at least one source from each major leaning relevant to the story (left + center + right for US/Brazil politics; geographic spread for World politics). Each source must be labeled inline with its country and leaning, e.g. `**Folha** (BR / center-left)`, `**Gazeta do Povo** (BR / right-leaning)`, `**Reuters** (intl / wire)`. The source map is guidance — if a needed perspective isn't in it, search beyond the map.

## Output Template (Obsidian-rich)

### Per-day section header (top of file when day is new)

```markdown
## 📅 2026-04-28 — Tuesday
*Generated 14:32 BRT • {N} stories • Sources: {M} articles across {K} publications*

> [!abstract]+ Today's lede
> {2–3 sentences: what dominated this topic today, why it matters, the headline-of-headlines}

```

### Per-story block

```markdown
> [!info]+ {{HEADLINE}}
>
> **TL;DR**: {one-sentence summary}
>
> **Key points**:
> - {fact with citation}
> - {fact with citation}
> - {fact with citation}
>
> > [!quote] Multiple perspectives
> > - **{Outlet A}** ({country/leaning}): {framing angle}
> > - **{Outlet B}** ({country/leaning}): {framing angle}
> > - **{Outlet C}** ({country/leaning}): {framing angle}
>
> > [!warning] Bias & media-literacy notes
> > {1–3 bullets — only if a real pattern exists}
>
> > [!tip] Connections & why it matters
> > {Pattern this fits / connection to another story / stake for the reader}
>
> > [!example] Historical parallel
> > {1–2 sentences with a dated prior event — omit if no real parallel}
>
> > [!question] Follow-up questions
> > 1. ...
> > 2. ...
> > 3. ...
```

**Inline citations.** Every factual claim in `Key points`, `Multiple perspectives`, `Bias notes`, and `Connections` must end with a footnote reference to its source: `Lula vetoed the bill on Tuesday[^lula-veto-1].` Use slug-prefixed footnote IDs (kebab-case headline slug + sequential number, e.g. `[^lula-veto-1]`, `[^lula-veto-2]`) so footnotes from different stories in the same file don't collide.

Define the footnotes immediately after the `📎 **Sources**` block of each story. Each footnote points to one of the sources in the source block:

```
> 📎 **Sources**:
> - [Folha — Lula veta projeto X](url) — 2026-04-28 (BR / center-left)
> - [Gazeta do Povo — Veto a projeto X gera reação](url) — 2026-04-28 (BR / right-leaning)
> - [Reuters — Brazil's Lula vetoes...](url) — 2026-04-28 (intl / wire, paywalled) [bypass: sempaywall, removepaywall]
>
> [^lula-veto-1]: Folha, 2026-04-28 — link
> [^lula-veto-2]: Gazeta do Povo, 2026-04-28 — link
> [^lula-veto-3]: Reuters, 2026-04-28 — link
```

This gives the reader two paths: scan the inline citation hover-preview in Obsidian for quick verification, or read the full source block at the bottom for the spectrum view.

Each story still ends with the tag line: `> 🏷️ #{topic} #{subtopic} #{entity}`

### Day separator

After the last story of a day, before older entries:
```markdown
---
```

### Callout types to use (Obsidian renders each in a distinct color)

| Callout | Use for | Color |
|---|---|---|
| `[!abstract]+` | Day's lede / summary | Gray-blue |
| `[!info]+` | Story container (foldable, open) | Blue |
| `[!quote]` | Multiple perspectives | Gray |
| `[!warning]` | Bias / media-literacy notes | Orange |
| `[!tip]` | Connections & why-it-matters | Green |
| `[!example]` | Historical parallels | Purple |
| `[!question]` | Follow-up questions | Cyan |
| `[!danger]` | Critical breaking developments only | Red |
| `[!success]` | Confirmed wins/breakthroughs (Science, Tech) | Green |

The `+` suffix makes a callout open by default; `-` makes it collapsed. Use `+` on the abstract and the story container so the file is scannable but rich on expand.

Use `==highlights==` sparingly to mark numbers, names, or claims that matter most. Use `[[wiki-links]]` to other vault notes when relevant (e.g. `[[Lula]]`, `[[Anthropic]]`).

## File-write Procedure

For each target file:

1. **Bash**: `date +%Y-%m-%d` (and weekday name for the header)
2. **Read** the file if it exists. Note whether the first non-blank H2 matches today's date.
3. Build the new content:
   - **If today's heading exists**: just the new story blocks (no new H2 or `---`)
   - **If today's heading is missing**: `## 📅 <today> — <weekday>` + lede abstract + story blocks + `---`
4. **Edit** the file:
   - Today's heading exists → `Edit` to insert new stories under it (before the next `---`)
   - Today's heading missing → `Edit` to prepend the new section to the top of the file (after the file's title/intro lines, if any)
5. If the file doesn't exist, **Write** it with a one-line title (`# {Topic} News Briefings`), one-line intro, then the new section.

**Never** overwrite the entire file with `Write` if it already has content. **Never** edit prior days' entries.

## Volume Cap and Quiet Days

**Per-topic cap.** Maximum **6 full story callouts per topic per run-day**. If more than 6 candidates exist, prioritize: (1) consequence/stakes, (2) source diversity available, (3) absence of close coverage in recent days. Drop the rest — restraint over churn.

**Quiet days.** If a topic has no substantive new stories in the last 24–72h, do not pad with filler. Write a single quiet-day callout in place of stories:

For English files:
> [!abstract]+ Quiet day
> No substantive new stories in this topic in the last 24–72h. Re-check tomorrow.

For PT files (Brazil.md, Politics-Brazil.md):
> [!abstract]+ Dia tranquilo
> Sem matérias substanciais sobre este tópico nas últimas 24–72h. Voltar amanhã.

The quiet-day note still goes under today's `## 📅 <date>` heading and follows the same prepend/append rules.

## Cross-topic Stories

Some stories belong in more than one file (e.g. AI regulation: AI + Tech + Politics). Handle them with a **primary + stub** pattern:

1. **Primary file** (the most natural lens): full story callout with all the analysis.
2. **Secondary file(s)**: a short stub callout with a wiki-link back to the primary. Format:

> [!info] {{HEADLINE}} — cross-posted
> {One sentence on why this matters from this topic's lens.}
>
> 📎 Full coverage: [[<primary-file>#{date-anchor}]]
>
> 🏷️ #{topic} #cross-posted

3. **Stubs do NOT count** against the 6-story cap, but cap stubs at **3 per file per day** so a single news cycle can't flood every file with cross-posts.

Pick the primary lens by asking: which audience would lose the most by missing this story? That's the primary file.

## End-of-run Behavior

After writing, surface in chat:
- Which files were updated and how many stories each got
- 3–5 bullet "headlines of the day" pulled across all topics
- An **invitation to discuss**: "Want me to dig into [most consequential story] or pull thread on [pattern X]?"

This satisfies the user's "interactive analysis" requirement — the skill is a starting point for conversation, not a write-and-walk-away.

## Quick Reference

| Need | Action |
|---|---|
| Get today's date | `date +%Y-%m-%d` via Bash — do not trust context |
| File exists, has today's heading | `Edit` to append stories under today's section |
| File exists, no today's heading | `Edit` to prepend new dated section at top |
| File missing | `Write` with title + intro + first dated section |
| Old story, surfaced today | File under TODAY's date — note pub date in source line |
| Story too thin for callouts | Cut it. No filler. |
| Cross-topic story (e.g. AI regulation) | Full story in primary file, stub callouts in secondary files (see Cross-topic Stories) |

## Common Mistakes

- ❌ Writing the briefing only to chat → user has to ask for the file. **Always write to disk by default** unless user explicitly says "just chat."
- ❌ Filing under the publication date instead of today → breaks the "what I learned when" model
- ❌ Overwriting the file with `Write` → destroys history. Use `Edit` to prepend/append.
- ❌ Empty bias/parallel callouts with filler text → trust erosion. Omit when nothing real to say.
- ❌ Single-outlet sourcing on contested stories → violates source-diversity requirement
- ❌ Skipping the in-chat summary + invitation → makes the skill feel like a job done, not a conversation started
- ❌ Using basic `###` headings instead of Obsidian callouts → loses the visual scannability the user explicitly asked for
- ❌ Re-running same day creating duplicate `## 📅 <today>` sections → must merge under existing heading

## Red Flags — STOP and Reconsider

- "I'll write to chat first and ask if they want it on disk" → No. The user already established the convention. Write to disk and surface a summary.
- "I don't have a good historical parallel but I'll add one anyway" → No. Omit the callout.
- "All my sources for this Brazil-politics story are from one outlet" → Search again with different queries before writing.
- "I'll just use Write to replace the file, it's cleaner" → No. Read → Edit. Preserve history.
