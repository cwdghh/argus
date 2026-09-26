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
| `src/agent.mjs` | Turn coordinator (call model → run tools → repeat) |
| `src/agent/` | `model-step.mjs` (stream retry), `tool-call.mjs` (dispatch), `tool-result.mjs` (bounds/spill), `turn-state.mjs` (protocol/loop guards), `usage.mjs` (accounting), `evidence.mjs` (task checks) |
| `src/llm.mjs` | Streaming chat client: network, retries, timeouts |
| `src/sse.mjs` | Pure SSE framing + chat-delta folding (protocol layer of `llm.mjs`) |
| `src/tools.mjs` | Model-visible tool registry and file-tool adapters |
| `src/tools/` | `bash.mjs` (shell policy), `shell-process.mjs` (supervised execution), `validate.mjs` (schema validation), `atomic-write.mjs` (file replacement) |
| `src/edit-engine.mjs` | Pure exact/fuzzy/range text-edit engine |
| `src/read-bounds.mjs` | Bounded-memory file scanning + read line/byte caps |
| `src/tool-state.mjs` | Same-turn read coverage/hash state for safe range edits |
| `src/compact.mjs` | Context compaction |
| `src/session/` | `paths.mjs` (naming), `catalog.mjs` (discovery/housekeeping), `reader.mjs` (streaming loads), `journal.mjs` (crash prefixes), `ownership.mjs` (single writer), `context.mjs` (source artifacts), `store.mjs` (writer), `resume.mjs` (folder matching), `data.mjs` (reconstruction) — import from `index.mjs` |
| `src/headless.mjs` | One-shot CLI mode (no TUI) |
| `src/tui.mjs` + `src/tui/*.mjs` | Terminal UI: controller; input/turn orchestration; editor, keys, suggestions, frames, markdown, blocks, commands, layout, lifecycle |
| `src/format.mjs` | Neutral value formatting (durations, tokens, result summaries) |
| `src/transcript.mjs` | Shared transcript block folding (used by TUI + headless) |
| `src/theme.mjs` | Colors / styling tokens |
| `src/config.mjs` | Env-driven config |
| `src/doctor.mjs` | Read-only CLI installation diagnostics |
| `docs/` | Architecture, tool contract, tool-surface decisions, self-updating guide, debugging saved sessions |
| `docs/improvements-plan.md` | Stable work IDs, dependencies, and future-session briefs — read before new work |
| `docs/product-direction.md` | Selected product direction and decision ledger |
| `docs/design/` | Proposed execution, context, evaluation/evidence, and provider designs |
| `docs/conventions.md` | Code, testing, commit, and reference-tag conventions |
| `docs/sessions.md` | Session record format, compatibility, and recovery |
| `scripts/` | Offline repository checks and isolated test runner |
| `eval/` | Opt-in provider evaluations; coding fixtures also have offline scoring tests |
| `.github/workflows/verify.yml` | CI verification matrix |
| `docs/archive/` | Frozen history & executed one-time plans (read only when needed) |
| `PROGRESS.md` | What we've done (append on real change) |
| `GAPS.md` | Open design questions |
| `NEXT_STEPS.md` | Candidate next directions, ranked by impact |

> **Agent docs (read before you work on argus itself):**
> `docs/self-updating.md` — the contract for how argus changes argus (fact
> ownership, the verify/record workflow, boundaries); `docs/architecture.md` —
> how the code fits together; `docs/tools.md` — the tool contract;
> `docs/tool-surface.md` — the canonical tool-set decisions and rationale;
> `docs/conventions.md` — engineering conventions; `docs/sessions.md` — session
> records and recovery; `docs/debug-tool-failures.md` — how to find tool failures in saved session
> transcripts. README is
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
- **The human reviews and commits by default.** An explicit request to commit
  or tag the finished outcome authorizes that local action. List verification
  actually run in the PROGRESS entry; claims beyond that are not statuses.
  See `docs/self-updating.md` and `docs/conventions.md`.

## How to run

```bash
cp .env.example .env   # set ARGUS_API_KEY
npm start
```

## How to change the tool registry

Prefer refining an existing tool; `docs/tool-surface.md` defines the evidence
required for a fifth default. Registry objects in `src/tools.mjs` look like:

```js
{
  name: "my_tool",
  risk: "read-only", // or filesystem-write / shell; not shown to the model
  description: "One or two sentences: when to use it, what it does.",
  parameters: {
    type: "object",
    properties: {...},
    required: [...],
    additionalProperties: false,
  },
  validate(args) { ... return null or an error string ... }, // optional
  approval(args) { ... return null or an approval reason ... }, // optional
  async execute(args, context) { ... return a JSON-serialisable value ... },
}
```

The loop and TUI pick it up automatically. Update `docs/tools.md`, the surface
decision, tests, and the tool list here in the same change.
