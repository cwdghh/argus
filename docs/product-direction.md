# Product direction and decision ledger

Status: **D1–D3 selected on 2026-09-24; D4–D6 selected on 2026-09-26**. The owner delegated
the first three choices with a requirement that Argus stay minimal and easy to
use, and that tool clarity be addressed first. This document owns product
identity and decision status. It does not authorize every proposed feature or
change the constraints in [AGENTS.md](../AGENTS.md). Implemented limitations
belong in [GAPS.md](../GAPS.md); implementation briefs are indexed in
[improvements-plan.md](improvements-plan.md).

## Chosen identity

Argus should be a small terminal coding partner whose work a human can steer,
recover, and verify. Its understandable implementation is part of its value:
someone should be able to trace a request, a tool execution, and a saved result
without learning a framework. The intended primary user is a developer working
inside one local repository, often with an existing dirty working tree.

Three intended distinguishing characteristics:

| Characteristic | Observable promise | Cost we would accept |
| --- | --- | --- |
| Recoverable work | Interruption preserves recorded progress; restart explains what completed and what remains uncertain. | Checkpoint I/O and explicit uncertainty after a crash. |
| Human control | A developer can stop, redirect, or continue work without reconstructing the task. | A sequential execution model and visible boundary handling. |
| Evidence-backed results | Verification claims identify what ran, what it checked, and which workspace state it covered. | More precise outcome reporting and some verification time. |

These are product aims; implemented guarantees and limits live in the owning
contracts.
Understandability is the admission test across all three. Feature count, maximum
autonomy, and provider breadth would not be the primary measures of progress.

## Decision ledger

The owner delegated D1–D3 to the recommended direction on 2026-09-24 and
directed completion of the remaining minimal terminal-agent work on 2026-09-26.
Existing constraints remain authoritative; link technical details
rather than repeating their contracts.

| ID | Choice | Status | What choosing another direction changes |
| --- | --- | --- | --- |
| D1 | Everyday coding partner, learning platform, or unattended worker? | **Chosen:** everyday coding partner with an inspectable core (2026-09-24). | Learning emphasizes traces/experiments; unattended work requires stronger isolation, budgets, recovery policy, and supervision. |
| D2 | What wins when priorities conflict: recoverability, interaction speed, or experimentation? | **Chosen:** recoverability, with responsiveness measured (2026-09-24). | Speed favors lighter persistence; experimentation favors replaceable components and broader extension points. |
| D3 | Human-directed execution, step-by-step approval, or long-running autonomy? | **Chosen:** human-directed execution within a clear task (2026-09-24). | Step approval requires a plan/approval lifecycle; unattended work needs leases, escalation, and durable scheduling. |
| D4 | How should users trust completion? | **Chosen:** recorded verification evidence and its limits, with optional exact task checks (2026-09-26). | Mandatory gates for every task add friction. |
| D5 | How broad should provider support become? | **Chosen:** test named compatible-chat targets before expanding support (2026-09-26). | Native adapters need independently tested message, cancellation, tool, and usage mappings. |
| D6 | How far should the tiny core grow? | **Chosen:** add a concept only for a recurring measured task that the four tools and current primitives cannot handle (2026-09-26). | A plugin/platform direction needs a separate public API, compatibility policy, and ownership model. |

These choices follow the owner's 2026-09-26 instruction to finish the pending
terminal-agent improvements while keeping Argus minimal and easy to use. They
do not claim live-provider compatibility or admit fallback without evidence.

## Scenarios that make the choice concrete

1. **A test command hangs after editing three files.** A recoverable partner stops
   the owned process group, retains output and finished edits, reports uncertainty,
   and continues from the recorded state. It cannot promise undo of shell effects.
2. **The developer changes the target halfway through a task.** Steering takes
   effect at a visible boundary; queued obsolete calls are not executed first.
   The revised instruction survives restart.
3. **A long task revisits an early constraint.** Context reduction preserves the
   source of that constraint and whether it was later superseded. The agent can
   retrieve detail rather than treating a summary as unquestionable truth.
4. **The agent says a refactor is ready.** Its handoff identifies changes and
   checks, distinguishes pre-existing modifications, and flags checks that became
   stale after subsequent edits. A passing test is evidence for its scope only.
5. **The provider fails after a shell command may have run.** Model retry and tool
   retry are distinct. The agent does not silently repeat an uncertain side effect.

Ask which scenario would most improve actual daily use. That answer should weigh
more heavily than the appeal of a feature in isolation.

## Measures and decision gates

Use deterministic invariants for recovery, pairing, and accounting. Use repeated
task trials for model usefulness. Track task completion, corrective user messages,
time to visible stop, recovered progress, verification freshness, and reported
usage. Missing measurements stay unknown; do not invent numerical baselines.

The first evaluation workstream establishes values before setting improvement
targets. A capability should earn its complexity by fixing observed failures or
improving a named measure while preserving the existing invariants.

For parallel tools, sub-agents, plugins, a fifth tool, persistent semantic memory,
native providers, or a background daemon, require: a recurring failing scenario,
a comparison with the simpler approach, defined state/permission ownership,
failure recovery, and an independently verifiable success criterion. Such work
is a separate product decision, not an implicit extension of this roadmap.

## What is deliberately undecided

- Whether sharing a task across machines is valuable enough to justify portable
  artifacts, identity, and secrets handling.
- Whether plans should be a UI aid, a durable execution contract, or ordinary
  conversation. Begin with ordinary conversation until a concrete need emerges.
- Whether code verification should be explicitly requested or inferred from
  repository instructions. First expose accurate evidence; defer automatic gates.
- Whether reducing provider cost is a primary goal. First measure per-request
  usage; pricing estimates require explicit rates and cannot replace actual bills.

These questions should be revisited from use, not answered by speculative
infrastructure. The roadmap provides bounded next-session briefs while keeping
these larger commitments open.
