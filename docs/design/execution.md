# Execution qualification

Work IDs E1–E3. The implemented outcome and coordinator flow live in
[architecture](../architecture.md), shell behavior in [tools](../tools.md), and
checkpoint, ownership, and recovery rules in [sessions](../sessions.md).
[The prior design](../archive/execution-design-through-2026-09-27.md) preserves
its reasoning and full acceptance proposal. Current limitations are tracked in
[GAPS.md](../../GAPS.md); [NEXT_STEPS.md](../../NEXT_STEPS.md) owns priority.

## E2 — Shell lifecycle

Qualify the supervised process across zero and nonzero exits, stdout and stderr
floods, split UTF-8, timeout, cancellation, ignored SIGTERM, inherited pipes,
cwd changes, and artifact-write failure. Check that each result distinguishes
exit status, termination, output completeness, and known cwd. Confirm that no
owned descendants remain after cleanup; detached descendants are outside that
guarantee. Exercise the live preview and cancellation in real terminals used by
supported users.

## E3 — Checkpoint and recovery boundaries

Inject process death before and after run start, assistant-call persistence,
intent persistence, the tool effect, result persistence, and run end. Compare
recovered messages, call/result pairing, cwd, usage, and evidence with the
acknowledged prefix. An intent without a result must remain execution-uncertain;
a saved result must not run again on continuation.

Also test disk-full and permission failures at those writes; torn tails, interior
gaps, duplicate sequences, and reused provider IDs; competing writers; legacy
turns; and rename, delete, and pruning with linked artifacts. Process-kill tests
show crash recovery, not power-loss durability. Recheck directory-sync behavior
on each supported filesystem before making a stronger durability claim.

Use named compatible providers to qualify continuation protocol behavior before
claiming support beyond the local mock provider. Report live and offline evidence
separately in [PROGRESS.md](../../PROGRESS.md).
