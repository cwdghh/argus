# Progress

Dated changelog, **newest first** (this file is a log — never edit entries in place; a wrong entry gets a dated correction note). Entries before 2026-08-18 live in `docs/archive/progress-through-2026-08-17.md` (read them only when you actually need that history). Docs live in `README.md` / `AGENTS.md` / `GAPS.md` / `NEXT_STEPS.md` / `docs/*`; this file only records *what shipped when*.

---

#### 2026-08-23 — docs consolidation: single source of truth + archive

**Status: ✅ done**

Took over the documentation consolidation task and completed it:

- **One fact, one owner** is now the rule (AGENTS.md PREREQUISITES +
  docs/self-updating.md "Fact ownership"): every fact lives in exactly one
  file; every other mention is a pointer. README links to AGENTS.md for the
  file map; NEXT_STEPS.md holds only ranked remaining work and points at
  GAPS.md numbers; docs/tools.md points at GAPS.md #12.
- **Archiving added.** `docs/archive/` holds frozen history: PROGRESS.md
  entries dated 2026-08-17 and earlier moved verbatim to
  `docs/archive/progress-through-2026-08-17.md`, and the executed refactor
  plan moved to `docs/archive/refactor-plan.md`. PROGRESS.md went from
  ~1044 to ~150 lines. The archive convention lives in
  `docs/archive/README.md`; docs/self-updating.md gained the "Live docs stay
  small" (≈400-line guard) + "Archive aggressively" rules.


#### 2026-08-23 — scrolling: absolute viewport anchor while generating

**Status: ✅ done**

Scrolling was relative to the last transcript line, so while the model was
generating the viewport crept toward the newest output and scrolling back
didn't stay put. `scrollOffset` is now an **absolute first-visible-line
index** (`null` = follow the latest output):

- PgUp/PgDn/Home/End/wheel adjust the absolute index; reaching the bottom
  resumes following; the end of a turn no longer yanks the viewport.
- The header hint shows the true distance from the latest line (and stays
  accurate as output grows).
- Tests: absolute-anchor stability while appending, wheel/page/home/end
  semantics, header distance.

#### 2026-08-23 — agent stops runaway tool loops; tool surface simplified

**Status: ✅ done**

Investigated "the model fails to stop generating" and landed three changes
(decisions recorded in GAPS.md #12):

- **Loop guard.** `runTurn` refuses a third identical tool call (same name +
  canonical arguments), so a degenerate model loop ends with a clear error
  instead of grinding through ARGUS_MAX_STEPS.
- **One tool per step.** The request body now sends `parallel_tool_calls:
  false` — sequential, audit-friendly, fewer ways for the model to keep going.
- **`edit` simplified to one shape.** The model-visible schema exposes only
  `edits[]` (+ `all`); the legacy top-level `old`/`new`/`startLine`/`endLine`
  fields were removed from the schema (description and system-prompt guidance
  now point at the single shape). `execute` still accepts the legacy fields
  defensively.
- Tools stay four (`read`, `write`, `edit`, `bash`) — the simplicity win was
  *shape*, not count. Tests: repeated-call guard, `parallel_tool_calls`,
  canonical-tool-call identity, single-shape schema.

#### 2026-08-22 — auto-compact audit: cumulative summaries + 200k real-token budget

**Status: ✅ done**

Goal (from review): verify the auto-compact functionality actually works, then
relax the default compact limit to **200k real tokens** (the previous default
was 300k chars ≈ 75k tokens, measured and displayed with a heuristic).

Audit findings (`maybeCompact` / `src/compact.mjs`):

- ✅ **It fires and summarizes correctly**, and two real problems were found
  and fixed:
  1. **Repeated compaction dropped the previous summary.** A second compaction
     treated the existing "Summary of earlier conversation" system message as
     an ordinary dropped turn and summarized only the newest dropped turns —
     silently forgetting every older turn the first summary had compressed
     (reproduced with a scripted 12+ turn session). Summaries are now carried
     forward and folded into the new summary, so re-compaction never forgets.
  2. **The limit was chars and the meter heuristic tokens.** Both are now real.
- ✅ **Real-token compaction.** `ARGUS_COMPACT_TOKENS` (default 200_000) is the
  budget. `nextContextTokens(lastUsage)` derives the context the *next*
  request will carry — the last request's real `prompt_tokens` plus that
  turn's `completion_tokens` (the reply is re-sent) — and `maybeCompact` fires
  when it reaches the limit. Before the first usage report, a measured-payload
  safety net (`ARGUS_COMPACT_AT`, default 800k chars ≈ 200k tokens) prevents
  unbounded growth. The char heuristic is a safety net only, never the meter.
- ✅ **Plumbed where real usage lives**: the TUI passes its `lastTurnUsage`
  into every turn; headless now persists a timing block with its real usage
  (so headless chains compact from real tokens on resume too); `runTurn`
  forwards `lastTokens` to `maybeCompact`.
- ✅ Footer Y is now the 200k real-token budget (`1.6K / 200.0K (1%)`,
  `— / 200.0K (0%)` before the first request).
- ✅ Tests: 211 pass. New coverage: real-token trigger (at/over the limit),
  real-report-beats-char path, cumulative-summary regression,
  `nextContextTokens`, derived defaults, agent-level real-token compaction,
  and a headless resumed-run compaction test seeded with persisted usage.
- ✅ Docs updated: README, .env.example, GAPS.md §4, docs/architecture.md,
  docs/interrupt-resume.md.

#### 2026-08-18 — token counts: real request tokens, shown as X / Y (Z%)

**Status: ✅ done**

Goal (from review): the footer claimed the "context window" was `2 / 300.0K` on
an empty session, per-turn usage summed the same context once per model step,
and both needed to stay honest under the planned interrupt→continue flow
(`docs/interrupt-resume.md`). The review then hardened the ask: the context
*count* must be the real, provider-reported tokens from the request — not a
chars/4 heuristic — while keeping the `X / Y (Z%)` meter so the current upper
limit and percentage stay visible.

What was done:

- ✅ **Startup context bug fixed.** The right-hand context field was
  `estimateChars(history) / ARGUS_COMPACT_AT` chars, so an empty history
  rendered as `2 / 300.0K (0%)` — the length of `JSON.stringify([])`. The
  meter now shows the real `prompt_tokens` of the most recent request as X,
  with `—` before any request has reported usage (no made-up number).
- ✅ **X / Y (Z%) with a real X.** `contextUsage()` in `src/tui/frames.mjs` is
  the single source for the footer and `/status`: X = real provider-reported
  prompt tokens (live `turnUsage`, else persisted `lastTurnUsage`), Y = the
  token-equivalent compaction budget — the only upper limit argus enforces
  (`ARGUS_COMPACT_AT` chars, using the repo's documented ~4 chars/token
  convention) — and Z% = X / Y. `/status`: `Context: 1.6K / 75.0K tokens (2%)`.
- ✅ **No repeated counting in per-turn usage.** `accumulateUsage` no longer
  sums `prompt_tokens` across model steps (that counted the shared history
  once per step); it reports the largest context sent (`↑`), summed output
  (`↓`), a consistent total, and the largest cached share. All real provider
  counts.
- ✅ **Interrupt/continuation ready.** An interrupted turn records only the
  usage of *completed* steps (a mid-stream abort reports no usage), and a
  regression test locks the spec's §6.2 end-state shape: the partial assistant
  text appears in the message history exactly once, so the next request's real
  prompt count can't be inflated by a duplicate.
- ✅ Docs updated: README footer screenshot + bullets, GAPS.md §4 status note,
  docs/interrupt-resume.md §4.3 accounting guarantee.

Verification: 205 tests pass (`node --check` clean), including new agent
(no-repeat accumulation, interrupted-turn usage), compact (token-budget
conversion, continued-interrupt history shape), and TUI/frames (real context
meter `X / Y (Z%)`, em-dash before the first request) coverage.

#### 2026-08-18 — planned: tool-design discussion (next session opener)

**Status: ⏳ planned**

Agreed with the maintainer: the next session opens with a design discussion on
**how to design reasonable tools first** — before adding any tool or changing
tool behavior (parallel execution, read-before-edit freshness guard, possible
search tools). The discussion map and open questions were recorded in
`GAPS.md` #12 (new section), `NEXT_STEPS.md` gained a "Scheduled next" block
at the top, and `docs/tools.md` now points at the open design questions.
Refinement suggestions from the `/name` hardening review were folded into the
agenda (the tool-surface bar, risk declaration, result-shape conventions, and
the order of the first contract-touching features: freshness guard, then a
tool-choice behavioral eval; `/session delete` can land anytime). No code
changed.
