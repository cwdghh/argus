# Architecture

argus is built around one idea: **the model proposes actions; the code disposes
them.** A short loop turns a language model into an agent.

## The loop (`src/agent.mjs`)

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
   └─ tool_calls ─▶ for each: validate → execute → append result as a `tool` message
                       │
                       └──────────────▶ loop again (model now sees the results)
```

Key properties:

- **No hidden state.** The model's only "memory" is the message history we
  re-send every request.
- **No direct model access.** The model only *requests* tools by name + JSON
  arguments; `src/tools.mjs` decides what actually runs. This is where safety
  lives.
- **Termination policy.** The agent stops when the model replies with no tool
  calls, or fails clearly after `ARGUS_MAX_STEPS` model calls. Truncated model
  responses never execute partial tool calls.
- **Runtime validation.** Tool arguments are parsed and checked against the
  tool's required fields and primitive JSON Schema types before `execute` runs.
- **Bounded requests.** Transient model errors are retried with short backoff;
  each request has an overall timeout.
- **Bounded tool results.** Every tool result passes through one centralized
  size cap before it is added to model history. The `read` tool also truncates
  itself (2000 lines / 50KB) and pages with `offset`/`limit`, so a large file
  never floods the context window in a single call.
- **Forgiving edits.** `edit` matches exactly first, then falls back to
  normalised matching (trailing whitespace, smart quotes, unicode dashes, CRLF)
  and overlays changed lines back onto the file so untouched bytes are
  preserved — the model can make precise edits without a perfect byte-level
  copy of the old text.
- **Config as env vars.** `src/config.mjs` reads the process environment plus
  two dotenv files — the project `.env` and the global `~/.argus/.env`
  (loaded last, so it only fills gaps). Precedence is process env > project
  `.env` > home `.env` > built-in defaults, matching how argus keeps every
  knob small, inspectable, and overridable per checkout.

## Data flow

```
src/main.mjs ──▶ src/tui.mjs ──▶ src/agent.mjs ──▶ src/llm.mjs ──▶ HTTP (OpenAI-compatible)
                      │  ▲                    │          │
                      ▼  │                    ▼          ▼
                 src/tools.mjs        src/sse.mjs   (SSE framing +
                 (registry + fs)          ▲        chat-delta fold)
                 read / write / edit / bash
                      │  ▲
                      ▼  │
         src/read-bounds.mjs      src/edit-engine.mjs
         (read caps)              (exact/fuzzy/range edits)
```

`src/agent.mjs` emits events (`text_delta`, `tool_call`, `tool_result`, …) so any
UI can render live without knowing how the loop works. `src/tui.mjs` is one such UI; you could swap it
for a logging UI or a web UI without touching the loop.

`src/tui.mjs` is the controller — input parsing, event → block mapping, and
session wiring. The pure pieces live beside it in `src/tui/`:
`renderers.mjs` (ANSI/text + CJK/emoji-aware column widths), `markdown.mjs`
(markdown incl. tables), `blocks.mjs` (transcript block → lines), `editor.mjs`
(the multiline prompt: buffer, caret, recall history), `keys.mjs` (terminal
escape/CSI decoding), `suggestions.mjs` (`@path` + `/command` popups),
`frames.mjs` (status/footer/header text), `commands.mjs` (the local command
table + `/help` text), `layout.mjs` (full-frame assembly), and `lifecycle.mjs`
(raw-mode startup, render clock, git polling, theme detection, shutdown). Each
is unit-testable without a terminal. Shared, frontend-neutral helpers live
outside the TUI: `src/format.mjs` (durations/tokens/result summaries),
`src/transcript.mjs` (block folding), and `src/session/` (persistence).

The TUI handles its local command set (the `COMMANDS` table in
`src/tui/commands.mjs` — `/help`, `/status`, `/model`, `/sessions`, `/resume`,
`/name`, `/new`, `/exit`) before invoking the loop; adding a command touches
just that table. Session switches replace the transcript, model history, input
history, cwd, and writable session handle together. Typing a bare `/` command
or an `@path` token opens a live suggestion popup above the editor (Up/Down to
highlight, Tab to accept, Esc to dismiss); `@path` is deliberately not a
parser-side expansion — the path is completed locally, then the model sees it
as a reference and uses `read` visibly. Elapsed phase/tool/turn timing is also
TUI-owned; it needs no agent-protocol or tool changes, and completed turn
timings persist as ordinary display blocks.

## Message types

- `user` — your prompt
- `assistant` — model output (text and/or tool_calls)
- `tool` — a tool result, tied to a tool call via `tool_call_id`

## Why it's organised this way

The loop stays small enough to read in one sitting; everything else is
support, split along clear boundaries (network vs. protocol, registry vs.
engine, controller vs. widget vs. layout, store vs. data shape). Keeping each
module cohesive means a single person (or an agent) can hold the whole thing in
their head — which is exactly what makes self-updating safe. File count is a
means to that end, not a goal: prefer a clear boundary and a descriptive name
over one more crowded file.
