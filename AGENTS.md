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
| `src/llm.mjs` | OpenAI-compatible chat client (streaming only) |
| `src/tools.mjs` | Tool schemas + implementations |
| `src/compact.mjs` | Context compaction |
| `src/session.mjs` | JSONL session persistence (also shared session helpers) |
| `src/headless.mjs` | One-shot CLI mode (no TUI) |
| `src/tui.mjs` + `src/tui/*.mjs` | Terminal UI (controller + pure renderers / editor / keys / suggestions / frames / help) |
| `src/theme.mjs` | Colors / styling tokens |
| `src/config.mjs` | Env-driven config |
| `docs/` | Architecture, tool contract, self-updating guide |
| `PROGRESS.md` | What we've done (append on real change) |
| `GAPS.md` | Open design questions |

## The one rule

**Stay minimal.** Prefer a small, clear change over a clever or large one. If a
change adds a tool, a dependency, or a new concept, the docs that describe it must
be updated in the same change. See `docs/self-updating.md` for the workflow.

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
