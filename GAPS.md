# GAPS.md — where argus stands vs. a production agent

**Purpose:** a living reference for what argus deliberately omits, and the open
design questions we want to discuss in detail later. This is *not* a checklist to
copy from `pi` line by line. Argus should grow its own characteristics — this file
just records the territory so we can decide what argus wants to be.

**How to use:** each gap lists *what it is*, *why it matters*, *pi's high-level
approach* (conceptual only), and *open questions specific to argus*. The open
questions are deliberately unresolved — we'll discuss them.

---

## 1. Streaming output

> **Status: resolved (2026-08-10)** — text AND reasoning/thinking are streamed via
> `src/llm.mjs` (SSE) and rendered live by the TUI (thinking shown muted).

- **What:** text and reasoning stream live. Tool calls are assembled from stream
  fragments and shown once their arguments are complete.
- **Why it matters:** makes the agent feel responsive and lets you inspect
  thinking/tool-call intent while it's happening.
- **pi's approach (conceptual):** streams token deltas and emits events
  (`text_delta`, `thinking_delta`, `toolcall_delta`) that the TUI renders live.
- **Open questions for argus:**
  - Should incomplete tool-call arguments ever be shown live, or only after
    they form valid JSON?

## 2. Tool execution policy (permission / safety gate)

> **Status: partially resolved (2026-08-24)** — tools declare model-invisible
> risk classes; policy triggers produce structured authorization requests and
> persisted decisions. Destructive shell patterns ask for TUI confirmation and
> are blocked headlessly. This remains a best-effort gate, not a sandbox or
> comprehensive shell policy.

- **What:** file tools and ordinary shell commands run immediately; a small set
  of destructive shell patterns requires a human check in the TUI.
- **Why it matters:** "model proposes, code disposes" is only meaningful if the
  code actually *decides*. A gate is where safety, trust, and control live.
- **pi's approach (conceptual):** `beforeToolCall` / `afterToolCall` hooks that
  can allow, block, or rewrite tool calls; containerized/sandboxed execution.
- **Open questions for argus:**
  - Should policy become user-configurable by risk class, tool, or path?
  - Should argus support a sandbox, or stay host-native deliberately?

## 3. Parallel tool execution

> **Status: deliberately omitted (2026-08-24)** — argus requires exactly one
> tool call per model step and rejects provider violations before side effects.
> Sequential execution keeps authorization, cwd, freshness, and audit order
> unambiguous. Revisit only with measured latency evidence that justifies a new
> concurrency contract.

- **What:** we run tool calls one at a time, in order.
- **Why it matters:** independent calls (e.g. read three files) could run
  concurrently and finish faster.
- **pi's approach (conceptual):** sequential vs parallel modes, with ordering
  caveats around correctness.

## 4. Context management (compaction / truncation)

> **Status: resolved at the minimal level (2026-08-11)** — deterministic
> compaction keeps recent turns and summarizes older user intent + outcomes.
> Tool results also have a hard per-result cap. Smarter semantic summaries
> remain open.
> **2026-08-17:** `read` now self-bounds too — at most 2000 lines or 50KB per
> call, with `offset`/`limit` paging and numbered lines, so reading a large
> file never floods the context window; the per-result cap stays as the
> backstop, and the model is told exactly which window it saw and how to
> continue.
> **2026-08-18:** per-turn token accounting resolved: `accumulateUsage` never
> counts shared context twice (largest prompt + summed completions), an
> interrupted turn records only completed steps, and the footer context meter
> (`X / Y (Z%)`) uses the real, provider-reported prompt tokens of the most
> recent request as X.
> **2026-08-22:** auto-compact audited and the default limit relaxed to 200k
> **real tokens**. The compaction *decision* now uses real provider tokens too
> (`ARGUS_COMPACT_TOKENS`, default 200_000, fed by `nextContextTokens` from the
> last turn's usage); `ARGUS_COMPACT_AT` (chars) survives only as a
> pre-first-usage safety net. Repeated compactions now carry earlier summaries
> forward instead of silently forgetting them.
> **2026-08-24:** active turns now have a cumulative tool-result budget in
> addition to per-result/read bounds, and the complete outgoing request is
> measured before network I/O. Summaries remain terse deterministic digests,
> not semantic rewrites.

- **What:** recent history is sent verbatim; older turns are compacted into a
  deterministic summary after a configurable character budget.
- **Why it matters:** the context window is a budget; long sessions overflow.
- **pi's approach (conceptual):** summarizes/compacts old messages, truncates
  what no longer fits.
- **Open questions for argus:**
  - When is a real model-generated summary worth its latency and complexity?
  - ~~Should the compaction decision use provider token counts instead of
    character estimates?~~ Resolved 2026-08-22: `ARGUS_COMPACT_TOKENS` drives
    compaction from real provider tokens; `ARGUS_COMPACT_AT` remains only as
    the pre-first-usage safety net.

## 5. Session persistence

> **Status: resolved (2026-08-10)** — append-only JSONL sessions auto-save and
> resume transcript, messages, configuration, and working directory.

- **What:** turns are appended to readable JSONL files and the latest session is
  resumed automatically unless the user asks for a new or named session.
- **Why it matters:** agents that survive restarts are far more useful (resume a
  task, audit what happened).
- **pi's approach (conceptual):** session backends (memory, SQLite, JSONL) that
  store the transcript.
> **2026-08-16:** automatic retention is resolved via `ARGUS_SESSION_KEEP` (prune
> on TUI startup, newest-first by mtime, active session always preserved), and
> `/sessions` now reports file sizes.
> **2026-08-17:** naming is resolved — `/name <name>` renames the current
> session (a pure file move: the name lives only in the filename), `/new <name>`
> names a session at creation, and session-targeting commands complete saved names in
> the editor popup, so a large session collection stays navigable. Rejected
> names (spaces, non-ASCII, >249 chars) report the reason; the destination is
> reserved with O_EXCL so a rename can never clobber an existing session; and
> renaming a just-created `/new` session (no file on disk yet) is a pure
> handle repoint.
> **2026-08-17:** the auto-resume default is now folder-scoped — starting
> without `--session`/`--new` picks the newest session whose cwd is the
> current folder or a subfolder (newest 20 considered), and falls back to a
> fresh session rather than another repo's latest.
> **2026-08-24:** `/delete <name>` adds confirmed exact-name cleanup, refuses
> the active session, and updates completion immediately. Session directories
> and newly written transcript files use owner-only POSIX permissions.

- **Open questions for argus:**
  - When would JSONL stop being sufficient and justify SQLite?

## 6. Multi-provider abstraction

- **What:** we're hard-wired to the OpenAI-compatible protocol (by design, and it
  covers a lot: DashScope, OpenAI, Ollama, vLLM, …).
- **Why it matters:** a thin abstraction lets one agent talk to many backends.
- **pi's approach (conceptual):** a provider layer (`packages/ai`) that maps a
  common message type to each vendor.
- **Open questions for argus:**
  - Is OpenAI-compatible enough, or do we want Anthropic natively?
  - Do we want a provider registry, or keep it intentionally minimal?

## 7. Robustness / error handling

> **Status: partially resolved (2026-08-13)** — model requests have bounded
> timeout/retry behavior, turns have a step cap, tool arguments are validated,
> truncated tool calls never run, and tool results are size-bounded.
> Stream-protocol diagnostics and process isolation remain intentionally small.
> **2026-08-17:** timeouts were relaxed for reasoning models that think a long
> time before the first byte or between chunks — request timeout 600s, stream
> idle 300s by default, both configurable and mirrored in `.env.example`.
> **2026-08-24:** schema validation is recursive, provider multi-call replies
> are refused before side effects, the last model step is reserved for result
> synthesis, repeated no-progress calls are bounded, and active-turn result
> growth has a cumulative cap.

- **What:** expected failures have bounded handling, but malformed provider
  streams and subprocess isolation remain limited.
- **Why it matters:** real sessions hit malformed output, token limits, and API
  hiccups; an agent should degrade gracefully.
- **pi's approach (conceptual):** treats a `length` stop as "arguments may be
  truncated" and fails the batch rather than executing possibly-broken calls;
  encodes failures as error events.
- **Open questions for argus:**
  - Should malformed SSE events fail fast or remain compatibility-tolerant?
  - Is process-group cleanup enough, or should shell tools run in a sandbox?

## 8. Terminal UX

> **Status: resolved and refined (2026-08-13)** — a minimal, dependency-free TUI
> (`src/tui.mjs`, raw-mode + ANSI) with markdown, scrollable history, a bottom
> editor with caret, thinking display, live timings, and a responsive status
> footer.
> **2026-08-17:** GFM markdown tables render as aligned box-drawing tables in
> the transcript, and column widths are CJK/emoji-aware (East Asian wide = 2,
> ZWJ/VS16/skin-tone modifiers = 0, flags = 2) so borders stay aligned in
> mixed scripts.

- **What:** a raw-mode ANSI TUI provides streaming markdown, a fixed editor,
  transcript scrolling, theme detection, phase/tool/turn timing, and live
  responsive status.
- **Why it matters:** the interface shapes how it feels to drive the agent.
- **pi's approach (conceptual):** a full differential-rendering TUI.
> **2026-08-16:** runtime model switching is resolved via `/model <name>` — the
> switch is per-session, persisted in the session JSONL, restored on resume, and
> resets to `ARGUS_MODEL` on `/new`. Desktop notifications remain an open
> question (would a terminal-only agent keep its identity?).
> Width measurement is per code point and covers common cases, but remains
> approximate for grapheme clusters — keycap sequences (`1️⃣`), ambiguous-width
> symbols (ornamental dingbats, geometric shapes), and the few emoji that
> render narrow without VS16. Revisit grapheme-aware measurement only if such
> glyphs show up in real output.

## 9. Testing & evals

> **Status: resolved for regression testing (2026-08-11)** — the dependency-free
> mock-LLM suite covers the loop, tools, aborts, sessions, headless mode, safety,
> compaction, CLI parsing, retries/timeouts, and TUI behavior.
> **2026-08-24:** an opt-in provider-backed tool-choice evaluator now exercises
> content edit, fresh range edit, shell search, and new-file creation in
> isolated temporary workspaces. Broader coding-quality benchmarks and
> transcript replay remain open.

- **What:** deterministic integration tests exercise a scripted local SSE
  model; `npm run eval:tools` supplies a small real-model surface eval, but not
  a general answer-quality benchmark.
- **Why it matters:** the loop's behavior is subtle; evals catch regressions.
- **pi's approach (conceptual):** a full eval harness and conformance tests.
- **Open questions for argus:**
  - Do we want a way to replay saved transcripts as tests?
  - Which behavioral evals would actually predict useful coding performance?
  - Which additional tasks and provider baselines predict useful coding
    performance without turning the small repo into an eval framework?

## 10. Model catalog / configuration

> **Status: partially resolved (2026-08-16)** — `/model <name>` switches the
> model at runtime; the override is stored per session and restored on resume,
> and `/new` falls back to the `ARGUS_MODEL` env default.
> **2026-08-24:** settled the prompt-vs-tools split — JSON tool schemas and
> their descriptions own tool mechanics; the default system prompt carries
> repository behavior without repeating edit/bash usage. The prompt remains
> plain text from env/fallback, not a versioned artifact.
> **2026-08-17:** config gained a third source — global defaults in
> `~/.argus/.env` (same variables/format as the project `.env`, loaded last
> so it only fills gaps). Precedence is process env > project `.env` >
> home `.env` > built-in defaults; `ARGUS_HOME` relocates both the file and
> the session store.

- **What:** one model + one system prompt, read from env.
- **Why it matters:** model choice and prompt are the user-facing "knobs."
- **pi's approach (conceptual):** a generated model catalog; per-session config.
- **Open questions for argus:**
  - Version the system prompt as a first-class artifact?

---

## 11. File editing reliability & freshness

> **Status: resolved at the current design level (2026-08-24)** — `edit` is exact→fuzzy,
> batches atomically (`edits[]`), preserves CRLF/BOM, and gained line-range
> mode (`startLine`/`endLine`/`new`) for whole-block rewrites, insertions, and
> deletions. Range edits require same-turn hash-and-line coverage from `read`;
> partial reads authorize only their displayed range, mutations invalidate the
> path, and any executed shell command invalidates all evidence.
> **2026-08-24 experiment:** the rendered read field is now named
> `numberedText`; copied gutters remain accepted in `old`, while strong evidence
> of gutters leaking into `new` is rejected before the atomic batch mutates.
> Three uncued live-model trials produced clean selector/replacement text and
> exact outcomes with zero invalid calls.

- **What:** editing is the highest-frequency and highest-risk tool. Two
  failure modes dominated: (a) the model's `old` text doesn't match the file
  byte-for-byte ("no old strings"), and (b) the model's sense of *where* —
  line numbers, or the file's current shape — is stale.
- **Why it matters:** "edits fail with no old strings" was argus's most
  recurring reliability problem; and a wrong-but-successful edit is worse
  than an error because it corrupts the file silently.
- **Resolving (a) — content mode:** exact match first, then a normalized fuzzy
  match (NFKC, ASCII folding of quotes/dashes/spaces, trailing-whitespace and
  CRLF tolerance, and `N │ ` gutter-stripping for text copied from a numbered
  read). A normalized offset map identifies the exact original match span, so
  unrelated punctuation/whitespace stays identical and CRLF + UTF-8 BOM survive. The result
  reports `fuzzy: true`, and failures keep the "copy from a fresh read"
  guidance.
- **Resolving the *where* — range mode:** `startLine`/`endLine`/`new` replaces
  the inclusive 1-indexed line range; `endLine = startLine - 1` inserts;
  `new = ""` deletes. Line-oriented like `sed` — the block occupies whole
  lines and never merges with neighbours. Content and range edits mix in one
  `edits[]` batch, all resolved against the original file and applied
  bottom-up, with bounds/overlap errors that name the file's current line
  count.
- **pi's approach (conceptual):** an edit diff/merge facade — exact match
  first, then fuzzy fallback; results tagged `isExactMatch`/`isFuzzyMatch`;
  edits into files above a context-size threshold are refused (a soft
  read-first stance rather than tracked state).
- **Open questions for argus:**
  - Would a short verification anchor (the first line of the old block)
    ever justify its per-edit model burden, or is the guard the better
    mechanism? (`expect` was deliberately cut for now.)
  - Does an explicit edit-operation discriminator outperform the current
    selector shape on uncued insert/delete/mixed-batch tasks enough to justify
    its extra field, or is the existing model behavior already sufficient?

---

## 12. Tool design — what should the tool surface be?

> **Status: resolved for the current surface (2026-08-24).** The canonical
> four-tool decision, admission rule, and D1–D15 rationale live in
> `docs/tool-surface.md`; the executable contract lives in `docs/tools.md`.
> Reopen this gap only with behavioral evidence that an existing tool cannot
> be refined to cover a recurring failure.

## Meta-question (the one we'll return to)

Each gap above is a *direction*, not a mandate. When we discuss in detail, the
question is: **which characteristics should define argus?** For example:

- Minimal-and-correct (few moving parts, everything auditable)?
- Educational (every feature exists to teach a concept clearly)?
- Opinionated-single-provider (great one experience) vs. portable-neutral?

We'll settle this together. For now, this file is just the reference map.
