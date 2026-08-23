/**
 * A tiny OpenAI-compatible "chat completions" client built on fetch.
 *
 * The one entry point is `streamChat`: a streaming request that yields
 * `text_delta` events and finally a `done` event with the assembled assistant
 * message. It accepts an optional `signal` (AbortSignal) so a long-running
 * turn can be cancelled (e.g. when the user interrupts from the TUI).
 *
 * This is intentionally minimal, but it is the only place that talks to the
 * network, and all turns stream so token usage can be captured.
 */
// Timeout defaults (also the .env.example template). Reasoning models can
// spend a long time "thinking" before the first byte or between chunks, so
// both are generous; mirror the values in src/config.mjs.
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

const CHAT_PATH = "/chat/completions";

import {
  assembleChatMessage,
  createChatStreamState,
  decodeSseChunk,
  foldChatDelta,
  ssePayload,
} from "./sse.mjs";

function buildBody({ model, systemPrompt, messages, tools }) {
  return {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice: "auto",
    // One tool call per model step: sequential, audit-friendly, and it keeps
    // the loop tight (fewer ways for the model to keep generating).
    parallel_tool_calls: false,
    stream: true,
    stream_options: { include_usage: true },
  };
}

async function request({ baseUrl, apiKey, body, signal, requestTimeoutMs, maxRetries: configuredRetries }) {
  const timeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = configuredRetries ?? 0;
  const url = `${baseUrl.replace(/\/+$/, "")}${CHAT_PATH}`;

  for (let attempt = 0; ; attempt++) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (res.ok) return { response: res, timeoutSignal };

      const responseText = await res.text();
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`LLM request failed (${res.status}): ${responseText.slice(0, 500)}`);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeoutSignal.aborted) {
        if (attempt >= maxRetries) throw new Error(`LLM request timed out after ${timeoutMs}ms`);
      } else if (/^LLM request failed \(\d+\):/.test(err.message)) {
        throw err;
      } else if (attempt >= maxRetries) {
        throw err;
      }
    }

    await abortableDelay(250 * 2 ** attempt, signal);
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * Race a reader.read() against an idle timeout. Returns `{ done, value }` on
 * success or throws if the idle timeout fires first (without aborting the
 * user's cancellation signal).
 */
async function readWithIdleTimeout(reader, idleTimeoutMs, signal) {
  if (idleTimeoutMs == null || idleTimeoutMs <= 0) {
    return reader.read();
  }
  const idleSignal = AbortSignal.timeout(idleTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, idleSignal]) : idleSignal;

  // Race the read against the idle timeout.
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // If the user signal aborted, propagate as an abort error.
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      } else {
        // Idle timeout fired.
        reject(new Error(`LLM stream idle timeout after ${idleTimeoutMs}ms`));
      }
    };
    combined.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      combined.removeEventListener("abort", onAbort);
    };

    reader.read().then(
      (result) => settle(resolve, result),
      (err) => settle(reject, err)
    );
  });
}

/**
 * Streaming chat. Yields:
 *   { type: "text_delta", delta }          as text arrives
 *   { type: "done", message, finishReason, usage } at the end
 *
 * Tool calls are streamed in pieces (id + name + chunks of arguments); we
 * aggregate them and emit them only in the `done` event, fully assembled.
 *
 * If `signal` aborts at any point (even during the initial request), we stop
 * and yield a final `{ type: "done", aborted: true, message }`.
 *
 * The initial request uses `requestTimeoutMs` (default 600s) to cover slow
 * reasoning models. Once streaming begins, an idle timeout
 * (`streamIdleTimeoutMs`, default 300s) resets on each chunk so we only abort
 * if the server stops sending data.
 */
export async function* streamChat({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  tools,
  signal,
  requestTimeoutMs,
  streamIdleTimeoutMs,
  maxRetries,
}) {
  const body = buildBody({ model, systemPrompt, messages, tools });
  let state = createChatStreamState();
  let timeoutSignal = null;
  const idleTimeoutMs = streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  try {
    const requested = await request({ baseUrl, apiKey, body, signal, requestTimeoutMs, maxRetries });
    const res = requested.response;
    timeoutSignal = requested.timeoutSignal;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs, signal);
      if (done) break;

      // Frame the chunk into complete `data:` lines; keep the trailing partial
      // line for the next chunk.
      const { lines, rest } = decodeSseChunk(buffer, decoder.decode(value, { stream: true }));
      buffer = rest;

      for (const line of lines) {
        const data = ssePayload(line);
        if (data == null) continue; // comments, heartbeats, events without data
        if (data === "[DONE]") {
          yield { type: "done", finishReason: state.finishReason, usage: state.usage, message: assembleChatMessage(state) };
          return;
        }

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // ignore partial/heartbeat lines
        }

        const { state: next, events } = foldChatDelta(state, json);
        state = next;
        for (const ev of events) yield ev;
      }
    }

    // Stream ended without [DONE] sentinel; still emit what we assembled.
    yield { type: "done", finishReason: state.finishReason, usage: state.usage, message: assembleChatMessage(state) };
  } catch (err) {
    if (timeoutSignal?.aborted && !signal?.aborted) {
      throw new Error(`LLM request timed out after ${requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms`);
    }
    if (/LLM stream idle timeout after/.test(err?.message ?? "")) {
      throw err;
    }
    if (signal?.aborted || err?.name === "AbortError") {
      yield { type: "done", aborted: true, finishReason: state.finishReason, usage: state.usage, message: assembleChatMessage(state) };
      return;
    }
    throw err;
  }
}
