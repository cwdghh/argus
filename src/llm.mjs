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
 *
 * Two DashScope-specific extensions live here, both opt-in via config:
 *   - Explicit context cache (`contextCache`): stamps `cache_control` markers
 *     on the system message and the newest message so the backend creates and
 *     re-reads 5-minute cache blocks (see buildBody).
 *   - Quota retries (`quotaRetries`/`quotaRetryDelayMs`): HTTP 429 errors with
 *     code `insufficientquota` get their own, longer backoff because a quota
 *     reset is slower than a rate-limit burst.
 */
// Timeout defaults (also the .env.example template). Reasoning models can
// spend a long time "thinking" before the first byte or between chunks, so
// both are generous; mirror the values in src/config.mjs.
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_QUOTA_RETRY_DELAY_MS = 10_000;

const CHAT_PATH = "/chat/completions";

// Units of the messages array that may carry a cache marker (Aliyun docs:
// system, user, assistant, and tool messages; tool *definitions* cannot be
// marked, they ride along inside the system message's cache block).
const CACHEABLE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const EXHAUSTED_MARKER = /^LLM request failed \(\d+\):/;

import {
  assembleChatMessage,
  createChatStreamState,
  decodeSseChunk,
  foldChatDelta,
  ssePayload,
} from "./sse.mjs";

/**
 * Build the chat-completions request body.
 *
 * When `contextCache` is enabled, two `cache_control` markers are added
 * (DashScope explicit cache, max four per request):
 *
 *   1. On the system message (covers the system prompt AND the tool schemas,
 *      which DashScope folds into the system message for cache accounting —
 *      the most stable prefix across *every* request).
 *   2. On the newest message (a rolling marker: each request caches everything
 *      up to the end, so the next request of a multi-turn session or a
 *      multi-step tool-calling loop re-reads it instead of reprocessing it).
 *
 * Remember to put shared content at the front: a cache hit is a *prefix* hit,
 * and marker lookback is limited to 20 content blocks. Markers require
 * content-block message shapes, so only the marked message is rewritten to an
 * array; everything else keeps the plain string form.
 */
export function buildBody({ model, systemPrompt, messages, tools, contextCache }) {
  const system = contextCache
    ? { role: "system", content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }] }
    : { role: "system", content: systemPrompt };
  const bodyMessages = contextCache ? markNewestMessage(messages) : messages;
  return {
    model,
    messages: [system, ...bodyMessages],
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

/** Rewrite only the newest message so it carries a rolling cache marker. */
function markNewestMessage(messages) {
  if (messages.length === 0) return messages;
  const copy = messages.slice();
  const last = copy.length - 1;
  const message = copy[last];
  if (!CACHEABLE_ROLES.has(message.role)) return copy;
  const content = message.content;
  if (content == null) return copy; // e.g. assistant message with tool_calls
  if (Array.isArray(content)) {
    const tail = content[content.length - 1];
    if (!tail || typeof tail !== "object" || tail.type !== "text") return copy;
    const next = content.slice();
    next[next.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
    copy[last] = { ...message, content: next };
    return copy;
  }
  copy[last] = {
    ...message,
    content: [{ type: "text", text: String(content), cache_control: { type: "ephemeral" } }],
  };
  return copy;
}

/** Pull the machine-readable error code out of a DashScope/OpenAI error body. */
function errorCode(responseText) {
  if (!responseText) return null;
  try {
    return JSON.parse(responseText)?.error?.code ?? null;
  } catch {
    return null;
  }
}

function requestError(res, responseText) {
  return new Error(`LLM request failed (${res.status}): ${responseText.slice(0, 500)}`);
}

async function request({ baseUrl, apiKey, body, signal, requestTimeoutMs, maxRetries, quotaRetries, quotaRetryDelayMs, onEvent }) {
  const timeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const genericBudget = maxRetries ?? 0;
  const quotaBudget = quotaRetries ?? 0;
  const quotaDelayMs = quotaRetryDelayMs ?? DEFAULT_QUOTA_RETRY_DELAY_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}${CHAT_PATH}`;

  for (let generic = 0, quota = 0; ; ) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let backoffMs;
    let retryKind;
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
      // A 429 can mean "slow down" (rate limit) or "you are out of money"
      // (insufficient quota). Only the latter gets the longer quota backoff —
      // repeat users of a resetting quota often just need a longer wait than
      // the generic 250ms-doubling schedule would ever give them.
      const isQuota = res.status === 429 && errorCode(responseText) === "insufficientquota";
      if (isQuota) {
        if (quota >= quotaBudget) throw requestError(res, responseText);
        retryKind = "quota";
        quota++;
        backoffMs = quotaDelayMs * 2 ** (quota - 1);
      } else {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!retryable || generic >= genericBudget) throw requestError(res, responseText);
        retryKind = "retry";
        generic++;
        backoffMs = 250 * 2 ** (generic - 1);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeoutSignal.aborted) {
        if (generic >= genericBudget) throw new Error(`LLM request timed out after ${timeoutMs}ms`);
        generic++;
        retryKind = "retry";
        backoffMs = 250 * 2 ** (generic - 1);
      } else if (EXHAUSTED_MARKER.test(err.message)) {
        // Both budgets spent: the error was already wrapped with its status.
        throw err;
      } else if (generic >= genericBudget) {
        throw err;
      } else {
        generic++;
        retryKind = "retry";
        backoffMs = 250 * 2 ** (generic - 1);
      }
    }

    onEvent?.({
      type: "retrying",
      reason: retryKind,
      attempt: retryKind === "quota" ? quota : generic,
      budget: retryKind === "quota" ? quotaBudget : genericBudget,
      delayMs: backoffMs,
    });
    await abortableDelay(backoffMs, signal);
  }
}

export function abortableDelay(ms, signal) {
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
 *
 * When the race is lost the reader is cancelled so the underlying connection is
 * torn down; otherwise the pending read() would leak the open body for as long
 * as the server keeps the stream alive.
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
    const cleanup = () => {
      combined.removeEventListener("abort", onAbort);
    };
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    const onAbort = () => {
      if (settled) return;
      // Settle the race BEFORE tearing down: cancel() resolves the pending
      // read() as {done:true}, which would swallow the error below if it
      // settled first.
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      } else {
        // Idle timeout fired.
        reject(new Error(`LLM stream idle timeout after ${idleTimeoutMs}ms`));
      }
      // Cancel the pending read so the underlying connection is torn down
      // instead of staying open for however long the server holds the stream.
      reader.cancel().catch(() => {
        // the request may already be gone; nothing left to tear down
      });
    };
    combined.addEventListener("abort", onAbort, { once: true });

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
  contextCache,
  quotaRetries,
  quotaRetryDelayMs,
  onEvent,
  // A prebuilt body (agent.mjs measures the payload it sends, so it builds the
  // body once and hands it over; without it, the body is built here as ever).
  requestBody = null,
}) {
  const body = requestBody ?? buildBody({ model, systemPrompt, messages, tools, contextCache });
  let state = createChatStreamState();
  let timeoutSignal = null;
  const idleTimeoutMs = streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  try {
    const requested = await request({
      baseUrl,
      apiKey,
      body,
      signal,
      requestTimeoutMs,
      maxRetries,
      quotaRetries,
      quotaRetryDelayMs,
      onEvent,
    });
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
