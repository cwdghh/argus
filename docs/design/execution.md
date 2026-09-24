# Execution outcomes and recoverable progress

Status: **E1 implemented; E2–E3 proposed**. This file owns the future shell and
checkpoint designs. The implemented E1 result and accounting contract lives in
[architecture.md](../architecture.md) and [sessions.md](../sessions.md).
Interaction belongs in [interrupt-resume.md](../interrupt-resume.md).

## E1 — Honest outcomes and request accounting

Implemented in the coordinator, transport, both frontends, and additive timing
metadata. The current contract is in [architecture.md](../architecture.md) and
[sessions.md](../sessions.md). E1 does not add checkpoints: a crash can still
lose the active turn, and a run that completed but failed to save has separate
persistence health. E2–E3 below address execution and recovery boundaries.

## E2 — Shell lifecycle and output

Replace buffered `exec` with a supervised `spawn` implementation using the
existing shell/command contract. Separate four facts: exit status, termination
reason, captured output completeness, and known working directory. Example:

```js
{
  exitCode: null, signal: "SIGTERM", termination: "cancelled",
  stdout: "…", stderr: "…", outputTruncated: true,
  artifact: null, cwd: null,
}
```

Zero exit with a bounded preview is different from termination caused by an
output limit. Never label an unknown exit successful. Preserve available output
on cancellation and timeout. Decode chunks safely across UTF-8 boundaries; stdout
and stderr order is observable arrival order, not a guaranteed global ordering.

On supported POSIX hosts, create an owned process group, request termination,
then escalate after a bounded grace period. Await close or a bounded cleanup
failure; detached grandchildren can escape ownership and must not be claimed
terminated. Do not signal a process discovered only by an old PID after restart.
Unsupported platforms report their actual cleanup guarantee. This is lifecycle
control, not a sandbox.

Keep bounded in-memory previews and optional private output artifacts. Bound
artifact bytes and UI update rate separately. At the artifact limit, continue
draining and discard excess bytes with a visible truncation flag, unless a
separately documented execution policy explicitly requires termination. An
artifact-write failure must not deadlock a full pipe. Preserve cwd only from a
valid completion marker; interrupted commands may leave it unknown.

Acceptance: commands with nonzero/zero exits; stdout and stderr floods; split
Unicode; timeout; cancellation; ignored SIGTERM; a child inheriting pipes; a cwd
change; disk-write failure; cancellation during escalation. Tests use isolated
temporary processes and verify they leave no owned descendants. A real TTY check
is needed for live output presentation, separately from process tests.

## E3 — Checkpoints and recovery

Introduce a narrow awaited checkpoint callback supplied by the host. The agent
must not import session storage. Rendering deltas remain lightweight events;
checkpoint persistence has explicit backpressure and error handling. Avoid a
generic event bus or duplicated frontend journal writers.

Proposed records: `run_start`, `checkpoint`, `run_end`, each versioned and carrying
run ID plus a monotonically increasing sequence. A checkpoint can carry a completed
assistant step, a partial text snapshot, tool intent, or tool result. Use bounded
per-step snapshots/deltas rather than writing an ever-growing whole transcript.
The exact schema is finalized in E3 and then becomes owned by `sessions.md`.

Required ordering for tool execution:

1. Persist and sync the user instruction and normalized complete assistant call.
2. Persist and sync tool intent after validation/authorization, before invocation.
3. Invoke once in this process; capture result, cwd, and output references.
4. Persist and sync the tool result before any dependent tool/model step.

A persisted intent without a result means **execution uncertain**, even if the
process may have died before invocation. Arbitrary filesystem/shell effects and
the session journal are not one transaction. No exactly-once side-effect promise
is possible from these records alone. Known results are reused during recovery;
uncertain writes/shell commands require inspection and explicit user direction
before re-execution. Safe reads can be repeated as new attempts.

Partial text checkpoints should be bounded by both bytes and elapsed time.
Choose limits using E0 measurements; flush buffered text on cooperative stop.
Define the display's saved indicator by completed persistence acknowledgement.
Abrupt termination can lose text since that acknowledgement. Sync files at
execution boundaries; document platform/filesystem limits and directory-sync
handling for new files. Do not promise survival of every byte or every hardware
failure. A journaling failure stops new effects and leaves the host usable for
inspection/export; continuing without durable tracking is an explicit user choice.

Recovery folds only a verified contiguous record sequence for each journaled run.
A torn final record yields the prior valid prefix. Interior damage or a sequence
gap marks that run uncertain and blocks automatic continuation across the gap.
Keep legacy recovery behavior for legacy `turn` records; stricter new semantics
must not silently reinterpret old records as durable checkpoints.

Acquire exclusive writer ownership before mutating a session. A second writer
can inspect read-only but cannot append. Use local owner identity and a unique
token; release only one's own lock. Stale ownership recovery must account for
PID reuse and ambiguous liveness; never steal an uncertain active lease. Do not
claim network-filesystem coordination without testing it.

Migration: add an explicit new format version and reader support first. Fold
journaled runs once; do not count a legacy terminal snapshot plus checkpoints
twice. Keep legacy turns readable. Older binaries may omit newer records, so warn
against downgrade rather than claiming bidirectional compatibility. Session
rename/delete/retention must honor active ownership and linked output artifacts.

Acceptance: child-process crash injection before/after each persistence/effect
boundary; completion-before-result-write; disk full/permission failure; torn tail;
interior gap; duplicate sequence; reused provider IDs; two competing writers;
legacy fixture loads; reopen/continue without repeated known side effects.
Compare projected messages, evidence, cwd, and usage before and after restart.
Kill-injection tests demonstrate process-crash recovery, not power-loss durability.

## Delivery boundaries

E1 can ship independently. E2 can follow E1 without introducing persistence.
Split E3 into reader/schema fixtures, writer/ownership, and coordinator integration
if needed; each commit must be usable and pass existing verification. Keep new
records behind an explicit development gate until end-to-end recovery passes.
Do not ship a UI promise of recoverability before its persistence gate passes.
