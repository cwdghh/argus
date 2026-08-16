# argus — a minimal terminal coding agent

A tiny, **dependency-free** terminal coding agent built to understand how agents
work. Argus is a standalone project: a small tool-calling loop around a language
model — call the model, run the tools it requests, repeat. No build step, no
dependencies; the whole thing fits in a handful of files under `src/`, written
to be read end to end.

## Run it

No `npm install`, no build step, no dependencies. It only uses Node's built-ins
(`fetch`, `fs`, `child_process`, and terminal I/O).

```bash
# 1. Put your API key in `.env` (copy from .env.example)
cp .env.example .env
# edit .env and set ARGUS_API_KEY

# 2. Run
npm start
```

Optional: run `npm link` once to make the shorter `argus` command available
from any directory. It still uses this checkout, so your local updates apply
immediately.

Defaults already point at Alibaba Cloud DashScope with the
`deepseek-v4-flash-0731` model, so with just an API key it works out of the box.

### Configuration

Env vars are read from your shell and from `.env` (loaded automatically if it
exists). `.env` is gitignored; `.env.example` is the committed template.

| Variable | Default | Purpose |
|---|---|---|
| `ARGUS_API_KEY` | empty | API key for DashScope/custom endpoints |
| `ARGUS_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Base URL of the chat endpoint |
| `ARGUS_MODEL` | `deepseek-v4-flash-0731` | Model identifier |
| `ARGUS_SYSTEM_PROMPT` | built-in coding-agent prompt | System prompt |
| `ARGUS_REQUEST_TIMEOUT_MS` | `300000` | Overall timeout per model request (long default helps reasoning models) |
| `ARGUS_STREAM_IDLE_TIMEOUT_MS` | `60000` | Streaming idle timeout; resets on each chunk |
| `ARGUS_MAX_RETRIES` | `2` | Retries for 408/429/5xx/network failures |
| `ARGUS_MAX_STEPS` | `100` | Maximum model calls in one turn |
| `ARGUS_MAX_TOOL_RESULT_CHARS` | `50000` | Maximum characters returned by one tool |
| `ARGUS_COMPACT_AT` | `300000` | History size (chars) that triggers compaction |
| `ARGUS_COMPACT_KEEP` | `8` | Recent turns kept intact when compacting |
| `ARGUS_SESSION_KEEP` | `0` | Keep only the newest N saved sessions on startup (`0` keeps all; the active session is never pruned) |

You can point it at any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio,
vLLM, LiteLLM, …). Example with a local model:

```bash
ARGUS_BASE_URL=http://localhost:11434/v1 ARGUS_MODEL=llama3 npm start
```

For `https://api.openai.com`, `OPENAI_API_KEY` is accepted as a fallback.
For every other authenticated host, set `ARGUS_API_KEY` explicitly so a key is
never sent to the wrong provider by accident.

## The TUI

A minimal, dependency-free terminal UI (raw-mode input + ANSI escapes). Fixed
layout: header, scrollable transcript, a bottom **editor**, and a **footer**.

```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│argus  ·  rogue                                                                                     │
│────────────────────────────────────────────────────────────────────────────────────────────────────│
│❯ list the files here                                                                               │
│                                                                                                    │
││ I need to figure out what to run.                                                                 │
│                                                                                                    │
││ ⚙ bash({"command":"ls -la"})                                                                      │
││ ✓ stdout: src                                                                                     │
│This directory contains src/, test/, and docs.                                                      │
│                                                                                                    │
│────────────────────────────────────────────────────────────────────────────────────────────────────│
│❯ Describe a task…  (/help for commands)                                                            │
│────────────────────────────────────────────────────────────────────────────────────────────────────│
│idle · last 12s  git main ~2 · deepseek-v4-flash-0731 · 0% 300.0K · ↑1.6K ↓412 tok · /User…rgus     │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Markdown rendering** for assistant replies: headings, bold/italic, inline +
  fenced code, lists, quotes.
- **Block rails and separators** make the transcript scannable: thinking, tool
  calls, and tool results are visually grouped, and each turn gets a divider.
- **Thinking / reasoning** is shown (muted, italic) while the model emits it.
- **Live working time** follows the current phase (`working`, `thinking`,
  confirmation, or aborting); completed turns and tool calls keep their timing
  in the transcript, and `/status` reports the last turn.
- **Token usage travels with the turn**: the footer shows live tokens while
  working, and the last turn's usage (`↑ input / ↓ output`) is kept in the
  timing row and reported by `/status`.
- **Auto light/dark theme** (detected via OSC 11; falls back to light).
- **Scrollable history**: mouse wheel to scroll; PgUp/PgDn (pages), Home/End
  (top/bottom). The header shows when you are away from the latest output.
- **Up/Down** navigate past inputs (input history) in the editor.
- **Multiline editing**: Shift+Enter inserts a soft line break; the caret
  tracks double-width characters and wraps within the terminal width.
- **Familiar terminal editing**: Ctrl-A/E moves to start/end, Ctrl-U/K deletes
  to start/end, Ctrl-W deletes the previous word, and Ctrl-L redraws.
- **Responsive footer** shows phase + elapsed time, git status, model, context
  window usage (percent of the compaction budget), live token usage (`↑` input /
  `↓` output, plus `✶` reasoning and `≡` cached when the provider reports them),
  and the current path — lower-priority details collapse cleanly on narrow
  terminals.
- **Helpful empty state and editor hints** make commands, `@path` references,
  live suggestions, completion, and interruption discoverable without opening
  the manual first.
- **Ctrl-C during a turn aborts it** (second Ctrl-C force-quits); Ctrl-C when
  idle quits. Esc also aborts a running turn. Ctrl-D deletes at the cursor, or
  quits when the editor is empty.
- **Bracketed paste is safe**: multiline clipboard content is folded into one
  prompt instead of accidentally submitting a turn per line.

### Local commands and file references

Slash commands are handled by the TUI itself, without calling the model:

| Command | Action |
|---------|--------|
| `/help` | Show commands and keyboard shortcuts |
| `/keys` | Show the keyboard-shortcut reference |
| `/status` | Show session, model, cwd, last-turn time + token usage, context-window usage, and reliability limits |
| `/model <name>` | Show or switch the model for this session (`/model` alone shows the current one) |
| `/sessions` | List up to 20 recent sessions (turns, size, last prompt) |
| `/resume <name>` | Switch to a saved session without restarting |
| `/new` | Start a fresh session without restarting |
| `/exit`, `/quit` | Quit Argus |

Use `@path` as a lightweight file reference in prompts, for example:

```text
Review @src/agent.mjs and explain its failure modes.
```

Argus does not inject the file eagerly. The built-in prompt tells the model to
use `read`, keeping access visible and letting normal tool-result limits apply.

Typing shows live suggestions in a popup just above the editor:

- `/` lists the local commands; keep typing to filter.
- `@` lists files and directories relative to the session cwd; keep typing to
  filter or Tab to descend into a directory.
- Up/Down move the highlight; the window scrolls once you arrow past the
  visible limit without ever changing the popup's height. A fixed status row
  reports the hidden matches (`↑ N` above, `↓ N` below) or the match count
  when everything fits. Tab accepts the highlighted suggestion, and Esc
  dismisses the popup without touching your input.
- Paths containing spaces are quoted automatically; quoted and unquoted
  `@path` tokens complete the same way. Directory entries keep a muted trailing
  slash, and symlinks show a muted arrow to their resolved target (a symlink to
  a directory sorts, completes, and descends like a directory).

## Sessions & persistence

argus auto-saves each turn to `~/.argus/sessions/<name>.jsonl` (override
the root with the `ARGUS_HOME` env var). JSONL is append-only and keeps
everything needed to reconstruct the exact requests a session made: the config
(model, base URL, system prompt), the full `messages` (verbatim tool calls +
results), the tool schemas, and the on-screen blocks (incl. thinking).
Your API key is never written to disk. `/sessions` lists saved sessions
with their turn count, file size, and last prompt.

Set `ARGUS_SESSION_KEEP` to a positive number to prune everything but the
newest sessions on startup — the session you are opening is always preserved.
`0` (the default) keeps everything.

By default `npm start` resumes the most recent session:

```bash
npm start                 # resume latest session (or start fresh)
npm start -- --new        # start a brand-new session
npm start -- --session X  # resume/create a session named X
```

The active session name is shown in the header.
Use `/sessions` and `/resume <name>` to move between saved sessions from the TUI.

`/model <name>` switches the model for the current session only. The override
is saved with the session (in its JSONL file) and restored when you resume it;
`/status` and the footer reflect it immediately. A fresh session (`/resume` of a
session without an override, or `/new`) uses the `ARGUS_MODEL` default again.
Headless runs against a session honor the same override.

## What it teaches

The whole agent lives in a few small files:

| File | What it does |
|------|--------------|
| `src/config.mjs` | Reads configuration from the environment / `.env` |
| `src/llm.mjs` | OpenAI-compatible chat client, incl. **streaming** + thinking |
| `src/tools.mjs` | Tool schemas + implementations (`read`, `write`, `edit`, `bash`) |
| `src/agent.mjs` | **The loop**: call LLM → run requested tools → repeat |
| `src/compact.mjs` | Context compaction (auto-summarize old turns) |
| `src/session.mjs` | Append-only JSONL session persistence |
| `src/headless.mjs` | One-shot CLI mode (no TUI) |
| `src/tui.mjs` + `src/tui/renderers.mjs` | Dependency-free TUI (frame/input logic + pure renderers) |
| `src/theme.mjs` | Colors / styling tokens, auto light-dark detection |
| `src/main.mjs` | Entry point / CLI |
| `package.json` | `start` / `test` scripts (loads `.env` if present) |
| `docs/` | Architecture, tool contract, self-updating guide |
| `test/` | `node:test` suites + `helpers/mock-llm.mjs` (scripted mock LLM server) |
| `AGENTS.md` | Rules for working with/updating argus |
| `PROGRESS.md` | Running log of what we've done |
| `GAPS.md` | Open design questions & where argus stays simple |
| `NEXT_STEPS.md` | Candidate next directions (planning reference) |

### The core loop (`src/agent.mjs`)

See `docs/architecture.md` for the loop diagram and its invariants. The key
idea: **the model never executes tools — it only requests them.** Your code
decides what actually runs. That separation (model proposes, code disposes) is
the single most important concept in agent engineering.

The loop is **UI-agnostic**: it emits events (`thinking_delta`, `text_delta`,
`tool_call`, `tool_result`, …) so any front-end can render live. `src/tui.mjs` is
one such front-end; you could swap it for a logger or a web UI without touching
the loop.

`bash` has a **persistent working directory**: a `cd` inside a command is
remembered and used by later calls — persisted across sessions (`~/.argus`) and
shown in the footer.

## Safety

Destructive shell commands (recursive `rm`, `dd`, `mkfs`, `shutdown`, …) are
not run silently. In the TUI they show a `⚠ <command> (y/n)` prompt — `y`
approves, `n`/Esc denies. Headless mode blocks them by default.

File changes also prefer explicit intent: `write` creates files but refuses to
replace an existing one unless the model passes `overwrite: true`, while `edit`
refuses an ambiguous match unless every occurrence was explicitly requested.

The gate is deliberately small and pattern-based, not a sandbox. Review commands
before approving them and run Argus inside a disposable workspace when working
with untrusted repositories.

## Context

Long sessions eventually overflow the model's context window. argus compacts
automatically: when the estimated history size passes the `ARGUS_COMPACT_AT`
budget (default 300k chars) the oldest turns are replaced by a short summary and
the most recent `ARGUS_COMPACT_KEEP` (default 8) turns are kept intact. Full
messages stay in the session file, so the original requests remain
reconstructable. The footer shows how much of that budget the active session
is using.

Individual tool results are capped at `ARGUS_MAX_TOOL_RESULT_CHARS`; oversized
results include a marked preview so the model can retry with a narrower read or
command instead of overflowing the active turn.

## Self-updating

Argus can modify its own source — that's the point of the docs. Start with
`AGENTS.md` and `docs/self-updating.md`.

## Acknowledgements

Argus stands on its own now, but it grew out of studying
[pi](https://github.com/earendil-works/pi), a far richer terminal coding agent
that made a great reference for how a tool-calling agent is put together. The
loop, the tool harness (`read`/`write`/`edit`/`bash`), the streaming LLM
transport, and the TUI all re-implement a deliberately smaller slice of pi's
ideas from scratch in this one dependency-free codebase. Thanks to pi and its
maintainers for the design that got argus started. See `GAPS.md` for where argus
intentionally stays simpler.

## Headless one-shot

Run a single prompt without the TUI. Assistant text goes to **stdout** (clean
for piping); reasoning, tool calls and errors go to **stderr**:

```bash
npm start -- "<prompt>"            # run one prompt (quotes recommended)
npm start -- "<prompt>" --session X  # ...and append to a named session
npm start -- --help                # usage
```

Unquoted prompt words are joined too (`npm start -- explain this repo`). Invalid
options and session names fail with a clear error instead of being ignored.

## Testing

A dependency-free test suite using Node's built-in test runner plus a scripted
**mock LLM server** (`test/helpers/mock-llm.mjs`), so argus can verify its own
edits safely without a real API:

```bash
npm test
```

Covers the agent loop (tools, abort, persistent cwd), context compaction,
headless mode, session round-trip, safety gates, retry/reliability behaviour,
and TUI rendering and navigation.
