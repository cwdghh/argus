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
  calls. (Policy is intentionally simple; see `GAPS.md` for richer options.)

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

## Message types

- `user` — your prompt
- `assistant` — model output (text and/or tool_calls)
- `tool` — a tool result, tied to a tool call via `tool_call_id`

## Why it's small

The core loop is ~50 lines. Everything else is support. Keeping it small means a
single person (or an agent) can hold the whole thing in their head — which is
exactly what makes self-updating safe.
