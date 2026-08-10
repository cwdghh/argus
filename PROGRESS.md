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

## Next steps (candidate)

⏳ Streaming output (token deltas) instead of one-shot replies.
⏳ Ask before executing a tool (permission gating).
⏳ Parallel tool execution.
⏳ Message compaction / history truncation for long sessions.
⏳ Session persistence across runs.
⏳ Commit the initial state to git (currently all untracked).
