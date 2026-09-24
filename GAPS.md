# Current design questions

This file owns open design questions and deliberate limits. History is in
[PROGRESS.md](PROGRESS.md); priorities are in [NEXT_STEPS.md](NEXT_STEPS.md).
Section numbers remain stable for existing references.
Proposed solutions are indexed in [implementation briefs](docs/improvements-plan.md);
the [product decision ledger](docs/product-direction.md) distinguishes recommendations
from choices accepted by the owner. E1 is implemented; the other workstream
proposals remain future work.

## 1. Streaming output

Implemented at the current scope; see [architecture](docs/architecture.md).
Open: whether incomplete tool-call arguments should be shown before valid JSON
is available, and how much malformed-SSE tolerance is desirable.

## 2. Tool execution policy

The current approval policy is defined in [tools](docs/tools.md). Open:
configurable policy by path/risk and process isolation. Shell approval remains
a best-effort accident backstop, not a sandbox.

## 3. Parallel tool execution

Deliberately omitted. Current batch handling is sequential; the rationale and
admission rule live in [tool-surface](docs/tool-surface.md). Revisit concurrency
only with measured latency evidence and an explicit cwd/freshness/order contract.

## 4. Context management

Deterministic compaction is implemented. Open: semantic summaries that preserve
intent, mid-turn compaction when active output reaches a limit, and retention for
oversized-result spill files. A digest can lose detail even while carrying earlier
summary text forward. See [architecture](docs/architecture.md).
The C1 proposal is in [context design](docs/design/context.md).

## 5. Session persistence

The current format and recovery policy are in [sessions](docs/sessions.md).
Open: checkpointed interruption and continuation, safe coordination of concurrent
processes writing one session, and whether future scale ever justifies a store
beyond JSONL. Discovery still reads each candidate file even though it avoids
retaining turns; a measured need should precede an index.
See [E3](docs/design/execution.md) for proposed recovery and uncertainty semantics.

## 6. Provider abstraction

OpenAI-compatible chat completions is the implemented protocol. Open: whether a
native provider adapter adds enough value to justify another message/tool/usage
mapping. Mid-turn fallback among compatible model names is a separate proposal.
See [P1](docs/design/providers.md).

## 7. Robustness and outcomes

The current loop limits, pairing guarantees, and retry behavior are documented in
[tools](docs/tools.md) and [architecture](docs/architecture.md). Open: recoverable
interrupt/continue ([proposal](docs/interrupt-resume.md)) and stronger shell
process-group cleanup. Normal, interrupted, truncated, failed, and limited run
outcomes are now distinguished; see [architecture](docs/architecture.md).
Capture-buffer overflow now yields an error with captured output and explicitly
unknown completion. Supervised process cleanup and output artifacts remain E2 work.
The proposed shell and checkpoint foundations are [E2–E3](docs/design/execution.md).

## 8. Terminal UX

Open: steering input while a turn is active, optional kitty keyboard negotiation,
live shell-output streaming, desktop notifications, and making full-result
browsing easier to discover. Input typed during a running turn currently remains
in the next draft. Width handling covers common CJK/emoji but is not a complete
grapheme implementation; extend it when a real rendering case requires it.
The proposed steering contract is [I2](docs/interrupt-resume.md).

## 9. Testing and evals

Offline regression tests and the opt-in provider tool-choice evaluator exist.
Open: small coding tasks with automatic outcome checks, repeatable provider
baselines, and sanitized real-session replay. These should predict usefulness
without growing into a general evaluation framework.
See [E0 and V1](docs/design/evaluation.md) for proposed task evaluation and
verification evidence attached to an individual handoff.

## 10. Configuration

Open: a versioned system prompt and a provider/model catalog. Keep ordinary knobs
in the existing environment configuration until a concrete need justifies another
configuration format. See [.env.example](.env.example).

## 11. File editing

The current contract is in [tools](docs/tools.md). Open: whether explicit operation
discriminators or verification anchors improve live-model insert/delete/mixed
batch outcomes enough to justify their schema cost. Atomic file replacement does
not coordinate simultaneous external edits or preserve hard-link relationships.

## 12. Tool surface

The current decision and criteria for a fifth tool live in
[tool-surface](docs/tool-surface.md). A proposed sub-agent or model-to-user input
tool requires a separate design decision; neither is part of the current registry.
