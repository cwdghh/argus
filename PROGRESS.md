#### 2026-08-17 — folder-scoped default resume

**Status: ✅ done**

Goal (from discussion): `npm start` resumed the globally-latest session, which
could point at a different repo; the default should pick up the work related
to the folder you launch argus in.

What was done:
- ✅ `latestSessionForCwd(cwd)` in `src/session.mjs` returns the newest saved
  session whose persisted cwd is the given folder or one of its subfolders
  (boundary-aware: `/repo/src` matches `/repo`, `/repo-x` does not; trailing
  slashes tolerated; the filesystem root matches everything). Scans the newest
  20 sessions by default so startup stays fast.
- ✅ `defaultSessionName(cwd)` = folder match, else a **fresh** session name —
  an unrelated project's session is never auto-resumed (still reachable via
  `/resume <tab>` or `--session`).
- ✅ `src/main.mjs` uses `defaultSessionName(process.cwd())` for the default
  TUI start (`--session` and `--new` are unchanged).
- ✅ Tests: 4 new, isolated in their own throwaway `ARGUS_HOME` — folder
  preference vs global latest, subfolder/sibling/trailing-slash/root
  boundaries, the scan `limit`, and the fresh-name fallback. Docs updated in
  README, `GAPS.md` #5, and `NEXT_STEPS.md`.

Verification: 170 tests pass (166 before + 4 new), `node --check` clean.

#### 2026-08-17 — session naming & resume completion

**Status: ✅ done**

Goal (from discussion): sessions were hard to find and name — `/sessions`
only listed the latest 20, `/resume` demanded exact auto-timestamp names, and
there was no way to give a session a meaningful name.

What was done:
- ✅ `/resume <partial>` completion: typing `/resume ` opens the editor popup
  on saved-session names (newest-first from `listSessions()`); an empty token
  lists everything, typing filters, Tab accepts and replaces just the token.
  New "session" suggestion kind in `src/tui/suggestions.mjs` beside slash and
  `@path`; the TUI caches session names and refreshes after any session change.
- ✅ `/name <name>` renames the current session: `renameSession()` in
  `src/session.mjs` validates the new name, rejects collisions, and moves the
  file (the name lives only in the filename, never inside the JSONL);
  `Session#renameTo()` repoints the live handle so later turns append to the
  renamed file.
- ✅ `/new <name>` starts a named fresh session (bare `/new` keeps the
  timestamp name).
- ✅ `SLASH_COMMANDS` gained an `args` field, so `/help` renders
  `/resume <name>`, `/name <name>`, and `/new [<name>]` without per-command
  special cases; the `/keys` Tab line now mentions session names.
- ✅ Tests: 12 new — session rename/collision/no-op/handle repointing,
  suggestion trigger/filter/accept/header/highlight, and TUI `/name`,
  `/new <name>`, `/resume` completion, and `/help` rendering. Docs updated in
  README, `GAPS.md` #5, and `NEXT_STEPS.md` (rename resolved; delete remains).

Verification: 166 tests pass (154 before + 12 new), `node --check` clean.

#### 2026-08-17 — global config file under ~/.argus

**Status: ✅ done**

Goal (from discussion): machine-wide defaults without copying `.env` into
every checkout.

What was done:
- ✅ `src/config.mjs` exports `argusHome()` (single source of truth for the
  `~/.argus` root, `ARGUS_HOME`-aware, resolved lazily) and `loadHomeEnv()`,
  which loads `$ARGUS_HOME/.env` (default `~/.argus/.env`) with the same
  variables and format as the project `.env`.
- ✅ `src/main.mjs` calls `loadHomeEnv()` right after the project `.env`, so
  precedence is exactly: process env > project `.env` > home `.env` > built-in
  defaults. Node's env-file loader never overrides an already-set variable,
  which makes that ordering precise rather than accidental (verified).
- ✅ `src/session.mjs` delegates `sessionsDir()` to `argusHome()`, so the
  config file and the session store always agree on where "home" is.
- ✅ Double-quoted multiline values work (`ARGUS_SYSTEM_PROMPT="…
…"`), and
  the home file can hold the API key — argus never writes the file, and a
  `chmod 600` keeps it private. Documented in `.env.example`, README
  (config + sessions), and `docs/architecture.md`.
- ✅ Tests: new `test/config.test.mjs` (7 tests) covering home defaults,
  missing-file tolerance, process-env precedence, project-over-home
  precedence, multiline values, and a home-supplied DashScope key.
- ✅ `GAPS.md` #10 and the `NEXT_STEPS.md` "recently completed" block note the
  change.

Verification: 154 tests pass (147 before + 7 new), `node --check` clean.

#### 2026-08-17 — planning docs: reflect the reliability work in GAPS.md / NEXT_STEPS.md

**Status: ✅ done**

- `GAPS.md`:
  - Dated status notes on the work shipped this week: `read` self-bounding in
    #4 (context management), relaxed 600s/300s timeouts in #7 (robustness),
    markdown tables + CJK/emoji-aware widths in #8 (terminal UX), and the
    prompt-vs-docs split decision in #10 (model catalog).
  - New section **#11 "File editing reliability & freshness"** recording the
    design territory: the two edit failure modes (byte mismatch vs stale
    "where"), how content mode (exact→fuzzy + gutter-strip + byte-preserving
    overlay) and range mode (sed-like line semantics, mixed atomic batches)
    each resolve one, pi's conceptual approach, and the open questions —
    read-before-edit freshness guard, partial-read freshness, verification
    anchors (`expect`), and a raw read mode.
  - New open questions in #8 (grapheme-cluster width edge cases) and #9 (an
    eval that exercises edit-mode choice and line-number usage).
- `NEXT_STEPS.md`:
  - "Recently completed" pointer block so the planning list doesn't drift from
    PROGRESS.md.
  - New high-impact candidate **#2 "Read-before-edit freshness guard
    (stale-line protection)"** with the sequence-stamp bookkeeping, bash
    invalidation trade-off, partial-read question, `force` escape hatch, and
    why `expect` anchors were rejected — the main direction the edit work
    deliberately deferred; items renumbered 2–8 → 3–9.
  - #5 Behavioral evals gained a concrete high-value task suggestion (does the
    model pick content vs range edits and copy line numbers correctly).

Verification: docs-only change; 147 tests still pass.

#### 2026-08-17 — polish: CJK/emoji-aware table widths + tool rules in the system prompt

**Status: ✅ done**

- `charWidth` (`src/tui/renderers.mjs`) now measures terminal columns correctly
  so table borders stay aligned with CJK and emoji cells:
  - zero width for combining/format marks (`\p{Mn}`, `\p{Me}`, `\p{Cf}`),
    ZWJ/ZWSP, variation selectors (VS16), skin-tone modifiers, and Hangul
    V/T jamo — so "👨‍👩‍👧" = 6, "👍🏽" = 2, "1️⃣"-style joins are no longer
    over-counted;
  - two columns for East Asian wide ranges (Hangul, CJK radicals/ideographs,
    Hiragana/Katakana, fullwidth forms, CJK Ext) and presentation-width emoji
    — including the previously missing transport block (🚀 was 1, now 2),
    BMP emoji (⌚⏰✅), and Emoji 12–14 blocks (1FA70+);
  - one column otherwise (regional indicators stay 1 so flags measure 2).
- Added a compact tool-usage sentence to the **default system prompt**
  (`src/config.mjs`): read before editing, copy line numbers for
  `startLine`/`endLine`, content vs range edit split, `write` for whole files,
  persistent `bash` cwd. This is the "usage rules in the prompt, schemas in
  the request, long docs in docs/" split — the JSON schemas still travel with
  every request via the tools payload, and nothing is duplicated.
- Tests: 3 new renderer tests (CJK/fullwidth widths, emoji/zero-width
  sequences, and a mixed CJK+emoji table where every rendered line has
  exactly the same display width). Docs: `docs/architecture.md` notes the
  width-aware layout.

Verification: 147 tests pass (144 before + 3 new), `node --check` clean.

#### 2026-08-17 — line-aware reads and edits: numbered reads + range-mode edit

**Status: ✅ done**

- `read` now prefixes every returned line with its absolute 1-indexed line
  number (`  87 │ const x = 1;`), so the model copies numbers instead of
  counting them. Numbers stay absolute across `offset`/`limit` pages.
- `edit` matching now tolerates line-number gutters copied from a read: the
  fuzzy normaliser strips a `^\s*\d{1,6}\s*[|│]\s*` prefix per line, so
  content mode keeps working even when the model pastes a numbered read back.
- New **range mode** for `edit`: `startLine`/`endLine`/`new` replaces the
  inclusive 1-indexed line range (inserts before `startLine` when
  `endLine = startLine - 1`, deletes with `new = ""`). Range mode is
  line-oriented like `sed` — the block occupies whole lines, never merges
  with neighbours, and preserves CRLF — so whole-function rewrites and
  insertions work without reproducing large old code byte-for-byte.
- Content and range edits mix freely in one `edits[]` call; every replacement
  is resolved against the original file and applied bottom-up, with bounds
  and overlap validation (error messages name the current line count).
- Deliberately out of scope (considered and cut to keep the model's burden
  and the loop's state minimal): optional verification anchors on range
  edits, and a loop-level read-before-edit guard.
- Tests: 9 new cases (numbered reads/paging, gutter tolerance, range
  replace/insert/delete/bounds/mixed/CRLF/empty file). Docs updated in
  `docs/tools.md` and README.

Verification: 144 tests pass (135 before + 9 new), `node --check` clean.

#### 2026-08-17 — reliability: table rendering, forgiving edits, bounded reads

**Status: ✅ done**

- Rendered GFM markdown tables in the TUI as aligned box-drawing tables
  (`src/tui/renderers.mjs`), with width-aware cell wrapping, optional
  alignment, inline styles in cells, and a plain-text fallback on narrow
  terminals. Streaming-tolerant: a table appears once its delimiter row
  arrives, so mid-stream renders are never corrupted.
- Stopped `edit` failing on "old string not found" by porting pi's edit-diff
  machinery (`src/tools.mjs`): exact match first, then a normalised fuzzy match
  (NFKC + ASCII folding of quotes/dashes/spaces, trailing whitespace, CRLF).
  Changed lines are overlaid back onto the original so untouched bytes keep
  their exact form; CRLF and a UTF-8 BOM survive. `edit` also accepts an
  `edits[]` array for atomic multi-edit and returns `fuzzy: true` when a
  relaxed match was used, with actionable not-found messages.
- Bounded `read` (pi-style): at most 2000 lines / 50KB per call, plus
  `offset`/`limit` paging and an explicit
  `[Showing lines X-Y of Z. Use offset=N to continue.]` hint, so large files
  stop flooding the context window.
- Relaxed timeouts for reasoning models that think a long time before the
  first byte or between chunks: `ARGUS_REQUEST_TIMEOUT_MS` default 300s → 600s,
  `ARGUS_STREAM_IDLE_TIMEOUT_MS` default 60s → 300s (pi's idle default).
  `.env.example`, README config table, and `docs` updated alongside.
- New unit tests: `test/renderers.test.mjs` (tables) and `test/tools.test.mjs`
  (read truncation/paging, fuzzy edits, multi-edit, CRLF/BOM preservation);
  a config default-timeout test in `test/reliability.test.mjs`. Updated
  `docs/tools.md` and `docs/architecture.md` in the same change.

Verification: 135 tests pass (118 before + 17 new), `node --check` clean.

#### 2026-08-17 — quality: restructure the TUI into suggestions/frames/help modules

**Status: ✅ done**

- Extracted the remaining separable concerns out of `src/tui.mjs` (down to
  991 lines of controller code with thin delegation):
  - `src/tui/help.mjs` — the `SLASH_COMMANDS` table + the `/help`/`/keys`
    reference text its popup and commands share.
  - `src/tui/suggestions.mjs` — pure `@path` + `/command` popup logic:
    `computeSuggestion`, `acceptSuggestion`, `suggestionLines`.
  - `src/tui/frames.mjs` — pure `statusText` / `footerText` / `headerText`
    renderers over a read-only controller snapshot.
- Removed dead state: the write-only `_activeInputRow` field and the duplicate
  `activeRow` in `Editor.view()` (same value as `caretRow`).
- Added unit tests for the new modules (`test/help.test.mjs`,
  `test/suggestions.test.mjs`, `test/frames.test.mjs`); the 28 TUI integration
  tests pass unchanged.

Verification: 118 tests pass (104 before + 14 new), `node --check` clean, no
unused imports across `src/` and `src/tui/`.

#### 2026-08-17 — structure: split the TUI into editor + keys modules

**Status: ✅ done**

- `src/tui.mjs` was the only oversized file (1518 lines): one controller class
  mixing terminal decoding, the multiline prompt editor, and frame/command
  logic. Extracted the two separable, pure concerns beside the existing
  renderers module:
  - `src/tui/keys.mjs` (82 lines) — `decodeEscape()`: CSI keys, SGR mouse,
    bracketed paste, and OSC skips. `tryEscape()` in the controller is now a
    thin slice-and-dispatch wrapper.
  - `src/tui/editor.mjs` (232 lines) — the `Editor` widget: buffer / caret /
    recall-history state plus wrap, caret, and view geometry and text
    mutations, with no rendering or I/O. The TUI keeps plain-field accessors
    (`inputBuffer`, `inputCursor`, `inputHistory`, `historyIndex`) that
    delegate to the editor, so behavior is unchanged.
- `src/tui.mjs` shrank by 200 lines (1518 → 1318) and dropped three now-unused
  renderer imports; each new module is unit-tested in isolation.
- Added `test/keys.test.mjs` (8 tests) and `test/editor.test.mjs` (9 tests);
  updated the README and AGENTS.md file maps plus docs/architecture.md.

Verification: 104 tests pass (87 before + 17 new), `node --check` clean.

#### 2026-08-16 — footer: context-window usage vs. compaction budget

**Status: ✅ done**

- The footer's right-side context field now reports the active session's
  estimated history size against the compaction budget — e.g.
  `12.3K / 300.0K (4%)` — instead of the last turn's token count. It uses the
  same `estimateChars` / `ARGUS_COMPACT_AT` values the compaction path reads, so
  the percentage marks exactly where the loop will start summarising old turns.
- Updated README footer text, screenshot, and responsive-footer description in
  the same change; added a TUI regression test that pins the
  `chars / budget (percent)` rendering against a known history size.

Verification: 87 tests pass, `node --check` clean.

#### 2026-08-16 — footer: token usage on the left, context field shows tok

**Status: ✅ done**

- Moved token usage from the right-hand meta area to the left-hand status text
  in the footer: idle now reads `last 2.7s · ↑1.1K ↓140 ✶77 ≡384 tok`, and the
  working phase appends live usage as it arrives.
- Context-window usage on the right now shows `0% 300.0K tok` instead of a bare
  character count.
- Updated README footer screenshot and responsive-footer description, plus a TUI
  regression test verifying tokens sit on the left.

Verification: 86 tests pass, `node --check` clean.

#### 2026-08-16 — housekeeping: dedupe, dead code, single source of truth

**Status: ✅ done** (branch `housekeeping`, merged to `main`)

- Removed the never-used one-shot `chat()` from `src/llm.mjs` (all turns stream
  via `streamChat`), simplified `buildBody` to always request `include_usage`,
  and updated the module docs.
- Removed the duplicated local `summarize()` in `src/headless.mjs` — it now
  imports the single implementation from `src/tui/renderers.mjs`.
- Extracted two shared session helpers into `src/session.mjs` and used them in
  both call sites:
  - `sessionData(data)` rebuilds transcript blocks + model history + cwd/model
    meta (was duplicated in `main.mjs sessionState` and `headless.mjs`);
  - `sessionConfig(config)` is the one persisted-config shape (was duplicated
    in the TUI and headless `appendTurn` calls) — keeps the API key out of
    session files by construction.
- Dropped the unused `RESET` constant in `src/tui.mjs` and trimmed the usage
  comment in `src/main.mjs` (the `USAGE` constant is the source).
- Docs single-sourcing:
  - Deleted stale `REFACTOR_PLAN.md` (its tasks are long done and recorded in
    PROGRESS.md).
  - README now keeps one file map (the "What it teaches" table) instead of a
    duplicate ASCII tree, and links to `docs/architecture.md` for the loop
    diagram instead of copying it.
  - `docs/architecture.md` reflects thinking deltas and the `SLASH_COMMANDS`
    single source for the command set.
  - `AGENTS.md` file map completed so it can't drift from the repo.

Verification: 85 tests pass (added `sessionConfig`/`sessionData` unit tests),
`node --check` clean across src + tests.

#### 2026-08-16 — usage in /status + timing, /model switching, session retention

**Status: ✅ done** (commits `ce99d04`, `e92d53f`, and the session-retention
batch)

- Token usage now travels with the turn: the last turn's real `↑` input /
  `↓` output tokens appear in the timing row and in `/status` (the shared
  formatter moved into `src/tui/renderers.mjs` so the footer, timing rows, and
  `/status` use one implementation).
- `@path` popup polish: symlink targets are resolved at list time (a link to a
  directory sorts, completes, and descends like a directory), directories keep a
  muted trailing slash, and symlinks get a muted arrow to their resolved target
  without polluting the completed path.
- `/model <name>` switches the model at runtime. The override is saved per
  session (one `{"type":"model",...}` JSONL line, deduped), restored on resume,
  and `/new` plus sessions without an override fall back to the `ARGUS_MODEL`
  env default. Headless runs against a session honor the same override so the
  persisted turn config records the model that actually ran. `/help`,
  `SLASH_COMMANDS`, README, `NEXT_STEPS.md`, and `GAPS.md` updated in the same
  changes.
- Session housekeeping: `ARGUS_SESSION_KEEP` (default `0` = keep all) prunes
  old sessions on TUI startup, newest-first by mtime, always preserving the
  session being opened; `/sessions` now reports each session's file size.
  `.env.example`, README config table, and `GAPS.md` updated.

Verification: 83 tests pass (`node --check` clean), covering usage rendering,
dir/symlink popup markers, `/model` switch + persistence + resume-apply +
headless override, and prune/size behaviour.

#### 2026-08-16 — live suggestions for @path and /commands

**Status: ✅ done**

Typing now shows a live completion popup directly above the editor:

- Type `/` at the start of a prompt and the local commands (\`/help\`,
  \`/keys\`, \`/status\`, \`/sessions\`, \`/resume\`, \`/new\`, \`/exit\`,
  \`/quit\`) appear; keep typing to filter.
- Type \`@\` and files/directories relative to the session cwd appear; keep
  typing to filter or Tab to descend into a directory. Dirs sort first and are
  quoted automatically when they contain spaces.
- Up/Down move the highlight (the highlighted command survives narrowing as you
  type more); the popup scrolls once you arrow past the visible limit so the
  selection is always on screen. The popup height is fixed: a single always-
  present status row reports hidden matches (`↑ N` above, `↓ N` below) or the
  match count when everything fits, instead of toggling extra lines. Tab
  accepts, Esc dismisses without touching the input.
- The popup hides when the token ends (space after a command, caret leaves the
  @token, or a turn starts running). Ambiguous @ matches stay in the popup
  instead of being dumped into the transcript on Tab. The slash-command table
  is now a single source of truth that also generates \`/help\`.
- README, \`docs/architecture.md\`, key help, and empty-state hints updated;
  tests cover filtering, navigation, sticky selection, accepting via Tab,
  popup layout/hiding, window scrolling, constant popup height, and
  short-terminal visibility.

Verification: 71 tests pass, \`node --check\` clean.

#### 2026-08-13 — rail separators, thinking rails, colored tool bars, multiline editor

**Note:** the WIP batch previously on disk (live timing, responsive header/
footer, empty state, npm-link fix) was committed and pushed as
`eec3a46`; the repo itself was also pushed to origin.

**Status: ✅ done**

Goal: friendlier transcript and editor:

- ✅ "proper separation lines" between turns — replace the plain `─` divider
  with a colored **rail** row (`│ theme.rail`) so turns are visibly separated.
- ✅ thinking marker `…` → a left rail (`│`) that runs down the thinking block,
  comparable to ChatGPT-style rails.
- ✅ **different color vertical bars for tool calls** (`│ theme.tool` for the
  `⚙` line and the wrapped result lines).
- ✅ **multiline editor input**: `Shift+Enter` inserts a newline, Enter submits,
  Up/Down stay bound to input history, and the editor grows upward above the
  footer (continuation rows prefixed with `│` rails).
- ✅ documentation + tests updated as part of the change.

These landed in commits `945e9d5` (rail separators / tool bars) and
`74a2f57` (multiline cursor positioning), then got the 2026-08-16 polish
batch (footer, suggestions, token usage) on top.

#### 2026-08-13 — readiness & polish pass (pre-dogfood)

**Status: ✅ done**

Bugs fixed:
- ✅ TUI `submit()` referenced `ac` (the AbortController) in the catch block
  though it was declared inside `try` — any turn error (network/LLM) crashed the
  TUI. Declared before `try`; covered by a regression test.
- ✅ `edit` tool's "old string not found" error dropped the file path. Fixed.
- ✅ `read`/`write`/`edit` resolved relative to `process.cwd()` while `bash`
  used the session cwd — file tools now resolve against the session cwd too, so
  all tools agree after `cd`. Covered by tests.
- ✅ `refreshGitStatus` used `process.cwd()`; now follows the session cwd.

Usability / visuals:
- ✅ Empty transcript shows a centered welcome hint (task + shortcuts).
- ✅ Resumed sessions show a "✓ resumed session <name>" note at the top.
- ✅ A subtle divider separates each turn in the transcript.
- ✅ Code-fence bodies are indented to align with the ` ``` ` markers.
- ✅ Confirm prompt keeps the caret at the start of the warning.
- ✅ CJK/emoji display width: line wrapping and the input caret now count East
  Asian wide chars as 2 columns (was breaking Chinese text alignment).

Verified: 30 tests pass, live boot (empty state, resume, CJK caret at the
correct column), real headless call.
#### 2026-08-11 — context compaction

**Status: ✅ done**

Goal: long sessions grow the message history unbounded and eventually overflow
the context window.

What was done:
- ✅ `src/compact.mjs`: estimates the serialized history size; when it exceeds a
  budget (default 300k chars ~= 75k tokens) it drops the oldest turns, keeps
  the `ARGUS_COMPACT_KEEP` (default 8) most recent, and prepends a summary of
  the old turns (their final assistant text, truncated).
- ✅ `agent.mjs`: compacts history before each request, emits a `compacted`
  event; threshold/keep overridable via opts.
- ✅ Full messages stay in the session JSONL, so original requests remain
  reconstructable despite the in-memory compaction.
- ✅ TUI + headless show a "… earlier context compacted" note.
- ✅ Verified: 24 tests pass (below/above threshold, split/summarize, agent
  emits summary, end-to-end real call).
#### 2026-08-11 — tool safety gate (confirm destructive commands)

**Status: ✅ done**

Goal: let argus do real work without silently running destructive commands.
Chose option 1: auto-approve read/write/edit + safe bash; ask before dangerous
commands.

What was done:
- ✅ `tools.mjs`: danger detector (recursive `rm`, `dd`, `mkfs`, `fdisk`,
  `parted`, `shutdown`/`reboot`/`halt`/`poweroff`, fork bomb). `bash` now
  requires approval for these: uses `ctx.confirm` if provided; otherwise blocks
  with a clear error.
- ✅ `agent.mjs`: threads `opts.confirm` into tool execution.
- ✅ `tui.mjs`: a pending confirm shows a `⚠ <cmd> (y/n)` prompt in the editor
  row (mode `confirm`); `y` approves, `n`/Esc deny, and aborting a turn also
  denies the pending command.
- ✅ headless mode: no confirm -> destructive commands are blocked by default.
- ✅ Verified: 20 tests pass (blocked/denied/approved, safe command, TUI
  confirm flow) + live boot.
#### 2026-08-11 — test harness (mock LLM + integration tests)

**Status: ✅ done**

Goal: let argus verify its own edits safely (enabler for self-updating).

What was done:
- ✅ `test/helpers/mock-llm.mjs`: a scripted SSE server that fakes the API
  (deltas, tool_calls, delays for abort tests, 500s for error tests).
- ✅ `npm test` (`node --test test/*.test.mjs`): 15 tests across agent loop
  (tools, abort, persistent cwd), headless mode (stream separation, session +
  cwd save, error path), session round-trip/secret-safety, and TUI rendering +
  navigation.
- ✅ Made `runHeadless` accept injectable stdout/stderr (no monkeypatching),
  and headless now saves turns (incl. error blocks) on failure too.
- ✅ Fixed a test-harness gotcha: unclosed mock servers keep Node alive and hang
  the runner — tests now use `t.after(() => srv.close())`.
#### 2026-08-10 — headless one-shot mode

**Status: ✅ done**

Goal: run argus without the TUI (needed for scripting / the test harness).

What was done:
- ✅ `src/headless.mjs`: runs a single prompt to stdout. Assistant text ->
  stdout (clean for piping); reasoning, tool calls, errors -> stderr. If a
  `--session` name is given, it resumes that session's history, saves the turn,
  and persists the working directory. Exit codes: 0 ok, 1 error, 130 aborted.
- ✅ `main.mjs`: a positional prompt switches to headless mode; `--help` prints
  usage.
- ✅ Verified: mock (stdout only text, tool on stderr, session+cwd saved), and
  real end-to-end via `npm start -- "<prompt>"` (clean stdout + reasoning on
  stderr).
#### 2026-08-10 — persistent bash working directory

**Status: ✅ done**

Goal: every bash call ran in a fresh shell at the launch dir, so `cd src` never
stuck — the model had to re-cd every call and couldn't rely on state.

What was done:
- ✅ `tools.mjs` bash runs in a session cwd (`ctx.cwd`); a leading `cd <dir>`
  (or bare `cd` -> home) is resolved (~, relative, `..`) and returned as
  `{ cwd }` so it persists. `cd -` (previous dir) not yet supported.
- ✅ `agent.mjs` threads `opts.cwd`, passes it to tools, emits `cwd_change`,
  and returns the new `cwd`.
- ✅ `session.mjs`: cwd persisted (a deduped `{type:"cwd"}` JSONL line) and
  restored on resume.
- ✅ `tui.mjs`: holds `this.cwd`, updates on `cwd_change`, footer shows the
  session cwd (not just process.cwd()); `main.mjs` passes the initial cwd.
- ✅ Verified: cd -> pwd persists, agent emits cwd_change, session round-trip,
  dedupe, footer uses session cwd.
#### 2026-08-10 — footer: mode on the left, without the "mode " prefix

**Status: ✅ done**

- Removed the `mode ` label; the footer now shows just `idle` / `thinking` /
  `working` / `aborting`.
- Layout changed: mode on the left, model · path · git right-aligned on the
  same row.
#### 2026-08-10 — clear the terminal on startup

**Status: ✅ done**

- The TUI previously cleared only the viewport rows it drew; there was no
  explicit full-screen clear. Added `\x1b[2J\x1b[H` at startup so argus starts
  from a clean slate regardless of prior terminal content.
- (Note: argus draws in the main buffer, not an alternate screen, so the
  transcript stays in shell scrollback after exit — intentional.)
#### 2026-08-10 — session persistence (auto-save + resume)

**Status: ✅ done**

Goal (blocker #2): close the terminal -> everything gone. A coding agent works
across many turns/sessions.

Design (agreed with user):
- Store at `~/.argus/sessions/<name>.jsonl` (overridable via `ARGUS_HOME`).
- JSONL append-only. Every request is reconstructable: per-turn `config`
  (model / baseUrl / systemPrompt) + verbatim `messages` (tool_calls + results)
  + meta `tools` schemas determine each request; `blocks` preserve the on-screen
  transcript (incl. thinking). API key never written.
- Controls: `npm start` auto-resumes the latest session; `--new` starts fresh;
  `--session X` resumes/creates a named session. Session name shown in header.

What was done:
- ✅ `src/session.mjs`: `Session` (meta-once + appendTurn), load/list/latest,
  sanitize + new-session naming, `ARGUS_HOME` override.
- ✅ `src/main.mjs`: CLI parsing (`--new`, `--session`), auto-resume latest,
  populate initial blocks/history.
- ✅ `src/tui.mjs`: accepts initial session state, saves each turn (messages +
  blocks + config) after completion (incl. aborted turns), header shows the
  session name.
- ✅ Verified: JSONL round-trip (exact messages/blocks/config, no secrets),
  resume into a fresh TUI, latest-session listing, live boot showing the
  session name, and session dir creation with a temp `ARGUS_HOME`.
#### 2026-08-10 — abortable turns (interrupt a running turn)

**Status: ✅ done**

Goal (blocker #1 for usability): a running turn couldn't be cancelled — the
TUI was locked during a turn and Ctrl-C quit the whole app, so a looping or
hanging tool left you stuck.

What was done:
- ✅ `llm.mjs`: `streamChat`/`chat` accept an `AbortSignal`; abort is caught at
  the request stage AND mid-stream, yielding `{ type: "done", aborted: true }`
  with whatever was assembled (no uncaught AbortError).
- ✅ `agent.mjs`: `runTurn(..., { signal })` threads the signal through; on
  abort it returns early with `{ aborted: true }` and does not push an
  incomplete assistant reply (or partial tool_calls) into history.
- ✅ `tools.mjs`: `bash` accepts `{ signal }` and kills the in-flight command on
  abort (returns `{ aborted: true }` quickly).
- ✅ `tui.mjs`: first **Ctrl-C** (or **Esc**) aborts the running turn and shows
  `mode aborting` + a `⏹ interrupted` line; a second Ctrl-C force-quits;
  Ctrl-C when idle still quits.
- ✅ Verified: abort mid-stream (mock + real DashScope), abort during in-flight
  `bash sleep` (killed in ~0.2s), normal streaming unchanged, TUI abort logic,
  and live boot/idle-quit.
#### 2026-08-10 — fix: preserve model newlines as hard line breaks

**Status: ✅ done**

- Verified against the real model (deepseek-v4-flash-0731): it uses single
  newlines as meaningful line breaks (e.g. "A\nB\nC" meant as three lines) and
  blank lines for paragraph breaks.
- Our renderer previously collapsed single newlines to spaces (Markdown soft
  breaks), which mangled such output. Now `markdownLines` renders each source
  line as its own display line (hard breaks) and renders blank lines as empty
  lines, matching the model's convention and how chat UIs display output.
- Note: pi (via `marked`) uses soft breaks by default, but that does not match
  the model output convention, so we deliberately diverge here.
#### 2026-08-10 — theme detection, markdown refinement, mouse scroll, input history

**Status: ✅ done**

Goals:
- Auto light/dark theme.
- Refine markdown rendering (study pi's `packages/tui` markdown component).
- Scroll with the cursor (mouse wheel); Up/Down for past inputs.

What was done:
- ✅ `theme.mjs`: light + dark palettes with `setTheme()`; mutable `theme`
  read at render time. Defaults to light.
- ✅ Auto-detect terminal background via OSC 11; `setTheme()` accordingly,
  falling back to light if the terminal doesn't respond.
- ✅ Markdown refined (informed by pi): nested inline tokens (e.g. **bold with
  `code`**), ~~strikethrough~~, [links](url) with a dim (url) fallback, and
  code-fence border lines with the language label. Parsing is streaming-tolerant
  (unclosed markers render literally, so no flicker).
- ✅ Controls reworked: **Up/Down navigate input history**; **mouse wheel**
  scrolls the transcript (SGR mouse tracking); PgUp/PgDn and Home/End still
  scroll. Replaced `readline.emitKeypressEvents` with a raw input parser
  (handles keys + mouse + OSC), fixing an unknown-CSI byte-leak bug.
- ✅ Verified: light/dark switching, nested markdown, history nav, wheel
  scroll, raw parser (arrows/mouse/text/backspace/unknown-CSI), and a live PTY
  boot (theme query + mouse enable + clean exit).
#### 2026-08-10 — light-theme color fix

**Status: ✅ done**

- ✅ Replaced the dark "Tokyo Night" palette with a high-contrast light-theme
  palette (dark foregrounds: blue accent, purple user, teal tool, green/red
  ok/error, near-black text) so colors are readable on a light terminal.
#### 2026-08-10 — TUI overhaul: markdown, thinking, scroll, footer, real editor

**Status: ✅ done**

Goals (user feedback on the TUI):
- Cursor not at the editing position; "...working" leaking into history.
- Want markdown rendering, friendlier tool colors, thinking shown, editor always
  at the bottom, scrollable history, and a footer (model/path/git/mode).

What was done:
- ✅ `src/llm.mjs` now captures reasoning (`reasoning_content`/`reasoning`) and
  emits `thinking_delta` events; `src/agent.mjs` forwards them. Reasoning is
  shown but never sent back in history (verified via mock + real DashScope).
- ✅ `src/theme.mjs`: softer "Tokyo-Night"-ish palette (user/tool/good/bad/think/
  code/text/heading).
- ✅ `src/tui.mjs` rewritten:
  - **Markdown renderer** (headings, bold/italic, inline + fenced code, lists,
    blockquotes, rules) applied to assistant replies.
  - **Thinking** shown muted/italic with a `…` prefix.
  - **Fixed layout**: header / scrollable transcript / bottom **editor** /
    **footer**. The mode indicator lives in the footer only, so it no longer
    pollutes history.
  - **Editor caret** tracks Left/Right/backspace/delete (windowed for long input).
  - **Scrollable history**: Up/Down, PgUp/PgDn, Home/End.
  - **Footer**: model, truncated cwd, git branch + dirty count (refreshed async),
    and mode (`idle`/`working`/`thinking`).
- ✅ Verified: mock-SSE thinking flow, real DashScope thinking stream, markdown/
  footer/editor frame rendering, TUI boot + typing + Ctrl-C in a PTY.
#### 2026-08-10 — minimal tool set, own TUI, streaming, and self-updating docs

**Status: ✅ done**

Goals (from discussion):
- argus should be minimal (few default tools), easy to use & extend (docs so it
  can update itself), and look good.
- Full TUI framework was chosen, then changed course: **no third-party
  dependencies** — build the TUI by hand.

What was done:
- ✅ Tool set is now `read`, `write`, `edit`, `bash` (replaced read_file/write_file).
  `edit` does exact-string replacement across a file. All tools verified directly.
- ✅ Built a **dependency-free TUI** (`src/tui.mjs` + `src/theme.mjs`) using only
  Node built-ins: `readline` raw-mode key events + ANSI escapes (truecolor, cursor
  control). Header, live streaming transcript, readable tool call/result lines,
  bottom prompt line, Ctrl-C/D to quit.
- ✅ Added **streaming** to `src/llm.mjs` (SSE `stream:true`) and refactored
  `src/agent.mjs` to emit events (`text_delta`, `tool_call`, `tool_result`, …)
  that any UI can render.
- ✅ Removed ink/react; `package.json` has zero dependencies again. Removed
  `src/repl.mjs`; `src/main.mjs` is now the entry point.
- ✅ Wrote self-updating docs: `AGENTS.md` (root) + `docs/architecture.md`,
  `docs/tools.md`, `docs/self-updating.md`, and `docs/tools.md`.
- ✅ Verified: mock-SSE streaming loop (text deltas + aggregated tool call + real
  bash run + final answer), real DashScope streaming run, all four tools, TUI
  render frames, and TUI start/Ctrl-C exit in a PTY.
- ⏳ Remaining open from `GAPS.md` for later discussion: permission gate, parallel
  tools, compaction, session persistence, multi-provider.

---

#### 2026-08-10 — capture the "gap" as a reference file

**Status: ✅ done**

- ✅ Added `GAPS.md`: a living reference of where argus deliberately omits
  production features (streaming, permission gate, parallel tools, compaction,
  session persistence, multi-provider, robustness, TUI, testing/evals, model
  catalog). Each entry lists what/why/pi's approach/open questions.
- ✅ Explicitly *not* a line-by-line copy of pi — argus should grow its own
  characteristics; open questions are left unresolved for later discussion.

---

# Progress

Tracking log for the `argus` minimal terminal coding agent.
Format: `#### YYYY-MM-DD` entries, newest first. Status word: ✅ done / 🚧 in progress / ⏳ planned.

---

#### 2026-08-10 — default model, repo hygiene, and real API tests

**Status: ✅ done**

Goals this session:
- Make `deepseek-v4-flash-0731` the default model.
- Add a progress tracking file.
- Answer whether we need `.env`, `README`, and `.gitignore`, and set them up.

What was done:
- ✅ Verified `deepseek-v4-flash-0731` works on the DashScope compatible-mode endpoint (real curl test).
- ✅ Set the default model to `deepseek-v4-flash-0731` in `src/config.mjs`.
- ✅ Changed the default base URL to `https://dashscope.aliyuncs.com/compatible-mode/v1` (the server that hosts the default model).
- ✅ `npm start` now loads `.env` if present (`node --env-file-if-exists=.env src/repl.mjs`).
- ✅ Added `.env.example` (committed template) and `.gitignore` (ignores `.env`, `node_modules`, `references/pi/`, etc.).
- ✅ Added this `PROGRESS.md` file.
- ✅ Updated `README.md` for the new defaults and `.env` workflow.

---

#### 2026-08-10 — move code to repo root + real DashScope tests

**Status: ✅ done**

Goals:
- Move the agent code from `agent/` to the repo root.
- Run real tests against the DashScope API.

What was done:
- ✅ Moved `package.json`, `README.md`, and `src/` from `agent/` to the root.
- ✅ Ran the exact curl the user provided against DashScope — `qwen3.8-max` works.
- ✅ Ran the real agent against DashScope with `qwen3.8-max`:
  - simple Chinese prompt answered correctly,
  - `bash` tool loop (`pwd`) executed and reported the right directory,
  - `read_file` tool loop read a file and reported its contents.
- ✅ Fixed REPL bug: `ERR_USE_AFTER_CLOSE` on stdin EOF (piped input). Now exits cleanly.
- ✅ Repo structure after move:
  ```
  argus/
    package.json  README.md  PROGRESS.md  .gitignore  .env.example
    src/          (agent.mjs config.mjs llm.mjs repl.mjs tools.mjs)
    references/   (pi clone + API docs)
  ```

---

#### 2026-08-10 — initial build

**Status: ✅ done**

Goals:
- Clone `https://github.com/earendil-works/pi.git` as reference.
- Build a minimal terminal coding agent to learn how agents work.

What was done:
- ✅ Cloned pi into `agent/../pi` (later moved to `references/pi`).
- ✅ Studied pi's core loop in `packages/agent/src/agent-loop.ts`.
- ✅ Built a dependency-free agent (Node built-ins only) in `agent/src`:
  - `agent.mjs` — the tool-calling loop
  - `llm.mjs` — OpenAI-compatible chat completions via `fetch`
  - `tools.mjs` — `read_file`, `write_file`, `bash`
  - `repl.mjs` — terminal REPL
  - `config.mjs` — env-driven config
- ✅ Verified the loop end-to-end with a local mock LLM (tool call → execute → answer).

---

## Next steps (candidate at initial build; superseded by `GAPS.md`)

⏳ Streaming output (token deltas) instead of one-shot replies.
⏳ Ask before executing a tool (permission gating).
⏳ Parallel tool execution.
⏳ Message compaction / history truncation for long sessions.
⏳ Session persistence across runs.
⏳ Commit the initial state to git (currently all untracked).

#### 2026-08-13 — reliability hardening before personal use

**Status: ✅ done**

- ✅ Fixed CLI parsing: `--session <name>` now consumes the name, multi-word
  prompts work quoted or unquoted, and invalid/conflicting options fail clearly.
- ✅ Added a dependency-free `argus` executable entry so `npm link` provides a
  convenient command from any working directory.
- ✅ Bounded model calls with configurable request timeout, transient retries,
  and a per-turn step limit; truncated/empty responses fail safely.
- ✅ Prevented cross-provider credential leakage: `OPENAI_API_KEY` is only a
  fallback for `api.openai.com`; DashScope/custom hosts use `ARGUS_API_KEY`.
- ✅ Fixed standalone `argus` env loading: `ARGUS_HOME` and compaction defaults
  now resolve lazily, so `.env` works after `npm link` as well as `npm start`.
- ✅ Tool calls now receive runtime argument validation. Malformed JSON and
  missing/wrongly typed arguments are returned to the model and never executed.
- ✅ `write` protects existing files unless `overwrite=true` is explicit, and
  the built-in prompt now tells the agent to follow repository instructions.
- ✅ Destructive-command detection now catches split recursive-rm flags such as
  `rm -f -r`, closing a practical safety-gate bypass.
- ✅ `edit` is exact-by-default: ambiguous matches fail unless `all=true`.
- ✅ Bash captures the shell's real final cwd, including quoted/compound `cd`.
- ✅ Fixed TUI blank-submit lockup, column-zero Backspace corruption, emoji
  cursor splitting, lost startup keystrokes, terminal-control injection, and
  persistence of failed/interrupted turns.
- ✅ Serialized session writes; headless resume now restores the saved cwd and
  records failed user requests.
- ✅ Failed later model requests retain completed assistant/tool messages and
  cwd, so sessions accurately record side effects that already happened.
- ✅ TUI sessions now persist their launch cwd even without `cd`; resumed
  handles initialize their cwd cache to avoid redundant JSONL records.
- ✅ Compaction summaries retain user intent as well as assistant outcomes.
- ✅ Centralized tool-result bounds prevent large reads or command output from
  flooding the next model request; the model receives a marked preview.
- ✅ Strengthened the built-in prompt around inspection, focused changes,
  preserving user work, verification, and honest reporting.
- ✅ Added local `/help`, `/status`, `/new`, and `/exit`/`/quit` commands; none
  call the model or consume context.
- ✅ Added lightweight `@path` file-reference semantics via the built-in prompt:
  files are read visibly through the existing tool rather than auto-injected.
- ✅ Added bracketed-paste handling so multiline clipboard text becomes one
  prompt instead of triggering several concurrent submissions.
- ✅ Added conventional terminal editing keys: Ctrl-A/E, Ctrl-U/K/W, Ctrl-L,
  and context-sensitive Ctrl-D (delete at cursor; quit only on empty input).
- ✅ Expanded `/help` into a complete command and keyboard reference, with a
  focused `/keys` alias for quick shortcut lookup.
- ✅ Added `/sessions` discovery (recency, turn count, last prompt) and
  `/resume <name>` switching without restarting; all session-related TUI state
  changes atomically.
- ✅ Added conservative Tab completion for `@path` tokens only. Completion is
  cwd-relative, ignores hidden names unless requested, and never reads/injects
  file contents.
- ✅ Enriched `/status` with estimated context usage and configured reliability
  bounds; restored saved prompts into Up/Down history on session resume.
- ✅ Added regression coverage for every issue above. Verified with syntax
  checks, the full mock-LLM suite, CLI and PTY TUI smoke tests, plus a live
  provider tool-call round trip.

#### 2026-08-13 — live timing and responsive TUI polish

**Status: ✅ done**

- ✅ Added an animated phase indicator with live elapsed time for model work,
  thinking, confirmations, local tasks, and aborting.
- ✅ Added subtle per-tool and per-turn durations; completed turn time is saved
  with the transcript, restored on session resume, and shown by `/status`.
- ✅ Made the footer responsive: model and git details collapse by priority
  before the path or active state can overflow a narrow terminal.
- ✅ Added an always-visible scroll-away indicator with an `End` hint, including
  a compact form for narrow terminals.
- ✅ Refined the welcome copy and empty editor placeholder at wide, medium, and
  narrow widths so useful guidance stays readable instead of truncating badly.
- ✅ Added deterministic coverage for active/last timings, narrow layout,
  scroll visibility, session restoration, and the new empty state.

#### 2026-08-13 — fix the npm-linked executable

**Status: ✅ done**

- ✅ Fixed the executable entrypoint check to compare canonical paths. Node
  resolves the module to its real path while `npm link` invokes its symlink, so
  the old string comparison silently skipped `main()` for every `argus` command.
- ✅ Added a regression test that executes `--help` through a real symlink.
- ✅ Verified the existing linked command directly: two consecutive
  `argus --new` launches showed empty transcripts and distinct session names.
