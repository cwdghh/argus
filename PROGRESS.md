# Progress

Dated changelog, **newest first** (this file is a log — never edit entries in place; a wrong entry gets a dated correction note). Entries before 2026-08-18 live in `docs/archive/progress-through-2026-08-17.md` (read them only when you actually need that history). Docs live in `README.md` / `AGENTS.md` / `GAPS.md` / `NEXT_STEPS.md` / `docs/*`; this file only records *what shipped when*.

---

#### 2026-09-01 — session durability & startup scale (plan W4)

**Status: ✅ done** (tests under `test/session.test.mjs`, `test/headless.test.mjs`,
`test/polish.test.mjs`)

- **Torn-line recovery:** `loadSession` is now a streaming, tolerant scan — an
  unparseable line *anywhere* (torn final record from a crash, or interior
  corruption) is skipped with a warning instead of throwing, so one bad append
  can never brick a session again. `latestSessionForCwd` skips unreadable
  sessions instead of letting a single corrupt file block TUI startup.
- **Streaming meta scanner:** `scanSessionFile`/`scanSessionMeta` read a session
  head-first and stop at the first turn record, so default-session resolution
  parses a handful of leading cwd/model/config records instead of a full
  transcript rebuild of up to 20 sessions (~2-3 orders less parse work).
- **Memory-bounded `loadSession`:** readline streaming replaces
  `readFile` + `split("\n")`, which held ~2× the file plus every deserialized
  turn at once.
- **`systemPrompt` persisted once:** a new deduped `{type:"config"}` record
  (written by `Session#setConfig`) carries the static config — including the
  often-large systemPrompt — once per session instead of inside every turn
  record; turns now store only the model delta. The document header lists all
  record types.
- **Housekeeping & I/O:** `pruneSessions` now also runs in headless mode
  (`ARGUS_SESSION_KEEP`, preserving the session being written), and
  `listSessions`/`pruneSessions` issue their stats/removals concurrently.
- **Dead exports removed:** `truncateRead` (`read-bounds.mjs`), `recordRead`
  (`tool-state.mjs`), and `latestSessionName` (session store + index).

Verified in this session: `node --test` **286/286 pass** (3 new session tests
plus updated torn-line / config-shape expectations).

---

#### 2026-09-01 — tool output visibility (plan W2)

**Status: ✅ done** (tests under `test/format.test.mjs`, `test/tui.test.mjs`,
`test/headless.test.mjs`, `test/frames.test.mjs`, `test/suggestions.test.mjs`,
`test/commands.test.mjs`)

- **Shared `toolLabel(name, args)` resolver** in `format.mjs`: one place that
  names a tool call — the path for `read`/`write`/`edit`, the command for
  `bash` — and shows content-like payloads as char counts, never the payload
  itself (`⚙ write → src/a.mjs (content 4.1K chars)`). The TUI and headless now
  render identical tool lines, replacing the TUI's 60-char JSON truncation and
  headless's unlimited args dump. Persisted tool blocks store the resolved
  label instead of re-storing raw args that already live in the turn's tool
  message, killing the JSONL write amplification.
- **`previewResult` + `block.detail`:** a bounded ~20-line / ~2KB preview of a
  large result (stdout, numberedText, content) rides dimmed under the result
  summary inside the same rail, ending `… N more lines`. Paged reads strip the
  read tool's own `[Showing …]` hint and count from `totalLines`, so the number
  reflects the whole file, and `summarize()` now appends ` … N more lines` (or
  ` … (truncated)`) to the compact line — a truncated read or build log is no
  longer mistaken for the whole story.
- **`/show <n>`:** prints transcript block n in full — label, preview, and,
  via the tool-call id now carried on the `tool_call`/`tool_result` events, the
  complete stored result pulled from the session record (works on resumed
  turns too).
- **Active-tool footer:** after a tool has run ~1s the status line names it
  (`⠋ bash → npm run build 12.3s`) instead of the generic `working` phase;
  sub-second calls never flicker a label.

Verified in this session: `node --test` **283/283 pass** (10 new/updated tests).

---

#### 2026-09-01 — paste integrity + multi-line draft safety (plan W1)

**Status: ✅ done**

- **Bulk-literal paste insert:** a bracketed paste payload now lands in the
  editor in a single `editor.insert()` call, bypassing the per-character
  keybinding interpreter. Pasted TAB no longer fires path-completion and pasted
  Ctrl-A/K/D/U/E can no longer move the caret, delete, or quit; control bytes
  become literal text.
- **Newline preservation:** `\r\n`/`\r` normalize to `\n`; embedded `\n` no
  longer folds to spaces and no `submit()` can fire mid-paste (the existing
  fold test now asserts the preserved buffer).
- **`[pasted N lines]` marker:** a large paste (>1000 chars or >20 lines) whose
  buffer is submitted untouched renders the user block as `[pasted N lines]` /
  `[pasted N chars]`; the full text is still what reaches the model and persists
  in the session JSONL. Editing the paste afterwards keeps the real text.
- **Esc / history draft slot:** Esc on a multiline draft no longer flattens it
  silently; `Editor.historyUp` stashes the live draft and `historyDown` walking
  off the end of the recall history restores it (consumed once, cleared on
  submit and on session apply).

Verified in this session: `node --test` **263/263 pass** (7 new/updated paste +
draft tests).

---

#### 2026-09-01 — reliability batch (plan W3)

**Status: ✅ done** (one test per item; see tests under `test/agent.test.mjs`,
`test/tools.test.mjs`, `test/tui.test.mjs`, `test/reliability.test.mjs`)

- **Protocol-safe histories on mid-loop guards** (`protocolSafeMessages`):
  messages exposed via `err.turnMessages` (and the aborted-return paths) always
  satisfy tool-call pairing — a guard throw that happens after the assistant
  reply is pushed but before its tool executes synthesizes
  `{error:true, message:"tool call was never executed (…)"}` results instead of
  leaving a dangling tool_call, so persisted turns stay replayable.
- **Interrupt double-marker:** the result-block ✗ suppression in `blocks.mjs`
  now matches any summary containing `interrupted`, so the TUI's
  `⏹ interrupted` no longer renders `✗ ⏹ interrupted`.
- **Denied-approval double block:** a denied approval used to render both the
  `approval`-event result and the `tool_result` error block; the TUI and
  headless now record only approvals as a decision row — the denial itself is
  reported once by the tool_result block.
- **Ctrl-D mode guard + flush on stop:** Ctrl-D on an empty buffer only quits
  while `mode === "idle"` (mid-turn it can no longer exit); `stopTui` awaits the
  session write queue before `process.exit` so a just-finished turn isn't
  dropped.
- **bash maxBuffer + shell:** output overrunning the 1MB capture buffer is a
  truncated success (`{stdout, stderr, truncated:true}`), not a false failure;
  and the `{…}; $?` cwd wrapper always runs under `/bin/sh` instead of
  `$SHELL`, which broke under fish/csh.
- **Idle-timeout reader cancel:** `readWithIdleTimeout` now rejects *before*
  canceling the raced `reader.read()` (settling first is what preserves the
  error), tearing the connection down instead of leaking it for as long as the
  server holds the stream.
- **Atomic write/edit:** a shared temp-file + `rename()` helper (sibling dir,
  unique `wx` temp, cleaned up on failure) replaces in-place truncation; the
  write tool's no-overwrite protection is preserved and a failed/crashed write
  never tears a user file.
- **Loop detector catches alternation:** the no-progress guard keeps a rolling
  window of (call, result) pairs, refusing both 3× identical repeats (message
  unchanged) and an A/B/A/B two-cycle on its third repetition; a rerun
  separated by other work (the existing guard test) still passes.

Verified in this session: `node --test` **273/273 pass** (10 new tests).

---

#### 2026-08-24 — context cache (explicit) + automatic quota retry

**Status: ✅ done**

- **Explicit context cache** (opt-in via `ARGUS_CONTEXT_CACHE=on`, DashScope
  `cache_control` markers): `buildBody` stamps `{type:"ephemeral"}` markers on
  the system message (which also covers the tool schemas) and on the newest
  message, so a multi-turn session or a multi-step tool loop re-reads its own
  prefix instead of reprocessing it. Only the marked message is rewritten to
  content blocks; intermediate and non-cacheable messages keep plain shapes.
  Request-time only — persisted history is untouched.
- **Cache usage read:** `accumulateUsage` now tracks
  `cache_creation_input_tokens` (largest creation, like cached reads);
  `formatTokens` renders it as `✚N` between reasoning (`✶`) and cache reads
  (`≡`).
- **Automatic retry for HTTP 429 `insufficientquota`:** `request()` parses the
  DashScope error body and gives quota errors their own budget
  (`ARGUS_QUOTA_RETRIES`, default 2) and longer doubling backoff
  (`ARGUS_QUOTA_RETRY_DELAY_MS`, default 10s), independent of
  `ARGUS_MAX_RETRIES`. Non-quota (rate-limit) 429s keep the generic budget.
  Every retry emits a `retrying` event surfaced on stderr (headless) and as a
  result block (TUI); the mock server can now return arbitrary HTTP statuses.
- Caveat recorded where users will read it: explicit cache only works for
  models on the Model Studio "Explicit cache" list (e.g. `qwen3.8-max`);
  `deepseek-v4-flash*` is implicit-cache only, which already needs no config.

Verified in this session: `node --test` **256/256 pass**.

---

#### 2026-08-24 — TUI: distinct block separation + first-class confirm mode

**Status: ✅ done**

- **Block separation:** `transcriptLines()` now inserts a blank line whenever
  the block kind changes (user → thinking → tool → assistant), so thinking,
  tool calls, confirmations, and responses never visually blend. A tool call
  and its own result stay **paired** (no separator between them), and every new
  user prompt still gets its turn divider rail.
- **Confirm mode is now a distinct phase:**
  - A pending high-risk action renders in a dedicated warning row at
    `height - 3` (tool + cwd + command) with an explicit affordance row
    `[y] approve · [n] deny · [Esc] cancel` at `height - 2`.
  - The footer status names the phase (`confirm — y/n · Esc`) instead of
    reusing the working spinner.
  - `confirm()` records the pending question as a dedicated `confirm` block in
    the transcript; the agent's `approval` event records the decision as a
    `result` block, keeping approvals auditable.
  - `submit()` no-ops while a confirmation is pending (Enter can't start a
    nested turn); Enter during confirm resolves y/n via `insertText`.
- Added unit tests: separator pairing, confirm row/affordance/block, Enter
  during confirm, footer confirm phase. Real agent-loop mock test confirms the
  full `user → tool → confirm → approved → result → assistant → timing` flow.

Verified in this session: `node --check` on `src/tui*.mjs` + test; `npm test`
**249/249 pass**; live mock transcript matches the intended layout.

#### 2026-08-24 — doc: how to find tool failures in saved sessions

**Status: ✅ done**

- Added `docs/debug-tool-failures.md` — the exact session-file locations for
  failed tool results, a set of dependency-free `grep`/pipe queries that
  enumerate and group failures by tool and message, how to distinguish real
  tool failures from `bash` non-zero exits / read errors / turn-level errors,
  and how a full failure turn is reconstructable from the JSONL. It also
  records *why* no separate failure log is needed (every outcome is already
  persisted, and `eval/tool-choice.mjs` covers controlled traces).
- Linked it from `AGENTS.md` (file map + agent-docs list), `README.md`
  (sessions section), and `docs/self-updating.md` (documentation-set table).
- No code changed; the session/loop already persist failures (confirmed in
  `agent.mjs`, `session/store.mjs`, `headless.mjs`, `tui.mjs`).

Verified in this session: docs follow the one-owner/pointer rules; `git diff
--check` clean; no tests needed (no runtime change).

#### 2026-08-24 — `edit` description clarifies line-oriented range mode

**Status: ✅ done**

- Replaced the ambiguous phrase "replaces freshly read inclusive lines" in the
  model-visible `edit` description (`src/tools.mjs`) with an explicit
  line-oriented contract: a single-line replacement never merges with the
  following line; the block always occupies whole lines.
- Matched the executable contract prose in `docs/tools.md` (range mode
  paragraph) to the same wording so the two stay in agreement.
- No schema, validation, or engine behavior changed; the wording only removes
  the possible misreading that a range replacement rewrites all lines between
  `startLine` and `endLine`.

Verified in this session: `node --check src/tools.mjs`; full `npm test`
(244/244 pass); `git diff --check` clean.

#### 2026-08-24 — default system prompt names the agent Argus

**Status: ✅ done**

- Added a sentence at the top of the built-in default system prompt
  (`src/config.mjs`): the agent now identifies itself as **Argus**.
- Env override (`ARGUS_SYSTEM_PROMPT`) unchanged; documented example in
  `.env.example` unchanged (it never retells the default content).
- Added a config test covering the default prompt wording.

Verified in this session: `node --check` on `src/config.mjs` and
`test/config.test.mjs`; `npm test` (full suite) passes.

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
