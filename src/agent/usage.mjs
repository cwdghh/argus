/**
 * Fold one model call's usage into the running turn total without ever
 * counting the same tokens twice.
 *
 * Providers report per-request usage, and every request re-sends the whole
 * context so far (history + tool results). Summing `prompt_tokens` across the
 * steps of a multi-call turn would therefore count the same history once per
 * model call — the "X tokens used" number would grow with the request count,
 * not with the context. Instead:
 *
 *   - prompt_tokens  = the largest single prompt sent (the final request's
 *                      context); shared context is counted exactly once.
 *   - completion     = the sum of every step's output tokens (each step's
 *                      output is distinct).
 *   - total_tokens   = prompt_tokens + completion_tokens, recomputed so the
 *                      turn total stays consistent with its two members.
 *   - reasoning      = summed like completion (distinct per step).
 *   - cached         = the largest cached share of any prompt sent (a subset
 *                      of the prompt, so it is reported, not summed).
 *   - cache_creation = the largest cache block created by any request. Each
 *                      request with a `cache_control` marker can create (or
 *                      extend) a cache block; the biggest of them dominates,
 *                      because every later block reuses the earlier ones as a
 *                      prefix rather than adding on top of them.
 *
 * Members that don't apply to a given call are added as zero, and a missing
 * or malformed report is ignored.
 *
 * @returns {object|null} the accumulated usage object (null until a real one
 *   has been seen)
 */
export function accumulateUsage(usage, stepUsage) {
  if (!stepUsage || typeof stepUsage !== "object") return usage;
  // A report with no numeric counts isn't a usage report; keep the running
  // total untouched rather than recording a bogus zero-cost call.
  if (
    !Number.isFinite(stepUsage.prompt_tokens) &&
    !Number.isFinite(stepUsage.completion_tokens) &&
    !Number.isFinite(stepUsage.total_tokens)
  ) {
    return usage;
  }
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const add = (base, value) => (base ?? 0) + n(value);
  const step = {
    prompt: n(stepUsage.prompt_tokens),
    completion: n(stepUsage.completion_tokens),
    total: n(stepUsage.total_tokens),
    reasoning: n(stepUsage.completion_tokens_details?.reasoning_tokens),
    cached: n(stepUsage.prompt_tokens_details?.cached_tokens),
    cacheCreation: n(stepUsage.prompt_tokens_details?.cache_creation_input_tokens),
  };
  if (!usage) {
    return {
      prompt_tokens: step.prompt,
      completion_tokens: step.completion,
      total_tokens: step.total,
      reasoning_tokens: step.reasoning,
      cached_tokens: step.cached,
      cache_creation_input_tokens: step.cacheCreation,
    };
  }
  const prompt = Math.max(usage.prompt_tokens, step.prompt);
  const completion = add(usage.completion_tokens, step.completion);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    reasoning_tokens: add(usage.reasoning_tokens, stepUsage.completion_tokens_details?.reasoning_tokens),
    cached_tokens: Math.max(usage.cached_tokens, step.cached),
    cache_creation_input_tokens: Math.max(usage.cache_creation_input_tokens, step.cacheCreation),
  };
}
