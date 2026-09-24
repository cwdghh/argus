# Architecture

Argus separates model requests, local execution, persistence, and presentation.
[AGENTS.md](../AGENTS.md) is the module map; [conventions.md](conventions.md)
defines dependency boundaries and checks.

## Turn execution

```text
CLI → TUI or headless → runTurn
                         │
                         ├─ compact prior history
                         ├─ build and measure request → model step → HTTP/SSE
                         ├─ validate → authorize → execute tools sequentially
                         └─ append bounded results → next step or final answer
```

`src/agent.mjs` coordinates the turn. Its supporting modules in `src/agent/`
own model-step retries, tool dispatch, result bounds/spill files, pure turn
bookkeeping, and usage aggregation. None imports a frontend or session storage.
The coordinator returns messages, cwd, usage, and outcome flags; exceptions also
carry completed turn state so frontends can preserve work already performed.

`src/llm.mjs` owns HTTP requests, timeout/retry behavior, provider cache markers,
and streaming. `src/sse.mjs` owns pure SSE framing and delta assembly. A request
body is built once, measured before network I/O, then passed to the transport.
POST retries and pre-content stream retries have separate ownership. Once visible
text or reasoning has streamed, the step is not replayed automatically.

Requests ask the provider for one tool call. Providers that return a batch are
accepted and executed sequentially. Truncated replies are retained with a flag;
their tool calls receive explicit unexecuted results and never run. Every
completed or failed turn keeps assistant/tool pairing intact. Step limits reserve
a follow-up model response; repeated unchanged calls and alternating no-progress
cycles are bounded. Exact tool guarantees belong in [tools.md](tools.md).

## Tools and filesystem boundaries

`src/tools.mjs` owns the registry. It delegates shell execution and approval
classification, recursive schema validation, and atomic file replacement to
`src/tools/`. Pure edit matching/range resolution lives in `edit-engine.mjs`;
bounded file scanning lives in `read-bounds.mjs`.

The coordinator creates one `tool-state.mjs` freshness tracker per turn. Successful
reads record hashes and displayed line coverage. Range edits consume that evidence;
file mutations invalidate the path, and executed shell commands invalidate all
read evidence. Nothing restores freshness from persisted sessions.

The model sees tool names, descriptions, and schemas. Risk classification,
authorization callbacks, validation, and execution remain local. The shell policy
is a best-effort approval backstop, not process isolation. The canonical surface
and admission rule are in [tool-surface.md](tool-surface.md).

## Frontends

The agent emits `user`, `assistant_start`, `thinking_delta`, `text_delta`,
`assistant_stop`, `assistant_end`, `tool_call`, `tool_result`, `cwd_change`,
`usage`, `approval`, `compacted`, and `retrying` events. `transcript.mjs` owns the
shared projection of relevant events into persisted display blocks. `format.mjs`
owns labels, previews, durations, and usage formatting.

`MinimalTui` owns application state and wires components together:

- `tui/input.mjs` decodes raw input and dispatches editor/scrolling actions;
  `keys.mjs` handles terminal escape sequences and `editor.mjs` owns the buffer.
- `tui/turn.mjs` drives one submitted turn, updates live state, and saves its
  messages and display blocks. `commands.mjs` handles local commands.
- `blocks.mjs`, `markdown.mjs`, and `renderers.mjs` turn content into terminal
  lines; `frames.mjs` and `layout.mjs` assemble the frame.
- `lifecycle.mjs` owns terminal setup, render clocks, theme detection, and exit.

Per-block rendering is cached by identity, text, width, and theme revision. The
assembled transcript is cached until a block mutation, width change, or theme
change. Non-text block fields are immutable once a block is inserted. Raw terminal
I/O remains in the frontend; tests can exercise state and rendering without a TTY.

Headless mode uses the same agent and block projector, sending assistant text to
stdout and operational output to stderr. It supports named-session persistence.

## Sessions and configuration

All external session callers import `src/session/index.mjs`. Inside the package:
`paths.mjs` owns names/private directories, `catalog.mjs` owns discovery and
housekeeping, `reader.mjs` scans records, `store.mjs` serializes appends,
`data.mjs` reconstructs frontend state, and `resume.mjs` selects a folder match.
The format, recovery policy, compatibility, and writer limitations are owned by
[sessions.md](sessions.md).

Configuration is resolved after dotenv loading: process environment, project
`.env`, home `.env`, then built-in fallbacks. Paths are resolved lazily.
[.env.example](../.env.example) documents variables and defaults.

## Context and usage

Prior turns are compacted deterministically before a new turn. Real provider
usage drives the trigger once available; measured characters provide the fallback.
The recent turns remain verbatim and earlier summary text is carried forward.
This is a lossy digest, not a semantic summary or an exact request replay format.
Per-result, cumulative active-turn, and full-request limits bound further growth.
There is no mid-turn compaction yet.

Turn display usage keeps the largest reported prompt and sums completion/reasoning
counts across steps. Cached counts use the largest reported share. These are
context/output display metrics, not billing totals for repeated requests. The
footer uses the latest provider prompt count available; compaction uses the
previous turn's usage through `nextContextTokens()`.
