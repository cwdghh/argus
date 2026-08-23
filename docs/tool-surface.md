# Tool surface — canonical tool set & usage (discussion tracker)

**Status: in discussion (2026-08-23).** This file is the single source of
truth for the ongoing decision about *which* tools argus exposes to the model
and *how the model is told to use them*. A decision is recorded in the
decision log below **before** any code changes; once a row is `decided`, the
change ships with its tests and doc updates in the same commit.

Owner: this file. Pointers: `GAPS.md` #12, `NEXT_STEPS.md` #1, `docs/tools.md`
(`docs/tools.md` is the contract — *what the code does today*; this file is
*what we are deciding*).

## How to use this tracker

- Every unresolved question is a row in the decision log (`D#`), status `open`.
- To resolve one, flip the row to `decided` with a date and one-line rationale,
  then implement (tests + docs in the same change).
- Don't retell answers here in `GAPS.md` or anywhere else — point at the row.
- This file is a live doc: keep it under ~400 lines; move superseded stretches
  to `docs/archive/` when it grows (see `docs/self-updating.md`).

## Current state (snapshot 2026-08-23)

Exactly **four** model-visible tools, stable since argus started. The set is
test-enforced (`test/tools.test.mjs` asserts the `tools` array is exactly
`["read", "write", "edit", "bash"]`); no tool has been added or removed.

| Tool | Model-visible schema | Returns | Safety | Told to be used for |
|------|----------------------|---------|--------|---------------------|
| `read` | `path` (req), `offset?`, `limit?` | numbered lines `N │ text`, bounded at 2000 lines / 50KB, `truncated`/`nextOffset` + continue notice; `{error}` for bad offset / oversized single line | read-only, no gate | inspecting files; paging big ones; copy line numbers for `edit` |
| `write` | `path` (req), `content` (req), `overwrite?` | `{ok, path, bytes}`; `{error, message}` when the file exists | refuses overwrite unless `overwrite: true` | new files / whole-file replaces |
| `edit` | `path` (req), `edits[]`, `all?` | `{ok, path, replacements}` (+ `fuzzy`); `{error}` with actionable message | atomic bottom-up apply; ambiguous `old` errors unless `all`; overlapping edits rejected; CRLF/BOM preserved | precise content swaps; line-range rewrites, inserts, deletes |
| `bash` | `command` (req) | `{stdout, stderr, cwd}`; `{error}` on non-zero exit; `{aborted}` on timeout | 60s timeout, 1MB buffer, destructive-pattern gate (TUI confirm / headless block), cwd persists across calls | everything else: env inspection, listings, builds, git |

The full contract (schema, result shapes, examples, edge cases) is
`docs/tools.md`; the model's only documentation is each tool's `description`
plus the system prompt (`src/config.mjs`) — that is exactly the text a
decision here can make heavier or lighter.

### Where the "ways to use them" live today

- **Tool descriptions** (`src/tools.mjs`): each tool tells the model when/how
  to use it (e.g. `read` → "copy these numbers for startLine/endLine edits";
  `edit` → "content form for small changes, range form for whole-block
  rewrites"; `write` → "prefer edit for precise changes").
- **System prompt** (`src/config.mjs`): re-states the tool list and retells the
  `edit` and `bash` usage guidance that the tool descriptions already carry
  (see candidate **R2** below).
- **Loop-level rules** (`src/agent.mjs`, `src/llm.mjs`): one tool per model
  step (`parallel_tool_calls: false`), a stop guard after 3 identical tool
  calls, a per-result cap (`ARGUS_MAX_TOOL_RESULT_CHARS`), and `maxSteps`.

## Removal / simplification candidates

Things that may be "used" only by code, not by the model, or that cost tokens
without earning them. Each maps to an open decision below.

- **R1 — legacy top-level `edit` fields.** The model-visible schema has exposed
  only the canonical `edits[]` shape since 2026-08-23, but `execute` still
  tolerates top-level `old`/`new`/`startLine`/`endLine`, and
  `test/tools.test.mjs` has an explicit "edit legacy old/new still works" test.
  The model cannot produce these today; the only argument to keep them is
  replay of old saved transcripts. → D5.
- **R2 — system-prompt duplication.** The system prompt retells the tool list,
  the `edit` content-vs-range guidance, and the `bash` cwd persistence fact —
  all already in the tool descriptions. Removing the retold sentences is a
  small, low-risk prompt-token win (the "heavy burden to the models" concern
  in the discussion brief). → D13.
- **R3 — `/exit` / `/quit` alias (adjacent, not a model tool).** Both TUI
  commands stop argus identically. Harmless convenience; noted only so the
  surface audit is complete. → D15.

## The bar (what earns a tool a place)

Candidate tests from `GAPS.md` #12 — still open, and the crux of this
discussion:

- (a) measurably reduces model error,
- (b) saves context tokens vs the `bash` equivalent,
- (c) adds a capability `bash` can't do safely,
- (d) makes the transcript more auditable.

Which of these do we actually want to enforce, and how do we measure them
(e.g. a behavioral eval that exercises tool *choice*)? → D6, D14.

## Draft proposal (2026-08-23 — awaiting your review)

**Recommended set: `read`, `write`, `edit`, `bash` — unchanged names, no
additions.** Anything that looks like a new tool either duplicates one of
these or belongs at the loop level. Four principles shape the schemas:

1. **One canonical shape per tool** — no legacy fields, no aliases (D5, D10).
2. **Fewest parameters that cover real use.** Every optional knob is surface
   the model pays for on *every* request; extra knobs are the "heavy burden"
   we are removing (D7).
3. **`error: true` is the failure signal.** Success returns the natural
   payload — no mandatory `ok` flag on read/bash (it would be pure overhead);
   mutating tools (write/edit) keep `ok: true`. Bounded results follow the
   `read` pattern: a truncation flag, the continuation handle, and a
   human-readable "how to continue" note (D9).
4. **Tool descriptions are the single source of usage guidance.** The system
   prompt stops retelling them (D13).

### read — risk: read-only

```js
{
  name: "read",
  description: "Read a file and return its text with every line prefixed by its absolute 1-indexed line number — copy those numbers for edit's startLine/endLine. Output is bounded at 2000 lines or 50KB; pass offset/limit to page through large files. Paths are relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path:   { type: "string", description: "File to read" },
      offset: { type: "integer", minimum: 1, description: "1-indexed first line to return (default: 1)" },
      limit:  { type: "integer", minimum: 1, description: "Maximum lines to return (default: up to the 2000-line / 50KB bound)" },
    },
    required: ["path"],
  },
}
```

Result: `{ path, content }` — numbered lines, bounded at 2000 lines / 50KB;
`{ path, content, truncated: true, nextOffset: N }` plus a `[..Use offset=N to
continue.]` note when cut short; `{ error: true, path, message }` on failure.
(No schema change — read already models the result-shape contract.)

### write — risk: mutating

```js
{
  name: "write",
  description: "Create a new file with the given content. Refuses to overwrite an existing file unless overwrite=true; use edit for precise changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      path:      { type: "string", description: "Path of the file to create" },
      content:   { type: "string", description: "Full text content to write" },
      overwrite: { type: "boolean", description: "Allow replacing an existing file (default: false)" },
    },
    required: ["path", "content"],
  },
}
```

Result: `{ ok: true, path, bytes }`; `{ error: true, message }` when the file
exists (with the overwrite hint). (No change from today.)

### edit — risk: mutating (canonical, legacy removed)

```js
{
  name: "edit",
  description: "Apply one or more targeted replacements to an existing file in a single atomic call. edits[] mixes content mode ({old, new}: exact replace, tolerant of trailing whitespace and unicode punctuation; old must be unique unless all=true) and range mode ({startLine, endLine, new}: replace inclusive 1-indexed lines copied from a read; endLine = startLine - 1 inserts before startLine; new = '' deletes).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit" },
      edits: {
        type: "array",
        description: "Targeted replacements, applied atomically bottom-up in one call",
        items: {
          type: "object",
          properties: {
            old:       { type: "string", minLength: 1, description: "Content mode: text to replace (must be unique unless all=true)" },
            new:       { type: "string", description: "Replacement text (content or range mode)" },
            startLine: { type: "integer", minimum: 1, description: "Range mode: first line to replace (1-indexed, from a read)" },
            endLine:   { type: "integer", minimum: 1, description: "Range mode: last line (default startLine; startLine-1 inserts before startLine)" },
          },
        },
      },
      all: { type: "boolean", description: "Replace every occurrence of old (default: false)" },
    },
    required: ["path"],
  },
}
```

Result: `{ ok: true, path, replacements }` (+ `fuzzy: true` on a relaxed
match); `{ error: true, path, message }` with an actionable message.

**Proposed change (R1/D5):** delete the legacy top-level
`old`/`new`/`startLine`/`endLine` tolerance in `execute` and the
"edit legacy old/new still works" test — the schema is the only entry point.

### bash — risk: shell (destructive-pattern gate stays as backstop)

```js
{
  name: "bash",
  description: "Run a shell command and return its stdout and stderr. The working directory persists across calls (cd is remembered). Destructive commands (recursive rm, dd, mkfs, shutdown, ...) require approval. 60s timeout.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
    },
    required: ["command"],
  },
}
```

Result: `{ stdout, stderr, cwd }`; `{ error: true, stdout, stderr, message,
cwd }` on non-zero exit; `{ error: true, aborted: true, message }` on timeout.
(No change.)

### Registry-level (model-invisible) change — risk declaration (D8)

Add per-tool `risk: "read-only" | "mutating" | "shell"` in the registry only
(not in the model-visible schema). The safety gate (GAPS #2) can then route on
declared risk instead of pattern-matching shell text; `bash` keeps the
destructive-pattern gate as the backstop regardless.

### Evaluated, not recommended now

| Candidate | Verdict | Why |
|-----------|---------|-----|
| `grep` / `search` | ⏸ not now | `bash` covers it; a structured tool can't beat the current result cap without evidence. Revisit after the tool-choice eval (D14) if bash-grep causes measurable errors. |
| `ls` / `glob` / `find` | ⏸ not now | Listing via `bash` is bounded by the result cap; too little value to add schema to every request. |
| `patch` (unified diff) | ✖ no | `edit` already covers precise changes; a second editing tool doubles the surface. |
| `ask` (model → user) | ⏸ separate feature | Genuinely useful, but it is human-in-the-loop work tied to interrupt/continue (`docs/interrupt-resume.md`), not this tool-surface round. |
| parallel tool calls | ⏸ loop-level | Keep `parallel_tool_calls: false`; parallelism is D11, a loop concern, not a schema concern. |

### Decisions this proposal answers (draft status — not yet decided)

- **D5** — remove legacy top-level `edit` tolerance + its test: **proposed yes**.
- **D6** — new search/listing tools: **proposed no** (keep four; revisit after D14 evidence).
- **D7** — schema validation stays the minimal subset; no `enum`/`pattern`/`maxLength` beyond what exists today.
- **D8** — per-tool risk declaration: **proposed yes** (registry-only, model-invisible).
- **D9** — result shape: **proposed** — `error: true` is the failure signal; `read`-style truncation + continue note is the standard for bounded results; no `ok` flag on read/bash, keep it on write/edit.
- **D10** — naming: **proposed keep** `read`/`write`/`edit`/`bash` (most familiar to models; renaming is churn with no payoff).
- **D11** — freshness guard stays loop-level (a "re-read first" refusal error when it lands); no schema change.
- **D12** — model-visible metadata (size/timeout hints): **proposed no** for now — every hint adds tokens; the bounded-result contract already protects context.
- **D13** — de-duplicate system prompt: **proposed yes** (tighter prompt; all tool usage lives in descriptions).

## Decision log

| # | Question | Status |
|---|----------|--------|
| D1 | Keep the default set at exactly four (`read`, `write`, `edit`, `bash`)? | **decided** (2026-08-23 review) — the constraint is hard (AGENTS.md) and test-enforced; revisit only if a candidate passes the bar (D6). |
| D2 | One tool per model step (`parallel_tool_calls: false`)? | **decided** 2026-08-23 — sequential, audit-friendly; landed with the loop fix. |
| D3 | Stop the loop after 3 identical tool calls? | **decided** 2026-08-23 — same name + canonical args (incl. JSON arg order); landed with the loop fix. |
| D4 | `edit` exposes only the canonical `edits[]` shape to the model? | **decided** 2026-08-23 — one way to call `edit`; `execute` still tolerant (see D5). |
| D5 | Remove the legacy top-level `edit` tolerance (execute + test)? | **open** — removal candidate R1. Keep only if old-transcript replay matters; otherwise delete the dead path and its test. |
| D6 | Add a search/listing tool (`grep` / `ls` / `glob`), or keep the four and let `bash` cover the rest? | **open** — evaluate candidates against the bar. |
| D7 | Extend schema validation (`enum`, `pattern`, `maxLength`)? | **open** — current subset: required fields, primitive/array/object/integer types, string `minLength`. |
| D8 | Per-tool risk declaration feeding the safety gate (GAPS #2)? | **open** — read-only / mutating / destructive, instead of pattern-matching shell text. |
| D9 | Standardize the result-shape contract (error convention, truncation notice, "how to continue")? | **open** — `read` already models it; should the contract require it of every tool? |
| D10 | Naming policy (`bash` vs `run`/`shell`, `edit` vs `patch`)? | **open** — familiar names may matter to model reliability. |
| D11 | Read-before-edit freshness guard + parallel execution: loop-level state or tool-aware contract? | **open** — first *contract-touching* feature to implement after this discussion (NEXT_STEPS #2). |
| D12 | Model-visible metadata (result-size / timeout hints)? | **open** — currently only `name`/`description`/`parameters` are visible. |
| D13 | De-duplicate the system prompt (drop retold tool guidance)? | **open** — removal candidate R2; low-risk token win. |
| D14 | Add a behavioral eval that exercises tool *choice*? | **open** — protects the `edit` contract and measures how the contract reads to real models. |
| D15 | Collapse the `/exit` and `/quit` alias? | **open** — adjacent, user-facing only; low priority. |

## Standing notes

- `/session delete` is tool-independent housekeeping and can land any time —
  it does not need to wait for this discussion (NEXT_STEPS #5).
- The 2026-08-23 loop-fix context (runaway generation) is recorded in
  `PROGRESS.md` and `GAPS.md` #12 status; the raw problem was never reproduced
  against a real provider, so the guard covers identical-call loops only — if
  the "model won't stop" symptom recurs, capture a real transcript first.
