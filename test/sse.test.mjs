import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeSseChunk,
  ssePayload,
  createChatStreamState,
  foldChatDelta,
  assembleChatMessage,
} from "../src/sse.mjs";

test("decodeSseChunk splits lines across chunk boundaries and tolerates CRLF", () => {
  const first = decodeSseChunk("", 'data: {"a":1}\n\ndata: par');
  assert.deepEqual(first.lines, ['data: {"a":1}', ""]);
  assert.equal(first.rest, "data: par");

  const second = decodeSseChunk(first.rest, 'tial\r\n\r\ndata: [DONE]\n');
  assert.deepEqual(second.lines, ["data: partial", "", "data: [DONE]"]);
  assert.equal(second.rest, "");
});

test("ssePayload extracts only data: events", () => {
  assert.equal(ssePayload('data: {"x":1}'), '{"x":1}');
  assert.equal(ssePayload("data:  hello "), "hello");
  assert.equal(ssePayload(": comment"), null);
  assert.equal(ssePayload("event: foo"), null);
  assert.equal(ssePayload(""), null);
});

test("foldChatDelta accumulates text, thinking, usage, and finish reason", () => {
  let state = createChatStreamState();
  let out;

  ({ state, events: out } = foldChatDelta(state, { choices: [{ delta: { role: "assistant", content: "Hel" } }] }));
  assert.deepEqual(out, [{ type: "text_delta", delta: "Hel" }]);
  assert.equal(state.content, "Hel");

  ({ state, events: out } = foldChatDelta(state, {
    choices: [{ delta: { content: "lo", reasoning_content: "hmm" } }],
  }));
  assert.deepEqual(out, [
    { type: "text_delta", delta: "lo" },
    { type: "thinking_delta", delta: "hmm" },
  ]);
  assert.equal(state.content, "Hello");
  assert.equal(state.finishReason, null);

  ({ state, events: out } = foldChatDelta(state, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { total_tokens: 12 },
  }));
  assert.equal(state.finishReason, "stop");
  assert.equal(state.usage.total_tokens, 12);
  assert.deepEqual(out, []);
});

test("foldChatDelta aggregates streamed tool calls by index", () => {
  let state = createChatStreamState();

  ({ state } = foldChatDelta(state, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{\"com" } }] } }],
  }));
  ({ state } = foldChatDelta(state, {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "mand\":\"pwd\"}" } }] } }],
  }));

  const message = assembleChatMessage(state);
  assert.deepEqual(message.tool_calls, [
    { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } },
  ]);
  // Content stays null when only tools were requested.
  assert.equal(message.content, null);
});

test("assembleChatMessage returns a plain text message when no tools were requested", () => {
  const state = createChatStreamState();
  const withContent = { ...state, content: "hi" };
  assert.deepEqual(assembleChatMessage(withContent), { role: "assistant", content: "hi" });
  assert.deepEqual(assembleChatMessage(state), { role: "assistant", content: null });
});
