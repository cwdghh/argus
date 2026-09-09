import test from "node:test";
import assert from "node:assert/strict";
import { appendBlock, consumeAgentEvent } from "../src/transcript.mjs";

test("appendBlock folds consecutive deltas of the same kind", () => {
  const blocks = [];
  appendBlock(blocks, "assistant", "Hel");
  appendBlock(blocks, "assistant", "lo");
  assert.deepEqual(blocks, [{ kind: "assistant", text: "Hello" }]);
});

test("appendBlock starts a new block when the kind changes", () => {
  const blocks = [];
  appendBlock(blocks, "thinking", "hmm");
  appendBlock(blocks, "assistant", "ok");
  assert.deepEqual(blocks, [
    { kind: "thinking", text: "hmm" },
    { kind: "assistant", text: "ok" },
  ]);
  // Repeating the previous kind after a change still folds into the *latest* block.
  appendBlock(blocks, "assistant", "!");
  assert.equal(blocks.at(-1).text, "ok!");
});

test("consumeAgentEvent projects one turn into the blocks both frontends persist", () => {
  const blocks = [];
  const events = [
    { type: "thinking_delta", delta: "hmm" },
    { type: "tool_call", name: "read", args: { path: "a.txt" }, id: "c1" },
    { type: "tool_result", ok: true, result: { numberedText: "1 │ one\n2 │ two" }, id: "c1" },
    { type: "text_delta", delta: "done" },
    { type: "compacted" },
    { type: "retrying", reason: "retry", attempt: 1, budget: 2, delayMs: 1000 },
    { type: "approval", tool: "bash", cwd: "/x", reason: "destructive", approved: true },
    { type: "approval", tool: "bash", cwd: "/x", reason: "destructive", approved: false },
    { type: "cwd_change", cwd: "/y" },
    { type: "usage", usage: { prompt_tokens: 10 } },
  ];
  for (const ev of events) {
    consumeAgentEvent(blocks, ev, { durationMs: ev.type === "tool_result" ? 1250 : undefined });
  }
  assert.deepEqual(blocks, [
    { kind: "thinking", text: "hmm" },
    { kind: "tool", name: "read", label: "read → a.txt", id: "c1" },
    { kind: "result", ok: true, summary: "1 │ one", durationMs: 1250, id: "c1", detail: "1 │ one\n2 │ two" },
    { kind: "assistant", text: "done" },
    { kind: "result", ok: true, summary: "… earlier context compacted" },
    { kind: "result", ok: true, summary: "LLM request failed; retrying (1/2) in 1.0s" },
    { kind: "result", ok: true, summary: "approved bash in /x: destructive" },
  ]);
});

test("consumeAgentEvent is a no-op for frontend-only events", () => {
  const blocks = [];
  consumeAgentEvent(blocks, { type: "user", text: "hi" });
  consumeAgentEvent(blocks, { type: "cwd_change", cwd: "/x" });
  consumeAgentEvent(blocks, { type: "usage", usage: {} });
  consumeAgentEvent(blocks, { type: "assistant_start" });
  assert.deepEqual(blocks, []);
});

test("a preview identical to its one-line summary is not duplicated", () => {
  const blocks = [];
  consumeAgentEvent(blocks, { type: "tool_result", ok: true, result: { numberedText: "1 │ one" } });
  assert.deepEqual(blocks, [{ kind: "result", ok: true, summary: "1 │ one" }]);
});
