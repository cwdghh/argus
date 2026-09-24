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
      onEvent(ev);
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
      if (signal?.aborted || sawContent || err?.message?.startsWith("LLM request ") || attempt >= stepRetries) throw err;
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
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      onEvent({ type: "text_delta", delta: ev.delta });
    } else if (ev.type === "thinking_delta") {
      onEvent({ type: "thinking_delta", delta: ev.delta });
    } else if (ev.type === "done") {
      message = ev.message;
      finishReason = ev.finishReason;
      usage = ev.usage ?? null;
    }
  }
  if (!message) throw new Error("model returned no message");
  if (!message.content && !(message.tool_calls?.length > 0) && !signal?.aborted) {
    throw new Error("model returned an empty response");
  }
  onEvent({ type: "assistant_stop" });
  return { message, finishReason, usage };
}
