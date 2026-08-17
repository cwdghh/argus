import test from "node:test";
import assert from "node:assert/strict";
import { appendBlock } from "../src/transcript.mjs";

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
