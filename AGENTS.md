# AGENTS.md — working with argus

This file is for humans **and** for agents (like argus itself) that maintain this
repo. It is intentionally short; details live in `docs/`.

## What argus is

A minimal terminal coding agent. It is a small tool-calling loop around a language
model. The default tool set is deliberately tiny: `read`, `write`, `edit`, `bash`.

## Where things live

| Path | Purpose |
|------|---------|
| `src/main.mjs` | Entry point / CLI |
| `src/agent.mjs` | The agent loop (call model → run tools → repeat) |
| `src/llm.mjs` | Streaming chat client: network, retries, timeouts |
| `src/sse.mjs` | Pure SSE framing + chat-delta folding (protocol layer of `llm.mjs`) |
| `src/tools.mjs` | Tool registry + fs/shell execution layer (`read`, `write`, `edit`, `bash`) |
| `src/edit-engine.mjs` | Pure exact/fuzzy/range text-edit engine |
| `src/read-bounds.mjs` | Read line/byte caps + truncation |
| `src/compact.mjs` | Context compaction |
| `src/session/` | JSONL session persistence: `store.mjs` (fs + writable handle), `resume.mjs` (folder-scoped default), `data.mjs` (reconstruction) — import from `index.mjs` |
| `src/headless.mjs` | One-shot CLI mode (no TUI) |
| `src/tui.mjs` + `src/tui/*.mjs` | Terminal UI: controller + pure widgets (editor, keys, suggestions, frames, markdown, blocks, commands, layout, lifecycle) |
| `src/format.mjs` | Neutral value formatting (durations, tokens, result summaries) |
| `src/transcript.mjs` | Shared transcript block folding (used by TUI + headless) |
| `src/theme.mjs` | Colors / styling tokens |
| `src/config.mjs` | Env-driven config |
| `docs/` | Architecture, tool contract, self-updating guide, refactor plan |
| `PROGRESS.md` | What we've done (append on real change) |
| `GAPS.md` | Open design questions |

## The one rule

**Clarity and quality over compactness.** Prefer code that is easy to read,
well-named, and organised around clear boundaries — even when that means more
files — over squeezing everything into the fewest possible files. Two
constraints stay: the default tool set stays minimal (`read`, `write`, `edit`,
`bash`), and the runtime stays dependency-free. If a change adds a tool, a
dependency, or a new concept, the docs that describe it must be updated in the
same change. See `docs/self-updating.md` for the workflow.

## How to run

```bash
cp .env.example .env   # set ARGUS_API_KEY
npm start
```

## How to add a tool (in 30 seconds)

In `src/tools.mjs`, add one object to the `tools` array:

```js
{
  name: "my_tool",
  description: "One or two sentences: when to use it, what it does.",
  parameters: { type: "object", properties: {...}, required: [...] },
  async execute(args) { ... return a JSON-serialisable value ... },
}
```

That's it — the loop and TUI pick it up automatically. Update `docs/tools.md`
and the tool list in this file if you want it to be a default.
