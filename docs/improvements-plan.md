# Future implementation briefs

Status: **E1 implemented; remaining work IDs are proposals**. Actual verification
is recorded in [PROGRESS.md](../PROGRESS.md). Read
[product direction](product-direction.md) for pending D4–D6 decisions and
[conventions](conventions.md) for engineering rules. [NEXT_STEPS.md](../NEXT_STEPS.md)
owns ordering; [GAPS.md](../GAPS.md) owns current limitations. This index owns stable
work IDs, dependencies, and session boundaries; linked designs own their details.

| ID | Bounded deliverable | Dependencies | Detailed scope and acceptance |
| --- | --- | --- | --- |
| E0 | Reproducible coding tasks and baseline measurement | None | [Evaluation](design/evaluation.md) |
| E1 | Shared outcome model and per-request accounting | None | Implemented contract: [architecture](architecture.md), [sessions](sessions.md) |
| E2 | Supervised shell lifecycle and bounded output | E1 | [Execution](design/execution.md) |
| E3 | Durable checkpoints, writer ownership, recovery | E1; E2 for shell recovery integration | [Execution](design/execution.md) |
| I1 | Explicit stop/continue in TUI and headless | E1, E2, E3 | [Interaction](interrupt-resume.md) |
| I2 | Persisted steering at safe boundaries | I1 | [Interaction](interrupt-resume.md) |
| C1 | Bounded context projection with provenance | E1; E3 for persisted revisions; E0 for semantic comparison | [Context](design/context.md) |
| V1 | Verification evidence and accurate handoff | E1, E3; E0 fixtures | [Evidence](design/evaluation.md) |
| P1 | One bounded compatible-model fallback | E0, E1, E3; measured need | [Providers](design/providers.md) |

Dependencies express contracts, not a command to complete every feature. E0 grows
fixtures as capabilities arrive. E3 is the largest change: deliver schema/reader,
writer/ownership, and coordinator integration as separately reviewed slices.
C1 starts between runs; semantic and mid-run reduction are later slices with their
own evidence. I2 should handle acceptance races before adding keyboard shortcuts.

## How to commission a future session

Use the ID with a concrete boundary. For example:

> Implement E2 from docs/improvements-plan.md. Re-read the current code and linked
> design, preserve the four-tool surface and existing session compatibility, and
> limit this session to supervised shell execution. Run the required verification,
> update owning contracts and progress, and report remaining limits.

Other bounded requests:

- **E0:** “Build the initial offline scoring fixtures and opt-in live runner. Do
  not spend API credits without my instruction; report which baseline measurements
  still require a live run.”
- **E2:** “Implement supervised shell cancellation and output bounds. Verify owned
  child cleanup on supported hosts and report actual platform limits.”
- **E3, slice 1:** “Finalize journal record examples and implement backward-compatible
  readers with crash-prefix fixtures. Keep new writing disabled until integration.”
- **E3, remaining slices:** “Implement ownership, checkpoint writes, and recovery
  integration from the accepted schema. Run crash-injection and competing-writer tests.”
- **I1:** “Implement explicit interruption and continuation from the accepted design.
  Verify restart and both frontends; distinguish mocked, real-TTY, and live-provider checks.”
- **I2:** “Implement explicit persisted steering, including pending-approval and
  run-completion races. Preserve normal draft behavior.”
- **C1, first slice:** “Implement bounded deterministic between-run context revisions
  with provenance and retrieval. Defer semantic and mid-run reduction.”
- **V1:** “Implement evidence recording and handoff reporting, including stale checks
  and pre-existing changes. Do not add mandatory automatic checks.”
- **P1:** “Review observed provider failures first; implement the bounded fallback
  only if the documented admission gate is met.”

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
