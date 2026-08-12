# argus — a minimal terminal coding agent

A tiny, **dependency-free** terminal coding agent built to understand how agents
work. It is a deliberately stripped-down mirror of the tool-calling loop in
[pi](https://github.com/earendil-works/pi) (cloned into `references/pi`).

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

Defaults already point at Alibaba Cloud DashScope with the `deepseek-v4-flash-0731`
model, so with just an API key it works out of the box.

### Configuration

Env vars are read from your shell and from `.env` (loaded automatically if it
exists). `.env` is gitignored; `.env.example` is the committed template.

| Variable           | Default                                    | Purpose                          |
|--------------------|--------------------------------------------|----------------------------------|
| `ARGUS_API_KEY`    | empty                                       | API key for DashScope/custom endpoints |
| `ARGUS_BASE_URL`   | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Base URL of the chat endpoint |
| `ARGUS_MODEL`      | `deepseek-v4-flash-0731`                   | Model identifier                 |
| `ARGUS_SYSTEM_PROMPT` | built-in coding-agent prompt            | System prompt                    |
| `ARGUS_REQUEST_TIMEOUT_MS` | `120000`                           | Overall timeout per model request |
| `ARGUS_MAX_RETRIES` | `2`                                        | Retries for 408/429/5xx/network failures |
| `ARGUS_MAX_STEPS`  | `25`                                       | Maximum model calls in one turn  |
| `ARGUS_MAX_TOOL_RESULT_CHARS` | `50000`                        | Maximum characters returned by one tool |

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
┌──────────────────────────────────────────────────────────────┐
│ argus  ·  minimal coding agent                               │
├──────────────────────────────────────────────────────────────┤
│ ❯ list the files here                                       │
│ … I need to figure out what to run.                          │  thinking (muted)
│ ## Result                                                    │  markdown heading
│ Here is **bold** and `code`.                                │  markdown inline
│   ⚙ bash({"command":"ls -la"})                               │  tool call
│   ✓ stdout: src                                              │  tool result
│ This directory contains …                                    │
├──────────────────────────────────────────────────────────────┤
│ ❯ type here… (caret tracks Left/Right/backspace/delete)      │
├──────────────────────────────────────────────────────────────┤
│ idle          model deepseek-v4-flash-0731 · /path/…/argus · git main ✓ │
└──────────────────────────────────────────────────────────────┘
```

- **Markdown rendering** for assistant replies: headings, bold/italic, inline +
  fenced code, lists, quotes.
- **Thinking / reasoning** is shown (muted, italic) when the model emits it.
- **Auto light/dark theme** (detected via OSC 11; falls back to light).
- **Scrollable history**: mouse wheel to scroll; PgUp/PgDn (pages), Home/End (top/bottom).
- **Up/Down** navigate past inputs (input history) in the editor.
- **Editor stays at the bottom**; the caret follows Left/Right/backspace/delete.
- **Familiar terminal editing**: Ctrl-A/E moves to start/end, Ctrl-U/K deletes
  to start/end, Ctrl-W deletes the previous word, and Ctrl-L redraws.
- **Footer** always shows model, current path, git status (branch + dirty count),
  and mode (`idle` / `working` / `thinking` / `aborting`).
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
| `/status` | Show session, model, cwd, context usage, and reliability limits |
| `/sessions` | List up to 20 recent sessions with their last prompt |
| `/resume <name>` | Switch to a saved session without restarting |
| `/new` | Start a fresh session without restarting |
| `/exit`, `/quit` | Quit Argus |

Use `@path` as a lightweight file reference in prompts, for example:

```text
Review @src/agent.mjs and explain its failure modes.
```

Argus does not inject the file eagerly. The built-in prompt tells the model to
use `read`, keeping access visible and letting normal tool-result limits apply.
Press Tab while the caret is after an `@path` token to complete files and
directories relative to the session cwd. Paths containing spaces are quoted
automatically; ambiguous matches are shown locally.

## Sessions & persistence

argus auto-saves each turn to `~/.argus/sessions/<name>.jsonl` (override
the root with the `ARGUS_HOME` env var). JSONL is append-only and keeps
everything needed to reconstruct the exact requests a session made: the config
(model, base URL, system prompt), the full `messages` (verbatim tool calls +
results), the tool schemas, and the on-screen blocks (incl. thinking).
Your API key is never written to disk.

By default `npm start` resumes the most recent session:

```bash
npm start                 # resume latest session (or start fresh)
npm start -- --new        # start a brand-new session
npm start -- --session X  # resume/create a session named X
```

The active session name is shown in the header.
Use `/sessions` and `/resume <name>` to move between saved sessions from the TUI.

## What it teaches

The whole agent lives in a few small files:

| File | What it does |
|------|--------------|
| `src/config.mjs` | Reads configuration from the environment / `.env` |
| `src/llm.mjs` | OpenAI-compatible chat client, incl. **streaming** + thinking |
| `src/tools.mjs` | Tool schemas + implementations (`read`, `write`, `edit`, `bash`) |
| `src/agent.mjs` | **The loop**: call LLM → run requested tools → repeat |
| `src/tui.mjs` | Minimal dependency-free terminal UI |
| `src/main.mjs` | Entry point |
| `docs/` | Architecture, tool contract, self-updating guide |

### The core loop (`src/agent.mjs`)

```text
user prompt
   │
   ▼
send full history + tool schemas to the model
   │
   ▼
model replies (streamed): thinking, text and/or tool_calls
   │
   ├─ no tool_calls ─▶ final answer, done
   │
   └─ tool_calls ─▶ for each: execute → append result as a `tool` message
                       │
                       └──────────────▶ loop again (model now sees the results)
```

The key idea: **the model never executes tools — it only requests them.** Your
code decides what actually runs. That separation (model proposes, code disposes)
is the single most important concept in agent engineering.

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

Long sessions eventually overflow the model’s context window. argus compacts
automatically: when history passes a budget (default 300k chars, ~= 75k tokens)
the oldest turns are replaced by a short summary and the most recent
`ARGUS_COMPACT_KEEP` (default 8) turns are kept. Full messages stay in the
session file, so the original requests remain reconstructable. Tune with
`ARGUS_COMPACT_AT` (chars) and `ARGUS_COMPACT_KEEP`.

Individual tool results are capped at `ARGUS_MAX_TOOL_RESULT_CHARS`; oversized
results include a marked preview so the model can retry with a narrower read or
command instead of overflowing the active turn.

## Self-updating

Argus can modify its own source — that's the point of the docs. Start with
`AGENTS.md` and `docs/self-updating.md`.

## How it maps to pi

The reference project is far richer, but every piece here has a direct analogue:

| This project | pi |
|--------------|-----|
| `src/agent.mjs` loop | `packages/agent/src/agent-loop.ts` (`runLoop`) |
| `src/tools.mjs` (`read`/`write`/`edit`/`bash`) | `packages/agent/src/harness/tools/*.ts` |
| `src/llm.mjs` | `packages/ai` (multi-provider `Message[]` transport) |
| system prompt | `packages/agent/src/harness/system-prompt.ts` |
| `src/tui.mjs` | `packages/tui` + `packages/coding-agent` CLI |

Things pi still adds beyond argus (see `GAPS.md`): a comprehensive permission
system, parallel tool execution, richer context management, and a native
multi-provider abstraction layer.

## Files

```
argus/
  package.json       # start script (loads .env if present)
  README.md          # this file
  PROGRESS.md        # running log of what we've done
  GAPS.md            # reference: where argus stands vs a production agent
  AGENTS.md          # rules for working with/updating argus
  .env.example       # committed template for local secrets
  .gitignore         # ignores .env, node_modules, references/pi/, etc.
  src/
    main.mjs
    session.mjs
    tui.mjs
    agent.mjs
    llm.mjs
    tools.mjs
    theme.mjs
    config.mjs
  docs/
    architecture.md
    tools.md
    self-updating.md
  references/
    pi/              # the pi reference clone (gitignored)
    *.md             # API reference docs
```

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

Covers the agent loop (tools, abort, persistent cwd), headless mode, session
round-trip, and TUI rendering/navigation.
