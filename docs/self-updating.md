# Self-updating workflow

Argus can change its own code. Small reviewable changes, mechanical verification,
and accurate records keep that process inspectable. The project rule and hard
constraints live in [AGENTS.md](../AGENTS.md); coding, testing, commit, and tag
conventions live in [conventions.md](conventions.md).

## Bootstrap reading order

Before changing the repository:

1. [AGENTS.md](../AGENTS.md) — constraints and module map.
2. This file — workflow and fact ownership.
3. [architecture.md](architecture.md) — responsibilities and data flow.
4. [tools.md](tools.md) and [tool-surface.md](tool-surface.md) — contract and design.
5. [conventions.md](conventions.md) — how to implement and verify changes.
6. [improvements-plan.md](improvements-plan.md) and [NEXT_STEPS.md](../NEXT_STEPS.md)
   — the current execution brief and ranked next actions.

Then read [GAPS.md](../GAPS.md), [PROGRESS.md](../PROGRESS.md),
[sessions.md](sessions.md), or [debug-tool-failures.md](debug-tool-failures.md) as
needed. Archived documents are historical evidence, not current instructions.

## Fact ownership

Each fact has one owner. Other documents link to it; they must not maintain
competing defaults, status narratives, file maps, or roadmaps.

| Fact | Owner |
| --- | --- |
| Project rule, constraints, module map | `AGENTS.md` |
| User-facing operation | `README.md` |
| Environment defaults and behavior | `.env.example` and owning configuration code |
| Module relationships and data flow | `docs/architecture.md` |
| Code, tests, commits, tags | `docs/conventions.md` |
| Tool names, schemas, and runtime behavior | `docs/tools.md` |
| Tool-surface design and admission rule | `docs/tool-surface.md` |
| Session records, compatibility, and recovery | `docs/sessions.md` |
| Diagnosing saved failures | `docs/debug-tool-failures.md` |
| This workflow and ownership table | `docs/self-updating.md` |
| Dated change history and actual verification | `PROGRESS.md` |
| Current design questions and limitations | `GAPS.md` |
| Ranked next actions | `NEXT_STEPS.md` |
| Implementation scope and acceptance for the next work | `docs/improvements-plan.md` |
| Proposed interrupt/continue interaction | `docs/interrupt-resume.md` |

## Change workflow

1. Read the owners above and inspect relevant code/tests. State the scope and
   preserve unrelated user work. Use pi only as a conceptual reference; do not
   copy its implementation wholesale.
2. Implement cohesive changes with regression tests where behavior changes.
   Refactor along actual responsibilities, not a line-count target.
3. Update the owning docs in the same change. A new concept must have an owner;
   link to it from the discovery documents. Keep proposed behavior distinct from
   implemented behavior.
4. Run `npm run verify`. For changed tools, exercise their observable behavior
   directly; suitable direct tool tests count. Use provider evaluation or a real
   TTY only when required for the claim being made. Record unavailable checks.
5. Prepend a dated `#### YYYY-MM-DD` entry below the `PROGRESS.md` introduction
   using ✅ done, 🚧 in progress, or ⏳ planned. List changes, behavior corrections,
   and checks actually run. Update open questions and next actions when affected.
6. Review the diff. Follow the review/commit authorization rule in `AGENTS.md`
   and the tagging convention in `docs/conventions.md`.

Passing offline tests does not establish live-provider quality, terminal behavior
on every emulator, CI success, or production readiness. Describe those limits
without marking unperformed checks complete.

## Records and archives

Never rewrite a historical progress entry to correct it. Add a new dated
correction describing what was inaccurate. Existing archive contents stay frozen.
When changing a path or section, update all live references to it; frozen archive
references remain as originally recorded.

Keep living documents small. When history makes a file grow past roughly 400
lines, copy the superseded material verbatim into a new file under `docs/archive/`
and leave a pointer. This archival move is the sole exception to keeping old
progress text in the live file. Add the new archive to its index; do not edit
existing archived narratives. Superseded one-time plans can be archived even
when they contain deferred items, provided those items remain in the live plan.

Never commit `.env`, secrets, session transcripts, test outputs, or downloaded
reference code. Preserve the existing history when creating a new baseline tag.
