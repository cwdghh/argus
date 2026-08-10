# Self-updating: how argus changes argus

argus can modify its own source. The goal is to make that safe and predictable.
Any agent (argus itself, or a human) should be able to follow this workflow.

## Principles

1. **Small, localised changes.** Prefer editing one file over rewiring several.
2. **Docs travel with code.** A change that adds a tool, a dependency, or a
   concept updates the matching docs in the same change.
3. **Verify before declaring done.** Run a real (or mock) end-to-end test.
4. **Record the change.** Append to `PROGRESS.md`.

## The workflow

1. **Read the docs first.** `AGENTS.md` (rules), `docs/architecture.md` (how it
   fits together), `docs/tools.md` (tool contract).
2. **Make the change.** Use `read` to inspect, `edit`/`write` to change, `bash`
   to run checks.
3. **Update docs in the same change.** If you touched behavior, update the
   relevant doc and `AGENTS.md`'s file map.
4. **Verify.**
   - `node --check src/*.mjs` — syntax.
   - Run a mock-LLM test (`test/stream-loop.test.mjs` if present, or a local SSE
     stub) to confirm the loop still terminates and tool results flow.
   - If you changed tools, exercise each one directly.
5. **Record.** Append a dated entry to `PROGRESS.md`; update `GAPS.md` if you
   resolved an open question.

## Boundaries

- **Never** commit secrets (`.env` is gitignored).
- **Don't** copy code wholesale from `references/pi` — argus has its own
  character. Use pi only as a conceptual reference.
- **Default tool set stays minimal** (`read`, `write`, `edit`, `bash`). New tools
  must earn their place; document the reason.
