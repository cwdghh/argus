# Context qualification

Work ID C1. [Architecture](../architecture.md) owns the implemented bounded
between-run projection; [sessions](../sessions.md) owns persisted revisions and
source artifacts. [The prior design](../archive/context-design-through-2026-09-27.md)
retains its full algorithm proposal. Current limits are in [GAPS.md](../../GAPS.md).

## Remaining decisions

The deterministic digest can omit an early constraint. Evaluate whether the
model retrieves omitted detail from the indexed source artifact and honors
changed decisions after repeated reductions. Keep the digest lower-trust than
current user instructions; source text and tool output must never become system
instructions or implied authorization.

A semantic summary is a separate optional model request with its own cost,
usage, timeout, cancellation, and validation. Admit it only if repeated E0 tasks
show better constraint retention than the deterministic digest. Mid-run
reduction needs its own boundary and pairing checks; it must never split an
unresolved assistant call/result batch. If pinned current material alone exceeds
the request cap, stop with an explicit limit instead of silently dropping it.

## Acceptance to qualify

Use old constraints, superseded decisions, failed tool calls, unsaved edits, very
large individual messages, steering, reused call IDs, and uncertain execution.
Check bounded outgoing payloads, stable source hashes and reload, valid
call/result pairs, artifact retrieval and deletion, missing artifacts, and disk
failure during publication. Compare actual task outcomes and provider usage;
structural cap tests alone do not prove that the model remembered an instruction.
Measure source-artifact growth in long sessions before setting a size policy.
