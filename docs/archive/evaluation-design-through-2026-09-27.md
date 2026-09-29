# Behavioral evaluation and verification evidence

Status: **E0 harness and V1 evidence core implemented; live baseline and
qualification pending**. Work IDs E0 and V1. Evaluation measures agent behavior;
verification evidence describes an individual task. Neither turns model prose
into an independent correctness check.

## E0 — A small reproducible task suite

The six baseline fixtures and opt-in runner now live in `eval/coding-tasks.mjs`
and `eval/coding.mjs`. Their checkable behavior is covered by offline tests.
No live provider baseline has been run; the remaining trial and comparison
requirements below are still open. The implemented CLI use is in the README.

Keep the existing tool-choice evaluator as a focused diagnostic. Add a separate
coding-task runner over temporary Git workspaces, with exact task definitions,
input fixture hashes, a permitted change surface, and trusted external verifiers.
Use repository-native JavaScript and Node facilities; avoid building an evaluation
framework before the task suite demonstrates a need.

Initial task matrix:

| Task family | Outcome to check |
| --- | --- |
| Bug fix | Hidden edge-case tests pass; unrelated behavior preserved. |
| Multi-file refactor | Public behavior unchanged; intended boundary actually moves. |
| Add a small feature | Acceptance cases and failure cases pass. |
| Dirty working tree | Pre-existing user changes survive. |
| Failed command | Agent uses failure evidence and corrects the task. |
| Large output | Useful diagnosis survives bounds; no false success claim. |
| Old constraint | A later edit honors an early constraint after compaction. |
| Interrupt/steer | Completed work retained; obsolete queued operations do not run. |

Begin with the first six families that can exercise the baseline. Add the last
two as the corresponding capabilities become available. Each fixture should be
small enough to inspect manually and have a failure explanation, not just a score.
Avoid rewarding a prescribed tool sequence when multiple correct approaches exist.

Keep reference verifiers and fixture manifests outside the writable task directory;
verify their hashes before scoring. This prevents accidental test weakening, but
an unrestricted shell can reach host files: it is not adversarial isolation.
Use a disposable OS/container boundary if evaluating untrusted tasks or claiming
resistance to verifier tampering. Never score model-authored tests as the only gate.

Record: task/fixture version, source commit and dirty-diff hash, Node/OS, endpoint
identifier without credentials, model, prompt/tool-surface hash, relevant config,
trial number, wall time, per-request reported usage, ending reason, tool failures
by category, final diff, verifier results, and operator interruptions. Missing
provider usage is unknown. Invalid arguments, expected command failure, and
transport failure are separate categories. Keep transcripts local and sanitize
explicitly before sharing; do not log credentials or authorize upload implicitly.

Controls: explicit task list, repeat count, per-task time/step/output limits, total
run cap, and opt-in live execution. A provider seed can be recorded if available;
it does not make a remote model deterministic. Use at least three trials per task
for an initial comparison, report raw counts and spread, and rerun ambiguous cases.
Small samples are diagnostic, not a precise general ranking of providers.

Report task success separately from tool efficiency, interruption recovery,
steering correctness, verification honesty, latency, and usage. Never combine all
metrics into an unexplained score. Store baseline reports as explicit opt-in
artifacts outside committed transcripts; check in task definitions and sanitized
aggregate summaries only when deliberately reviewed.

Acceptance: the runner detects a deliberately broken solution and weakened local
tests, cleans up on timeout, leaves the source repository untouched, labels
infrastructure failures separately, and reproduces an offline scoring report from
saved sanitized outputs. Run baseline trials before claiming improvements. Mock
failure/recovery tests remain part of normal CI; paid live comparisons do not.

## V1 — Evidence attached to a task handoff

The current agent records bounded Git worktree fingerprints for explicitly
designated checks, exact observed shell status/timing/artifact references, and
whether later mutating tools stale a check. TUI `/check <command>` and headless
`--check <command>` designate an exact optional command; they do not run it.
Recorded states are passed, failed, not run, or unknown, with separate freshness.
Both frontends render this evidence independently of model prose, and named
sessions retain it in timing blocks. The implementation and CLI behavior are
owned by [architecture](../architecture.md) and [README](../../README.md).

The remaining acceptance cases below need broader adversarial and real-workspace
trials. Fingerprints deliberately avoid ignored files, limit untracked files and
bytes, and mark incomplete scope as unknown. They cannot perfectly attribute
changes made by concurrent actors.

Build a compact evidence ledger from actual tool events and optional explicit
user-designated checks. Do not infer that every `bash` invocation is a test or
that every zero exit proves a requirement. Allow ordinary tasks without gates;
when a gate is specified, report its result or that it was not run.

Evidence record fields: run/tool-attempt ID, exact command and cwd, start/end,
exit/signal/termination, bounded output/artifact reference, check label/scope,
and workspace fingerprint before/after. Git HEAD alone is insufficient for a
dirty workspace. Use tracked and relevant untracked file hashes without storing
their contents in the ledger. For non-Git workspaces, label the selected file
scope and its limits. Avoid scanning ignored caches, secrets, or huge trees by
default; an incomplete fingerprint is explicitly incomplete.

Record the initial dirty-worktree fingerprint so the final handoff can distinguish
pre-existing changes from observed tool effects and external edits. It cannot
perfectly attribute simultaneous human/process changes. Never claim ownership
from a simple end-of-run `git diff` alone; overlapping edits are uncertain.

Evidence states: passed, failed, not run, interrupted, or unknown. Freshness is
separate: fresh for the captured scope, stale after relevant changes, or unknown
when a command/external actor could have changed untracked dependencies. Start
conservatively by invalidating all checks after any later mutating tool; refine
dependency-aware invalidation only with concrete evidence. A test that modifies
the workspace needs explicit before/after treatment, not a blind freshness stamp.

The final UI/headless summary should present changes, checks and their scope,
unresolved failures, uncertainty, and next action. Render recorded facts separately
from the model's explanation. Do not silently run arbitrary verification commands
solely because a model labels them safe. Existing tool authorization remains in
force; a new gate runner must use that same path.

Acceptance: check passes then files change; command times out after printing
"passed"; truncated output; test suite fails but model says success; pre-existing
changes; external concurrent edits; non-Git folder; missing artifact; crash after
check completion before recording. Persist/reload evidence through E3 and keep
the final summary consistent in both frontends. V1 depends on E1/E3 and uses E0
fixtures to measure whether it actually reduces misleading completion claims.
