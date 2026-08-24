# Progress

Dated changelog, **newest first** (this file is a log — never edit entries in place; a wrong entry gets a dated correction note). Entries before 2026-08-18 live in `docs/archive/progress-through-2026-08-17.md` (read them only when you actually need that history). Docs live in `README.md` / `AGENTS.md` / `GAPS.md` / `NEXT_STEPS.md` / `docs/*`; this file only records *what shipped when*.

---

#### 2026-08-24 — explicit write newline policy closes live-provider miss

**Status: ✅ implemented and live-validated**

Replaced the unreliable instruction to embed an invisible final character in
`write.content` with a required, structured newline decision.

- Added required `ensureFinalNewline: boolean`. `true` appends LF only when
  `content` lacks a final line break; `false` writes `content` exactly and
  never strips an already supplied newline.
- `write` now reports `finalNewline` and `newlineAdded` alongside its actual
  byte count, so the result itself explains what reached disk.
- Added schema/behavior tests for the required flag, append, exact-write, and
  no-duplicate cases. Updated direct tool-boundary fixtures to use the current
  canonical shape.
- Added a live no-final-newline task and allowed `bash` only as optional
  post-write byte verification; the required primary tool remains `write`.
- `deepseek-v4-flash-0731` selected `true` and `false` correctly in a focused
  **2/2** paid run. The first complete run produced all six exact outcomes but
  scored 5/6 because `xxd` verification was not yet allowed; after correcting
  that harness policy, the final complete run passed **6/6 with 0 invalid
  calls**.
- The standing prompt remains 406 characters. The four bare model-visible tool
  definitions now serialize to 3,570 characters (read 658, write 839, edit
  1,498, bash 575); the explicit newline contract replaces repeated prose with
  an enforced decision.

Verified in this session: full `node --check`; `git diff --check`; `npm test`
(**243/243 pass**); `npm pack --dry-run --json` (`src/main.mjs` executable,
project `.env` excluded); a real configured-provider headless CLI response; an
isolated interactive TUI startup and clean `/exit`; focused paid newline eval
**2/2**; and final complete paid tool eval **6/6**.

#### 2026-08-24 — numbered-read/edit boundary validated on live model

**Status: ✅ implemented and measured on `refine/argus-tool-surface-v2`**

Tested whether line gutters in `read` confuse the configured model's current
selector-based `edit` calls, without first introducing the proposed typed-edit
redesign.

- Renamed the rendered read-result field from generic `content` to
  `numberedText`. Tool wording now states that `N │ ` prefixes are selection
  metadata: `old` may copy them, while `new` contains literal file text only.
- Kept old result formatting compatible with historical `content` payloads.
- Added conservative, atomic gutter-leak detection. It rejects strong evidence
  that displayed prefixes entered replacement text, but does not silently
  rewrite `new`; exact files containing numbered text and ambiguous numbered
  insertions remain legal.
- Added regression coverage for copied numbered selectors, leaked content and
  range replacements, batch atomicity, legitimate numbered files, and result
  summarization.
- Extended the paid evaluator with named-task filtering, successful argument
  traces, zero-invalid-call enforcement, and a less-cued multiline edit task.
  Functional `bash` verification is allowed for that task rather than being
  misclassified as bad tool choice.
- Against `deepseek-v4-flash-0731`, content and range edits passed with clean
  arguments. The uncued multiline task passed on **3/3 independent runs** with
  exact outcomes and **0 invalid calls**; every `old` and `new` omitted read
  gutters. One initial report said 2/3 only because the harness disallowed the
  model's sensible post-edit `bash` verification; the file outcome and edit
  call were already correct, and the policy was corrected before both reruns.

Verified in this session: full `node --check`; `git diff --check`; `npm test`
(**242/242 pass**); one paid three-task edit run; and two additional paid
uncued-edit runs. The evidence says numbered lines do not currently confuse
this model on content/range/multiline edits; uncued insertion, deletion, and
mixed-batch choice remain the next comparison for a typed-operation proposal.

#### 2026-08-24 — live tool-choice baseline and role-boundary refinement

**Status: ✅ measured; one provider-specific outcome miss remains**

Ran the opt-in tool-choice evaluator against the configured
`deepseek-v4-flash-0731` provider and used the trace evidence to refine the
model-visible contract.

- Made each structured text tool's boundary with `bash` explicit: ordinary
  text reads use `read`, new complete files use `write`, targeted changes use
  `edit`, and `bash` owns search/listing/build/test/other CLI work.
- Clarified that `write.content` is byte-exact and must itself contain a
  requested final newline, including a concrete escaped-newline example.
- Corrected the evaluator to require the intended tool sequence as a
  subsequence while allowing task-specific verification calls. This prevents
  a sensible post-edit `read` from being counted as a failure, while any
  off-contract tool still fails tool choice.
- The final live run passed content edit, fresh range edit, and shell search.
  File creation chose `write` with valid arguments but the configured model
  omitted the requested trailing newline, so the exact file outcome failed:
  **3/4 pass, 4/4 intended primary-tool choice, 0 invalid calls**. Repeated
  wording refinements did not change that provider behavior, so it remains
  measurement rather than a hidden evaluator relaxation.
- The standing system prompt remains 59 words / 406 characters. The four bare
  model-visible tool definitions now serialize to 3,365 characters (read 660,
  write 739, edit 1,391, bash 575); the added 282 characters are explicit role
  boundaries and exact-content guidance.

Verified in this session: `node --check` for all source/eval/test modules;
`git diff --check`; `npm test` (**240/240 pass**, twice after the evaluator
changes); and three post-refinement paid/provider evaluator runs (each final
state **3/4**, with the trailing-newline outcome as the remaining miss).

#### 2026-08-24 — product-readiness pass: session safety, cleanup, and CLI smoke

**Status: ✅ done**

Audited startup, headless/TUI operation, session integrity, packaging, safety,
and first-use documentation after the canonical tool-surface work.

- Added confirmed `/delete <name>` session cleanup with exact-name validation,
  active-session protection, `/delete` name completion, immediate completion
  refresh, and an explicit irreversible-deletion result.
- Made the session store private by default (`0700` directory, `0600` newly
  written/resumed transcripts on POSIX platforms) instead of relying on the
  process umask.
- Stopped treating every session read failure as "not found." Interior JSONL
  corruption now fails with its line number; a torn final record is ignored
  with a visible TUI/headless recovery warning; `/sessions` degrades per file
  rather than failing the whole listing.
- Fixed Ctrl-C during a local confirmation so it cancels cleanly instead of
  leaving a stale force-quit state. Aligned `/status`'s fallback request timeout
  with the 600-second configured default and made missing-key guidance point to
  `.env`/the environment.
- Added a full CLI subprocess test through config loading, HTTP/SSE streaming,
  stdout/stderr separation, and clean exit. Updated session/command docs and
  removed shipped session deletion from `NEXT_STEPS.md`.

Verified in this session: interactive TUI startup, `/help`, and `/exit` in a
fresh isolated home; `npm pack --dry-run --json` (bin executable, `.env`
excluded); full `node --check`; `git diff --check`; and `npm test`
(**240/240 pass**). The opt-in paid/provider-backed tool-choice eval was not
run, so no live-model quality baseline is claimed.

#### 2026-08-24 — canonical four-tool surface completed and hardened

**Status: ✅ done**

Resolved the pending tool-surface decisions D1–D15 without adding a default
tool or runtime dependency. `read`, `write`, `edit`, and `bash` now have one
validated shape and one specific job; `docs/tool-surface.md` records the
rationale and `docs/tools.md` owns the current contract.

- Removed legacy top-level `edit` inputs. Recursive schema validation now
  enforces nested requirements, unknown-field rejection, array bounds, and
  numeric/string constraints before I/O; semantic validation owns cross-field
  edit rules.
- Made fuzzy edits exact-span preserving with a grapheme-aware normalized
  offset map, rejected empty normalized needles, isolated exact/fuzzy matching
  per batch item, and fixed the empty-needle infinite loop.
- Added bounded-memory `read` scanning, structured line metadata/pagination,
  safe oversized-line errors, final serialized-size fitting, and structured
  filesystem failures.
- Added same-turn range freshness (`src/tool-state.mjs`): exact file hashes and
  displayed line coverage are required; partial pages remain partial; writes
  invalidate their path and executed shell commands invalidate all evidence.
- Hardened the loop: provider multi-call replies are rejected before effects,
  the last model step is reserved for synthesis, identical no-progress calls
  stop on the third consecutive result, complete outgoing request size is
  measured, and active turns have a cumulative tool-result budget.
- Added model-invisible risk classes, centralized structured authorization,
  auditable TUI/headless decisions, a line-continuation-resistant destructive
  shell backstop, and distinct shell timeout vs user-abort results.
- Versioned the model-visible tool surface in append-only sessions with a hash
  per turn and a schema snapshot on change. Removed a duplicate session module
  header and persisted/displayed the new turn-result limit.
- Reduced the default prompt from 119 words / 791 characters to 59 words / 406
  characters by leaving tool mechanics in descriptions. The complete tool
  wire surface is now 3,083 characters (read 646, write 562, edit 1,373, bash
  502).
- Added the opt-in `npm run eval:tools` real-provider evaluator for content
  edit, fresh range edit, shell search, and new-file tool choice. It uses
  isolated temporary workspaces and is intentionally outside the offline test
  suite.

Verified in this session: `git diff --check`; `node --check` for all source,
session, TUI, eval, and test modules; `npm test` (**234/234 pass**). The
provider-backed evaluator was syntax-checked but not run, so no paid/model
quality baseline is claimed.

#### 2026-08-24 — tool-surface discussion brief for fresh-session continuity

**Status: 🚧 in discussion**

Wrote the canonical tool-set discussion down end-to-end in
`docs/tool-surface.md` so it can resume in a new session with fresh context:

- Retitled to a **discussion brief**; added a `Background` section (goals,
  timeline, commits `885e43a`/`3def44c`, prior decisions D1–D4) and a
  `Next session — where we left off` section with the approval checklist
  (4-tool set; D5/D8/D9/D13; confirm D6/D7/D10/D11/D12) plus a reading
  order.
- The draft proposal (schemas for `read`/`write`/`edit`/`bash`) is unchanged
  and still awaiting user review; nothing beyond D1–D4 is decided.

#### 2026-08-23 — tool-surface discussion opened: status list + tracker

**Status: 🚧 in discussion**

Started the canonical tool-set discussion (slim the model burden, drop unused
functionality). No tool was added or removed — the set stays `read`, `write`,
`edit`, `bash` (test-enforced).

- **`docs/tool-surface.md` (new)** is the single source of truth for the
  discussion: per-tool status table (model-visible schema, result shape,
  safety, usage guidance), where the "ways to use them" live (tool
  descriptions + system prompt + loop rules), removal candidates (R1 legacy
  top-level `edit` tolerance, R2 system-prompt duplication of tool guidance,
  R3 `/exit`/`/quit` alias), and a decision log D1–D15.
- **`GAPS.md` #12 slimmed** to a pointer at the new tracker (was ~70 lines of
  retold open questions).
- `docs/self-updating.md` and AGENTS.md now list the tracker (fact owner for
  tool-surface discussion state).
- Verified: full test suite green (217 tests); docs cross-references follow
  the one-fact-one-owner rule.

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
