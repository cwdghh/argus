# Argus improvements plan

Durable implementation plan distilled from a full-repo audit (11 subagents, run
2026-08-24: 9 dimensional readers incl. the `references/pi` sibling + synthesis +
completeness critic). Every finding below was **verified against the source** by
the maintainer session before being promoted to the plan. Line anchors are from
that date — **re-verify the anchor with a quick read before editing**; the code
is small and moves.

**How to use:** read `AGENTS.md` first, then pick a workstream. Each is
independently shippable; the execution order at the bottom is a recommendation,
not a dependency graph. On ship: append a `PROGRESS.md` entry, remove the item
from `NEXT_STEPS.md`, keep this file's status truthful. Commit to `main`
(conventional prefix: `feat:` / `fix:` / `refactor:` / `tui:` / `docs:` /
`test:`, trailing `Co-Authored-By: Claude <noreply@anthropic.com>`), and commit
before starting a new workstream.

Test convention: `node --test test/*.test.mjs`. The mock LLM server
(`test/helpers/mock-llm.mjs`) can now return arbitrary HTTP statuses
(`{status: 429, body: {...}}`) — use it for anything that needs error paths.

## The five user TUI asks — verdicts

| Ask | Verdict |
|---|---|
| 1. Better tool-call display | small change — per-tool label resolver, kills headless/block drift (W2) |
| 2. Multi-line input | mostly built; gaps = kitty keyboard protocol + Esc/history draft destruction (W1) |
| 3. Multi-line tool results | real gap, highest-value TUI fix — persist `block.detail` preview + `/show` (W2) |
| 4. Progress while writing a long file | write is one syscall — progress is noise; real gaps are bash buffering + footer active-tool (W2) |
| 5. `[Pasted Texts]` abbreviation | two coupled paste bugs, then the marker (W1) — **fix order matters** |

---

## W1 — Paste integrity + multi-line draft safety  *(small, medium impact)*

> **Status: shipped 2026-09-01** — items 1-4 (+ the draft slot) and the
> acceptance tests landed; item 5 (kitty keyboard protocol) remains optional and
> unfinished. See the PROGRESS.md entry.

**Files:** `src/tui.mjs` (pasting branch ~468-478, `insertText` ~529-558, Esc
~653-657), `src/tui/editor.mjs` (~213-231, historyUp/historyDown), `src/tui/keys.mjs`.

**Verified problems**
- Bracketed paste payload is flattened `replace(/\r?\n/g, " ")` (`tui.mjs:473`)
  and inserted character-by-character through `insertText` — the per-char
  keybinding interpreter. Pasted TAB fires path-completion and is dropped;
  pasted Ctrl-A/E/K/U move the caret / delete (`tui.mjs:536-558`).
- **Ordering hazard (critic correction):** `insertText` maps `cp===13/10 →
  submit()` (`tui.mjs:553`). Preserving newlines in a paste is only safe AFTER
  the paste path bypasses the interpreter. Do the bulk-literal insert FIRST.
- Esc silently flattens a multiline *draft* (`tui.mjs:655`, `replace(/\n/g," ")`);
  `historyUp` overwrites the in-progress draft (`editor.mjs:213-218`). Two
  silent data-loss paths, no undo.

**Changes**
1. In the pasting branch insert the payload with a single literal `editor.insert()`
   (control bytes become text), refresh suggestions once — keybindings must
   never fire from pasted bytes.
2. Preserve `\n` in pasted payload (allowed once 1 lands).
3. For pastes > ~1000 chars / > N lines, render the user block as `[pasted N
   lines]` (or `[pasted N chars]`); full text already persists in the session
   JSONL, so history stays intact.
4. Esc on a non-empty draft: do not flatten silently (keep or confirm); give the
   editor a draft slot restored on history walk-off past the end.
5. Optionally enable the kitty keyboard protocol (`\x1b[>1u`) so Shift+Enter and
   Alt chords arrive on terminals that don't emit them by default.

**Acceptance:** new raw-paste tests (payloads with TAB/ESC/control bytes and
`\n`/`\r\n`); pasted buffer is byte-exact; no submit fires mid-paste; multiline
draft survives Esc and history navigation. The existing paste test
(`tui.test.mjs:550-556`) asserting the newline fold must be updated.

## W2 — Tool output visibility  *(small→medium, highest-value TUI work)*

> **Status: shipped 2026-09-01** — every item below landed with a test. See
> the PROGRESS.md entry.

**Files:** `src/format.mjs` (new `toolLabel` + `previewResult`), `src/tui/blocks.mjs`
(~11-14 `formatArgs`, ~46-55 result render), `src/tui.mjs` (~259-266 tool blocks),
`src/headless.mjs` (~73), `src/tui/frames.mjs` (~26-42 `statusText`),
`src/tools.mjs` (~65 continuation hint).

**Verified problems**
- `formatArgs` JSON-stringifies whole args and truncates to 57 chars
  (`blocks.mjs:11-14`); a 4KB write renders as `⚙ write({"path":…,"content":"var…`.
  `headless.mjs:73` mirrors it with an *unlimited* dump — the two frontends
  already drift.
- `tool_result` stores only `{ok, summary, durationMs}` where `summary =
  summarize(ev.result)` = first line, 80 chars (`tui.mjs:265`, `format.mjs:53-73`).
  A 2000-line read or build log is invisible in the transcript, though the full
  bounded result is available at event time (`agent.mjs:358`) and persists in
  the JSONL.
- `fitReadResult` appends `[Showing X-Y of Z. Use offset=… to continue.]` at the
  **end** of `numberedText` (`tools.mjs:65`); `summarize` keeps only the first
  line, so whether a read was truncated/paged is invisible.
- `statusText` renders only `⠋ working <elapsed>` (`frames.mjs:26-42`);
  `activeToolStartedAt` is set on tool_call and only read back for `durationMs`.
- Session JSONL stores full raw args in tool blocks — the same 4KB write also
  sits in the turn's messages (~8KB on disk per write); resumed sessions
  re-render the junk through the 57-char truncation.

**Changes**
1. `toolLabel(name, args)` in `format.mjs`, used by BOTH `blocks.mjs` and
   `headless.mjs`: `read/write/edit` → path, `bash` → command, content-like
   fields (content/old/new/numberedText) → `(content N chars)`,
   e.g. `⚙ write → src/foo.mjs (content 4120 chars)`. Also produce the *persisted*
   tool block from this resolver to stop the args write/parse amplification.
2. `block.detail = previewResult(result)` — ~20 lines / ~2KB cap derived from
   `stdout`/`numberedText`, rail-prefixed like the thinking block, ending
   `… N more lines`. Add `…N more lines` to the compact `summarize()` line when
   the result carried `truncated`/`nextOffset`.
3. `/show N` (or Enter-to-expand on a result line) that prints the full stored
   block from the session record — no selection model needed since the content
   is already in the JSONL.
4. Track `this.activeTool` on `tool_call`, clear on `tool_result`; after ~1s,
   render `⠋ bash (<command>) 12.3s` in `statusText`.
5. *(Bigger, optional later)* switch `bash` to `spawn` with throttled `onEvent`
   deltas into a live result block (pi's `PREVIEW_LINES` pattern); no new deps.

**Acceptance:** a 2000-line read shows a preview + `… N more lines`; write tool
line shows the path not content junk; footer names the tool during a slow bash;
headless and TUI render identical tool lines from the same events; `/show`
works on a resumed turn.

## W3 — Reliability batch  *(small, high value)*

> **Status: shipped 2026-09-01** — every bullet below landed with a test. See
> the PROGRESS.md entry.

- **Protocol-safe histories on mid-loop guards** (`agent.mjs:132-161`):
  `turnMessages.push(reply)` precedes the repeat/max-steps/result-budget guards;
  a throw leaves a dangling assistant tool_call with no matching tool message.
  Trim trailing tool_calls or synthesize `{error:true, message:"call was never
  executed"}` before exposing `err.turnMessages`. Add a session-invariant test:
  no persisted turn violates tool pairing.
- **Interrupt double-marker** (`blocks.mjs:48` vs `tui.mjs:307`): ✗ suppression
  only matches `"interrupted"` but the TUI pushes `"⏹ interrupted"` → every
  interrupt renders `✗ ⏹ interrupted`.
- **Denied-approval double block (critic)** (`tui.mjs:267-275` + `:262-266`):
  a denied approval pushes both the `approval`-event result and the
  `tool_result` error block. Dedupe (one "denied …" row).
- **Ctrl-D mode guard** (`tui.mjs:542-545`): `cp===4` calls `stop()` (→
  `process.exit`) whenever the buffer is empty — that's mid-turn. Guard when
  `mode !== "idle"` like Esc/Ctrl-C, and await the write queue before exit.
- **bash maxBuffer overrun is success-shaped** (`tools.mjs:359-366`):
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` currently becomes `{error:true}` even for
  a run that succeeded. Return `{stdout, stderr, truncated:true}`.
- **bash shell under `/bin/sh`** (`tools.mjs:345`): `process.env.SHELL` breaks
  the `{…}; $?` cwd wrapper under fish/csh.
- **Idle-timeout leaks the connection** (`llm.mjs:216-246`): cancel the raced
  `reader.read()` on idle timeout and on user abort.
- **Write/edit atomicity** (`tools.mjs:190,276`): `writeFile` with `flag:"w"/
  "wx"` truncates in place; crash tears a user file. Shared temp-file +
  `rename()` (sibling dir) helper.
- **Loop detector misses alternation** (`agent.mjs:179-183`): `repeatStreak`
  resets on any key change, so A/B/A/B with identical results never trips.
  Add a rolling window of (call, result) pairs per turn.

**Acceptance:** one test per item; full suite green.

## W4 — Session durability & startup scale  *(medium)*

> **Status: shipped 2026-09-01** — every bullet below landed with a test. See
> the PROGRESS.md entry.

- **Torn-line recovery** (`store.mjs:264`, `resume.mjs:34`): a single unparseable
  interior JSONL line throws and bricks the session — skip-and-warn interior
  lines and try/catch `latestSessionForCwd` so startup can't be blocked. Two-line
  fix, highest durability payoff.
- **Streaming meta scanner** (`resume.mjs:34`, `store.mjs:240`): startup and
  `/sessions` full-load up to 20 sessions to read one small `cwd`/`model`
  record. Scan payloads starting `{"type":"meta"`/`"cwd"`/`"model"` (record
  types always lead, `store.mjs:314/324/339`) and skip turn lines — ~2-3 orders
  of magnitude faster startup.
- **`loadSession` memory spike** (`store.mjs:243-253`): `readFile` + `split("\n")`
  copies held simultaneously; use `readline.createInterface`, keep full parse
  only on the actual resume path.
- **Persist `systemPrompt` once** (`store.mjs:360-364`): it's duplicated on every
  turn record (10KB × 300 turns ≈ 3MB re-parsed each load); a `{type:"config"}`
  record like model/cwd.
- **`pruneSessions` in headless** + parallelize `listSessions` stats with
  `Promise.all` (`store.mjs:139`).
- **Dead exports:** `truncateRead` (`src/read-bounds.mjs`), `recordRead`
  (`src/tool-state.mjs:34`), `latestSessionName` (`src/session/index.mjs:13`).

**Acceptance:** a torn-line fixture loads with a warning; timing benchmark on a
synthetic 20-session dir.

## W5 — Core-loop hardening  *(medium)*

> **Status: shipped 2026-09-01** — every bullet below landed with a test. See
> the PROGRESS.md entry.

- **Mid-stream retry** (`llm.mjs` ~313-357): `request()` retries only the initial
  POST; a disconnect mid-SSE-body kills the turn though the step is idempotent.
  Retry the *step* at the loop level — extract `runModelStep` from the `runTurn`
  monolith (`agent.mjs:51-200`) so retry/fallback wrap one call (mechanical;
  tests assert through `runTurn`, low risk).
- **Build the body once** (`agent.mjs:432-437` vs `llm.mjs:275`):
  `requestPayloadChars` stringifies the full body to measure, then `streamChat`
  builds it again (the code comments the two "must stay identical");
  incremental measurement (static tools+system cost cached, re-measure messages).
- **Decouple `maxRequestChars`** (`agent.mjs:60`): it silently defaults to the
  compaction char budget; add explicit `ARGUS_MAX_REQUEST_CHARS` (validate ≥500).
- **Multi-tool batches sequential instead of throwing** (`agent.mjs:126-129`):
  some endpoints ignore `parallel_tool_calls:false`.
- **Graceful `finish_reason:"length"`** (`agent.mjs:122-124`): currently thrown
  away and the turn marked failed; push with `truncated:true`, feed non-executed
  tool_calls back as error tool results.
- **Tail-first truncation** (`agent.mjs` ~379-417): `boundToolResult` keeps the
  head, discarding the actionable tail of a failing build; keep last N chars +
  spill full output to `~/.argus/tmp` with the path in the result.

**Acceptance:** a mid-stream idle timeout/disconnect retries the step without a
user abort; suites green.

## W6 — Feature backlog  *(medium→large, independent)*

1. **Interrupt→continue** — spec approved (`docs/interrupt-resume.md`):
   return `{partialText}`, replay-safe trimmed assistant message, Enter to
   continue via a `request_input` seam, SIGINT flush. Large.
2. **Per-block rendered-line cache** — `transcriptLines()` re-wraps/re-tokenizes
   every block (~25×/s while streaming, full markdown incl. tables) and
   `maxScroll()` re-walks it; key on `(blocks.length, width)`, rebuild only the
   tail → O(delta). Large payoff on long sessions.
3. **LLM-assisted structured compaction** — replace the lossy
   `User:…|Assistant:…` digest (`compact.mjs:96-111`) with a one-call
   Goal/Constraints/Progress/Next-Steps summary (pi `compact.ts`), fallback to
   the digest on LLM failure. Medium.
4. **Mid-turn fallback model** — `ARGUS_FALLBACK_MODELS` reissues the same step
   on quota/429-budget exhaustion (`llm.mjs` quota path), emitting a
   `model_fallback` event; pairs with the existing quota retry. Medium.
5. **Steering** — pending-message queue drained between loop iterations (Enter
   while working queues a `steer` block); today input during a turn silently
   mutates the next prompt. Medium.
6. **Shared agent-event → block projector** — `tui.mjs:252-298` vs
   `headless.mjs:55-86` already drift (TUI persists `compacted`/`retrying`
   blocks, headless only prints); extract `consumeAgentEvent()` in
   `transcript.mjs`. Medium.
7. **Sub-agent task tool** — recursive `runTurn` for bounded, isolated
   exploration, depth-guarded. Medium.
8. **Mid-turn compaction** — digest oldest already-consumed tool-result pairs
   in a copy of `turnMessages` instead of hard-throwing. Large.

## Critic corrections to internalize (avoid implementing wrong advice)

1. Paste fix **must** land bulk-literal insert (W1.1) before preserving newlines
   (W1.2) — otherwise each pasted newline fires `submit()`.
2. Esc/history flat/overwrite a multiline draft (folded into W1).
3. Denied approvals render two blocks (folded into W3).
4. `summarize()` hides read-paging hints (folded into W2).
5. **Do NOT implement** "reject spaces in session names" — `nameError` already
   rejects them (`store.mjs:59`); only a friendlier quote-parse is left.
6. Persisted tool blocks re-store raw args already present in messages — build
   them from the shared label resolver (folded into W2.1).

## Suggested execution order

- **Batch A (start here, independent + small):** W1 (paste) → W3 (reliability).
- **Batch B:** W2 (tool visibility — highest user-facing value).
- **Batch C:** W4 (session durability/scale).
- **Batch D:** W5 (core loop).
- Then pick W6 items, starting with interrupt→continue (1) or the render cache (2).

## Audit provenance

Full report (deep-dive per-area text): the audit workflow task output from
2026-08-24 (ephemeral temp path; per-agent returns also in the run's
`journal.jsonl`). This file is the durable, maintainer-verified distillation —
treat it as the source of truth over the workflow's raw output.