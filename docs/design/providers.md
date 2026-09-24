# Bounded recovery across compatible models

Status: **proposed**. Work ID P1. This design covers a configured fallback within
the existing compatible-chat protocol. Native adapters are a separate decision
under [product direction](../product-direction.md).

## Eligibility and limits

Make failure categories structured at the transport boundary: authentication,
permission, malformed request, rate limit, server unavailable, network failure,
timeout, protocol error, cancellation, and context limit. Preserve provider status
and a bounded diagnostic. Do not infer retry eligibility from message prefixes.

Use one request-recovery budget across HTTP retries, stream restarts, and fallback;
avoid multiplying independent nested retry loops. Cancellation, invalid requests,
authentication failures, denied tools, and uncertain side effects are ineligible.
Context overflow goes to bounded context handling, not a blind switch to a model
with unknown limits. Respect server retry hints within the remaining time budget.

For the first version, allow one explicitly configured fallback model on the same
configured endpoint, only when a transient request fails before visible content
(including exposed reasoning) or
a committed assistant tool-call step. All prior completed tool results remain in
history. Never retry an executed tool as part of model fallback. A mid-text failure
becomes an explicit failed/interrupted run with partial output and a continuation
choice; do not splice answers from different models into one assistant message.

Do not silently send repository data to a second endpoint. Cross-endpoint fallback
needs a separate configuration/consent design and independent credentials. Unknown
capabilities are not treated as compatible. Maintain a small tested capability
record for explicitly supported targets: tool schema support, partial-history
projection, context/output limits, and usage fields. Model names alone do not
establish capabilities; avoid a speculative universal provider catalog.

## Events, history, and budgets

Emit a visible recovery event with failure class, selected model, and attempt
number. Persist each actual request model and usage through E1/E3. Leave the user's
session model selection unchanged: fallback applies to the failed step. To avoid
ping-pong, exhaust recovery for that step after the one configured fallback;
further failure is explicit. A subsequent step starts with the selected primary
unless the user deliberately changes it.

Account for summary requests, retries, and fallback separately. An interrupted
request may have unknown cost even if no text was shown. Never advertise savings
from missing usage. Enforce total steps, elapsed time, and output limits independent
of which model is selected. A durable attempt record must distinguish a request
that may have reached the server from one never sent.

## Verification and admission

Dependencies: E1 for typed outcomes/accounting, E3 for history, E0 for comparative
evidence. Test eligible 429/5xx/network failures; ineligible 401/403/400; retry-after
longer than remaining budget; cancellation during backoff; partial output; malformed
SSE; absent usage; fallback failure; and existing tool results before retry. Assert
bounded request counts, no repeated tool invocation, no silent endpoint changes,
and exact attribution of all reported usage.

An opt-in live matrix must establish that the chosen primary/fallback pair accepts
the actual request projection. Compare successful task completion and total
latency/usage against ordinary retry. Implement P1 only when observed provider
failures make that benefit worth the added state and tests. Keep an explicit off
switch; fallback is not required for the rest of the roadmap.
