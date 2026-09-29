# Behavioral evaluation and verification qualification

Work IDs E0 and V1. The coding fixtures and opt-in runner are in `eval/`; the
user-facing command is in the [README](../../README.md). The implemented check
ledger is described in [architecture](../architecture.md) and its saved form in
[sessions](../sessions.md). [The prior design](../archive/evaluation-design-through-2026-09-27.md)
retains the full rationale. [GAPS.md](../../GAPS.md) owns current limitations.

## E0 — Reproducible coding tasks

Run repeated trials of the six existing fixtures against an explicitly named
provider. Keep task success, tool efficiency, failure categories, latency,
reported usage, interruption recovery, steering correctness, and verification
honesty separate. Missing usage stays unknown. Report raw counts and spread;
small samples are diagnostic rather than a provider ranking. The provider-backed
runner is opt-in because it can consume paid credits.

Before treating the harness as a baseline, verify that it detects weakened local
tests, labels infrastructure failures separately, cleans up after timeout, and
can reproduce a score from a saved sanitized report. Include bounded final
change details so failures are inspectable without committing transcripts.
Evaluate old-constraint and interrupt/steer fixtures as those workstreams mature.
An unrestricted shell is not adversarial isolation; use a disposable OS boundary
before evaluating untrusted tasks or claiming verifier-tamper resistance.

## V1 — Evidence-backed handoffs

Challenge the recorded check state and freshness with: a passing check followed
by an edit, timeout after printing “passed,” truncated output, a failed suite
contradicted by model prose, pre-existing dirty changes, concurrent external
edits, ignored dependencies, non-Git folders, missing artifacts, and a crash
between check completion and persistence. Verify that both frontends show the
same saved facts and never infer a check merely from a successful shell command.

Measure whether the ledger reduces misleading completion claims in the coding
suite. Expand automatic gates or dependency-aware freshness only if those
measurements justify their state and execution cost. Keep optional exact checks
subject to the existing tool authorization path.
