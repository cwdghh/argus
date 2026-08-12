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
model replies (streamed): text and/or tool_calls
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
  size cap before it is added to model history.

## Data flow

```
src/main.mjs ──▶ src/tui.mjs ──▶ src/agent.mjs ──▶ src/llm.mjs ──▶ HTTP (OpenAI-compatible)
                      │  ▲
                      ▼  │
                 src/tools.mjs (read / write / edit / bash)
```

`src/agent.mjs` emits events (`text_delta`, `tool_call`, `tool_result`, …) so any
UI can render live without knowing how the loop works. `src/tui.mjs` is one such UI; you could swap it
for a logging UI or a web UI without touching the loop.

The TUI handles its small control plane (`/help`, `/status`, `/sessions`,
`/resume`, `/new`, `/exit`) before invoking the loop. Session switches replace
the transcript, model history, input history, cwd, and writable session handle
together. `@path` is deliberately not a parser-side expansion: Tab completes
the path locally, then the model sees it as a reference and uses `read` visibly.
Elapsed phase/tool/turn timing is also TUI-owned; it needs no agent-protocol or
tool changes, and completed turn timings persist as ordinary display blocks.

## Message types

- `user` — your prompt
- `assistant` — model output (text and/or tool_calls)
- `tool` — a tool result, tied to a tool call via `tool_call_id`

## Why it's small

The loop stays small enough to read in one sitting. Everything else is support.
Keeping it compact means a single person (or an agent) can hold the whole thing
in their head — which is exactly what makes self-updating safe.
