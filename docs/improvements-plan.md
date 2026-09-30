# Future implementation briefs

Status: **U0/E1–E3/I1–I2/C1 first slice/V1 core implemented; E0 named baseline
and tool-contract comparison recorded, broader qualification pending; P1 gated**. Actual verification
is recorded in [PROGRESS.md](../PROGRESS.md). Read
[product direction](product-direction.md) for selected D1–D6 decisions and
[conventions](conventions.md) for engineering rules. [NEXT_STEPS.md](../NEXT_STEPS.md)
owns ordering; [GAPS.md](../GAPS.md) owns current limitations. This index owns stable
work IDs, dependencies, and session boundaries; linked designs own their details.

| ID | Bounded deliverable | Dependencies | Detailed scope and acceptance |
| --- | --- | --- | --- |
| U0 | Linked install guide and read-only CLI diagnostics | None | Implemented: [README](../README.md) |
| E0 | Reproducible coding tasks and baseline measurement | None | Named measurement and comparison recorded in [PROGRESS](../PROGRESS.md); remaining qualification: [Evaluation](design/evaluation.md) |
| E1 | Shared outcome model and per-request accounting | None | Implemented contract: [architecture](architecture.md), [sessions](sessions.md) |
| E2 | Supervised shell lifecycle and bounded output | E1 | Implemented, qualification pending: [Execution](design/execution.md) |
| E3 | Durable checkpoints, writer ownership, recovery | E1; E2 for shell recovery integration | Implemented core, broader crash matrix pending: [Sessions](sessions.md) |
| I1 | Explicit stop/continue in TUI and headless | E1, E2, E3 | Implemented core; local mock real-TTY check passed, live-provider checks pending: [Interaction](interrupt-resume.md) |
| I2 | Persisted steering at safe boundaries | I1 | Implemented core, broader race checks pending: [Interaction](interrupt-resume.md) |
| C1 | Bounded context projection with provenance | E1; E3 for persisted revisions; E0 for semantic comparison | Deterministic between-run slice implemented: [Context](design/context.md) |
| V1 | Verification evidence and accurate handoff | E1, E3; E0 fixtures | Optional exact-check ledger implemented, qualification pending: [Evidence](design/evaluation.md) |
| P1 | One bounded compatible-model fallback | E0, E1, E3; measured need | [Providers](design/providers.md) |

Dependencies express contracts, not a command to add speculative features. E0
has preserved named measurements; compare follow-ups within their recorded limits.
C1's deterministic between-run slice is shipped; semantic and mid-run reduction
need comparative evidence.
The other implemented cores still need the qualification listed in their designs.

## How to commission a future session

Use the ID with a qualification boundary. Examples:

- **E0:** “Run three trials of each coding fixture against the named provider;
  record raw results, usage, and failure categories. Confirm the expected API
  cost before spending credits.”
- **E2–E3:** “Inject a process crash before and after every intent/result sync,
  test disk-full and permission failure, and exercise owned-child cleanup in a
  real terminal. Separate proven recovery from uncertain side effects.”
- **I1–I2:** “Run the stop, approval-steer, completion-race, restart, and continue
  matrix in a real TTY and against explicitly named compatible endpoints.”
- **C1:** “Use old-constraint and retrieval fixtures to compare repeated bounded
  revisions; admit semantic reduction only with measured gains.”
- **V1:** “Challenge check freshness and handoff claims with dirty worktrees,
  concurrent edits, ignored dependencies, and misleading model prose.”
- **P1:** “Review observed provider failures first; implement bounded fallback
  only if its documented admission gate is met.”

For a verified reference checkpoint, explicitly request a commit and a new annotated
baseline tag under [conventions](conventions.md). Do not move an existing tag. A
design ID is a stable discussion reference, not a release or a claim of completion.

## Completion discipline

Each session should deliver one usable capability or a clearly gated intermediate
slice. Before implementation, resolve only decisions that affect that slice. Keep
unrelated proposals pending. Where a brief changes the implemented contract, move
the authoritative behavior into architecture/tools/sessions/README and replace the
proposal details with a pointer; do not maintain two competing descriptions.

Every delivery includes observable acceptance tests, `npm run verify`, documentation
updates, and a truthful progress entry. Live provider and terminal claims require
their corresponding checks. Schedule estimates should follow actual scope discovery;
these briefs do not promise an arbitrary number of hours or sessions.

The [original audit](archive/improvements-plan-2026-09-24.md) and
[superseded continuation proposal](archive/interrupt-resume-2026-09-24.md) are frozen
history. Current implementation status is recorded in [PROGRESS.md](../PROGRESS.md).
