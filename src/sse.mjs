/**
 * Minimal SSE (text/event-stream) framing + OpenAI chat-completions delta
 * folding, as pure functions.
 *
 * The network layer (src/llm.mjs) owns retries, timeouts, and fetch; this
 * module owns only the wire protocol: splitting a decoded byte stream into
 * complete `data:` lines, turning each JSON payload into chat content, and
 * assembling the final assistant message (including streamed tool-call
 * pieces). Keeping it pure makes the protocol tolerance unit-testable without
 * a socket.
 */

/**
 * Split a decoded chunk into complete lines. Lines arrive across arbitrary
 * chunk boundaries, so the caller keeps the returned `rest` and feeds it to
 * the next call as `buffer`. Tolerates bare `\n` and CRLF (`\r\n`).
 *
 * @returns {{ lines: string[], rest: string }}
 */
export function decodeSseChunk(buffer, text) {
  const combined = buffer + text;
  const lines = [];
  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] === "\n") {
      lines.push(combined.slice(start, i).replace(/\r$/, ""));
      start = i + 1;
    }
  }
  return { lines, rest: combined.slice(start) };
}

/**
 * Extract the payload of one SSE `data:` line (leading whitespace tolerated,
 * like the wire usually sends after `data:`), or null for any other event
 * (comment, heartbeat, etc.).
 */
export function ssePayload(line) {
  const trimmed = String(line).trim();
  return trimmed.startsWith("data:") ? trimmed.slice(5).trim() : null;
}

/** The initial state for a chat-completions stream. */
export function createChatStreamState() {
  return { content: "", finishReason: null, usage: null, toolCalls: new Map() };
}

/**
 * Fold one parsed SSE JSON payload into the streaming state.
 *
 * Tool calls arrive streamed in pieces (id + name + chunks of arguments) and
 * are aggregated here, untouched, so the caller can emit them fully assembled
 * in the terminal `done` event.
 *
 * @returns {{ state: object, events: Array<{type, delta}> }} the next state
 *   and the display events (`text_delta` / `thinking_delta`) to emit
 */
export function foldChatDelta(state, json) {
  const events = [];
  let { content, finishReason, toolCalls, usage } = state;
  if (json.usage) usage = json.usage; // final chunk carries totals when stream_options.include_usage is set

  const choice = json.choices?.[0];
  if (!choice) return { state: { content, finishReason, toolCalls, usage }, events };
  if (choice.finish_reason) finishReason = choice.finish_reason;

  const delta = choice.delta ?? {};
  if (delta.content) {
    content += delta.content;
    events.push({ type: "text_delta", delta: delta.content });
  }
  const thinking = delta.reasoning_content ?? delta.reasoning;
  if (thinking) events.push({ type: "thinking_delta", delta: thinking });

  if (delta.tool_calls) {
    toolCalls = new Map(toolCalls);
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      const cur = toolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      toolCalls.set(idx, cur);
    }
  }

  return { state: { content, finishReason, toolCalls, usage }, events };
}

/**
 * Assemble the final assistant message from the aggregated stream state:
 * a plain-text reply when no tools were requested, or a message with
 * fully-assembled `tool_calls` (ordered by their stream index) when tools were.
 */
export function assembleChatMessage(state) {
  const message = { role: "assistant", content: state.content || null };
  if (state.toolCalls.size > 0) {
    message.tool_calls = [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
  }
  return message;
}
