/**
 * A tiny OpenAI-compatible "chat completions" client built on fetch.
 *
 * Two functions:
 *   - `chat`        : one-shot request, returns the assistant message.
 *   - `streamChat`  : same request with `stream: true`, returns an async
 *                     generator that yields `text_delta` events and finally a
 *                     `done` event with the assembled assistant message.
 *
 * Both accept an optional `signal` (AbortSignal) so a long-running turn can be
 * cancelled (e.g. when the user interrupts from the TUI).
 *
 * This is intentionally minimal, but it is the only place that talks to the
 * network, so both paths live here.
 */
const CHAT_PATH = "/chat/completions";

function buildBody({ model, systemPrompt, messages, tools, stream }) {
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
    ...(stream ? { stream: true } : {}),
  };
}

async function request({ baseUrl, apiKey, body, signal }) {
  const res = await fetch(`${baseUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res;
}

/**
 * One-shot chat. Returns the assistant message object.
 */
export async function chat({ baseUrl, apiKey, model, systemPrompt, messages, tools, signal }) {
  const body = buildBody({ model, systemPrompt, messages, tools, stream: false });
  const res = await request({ baseUrl, apiKey, body, signal });
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("LLM response had no choices");
  return choice.message;
}

/**
 * Streaming chat. Yields:
 *   { type: "text_delta", delta }          as text arrives
 *   { type: "done", message, finishReason } at the end
 *
 * Tool calls are streamed in pieces (id + name + chunks of arguments); we
 * aggregate them and emit them only in the `done` event, fully assembled.
 *
 * If `signal` aborts at any point (even during the initial request), we stop
 * and yield a final `{ type: "done", aborted: true, message }`.
 */
export async function* streamChat({ baseUrl, apiKey, model, systemPrompt, messages, tools, signal }) {
  const body = buildBody({ model, systemPrompt, messages, tools, stream: true });
  let content = "";
  let finishReason = null;
  const toolCalls = new Map(); // index -> { id, name, arguments }

  try {
    const res = await request({ baseUrl, apiKey, body, signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the possibly-incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield {
            type: "done",
            finishReason,
            message: assembleMessage(content, toolCalls),
          };
          return;
        }

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // ignore partial/heartbeat lines
        }
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (delta.content) {
          content += delta.content;
          yield { type: "text_delta", delta: delta.content };
        }
        if (delta.reasoning_content || delta.reasoning) {
          const t = delta.reasoning_content ?? delta.reasoning;
          if (t) yield { type: "thinking_delta", delta: t };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            toolCalls.set(idx, cur);
          }
        }
      }
    }

    // Stream ended without [DONE] sentinel; still emit what we assembled.
    yield {
      type: "done",
      finishReason,
      message: assembleMessage(content, toolCalls),
    };
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      yield { type: "done", aborted: true, finishReason, message: assembleMessage(content, toolCalls) };
      return;
    }
    throw err;
  }
}

function assembleMessage(content, toolCalls) {
  const message = { role: "assistant", content: content || null };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.values()].map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return message;
}
