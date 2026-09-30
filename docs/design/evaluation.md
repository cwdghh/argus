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

### Report and scoring contract

Both runners use `eval/coding.mjs` for sequential trials, deadlines, a separate
workspace and home per trial with awaited cleanup after scoring, and reporting.
`eval/report.mjs` owns source/config identities,
sanitization and bounded change details; `eval/tool-tasks.mjs` owns focused schema
fixtures. Runtime tool contracts and model guidance belong in
[tools](../tools.md) and [architecture](../architecture.md).

Version 3 reports identify the source revision and dirty hash, harness, prompt,
configuration, tool surface, and each fixture. Planned and attempted counts are
separate; an incomplete suite exits nonzero even if all attempted trials pass.
`summarizeEval(report)` recomputes aggregate scores from saved observations.
`verifierPassed` describes final behavior; `behaviorPassed` additionally requires
normal completion with no evaluation deadline/cancellation violation, harness
error, or observed protected-file change. `workflowPassed` independently records
the requested failure-before-fix and successful rerun, and is null when wrapped
checks leave their status unknown. Final answer hashes before calls distinguish
pre-edit and post-edit checks; commands outside the fixture do not qualify.
`toolChoicePassed` records required tool forms while allowing behavioral checks
with bash and file confirmation with read. `passed` combines behavior and any
required workflow/tool choice. `cleanPassed` additionally excludes unexpected
tool failures; a recovered tool error does not erase task success. The CLI exits
nonzero for incomplete suites or when any planned trial lacks a clean pass. Expected
nonzero task checks and the write-protection rejection are reported as tool
failures but do not count as unexpected failures. Schema mistakes are counted
independently. The original version 2 baseline and its scoring remain preserved.

Behavioral probes require an assertion-completion marker as well as exit zero.
Command fixtures require unchanged checks and an observed standalone
`node check.mjs` failure followed by success. Only the exact command qualifies:
an arbitrary shell prefix can skip execution, while a suffix can hide the
check's status. The runtime's designated ledger also requires exact commands.
Protected files are checked after tool results and at scoring.
This cannot detect a shell that
temporarily changes and restores a check within one call. Probe timeouts use
owned process-group cleanup; detached descendants can escape. Trial cancellation
awaits the agent's cooperative cleanup before removing its workspace.
The ordinary large-output task permits redirecting output; truncation is a
separate opt-in fixture, `large-output-truncation`, that explicitly requires an
unredirected failing check before editing. The six default coding fixtures remain
the default suite. Focused edit fixtures include insertion/deletion and mixed
selectors in one batch, in addition to the existing content/range cases.

Reports include bounded arguments/errors, up to 20 changed-file entries with
12,000 characters of before/after text, and up to 2,000 characters of final
handoff text. Each tool result also retains at most 1,000 characters of stdout,
stderr, and any serialized overflow preview, with unavailable/truncated output
explicit. Omitted/oversized details are explicit. The request ledger sums
only reported usage; missing fields remain null and completeness is separate.
Final text is evidence for manual verification-honesty review, not a success
signal; its initial assessment is `unassessed`. Exact designated check states
are retained separately from prose. The request cap includes retry attempts,
but cannot enforce a currency ceiling without provider pricing and output
bounds or a provider account cap. These are diagnostic small tasks, not a
claim of representative repository work or adversarial verifier isolation.

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
