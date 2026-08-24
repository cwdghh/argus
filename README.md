# argus — a minimal terminal coding agent

A tiny, **dependency-free** terminal coding agent built to understand how agents
work. Argus is a standalone project: a small tool-calling loop around a language
model — call the model, run the tools it requests, repeat. No build step, no
dependencies; every module under `src/` is small enough to be read end to end.

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

Global defaults live in `~/.argus/.env` — the same variables and format,
loaded after the project `.env` so they only fill gaps. Set a machine-wide
model, endpoint, API key, timeouts, or system prompt once instead of copying
them into every checkout; anything your shell or a project `.env` sets wins,
and `ARGUS_HOME` relocates the file (and your sessions).

| Variable | Default | Purpose |
|---|---|---|
| `ARGUS_API_KEY` | empty | API key for DashScope/custom endpoints |
| `ARGUS_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Base URL of the chat endpoint |
| `ARGUS_MODEL` | `deepseek-v4-flash-0731` | Model identifier |
| `ARGUS_SYSTEM_PROMPT` | built-in coding-agent prompt | System prompt |
| `ARGUS_REQUEST_TIMEOUT_MS` | `600000` | Time before a model request is abandoned (generous for long reasoning/thinking) |
| `ARGUS_STREAM_IDLE_TIMEOUT_MS` | `300000` | Streaming idle timeout between chunks; resets on each chunk |
| `ARGUS_MAX_RETRIES` | `2` | Retries for 408/429/5xx/network failures |
| `ARGUS_MAX_STEPS` | `100` | Maximum model calls in one turn |
| `ARGUS_MAX_TOOL_RESULT_CHARS` | `50000` | Maximum characters returned by one tool |
| `ARGUS_MAX_TURN_TOOL_RESULT_CHARS` | `400000` | Cumulative tool-result characters allowed in one active turn |
| `ARGUS_COMPACT_TOKENS` | `200000` | Real-token context budget that triggers compaction |
| `ARGUS_COMPACT_AT` | `800000` | Character safety net before provider usage is available |
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
│last 12s · ↑1.6K ↓412  git main ~2 · deepseek-v4-flash-0731 · 1.6K / 200.0K (1%) · /Users/…/argus  │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Markdown rendering** for assistant replies: headings, tables, bold/italic,
  inline + fenced code, lists, quotes.
- **Numbered, bounded reads**: every line of a `read` result carries its
  absolute line number, and `edit` accepts line ranges (`startLine`/`endLine`)
  for whole-block rewrites, insertions, and deletions without reproducing
  large old code verbatim.
- **Block rails and separators** make the transcript scannable: thinking, tool
  calls, and tool results are visually grouped, and each turn gets a divider.
- **Thinking / reasoning** is shown (muted, italic) while the model emits it.
- **Live working time** follows the current phase (`working`, `thinking`,
  confirmation, or aborting); completed turns and tool calls keep their timing
  in the transcript, and `/status` reports the last turn.
- **Token usage travels with the turn**: the footer shows live tokens while
  working, and the last turn's usage (`↑ input / ↓ output`) is kept in the
  timing row and reported by `/status`. Accumulation never counts the same
  tokens twice: a multi-call turn reports the largest context that was sent
  (`↑`) plus the sum of every step's output (`↓`), instead of summing the
  shared history once per model step. The right-side context meter is
  `X / Y (Z%)`: X is the real, provider-reported prompt tokens of the most
  recent request, Y is the current upper limit argus enforces — a 200k
  real-token compaction budget (`ARGUS_COMPACT_TOKENS`) — and Z% their ratio.
  Before any request has reported usage, X shows `—` instead of a made-up
  number (so a fresh session never shows a stray `2 / 300.0K`); once a request
  has reported usage, X keeps showing the last-known real context even while
  the next response is streaming (the live number replaces it as soon as the
  provider reports it).
- **Auto light/dark theme** (detected via OSC 11; falls back to light).
- **Scrollable history**: mouse wheel to scroll; PgUp/PgDn (pages), Home/End
  (top/bottom). The header shows when you are away from the latest output.
- **Up/Down** navigate past inputs (input history) in the editor.
- **Multiline editing**: Shift+Enter inserts a soft line break; the caret
  tracks double-width characters and wraps within the terminal width.
- **Familiar terminal editing**: Ctrl-A/E moves to start/end, Ctrl-U/K deletes
  to start/end, Ctrl-W deletes the previous word, and Ctrl-L redraws.
- **Responsive footer** shows phase + elapsed time plus live token usage
  (`↑` input / `↓` output, plus `✶` reasoning and `≡` cached when the provider
  reports them) on the left, and git status, model, context-window usage
  (real prompt tokens of the most recent request against the token budget —
  e.g. `1.6K / 200.0K (1%)`), and the current path on the right —
  lower-priority details collapse cleanly on narrow terminals.
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
| `/name <name>` | Rename the active session |
| `/delete <name>` | Permanently delete a saved inactive session after confirmation |
| `/new [name]` | Start a fresh, optionally named session without restarting |
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
the root with the `ARGUS_HOME` env var; the global `~/.argus/.env` shares
the same root). JSONL is append-only and keeps
everything needed to reconstruct the exact requests a session made: the config
(model, base URL, system prompt), the full `messages` (verbatim tool calls +
results), the tool-surface hash used by each turn plus a schema snapshot when
that surface changes, and the on-screen blocks (incl. thinking).
Your API key is never written to disk. `/sessions` lists saved sessions
with their turn count, file size, and last prompt.

Set `ARGUS_SESSION_KEEP` to a positive number to prune everything but the
newest sessions on startup — the session you are opening is always preserved.
`0` (the default) keeps everything.

Session directories are created with owner-only permissions and transcript
files with owner read/write permissions on platforms that support POSIX modes.
Use `/delete <name>` for confirmed cleanup; the active session is protected and
deletion cannot be undone.

By default `npm start` resumes the newest session that was used in (or
below) the current folder, so each project picks up its own work instead of
whatever session happened to be most recent globally. When nothing recent
relates to this folder, a fresh session starts (an unrelated project's
session is never auto-resumed; use `/resume` or `--session` for those):

```bash
npm start                 # resume the newest session for this folder, else fresh
npm start -- --new        # start a brand-new session
npm start -- --session X  # resume/create a session named X
```

The active session name is shown in the header.
Use `/sessions` and `/resume <name>` to move between saved sessions from the TUI.
Typing `/resume` or `/delete` followed by a space completes saved-session names
in the editor popup — keep typing to filter, Tab accepts, and the list reflects
renames, deletions, and new sessions.

Give sessions meaningful names: `/name <name>` renames the current session
(later turns keep writing to it), and `/new <name>` starts a named session
(`/new` alone still uses a timestamp). Sessions are discovered by their
names, not position in the list, so a large collection stays navigable.

Session names become filenames, so they may contain letters, digits, `-` and
`_` only (no spaces, and at most 249 characters so the name plus `.jsonl`
fits the filesystem's per-component limit). `/name fix the bug` is rejected
with that reason rather than silently altered. `/name` also works right after
`/new`: a fresh session only touches the disk on its first turn, so an early
rename simply repoints it.

`/model <name>` switches the model for the current session only. The override
is saved with the session (in its JSONL file) and restored when you resume it;
`/status` and the footer reflect it immediately. A fresh session (`/resume` of a
session without an override, or `/new`) uses the `ARGUS_MODEL` default again.
Headless runs against a session honor the same override.

## What it teaches

The whole agent lives in a few focused modules. The authoritative file map
(with the TUI widget list, session package, and doc roles) is `AGENTS.md`;
here is the condensed version:

| File | What it does |
|------|--------------|
| `src/config.mjs` | Reads configuration from the environment / `.env` |
| `src/llm.mjs` | OpenAI-compatible chat client, incl. **streaming** + thinking (`src/sse.mjs` holds the pure SSE framing) |
| `src/tools.mjs` | Tool registry + fs/shell layer (`read`, `write`, `edit`, `bash`); engines in `src/edit-engine.mjs` + `src/read-bounds.mjs`, freshness in `src/tool-state.mjs` |
| `src/agent.mjs` | **The loop**: call LLM → run requested tools → repeat |
| `src/compact.mjs` | Context compaction (auto-summarize old turns) |
| `src/session/` | Append-only JSONL session persistence (store / resume / data) |
| `src/headless.mjs` | One-shot CLI mode (no TUI) |
| `src/tui.mjs` + `src/tui/*.mjs` | Dependency-free TUI (controller + pure widgets: editor, keys, suggestions, frames, markdown, blocks, commands, layout, lifecycle) |
| `src/theme.mjs` | Colors / styling tokens, auto light-dark detection |
| `src/format.mjs` | Neutral value formatting (durations, tokens, result summaries) |
| `src/main.mjs` | Entry point / CLI |
| `package.json` | `start` / `test` scripts (loads `.env` if present) |
| `docs/` | Architecture, tool contract, self-updating guide (`docs/archive/` holds history) |
| `test/` | `node:test` suites + `helpers/mock-llm.mjs` (scripted mock LLM server) |
| [`AGENTS.md`](AGENTS.md) | Rules for working with/updating argus — the authoritative file map |
| [`PROGRESS.md`](PROGRESS.md) | Running log of what we've done |
| [`GAPS.md`](GAPS.md) | Open design questions & where argus stays simple |
| [`NEXT_STEPS.md`](NEXT_STEPS.md) | Candidate next directions (planning reference) |

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
not run silently. In the TUI they show a structured confirmation with the
tool and working directory — `y` approves, `n`/Esc denies — and the decision
is recorded in the transcript. Headless mode blocks them by default.

File changes also prefer explicit intent: `write` creates files but refuses to
replace an existing one unless the model passes `overwrite: true`, while `edit`
refuses an ambiguous match unless every occurrence was explicitly requested.
Line-range edits additionally require the same turn to have read the exact
current content and affected lines; later mutations invalidate that evidence.

The gate is deliberately small and pattern-based, not a sandbox. Review commands
before approving them and run Argus inside a disposable workspace when working
with untrusted repositories.

## Context

Long sessions eventually overflow the model's context window. argus compacts
automatically: once a request is sent the provider reports exactly how many
tokens it cost, and when that real context reaches the `ARGUS_COMPACT_TOKENS`
budget (default 200k tokens) the oldest turns are replaced by a short summary
and the most recent `ARGUS_COMPACT_KEEP` (default 8) turns are kept intact.
Earlier summaries are carried forward, so repeated compactions never forget
older context, and the full messages stay in the session file so the original
requests remain reconstructable. Before the first usage report (a brand-new
session, or a provider that omits usage), a measured-size safety net
(`ARGUS_COMPACT_AT`, default 800k chars ≈ the 200k-token budget) prevents
unbounded growth. The footer shows how much of the 200k-token budget the most
recent request used.

Individual serialized tool results are capped at
`ARGUS_MAX_TOOL_RESULT_CHARS`; their cumulative size in one active turn is
capped at `ARGUS_MAX_TURN_TOOL_RESULT_CHARS`. The `read` tool scans with
bounded memory, returns at most 2000 lines / 50KB, numbers every line, and
reports structured `truncated`/`nextOffset` continuation data. Other oversized
results retain a bounded preview plus stable fields such as `path`, `cwd`, or
`nextOffset`, so the model can narrow its next call.

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

An opt-in real-provider tool-choice evaluator covers content edits, fresh range
edits, shell search, and new-file creation in isolated temporary workspaces:

```bash
npm run eval:tools
```

It requires configured API credentials and may incur provider cost, so it is
not part of `npm test`.
