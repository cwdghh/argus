# Interaction qualification

Work IDs I1–I2. Commands and keyboard behavior are owned by the [README](../README.md);
run outcomes by [architecture](architecture.md); saved progress, steering, and
uncertain-effect resolution by [sessions](sessions.md). The
[replaced design](archive/interaction-design-through-2026-09-27.md) and its
[earlier proposal](archive/interrupt-resume-2026-09-24.md) remain available as
history. [GAPS.md](../GAPS.md) owns current limitations.

## Stop and continue

Test interruption before text, midword, during partial tool JSON, after a
complete call batch, mid-tool, between calls, and after the final result before
run-end persistence. On restart, verify exact-once display, valid tool pairs,
known-result reuse, explicit handling of uncertain effects, and a linked new
continuation rather than automatic tool replay. Include interruption during
context publication and provider retry.

A named compatible provider must pass a small opt-in continuation matrix before
its message projection is claimed compatible. Text-only chat behavior does not
prove support for reasoning or signature extensions. A machine-readable headless
result is still a possible refinement, subject to a concrete automation need.

## Steering

Test multiple queued corrections, cancellation, approval races, submission at
final completion, persistence failure, repeated provider call IDs, and restart
with pending steering. A skipped obsolete operation must never execute, and an
accepted instruction must appear exactly once in the next model request. Check
FIFO order and preservation of contradictory instructions without merging them.

A combined stop-and-steer shortcut remains an optional ergonomic idea. Measure
whether it helps compared with the current explicit commands before adding it.
Run keyboard behavior in a real terminal, and separate those observations from
mock-provider protocol tests in [PROGRESS.md](../PROGRESS.md).
