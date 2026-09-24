import { abortableDelay, buildBody, streamChat } from "../llm.mjs";

/** Build the chat request body once per step (measured and sent, never twice). */
export function buildRequestBody(config, messages, toolList) {
  return buildBody({
    model: config.model,
    systemPrompt: config.systemPrompt,
    messages,
    tools: toolList,
    contextCache: config.contextCache,
  });
}

/**
 * One model step, retried at the loop level when the stream died before any
 * visible text arrived (a disconnect ahead of the first token, or a body that
 * produced nothing). Once a text/thinking delta has been forwarded the step is
 * not retried — re-streaming would duplicate the visible text in the
 * transcript — and it fails as it always has. The in-request `request()`
 * retries inside llm.mjs already cover the initial POST; this wraps the whole
 * step on top of that for mid-body failures.
 */
export async function runModelStep(config, outgoingMessages, toolList, { body, onEvent, signal, stepRetries }) {
  for (let attempt = 0; ; attempt++) {
    let sawContent = false;
    const forward = (ev) => {
      if (ev.type === "text_delta" || ev.type === "thinking_delta") sawContent = true;
      try {
        onEvent(ev);
      } catch (err) {
        err.eventCallbackError = true;
        throw err;
      }
    };
    try {
      return {
        ...(await streamAssistant(config, outgoingMessages, toolList, forward, signal, body)),
        sawContent,
      };
    } catch (err) {
      // Only a pristine failure may be retried: a user abort, a step that
      // already streamed visible text, or a request that *already* exhausted
      // its in-`request()` retry budget (`LLM request …` errors) all fail the
      // step — re-running those would duplicate text or multiply the retries.
      if (err.eventCallbackError || signal?.aborted || sawContent || err?.message?.startsWith("LLM request ") || attempt >= stepRetries) throw err;
      const delayMs = 250 * 2 ** attempt;
      onEvent({ type: "retrying", reason: "step", attempt: attempt + 1, budget: stepRetries, delayMs });
      await abortableDelay(delayMs, signal);
    }
  }
}

/**
 * Stream one assistant reply from the model, emitting text deltas as they
 * arrive and returning the fully-assembled assistant message. `body` is the
 * prebuilt request body passed down so measurement and send share one object.
 */
async function streamAssistant(config, messages, toolList, onEvent, signal, body = null) {
  onEvent({ type: "assistant_start" });
  const stream = streamChat({
    ...config,
    messages,
    tools: toolList,
    signal,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    // Surface retry backoffs (notably the long quota waits) through the same
    // event channel as everything else.
    onEvent,
    ...(body ? { requestBody: body } : {}),
  });
  let message = null;
  let finishReason = null;
  let usage = null;
  let attemptId = null;
  let aborted = false;
  let partialText = "";
  let partialReasoning = "";
  try {
    for await (const ev of stream) {
      if (ev.type === "text_delta") {
        partialText += ev.delta;
        onEvent({ type: "text_delta", delta: ev.delta });
      } else if (ev.type === "thinking_delta") {
        partialReasoning += ev.delta;
        onEvent({ type: "thinking_delta", delta: ev.delta });
      } else if (ev.type === "usage_report") {
        usage = ev.usage;
        attemptId = ev.attemptId;
        onEvent({ type: "request_usage", attemptId, usage });
      } else if (ev.type === "done") {
        message = ev.message;
        finishReason = ev.finishReason;
        usage = ev.usage ?? null;
        attemptId = ev.attemptId;
        aborted = ev.aborted === true;
      }
    }
  } catch (err) {
    err.partial = { text: partialText, reasoning: partialReasoning };
    if (!err.eventCallbackError) err.operational = true;
    throw err;
  }
  if (!message) {
    const err = new Error("model returned no message");
    err.operational = true;
    err.partial = { text: partialText, reasoning: partialReasoning };
    throw err;
  }
  if (!message.content && !(message.tool_calls?.length > 0) && !aborted && !signal?.aborted) {
    const err = new Error("model returned an empty response");
    err.operational = true;
    err.partial = { text: partialText, reasoning: partialReasoning };
    throw err;
  }
  onEvent({ type: "assistant_stop" });
  return { message, finishReason, usage, attemptId, aborted, partial: { text: partialText, reasoning: partialReasoning } };
}
