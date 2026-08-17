# Refactor plan — executed (2026-08-17)

**Status: ✅ done.** All tiers below landed as behavior-preserving refactors on
2026-08-17 (194 tests green). This file now reads as the record of what was
proposed and what shipped; the final implementation differs from the proposal
only in names and one scope change:

- **The "stay minimal" rule was replaced.** Per discussion, `AGENTS.md`'s one
  rule is now *clarity and quality over compactness*; the default tool set and
  the dependency-free identity remain hard constraints.
- **Naming.** The edit engine shipped as `src/edit-engine.mjs` (not
  `src/edit.mjs`) and the read caps as `src/read-bounds.mjs` (not
  `src/read.mjs`) so the module names read as *concepts*, not verbs shared
  with the tools.
- **T2.2 scope.** Terminal lifecycle moved to `src/tui/lifecycle.mjs` in
  addition to the proposed frame assembly (`src/tui/layout.mjs`), and the
  editor state facade (T0.3) was resolved by deleting the accessors — the
  `Editor` widget is now the single owner of input state.
- **T3.1 shipped.** `src/session.mjs` became a small `src/session/` package
  (store / resume / data + `index.mjs` facade).

Every step kept `node --check` + `npm test` green and added focused unit tests
for the newly pure modules (`format`, `transcript`, `edit-engine`, `sse`,
`agent` seams).

## Why refactor at all

The architecture is already clean — one loop, one frontend controller, pure
widgets beside it, per-module tests. Refactoring is not about fixing broken
things; it is about (a) removing the few places where one file or one function
has grown past "readable in one sitting", and (b) making the two planned
features in `NEXT_STEPS.md` (#1 parallel tool execution, #2 read-before-edit
freshness guard) land as *smaller* changes.

## Findings (what the read turned up)

| # | Location | Evidence | Why it matters |
|---|----------|----------|----------------|
| 1 | `src/tui.mjs` (1,028 lines) | `runCommand` 124, `submit` 97, `buildFrame` 97, `runAction` 76, constructor 62 | The controller is the last big blob. It already handed pure logic to `src/tui/*`; the remaining file mixes input plumbing, command dispatch, transcript/event mapping, frame assembly, git polling, theme detection, and session switching. |
| 2 | `src/tools.mjs` (641 lines) | the `tools` array starts at line 356; ~350 lines of pure diff/read machinery (normalize, fuzzy, overlay, range ops, `truncateRead`) come first | The registry and the edit/read *engines* are different concepts living in one file. The edit engine is the natural seat for the freshness guard (#2). |
| 3 | `src/tui/renderers.mjs` (797 lines) | `parseInlineTokens` 94, `markdownLines` 82, `blockLines` 49, table machinery ~120 | Three responsibilities in one module: ANSI/text helpers, markdown + tables, block rendering. |
| 4 | `src/headless.mjs` | imports `summarize` from `./tui/renderers.mjs`; its block `append()` duplicates `MinimalTui.append()` | A non-TUI frontend reaches into the TUI layer for a concept (tool-result summary) that isn't terminal-specific. Duplicated event→block folding will drift. |
| 5 | `src/agent.mjs` | `runTurn` 144 lines; ~50 lines of per-call validation/execution inline; usage accumulation inline | The loop's core step ("execute a tool call") has no seam, so parallel execution (#1) means editing the loop body itself. |
| 6 | `src/llm.mjs` | `streamChat` 108 lines mixing retry/timeout orchestration with SSE framing + JSON parsing + delta aggregation | The SSE decoder is a pure protocol concern; separating it makes tolerance rules testable without a socket (`test/` has no direct llm unit file today). |
| 7 | `src/session.mjs` | 15 exports: naming, listing, pruning, renaming, resume semantics, data reconstruction, config subset, writable class | Kitchen-sink module; mostly harmless at 310 lines, but the import list in `src/main.mjs` (11 session symbols) shows the friction. |
| 8 | `src/tui.mjs` editor access | class getters/setters delegate to `this.editor`, yet some code paths call `this.editor.*` directly | Two APIs for the same state → confusing; a cleanup with existing test coverage. |

## Proposed moves, by tier

### Tier 0 — mechanical, low risk (no behavior change, no new concepts)

- **T0.1** Move `summarize` (and the token/time formatters it shares with
  headless) out of `tui/renderers.mjs` into a neutral `src/format.mjs`; update
  `headless.mjs`, `tui.mjs`, and the tests that import them. Breaks the
  non-TUI → TUI dependency and makes headless a first-class frontend.
- **T0.2** Extract the block-folding rule (`append(kind, delta)`) into a small
  shared `src/transcript.mjs`; have `headless.mjs` and `tui.mjs` use it.
- **T0.3** Resolve the editor accessor duality: route every mutation through
  `this.editor` and drop the `inputBuffer`/`inputCursor`/… getter/setter facade
  (or keep the facade and ban direct `this.editor` calls — pick one). The 112
  lines of `test/editor.test.mjs` + the TUI tests keep this safe.

### Tier 1 — structural extraction, medium risk (each with its own tests)

- **T1.1** Split `src/tools.mjs`:
  - `src/edit.mjs` — the pure diff engine: `normalizeLineEndings`,
    `normalizeForFuzzy`, `applyEditsToContent`, `applyWithOverlay`,
    `rangeOpToReplacement`, line-span helpers.
  - `src/read.mjs` — `truncateRead` + `formatBytes`.
  - `src/tools.mjs` keeps the 4-tool registry, thin `execute` wrappers, and
    `validateToolArgs`. Mirrors the extract-pure-pieces pattern already applied
    to the TUI, and gives the freshness guard (#2) a natural home.
  - Bonus: `test/reliability.test.mjs` covers this behavior end-to-end today;
    a direct `test/edit.test.mjs` unit file becomes possible.
- **T1.2** Split `src/tui/renderers.mjs`: text/ANSI helpers stay; markdown +
  tables move to `src/tui/markdown.mjs`; block rendering to
  `src/tui/blocks.mjs`. The table code is already written as pure functions, so
  this is a move, not a rewrite.
- **T1.3** Give `src/agent.mjs` a seam: extract
  `executeToolCall(call, { signal, cwd, confirm })` (parse args → find tool →
  validate → run → bound result → event → cwd tracking) and a pure
  `accumulateUsage`. `runTurn` then reads as *stream → handle end/abort →
  execute each call*. Enables parallel tools (#1) without touching the loop.
- **T1.4** Extract SSE framing + delta→event assembly into `src/sse.mjs`
  (pure functions); `streamChat` keeps network/retry/streaming orchestration.

### Tier 2 — tame the god controller (biggest churn; do last, one slice per commit)

- **T2.1** Make command dispatch table-driven off `SLASH_COMMANDS` (which
  `src/tui/help.mjs` already declares as the single source of truth) and move
  the handlers to `src/tui/commands.mjs`. New commands then register in one
  table instead of an ever-growing `if/else` ladder.
- **T2.2** Move frame assembly into renderer land (`buildFrame` is 97 lines but
  every piece it calls already exists as a pure function) and extract terminal
  lifecycle (`start`/`stop`/`queryBackground`/`attachInput`). The controller
  keeps input plumbing + state only.

### Tier 3 — optional, only when needed

- **T3.1** Split `src/session.mjs` into store / data / resume modules (or add a
  small facade) so `src/main.mjs` imports a handful of names instead of eleven.
- **T3.2** Leave `config.mjs` and `compact.mjs` as-is — they are small,
  single-purpose, and fit the house style.

## What we deliberately don't do

- No TypeScript, no framework, no new dependencies (the dependency-free
  identity is the README's headline).
- No provider abstraction (GAPS #6 stays open); no sandbox (GAPS #2 stays
  open).
- No behavior or feature work mixed into the refactor — features land
  afterwards via `NEXT_STEPS.md`, on top of the seams above.
- No big-bang rewrite: every tier is a sequence of behavior-preserving commits.

## Suggested order & verification

1. Tier 0 items (quick, safe, unblocks T1.1's import cleanup).
2. T1.1 → T1.4 in any order; each is an independent module split with its own
   docs note + tests.
3. Tier 2 last, one slice per commit, leaning on `test/tui.test.mjs` (729
   lines) and the PTY smoke test.
4. Every commit: `node --check src/*.mjs` + `npm test`; update
   `docs/architecture.md` file map + the `AGENTS.md` table in the same change;
   append one `PROGRESS.md` line.

## Open questions for the discussion

- Which tiers do we want now? (Recommendation: Tier 0 + Tier 1 first — they are
  the highest value per unit of risk; Tier 2 only if the controller keeps
  growing.)
- Keep this file as a living plan on the branch, or fold the agreed items into
  `NEXT_STEPS.md` as concrete tasks?
- Any objection to the file-name choices (`src/edit.mjs`, `src/sse.mjs`,
  `src/format.mjs`, `src/transcript.mjs`)? They follow the flat,
  noun-named style already in use.
