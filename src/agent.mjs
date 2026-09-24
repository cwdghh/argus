/**
 * UI-independent turn coordinator: compact history, request a model step,
 * execute its tools sequentially, and preserve a replayable outcome.
 * Supporting policy and I/O live in agent/; frontends import runTurn here.
 */
import { randomUUID } from "node:crypto";
import { tools } from "./tools.mjs";
import { COMPACT_DEFAULTS, maybeCompact } from "./compact.mjs";
import { createToolState } from "./tool-state.mjs";
import { buildRequestBody, runModelStep } from "./agent/model-step.mjs";
import { executeToolCall } from "./agent/tool-call.mjs";
import { accumulateUsage, reportedRequestUsage, totalReportedUsage } from "./agent/usage.mjs";
import { canonicalToolCall, detectCallLoop, LOOP_WINDOW, protocolSafeMessages, stableStringify } from "./agent/turn-state.mjs";

/**
 * Run one user prompt through the tool-calling loop.
 *
 * @param {object}  config     resolved config from config.mjs
 * @param {Array}   history    full conversation so far (outside this turn)
 * @param {string}  userMessage the new user prompt
 * @param {(event: object) => void} [onEvent] called with {type, ...} as things happen
 * @param {{
 *   signal?: AbortSignal,
 *   cwd?: string,
 *   confirm?: (cmd: string) => Promise<boolean>,
 *   authorize?: (request: object) => Promise<boolean>,
 *   maxSteps?: number,
 *   maxToolResultChars?: number,
 *   maxTurnToolResultChars?: number,
 *   maxRequestChars?: number,
 *   compactAtTokens?: number,
 *   compactAtChars?: number,
 *   keepTurns?: number,
 *   lastTokens?: number|null,
 * }} [opts]
 * @returns {Promise<{ runId: string, outcome: string, reason: string|null, messages: Array, partial: object|null, finalText: string, cwd: string, usage: object|null, requestUsage: object }>}
 */
export async function runTurn(config, history, userMessage, onEvent = () => {}, opts = {}) {
  const { signal } = opts;
  let cwd = opts.cwd || process.cwd();
  const confirm = opts.confirm || null;
  const authorize = opts.authorize || null;
  const toolList = tools;
  const maxSteps = opts.maxSteps ?? config.maxSteps ?? 100;
  const maxToolResultChars = opts.maxToolResultChars ?? config.maxToolResultChars ?? 50_000;
  const maxTurnToolResultChars = opts.maxTurnToolResultChars ?? config.maxTurnToolResultChars ?? 400_000;
  const maxRequestChars = opts.maxRequestChars ?? config.maxRequestChars ?? COMPACT_DEFAULTS.compactAtChars;
  // Loop-level retries for a model step that died before any visible text
  // streamed (the in-request `request()` retries already cover the initial
  // POST); reuses the same budget the request layer uses.
  const stepRetries = config.maxRetries ?? 2;
  const toolState = createToolState();
  const runId = randomUUID();
  const requestAttempts = [];
  const toolAttempts = [];
  let steps = 0;
  let turnToolResultChars = 0;

  // Everything created during this turn (assistant replies + tool results).
  const turnMessages = [{ role: "user", content: userMessage }];
  onEvent({ type: "user", text: userMessage });

  // Cumulative token usage across all model calls in this turn. Providers
  // return per-request usage (prompt + completion tokens); accumulateUsage
  // keeps the largest prompt and sums completions for the turn display.
  // `null` until the first model call reports usage.
  let usage = null;

  const emit = (event) => {
    if (event.type === "request_attempt") {
      requestAttempts.push({ id: event.attemptId, modelStepId: `${runId}:step:${steps}`, model: event.model, usage: null });
    } else if (event.type === "request_usage") {
      const attempt = requestAttempts.find((entry) => entry.id === event.attemptId);
      if (attempt) attempt.usage = reportedRequestUsage(event.usage);
    }
    onEvent(event);
  };
  const recordStepUsage = (attemptId, stepUsage) => {
    const attempt = requestAttempts.find((entry) => entry.id === attemptId);
    if (attempt) attempt.usage = reportedRequestUsage(stepUsage);
    usage = accumulateUsage(usage, stepUsage);
    emit({ type: "usage", usage });
  };
  const preservePartial = (partial) => {
    if (!partial?.text && !partial?.reasoning) return null;
    const saved = { text: partial.text ?? "", reasoning: partial.reasoning ?? "" };
    if (saved.text) turnMessages.push({ role: "assistant", content: saved.text, partial: true });
    return saved;
  };
  const finish = (outcome, reason = null, { partial = null, finalText = "", message = null } = {}) => ({
    runId,
    outcome,
    reason,
    message,
    messages: protocolSafeMessages(turnMessages),
    partial,
    finalText,
    cwd,
    usage,
    requestUsage: { attempts: requestAttempts, totals: totalReportedUsage(requestAttempts) },
    toolAttempts,
  });

  // Keep the model context within the window: drop the oldest turns and replace
  // them with a compact summary when the history grows too large.
  const { history: sendHistory, compacted } = maybeCompact(history, {
    compactAtTokens: opts.compactAtTokens,
    compactAtChars: opts.compactAtChars,
    keepTurns: opts.keepTurns,
    // Real provider-reported tokens of the context the next request will
    // carry (see compact.mjs `nextContextTokens`); falls back to the char
    // safety net before the first usage report.
    lastTokens: opts.lastTokens,
  });
  if (compacted) emit({ type: "compacted" });

  // Rolling window of executed (call, result) pairs for the no-progress guard.
  // Keying whole pairs — not just consecutive ones — lets the guard catch an
  // A/B/A/B alternation that a plain repeat-streak would reset on every change.
  const loopWindow = [];

  try {
    while (true) {
      if (steps >= maxSteps) {
        return finish("limited", "step_limit", { message: `agent stopped after ${maxSteps} model steps (ARGUS_MAX_STEPS)` });
      }
      steps++;
      const outgoingMessages = [...sendHistory, ...turnMessages];
      // Build the request body once per step: the same serialized payload is
      // both measured against the char cap and sent, so the measurement can
      // never drift from what actually goes over the wire.
      const body = buildRequestBody(config, outgoingMessages, toolList);
      const outgoingChars = JSON.stringify(body).length;
      if (outgoingChars > maxRequestChars) {
        return finish("limited", "request_size_limit", {
          message: `agent stopped before sending ${outgoingChars} characters; the active request exceeds the ${maxRequestChars}-character context safety limit`,
        });
      }
      const { message: reply, finishReason, usage: stepUsage, attemptId, aborted, partial } = await runModelStep(
        config,
        outgoingMessages,
        toolList,
        { body, onEvent: emit, signal, stepRetries }
      );
      recordStepUsage(attemptId, stepUsage);

      // Partial tool arguments are diagnostic only. Keep observed text once.
      if (aborted) {
        const saved = preservePartial(partial);
        return finish("interrupted", "user_abort", { partial: saved, finalText: saved?.text ?? "" });
      }

      const toolCalls = reply.tool_calls ?? [];
      if (finishReason === "length") {
        // The model hit its output/context limit. Keep what it said (marked
        // truncated) instead of discarding the reply, and turn any un-executed
        // tool_calls into explicit "never ran" error results so the persisted
        // turn still satisfies tool-call pairing.
        reply.truncated = true;
        turnMessages.push(reply);
        for (const call of toolCalls) {
          turnMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              error: true,
              truncated: true,
              message: 'model output was truncated (finish_reason "length"); this tool call never ran',
            }),
          });
        }
        return finish("truncated", "model_length", { finalText: reply.content ?? "" });
      }

      // A completed final reply wins a late stop. A pending tool batch must
      // still observe cancellation before dispatching any side effect.
      if (signal?.aborted && toolCalls.length > 0) {
        turnMessages.push(reply);
        return finish("interrupted", "user_abort");
      }

      // The assistant message becomes part of the conversation only after its
      // tool-call shape is known to be protocol-safe.
      turnMessages.push(reply);
      if (toolCalls.length === 0) {
        // No tools requested -> the model gave its final answer.
        emit({ type: "assistant_end", text: reply.content ?? "" });
        return finish("completed", null, { finalText: reply.content ?? "" });
      }

      // Execute each requested tool call in sequence and feed the results back as
      // `tool` messages. Some endpoints ignore `parallel_tool_calls:false` and
      // return several at once; they still never run in parallel, and each is
      // executed exactly once. The model does not actually run anything itself.
      for (const call of toolCalls) {
        const repeatKey = canonicalToolCall(call);
        const loop = detectCallLoop(repeatKey, loopWindow);
        if (loop) {
          const message = loop.period === 1
            ? `agent stopped: the model repeated the same no-progress tool call 3 times (${loop.name ?? "(missing name)"}); this looks like a loop — refusing to keep generating`
            : `agent stopped: the model alternated two no-progress tool calls 3 times (${loop.names}); this looks like a loop — refusing to keep generating`;
          return finish("limited", loop.period === 1 ? "repeated_tool_call" : "alternating_tool_calls", { message });
        }
        if (steps >= maxSteps) {
          return finish("limited", "step_limit_before_tool", {
            message: `agent stopped after ${maxSteps} model steps (ARGUS_MAX_STEPS) before executing another tool; no follow-up model step remains to report its result`,
          });
        }
        const remainingToolChars = maxTurnToolResultChars - turnToolResultChars;
        if (remainingToolChars < 500) {
          return finish("limited", "tool_result_budget", {
            message: `agent stopped before another tool call: this turn reached its ${maxTurnToolResultChars}-character tool-result budget`,
          });
        }
        const toolAttemptId = `${runId}:tool:${toolAttempts.length + 1}`;
        const toolAttempt = {
          id: toolAttemptId,
          modelStepId: `${runId}:step:${steps}`,
          providerCallId: call.id,
          name: call?.function?.name ?? "",
          resultError: null,
        };
        toolAttempts.push(toolAttempt);
        const { result, cwd: nextCwd } = await executeToolCall(call, {
          cwd,
          signal,
          confirm,
          authorize,
          maxToolResultChars: Math.min(maxToolResultChars, remainingToolChars),
          toolState,
          onEvent: emit,
          attemptId: toolAttemptId,
        });
        toolAttempt.resultError = result?.error === true;
        cwd = nextCwd;
        const serializedResult = JSON.stringify(result);
        turnToolResultChars += serializedResult.length;
        turnMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializedResult,
        });
        const resultKey = stableStringify(result);
        loopWindow.push({
          key: `${repeatKey}\u0000${resultKey}`,
          callKey: repeatKey,
          name: call?.function?.name ?? "(missing name)",
        });
        if (loopWindow.length > LOOP_WINDOW) loopWindow.shift();

        // Stop early if aborted (e.g. while a tool was running).
        if (signal?.aborted) {
          return finish("interrupted", "user_abort");
        }
      }
      // Loop again: the model now sees the tool results and can continue.
    }
  } catch (err) {
    if (err.operational || (signal?.aborted && !err.eventCallbackError && (err.name === "AbortError" || err === signal.reason))) {
      const saved = preservePartial(err.partial);
      return finish(signal?.aborted ? "interrupted" : "failed", signal?.aborted ? "user_abort" : "model_error", {
        partial: saved,
        finalText: saved?.text ?? "",
        message: signal?.aborted ? "interrupted by user" : err.message,
      });
    }
    // Programming failures still throw with the completed audit trail.
    err.turnMessages = protocolSafeMessages(turnMessages);
    err.cwd = cwd;
    err.usage = usage;
    err.runId = runId;
    err.requestUsage = { attempts: requestAttempts, totals: totalReportedUsage(requestAttempts) };
    err.toolAttempts = toolAttempts;
    throw err;
  }
}
