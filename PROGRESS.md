#### 2026-08-13 — rail separators, thinking rails, colored tool bars, multiline editor

**Note:** the WIP batch previously on disk (live timing, responsive header/
footer, empty state, npm-link fix) was committed and pushed as
`eec3a46`; the repo itself was also pushed to origin.

**Status: 🚧 in progress**

Goal: friendlier transcript and editor:

- 🚧 "proper separation lines" between turns — replace the plain `─` divider
  with a colored **rail** row (`│ theme.rail`) so turns are visibly separated.
- 🚧 thinking marker `…` → a left rail (`│`) that runs down the thinking block,
  comparable to ChatGPT-style rails.
- 🚧 **different color vertical bars for tool calls** (`│ theme.tool` for the
  `⚙` line and the wrapped result lines).
- 🚧 **multiline editor input**: `Shift+Enter` inserts a newline, Enter submits,
  Up/Down stay bound to input history, and the editor grows upward above the
  footer (continuation rows prefixed with `│` rails).
- documentation + tests updated as part of the change.

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
