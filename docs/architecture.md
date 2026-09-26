# Architecture

Argus separates model requests, local execution, persistence, and presentation.
[AGENTS.md](../AGENTS.md) is the module map; [conventions.md](conventions.md)
defines dependency boundaries and checks.

## Turn execution

```text
CLI → TUI or headless → runTurn
                         │
                         ├─ project bounded prior context with provenance
                         ├─ build and measure request → model step → HTTP/SSE
                         ├─ checkpoint → validate → authorize → checkpoint intent
                         ├─ execute tools sequentially → checkpoint results
                         └─ apply persisted steering at safe boundaries
```

`src/agent.mjs` coordinates the turn. Its supporting modules in `src/agent/`
own model-step retries, tool dispatch, result bounds/spill files, pure turn
bookkeeping, usage aggregation, and task check evidence. None imports a frontend
or session storage. The host supplies awaited run-start, checkpoint, and context
revision callbacks. A persistence failure stops dependent effects.
The coordinator returns one run result with `outcome` (`completed`,
`interrupted`, `truncated`, `failed`, or `limited`), a stable `reason`, human
`message`, messages, partial text/reasoning, cwd, display usage, and request/tool
attempt records plus optional check evidence and context revision. `completed`
means the model ended normally, not that the task is
correct. Operational endings return this result; unexpected programming errors
still throw with completed turn state for the frontends to preserve.

`src/llm.mjs` owns HTTP requests, timeout/retry behavior, provider cache markers,
and streaming. `src/sse.mjs` owns pure SSE framing and delta assembly. A request
body is built once, measured before network I/O, then passed to the transport.
POST retries and pre-content stream retries have separate ownership. Once visible
text or reasoning has streamed, the step is not replayed automatically.
Each network attempt gets a local ID. Its reported usage remains attached to
that attempt; missing usage stays unknown. Model steps and tool attempts also
have run-scoped local IDs, separate from provider tool-call IDs.

Requests ask the provider for one tool call. Providers that return a batch are
accepted and executed sequentially. Truncated replies are retained with a flag;
their tool calls receive explicit unexecuted results and never run. Every
completed or failed turn keeps assistant/tool pairing intact. Step limits reserve
a follow-up model response; repeated unchanged calls and alternating no-progress
cycles are bounded. Exact tool guarantees belong in [tools.md](tools.md).
Observed partial text is retained once on interruption or stream failure;
incomplete tool arguments are not executed. Local `partial`/`truncated` message
metadata is removed from outgoing provider requests.
Persisted steering is consumed after a completed model response or tool result,
before the next tool dispatch. Obsolete calls get local `not_executed` results;
the accepted correction becomes a new user message in the linked run. A final
reply that wins the race leaves steering as a visible next-turn draft.

## Tools and filesystem boundaries

`src/tools.mjs` owns the registry. It delegates shell approval classification,
supervised execution, recursive schema validation, and atomic file replacement to
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
`tool_output`, `steering`, `usage`, `request_attempt`, `request_usage`, `approval`, `compacted`, and
`retrying` events. `transcript.mjs` owns the
shared projection of relevant events into persisted display blocks. `format.mjs`
owns labels, previews, durations, and usage formatting.

`MinimalTui` owns application state and wires components together:

- `tui/input.mjs` decodes raw input and dispatches editor/scrolling actions;
  `keys.mjs` handles terminal escape sequences and `editor.mjs` owns the buffer.
- `tui/turn.mjs` drives one submitted turn, updates live state, and saves its
  messages and display blocks. `commands.mjs` handles local commands including
  continuation, steering inspection, and optional check designation.
- `blocks.mjs`, `markdown.mjs`, and `renderers.mjs` turn content into terminal
  lines; `frames.mjs` and `layout.mjs` assemble the frame.
- `lifecycle.mjs` owns terminal setup, render clocks, theme detection, and exit.

Per-block rendering is cached by identity, text, width, and theme revision. The
assembled transcript is cached until a block mutation, width change, or theme
change. Non-text block fields are immutable once a block is inserted. Raw terminal
I/O remains in the frontend; tests can exercise state and rendering without a TTY.

Headless mode uses the same agent and block projector, sending assistant text to
stdout and operational output to stderr. It supports named-session persistence.
Both frontends show the normalized terminal outcome. Headless exits zero only
for normal model completion, 130 for user interruption, and 1 for failed,
truncated, or limited runs. Designated check outcomes render separately from
model prose; no check is inferred merely from a shell command.

## Sessions and configuration

All external session callers import `src/session/index.mjs`. Inside the package:
`paths.mjs` owns names/private directories, `catalog.mjs` owns discovery and
housekeeping, `reader.mjs` scans records, `journal.mjs` folds crash prefixes,
`ownership.mjs` protects writers, `context.mjs` publishes source artifacts,
`store.mjs` serializes and syncs appends, `data.mjs` reconstructs frontend state,
and `resume.mjs` selects a folder match.
The format, recovery policy, compatibility, and writer limitations are owned by
[sessions.md](sessions.md).

Configuration is resolved after dotenv loading: process environment, project
`.env`, home `.env`, then built-in fallbacks. Paths are resolved lazily.
[.env.example](../.env.example) documents variables and defaults.

## Context and usage

Prior turns project through a bounded deterministic revision before a new run.
The revision records a covered source range/hash and retains recent logical runs
verbatim. It is sent as lower-trust assistant data, never promoted into the
system prompt. A private indexed artifact lets the existing `read` tool retrieve
omitted source detail. Real provider usage drives the trigger once available;
measured characters provide the fallback. Per-result, active-turn, and full
request limits bound further growth. The digest is lossy and is not an exact
request replay or semantic guarantee. Mid-run reduction remains open.

Turn display usage keeps the largest reported prompt and sums completion/reasoning
counts across steps. Cached counts use the largest reported share. These are
context/output display metrics, not billing totals for repeated requests. The
request ledger separately sums reported counts from each actual request attempt;
missing reports remain unknown and totals do not estimate charges. The footer
uses the latest provider prompt count available; compaction uses the previous
turn's display usage through `nextContextTokens()`.
