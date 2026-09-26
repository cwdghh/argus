# Context that preserves intent

Status: **bounded deterministic between-run revision implemented; semantic and
mid-run reduction remain proposed**. Work ID C1. The implemented behavior is
owned by [architecture](../architecture.md) and [sessions](../sessions.md);
current limits remain in [GAPS.md](../../GAPS.md). This file retains the design
and acceptance matrix.

## Model and boundaries

The current revision records covered message count, source hash, method,
retained message IDs, a capped digest, and an indexed private source artifact.
Logical saved-run sizes keep in-run steering together during reduction. The
digest is assistant-role lower-trust data and is reused from the last persisted
revision. It is not a semantic preservation guarantee.

Treat the append-only session as source evidence and the active model context as
a bounded projection. Retain a stable summary of a covered prefix plus a recent
suffix. Do not repeatedly summarize the same prefix from scratch at every new
turn. A context revision records its source range/hash, summary version, method,
and retained message IDs. It must be possible to explain what was omitted.

Proposed summary sections:

| Section | Required distinction |
| --- | --- |
| Objective and acceptance | User request versus inferred plan; active versus superseded. |
| Constraints and decisions | Source message IDs; scope; explicit approval versus suggestion. |
| Work completed | Observed edits/tool outcomes versus assistant claims. |
| Verification | Command/result references and whether changes later made evidence stale. |
| Open work and uncertainty | Unresolved failures, uncertain execution, and unanswered questions. |
| Retrieval references | Source record IDs and artifact locations; missing references explicit. |

The summary is lower-trust task data. Do not concatenate historical user/tool
content into the system prompt. Render a clearly delimited assistant-authored
summary with provenance, leaving authoritative current system instructions
separate. A label alone is not a security boundary; adversarial fixtures must
exercise quoted instructions and misleading tool output. Never promote a model's
claim into a user authorization.

## Reduction algorithm

1. Measure the complete serialized outgoing body, including schemas and current
   instructions, before every request. Maintain a hard character/byte bound in
   addition to estimated token budgets; character ratios are not exact tokenizers.
2. Reserve space for response generation and likely next tool output. Use the
   latest request's reported context usage as an estimate, not cumulative billing
   input. New tool output can invalidate an earlier estimate.
3. Select an old stable prefix at complete message-pair boundaries. Pin current
   objective/constraints, unresolved execution, accepted steering, and current
   unclosed tool segments. Use run IDs instead of splitting at each user message.
4. Generate a bounded deterministic digest first. Optional semantic summarization
   is a separately configured request with no tools, a budget/timeout, cancellation,
   recorded usage, and schema/size validation. On failure use the deterministic
   fallback; do not loop indefinitely trying to fit a summary.
5. Publish the candidate only if it fits, preserves required references, and
   passes structural validation. Record the context revision before using it.
   Keep the old projection until publication succeeds.
6. If the pinned content plus schemas still exceeds the cap, stop with `limited`
   and an explanation. Do not send an oversized request or silently discard the
   current instruction. Offer explicit task narrowing/new-session handoff.

Repeated reduction must obey a bound on the entire summary, including inherited
summaries. Discarding low-priority details is allowed only with retrieval pointers;
lossless semantic compression is not promised. Structural validation cannot prove
that an LLM summary preserved meaning; evaluate that separately.

## Mid-run scope and retrieval

Deliver between-run reduction first. Mid-run reduction is a later C1 slice after
run-boundary tests pass, at a completed tool batch or other valid request boundary.
Never reduce an unresolved assistant-call/result segment independently.

Keep a read-only context artifact available via the existing `read` tool,
with source references for deeper inspection. Do not force the model to scan a
huge raw JSONL file to recover one omitted fact. Artifact creation and lifetime
belong to the session host; the context reducer remains a pure transformation
where possible. Referenced artifacts remain while their session remains unless
the user explicitly removes them. Missing artifacts produce an honest unavailable
reference. Implement retention alongside publication, not as a cleanup afterthought.
The first slice bounds the digest and paged reads, but not total artifact bytes
across repeated revisions; that limit remains a follow-up.

Do not add embeddings, cross-project memory, a database, or a new retrieval tool
in C1. Those need separate evidence and ownership decisions.

## Acceptance

Use fixture conversations with early constraints, changed decisions, failed tool
calls, unsaved edits, repeated compaction, very large individual messages, steering,
reused call IDs, and uncertain execution. Assert caps, valid pairs, source-range
coverage, no loss of pinned constraints, and stable reload of a context revision.

Behavioral tasks should ask the agent to honor an old constraint after reduction,
retrieve a deliberately omitted detail, and distinguish tested work from an
unverified claim. Compare deterministic and semantic methods using E0; optional
summarization must demonstrate benefit against its extra latency/usage. Test disk
failure, missing artifacts, summary timeout, malformed summary, and cancellation.

Update the implemented architecture/session contracts at delivery. Report summary
quality separately from structural correctness; passing cap tests cannot establish
that the model remembered every important fact.
