# Current design questions

This file owns open design questions and deliberate limits. History is in
[PROGRESS.md](PROGRESS.md); priorities are in [NEXT_STEPS.md](NEXT_STEPS.md).
Section numbers remain stable for existing references.
Proposed solutions are indexed in [implementation briefs](docs/improvements-plan.md);
the [product decision ledger](docs/product-direction.md) records accepted choices.
Current capability contracts live in the linked architecture, tools, and session
documents; this file records remaining limits.

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

Bounded deterministic revisions with source hashes and private retrieval
artifacts are implemented between runs. Open: semantic preservation measured
against the coding suite, mid-run reduction, and a better response when pinned
current material alone exceeds the request cap. A digest can still omit an
important constraint; the indexed source is the recovery path. See
[architecture](docs/architecture.md) and [context design](docs/design/context.md).
The source artifact is replaced atomically at each new revision and grows with
the covered history; very long sessions still need a measured size policy.

## 5. Session persistence

The current format and recovery policy are in [sessions](docs/sessions.md).
Checkpointed runs, conservative single-writer ownership, and crash-prefix
recovery are implemented. Open: remaining kill-injection boundaries and disk-full testing,
power-loss/filesystem guarantees, handling a stale recovery guard after its own
crash, and whether future scale justifies a store beyond JSONL. Discovery still
reads each candidate file even though it avoids retaining turns. See
[sessions](docs/sessions.md) and the [E3 matrix](docs/design/execution.md).

## 6. Provider abstraction

OpenAI-compatible chat completions is the implemented protocol. Open: whether a
native provider adapter adds enough value to justify another message/tool/usage
mapping. Mid-turn fallback among compatible model names is a separate proposal.
See [P1](docs/design/providers.md).

## 7. Robustness and outcomes

The current loop limits, outcomes, supervised shell, bounded artifacts, and
continuation are in [tools](docs/tools.md), [architecture](docs/architecture.md),
and [sessions](docs/sessions.md). Open: descendants that detach from the owned
process group and a live-provider continuation
matrix. The short live output preview and Esc cancellation passed a local
mock-provider check in a real TTY. Exact-once effects
are not guaranteed after an uncertain crash.

## 8. Terminal UX

Persisted `/steer` applies at safe model/tool boundaries; ordinary input remains
a next-turn draft. Open: optional kitty keyboard negotiation, richer live shell
output browsing beyond the footer preview, desktop notifications, and easier
full-result discovery. Width handling covers common CJK/emoji but is not a
complete grapheme implementation. See [interaction](docs/interrupt-resume.md).

## 9. Testing and evals

Offline regression tests, six external-verifier coding fixtures, and opt-in
provider evaluators exist. No paid live coding baseline has been measured.
Optional exact-command checks record status and freshness, but the evidence
ledger cannot perfectly attribute concurrent edits or ignored dependencies.
Open: repeated provider trials, broader misleading-completion fixtures,
sanitized real-session replay, and observed usefulness gains. See
[E0 and V1](docs/design/evaluation.md).

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
