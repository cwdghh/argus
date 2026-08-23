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
| `docs/` | Architecture, tool contract, tool-surface tracker, self-updating guide |
| `docs/archive/` | Frozen history & executed one-time plans (read only when needed) |
| `PROGRESS.md` | What we've done (append on real change) |
| `GAPS.md` | Open design questions |
| `NEXT_STEPS.md` | Candidate next directions, ranked by impact |

> **Agent docs (read before you work on argus itself):**
> `docs/self-updating.md` — the contract for how argus changes argus (fact
> ownership, the verify/record workflow, boundaries); `docs/architecture.md` —
> how the code fits together; `docs/tools.md` — the tool contract;
> `docs/tool-surface.md` — the canonical tool-set discussion. README is
> the user-facing view; `PROGRESS.md`/`GAPS.md`/`NEXT_STEPS.md` are the
> current state. See `docs/self-updating.md` for the bootstrap reading order.

## The one rule

**Clarity and quality over compactness.** Prefer code that is easy to read,
well-named, and organised around clear boundaries — even when that means more
files — over squeezing everything into the fewest possible files. Two
constraints stay: the default tool set stays minimal (`read`, `write`, `edit`,
`bash`), and the runtime stays dependency-free. If a change adds a tool, a
dependency, or a new concept, the docs that describe it must be updated in the
same change. See `docs/self-updating.md` for the workflow.

## PREREQUISITES

- **One fact, one owner.** `docs/self-updating.md` keeps the fact-ownership
  table: history lives in `PROGRESS.md` (pointers only elsewhere), current
  design state lives in `GAPS.md`, next actions in `NEXT_STEPS.md`, tool
  contract in `docs/tools.md`, defaults in `.env.example`. A fact that appears
  in two files at once is a bug — turn the duplicate into a pointer.
- **Never edit `PROGRESS.md` in place.** Append dated entries, newest first;
  add a dated correction note if one turns out wrong. An argus that rewrites
  its own history can't be trusted to review its own work.
- **The human reviews and commits.** Verification actually runs in this
  session is listed in the PROGRESS entry; claims beyond that are wishes, not
  statuses. See `docs/self-updating.md`.

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
