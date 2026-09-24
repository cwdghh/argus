import test from "node:test";
import assert from "node:assert/strict";
import { detectCallLoop, protocolSafeMessages } from "../src/agent/turn-state.mjs";

const call = (id) => ({ id, type: "function", function: { name: "read", arguments: '{"path":"x"}' } });

test("missing results pair with their own reply even when later calls reuse ids", () => {
  const laterResult = { role: "tool", tool_call_id: "same", content: '{"ok":true}' };
  const messages = protocolSafeMessages([
    { role: "assistant", tool_calls: [call("same")] },
    { role: "user", content: "next turn" },
    { role: "assistant", tool_calls: [call("same")] },
    laterResult,
  ]);
  assert.equal(JSON.parse(messages[1].content).error, true);
  assert.equal(messages[2].role, "user");
  assert.equal(messages[4], laterResult);
});

test("partially executed batches preserve each result beside its own call", () => {
  const executed = { role: "tool", tool_call_id: "first", content: '{"ok":true}' };
  const messages = protocolSafeMessages([
    { role: "assistant", tool_calls: [call("first"), call("second")] }, executed,
  ]);
  assert.equal(messages[1], executed);
  assert.equal(messages[2].tool_call_id, "second");
  assert.equal(JSON.parse(messages[2].content).error, true);
});

test("a different call can break an alternating no-progress cycle", () => {
  const pair = (name) => ({ name, callKey: name, key: `${name}\0unchanged` });
  const window = ["a", "b", "a", "b", "a", "b"].map(pair);
  assert.equal(detectCallLoop("a", window).period, 2);
  assert.equal(detectCallLoop("useful-next-step", window), null);
});
