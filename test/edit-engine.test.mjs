import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEditsToContent,
  normalizeLineEndings,
  detectLineEnding,
  restoreLineEndings,
  normalizeForFuzzy,
} from "../src/edit-engine.mjs";

test("content mode: exact replacement is byte-faithful", () => {
  const r = applyEditsToContent("a\nb\nc\n", [{ old: "b", new: "X" }], false);
  assert.equal(r.error, undefined);
  assert.equal(r.newContent, "a\nX\nc\n");
  assert.equal(r.usedFuzzy, false);
  assert.equal(r.replacements, 1);
});

test("fuzzy mode: smart quotes, trailing whitespace, and read gutters match", () => {
  const content = "const s = 'fine';\nconst t = 'also';\n";
  const r = applyEditsToContent(content, [{ old: "  12 │ const s = ‘fine’;  ", new: "const s = 'ok';" }], false);
  assert.equal(r.error, undefined);
  assert.equal(r.newContent, "const s = 'ok';\nconst t = 'also';\n");
  assert.equal(r.usedFuzzy, true);
  // Untouched lines keep their original bytes even after a fuzzy run.
  assert.ok(r.newContent.includes("const t = 'also';"));
});

test("ambiguous old strings error unless all=true", () => {
  const ambiguous = applyEditsToContent("x\ny\nx\n", [{ old: "x", new: "z" }], false);
  assert.match(ambiguous.error, /occurs 2 times/);
  const all = applyEditsToContent("x\ny\nx\n", [{ old: "x", new: "z" }], true);
  assert.equal(all.error, undefined);
  assert.equal(all.newContent, "z\ny\nz\n");
  assert.equal(all.replacements, 2);
});

test("missing old strings explain how to recover", () => {
  const r = applyEditsToContent("hello\n", [{ old: "goodbye", new: "x" }], false);
  assert.match(r.error, /old string not found/);
});

test("line-range mode: replace, insert before, and delete whole lines", () => {
  assert.equal(applyEditsToContent("1\n2\n3\n", [{ startLine: 2, endLine: 2, new: "TWO" }], false).newContent, "1\nTWO\n3\n");
  assert.equal(applyEditsToContent("1\n2\n3\n", [{ startLine: 1, endLine: 0, new: "zero" }], false).newContent, "zero\n1\n2\n3\n");
  assert.equal(applyEditsToContent("1\n2\n3\n", [{ startLine: 2, endLine: 2, new: "" }], false).newContent, "1\n3\n");
});

test("range edits validate bounds against the file", () => {
  assert.match(applyEditsToContent("1\n2\n", [{ startLine: 9, endLine: 9, new: "x" }], false).error, /out of bounds/);
  assert.match(applyEditsToContent("1\n", [{ startLine: 5, endLine: 4, new: "x" }], false).error, /cannot insert before line 5/);
});

test("overlapping edits are rejected rather than corrupting the file", () => {
  const r = applyEditsToContent("abc\n", [{ old: "ab", new: "AB" }, { old: "bc", new: "BC" }], false);
  assert.match(r.error, /overlap/);
});

test("an edit that changes nothing is reported as an error", () => {
  const r = applyEditsToContent("abc\n", [{ old: "abc", new: "abc" }], false);
  assert.match(r.error, /identical content/);
});

test("line endings: detect, normalise, restore", () => {
  assert.equal(detectLineEnding("a\r\nb\r\n"), "\r\n");
  assert.equal(detectLineEnding("a\nb\n"), "\n");
  assert.equal(normalizeLineEndings("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(restoreLineEndings("a\nb\n", "\r\n"), "a\r\nb\r\n");
});

test("normalizeForFuzzy strips read gutters and folds punctuation", () => {
  assert.equal(normalizeForFuzzy("  42 │ const x = 1"), "const x = 1");
  assert.equal(normalizeForFuzzy("it\u2019s\u00a0fine"), "it's fine");
});

test("fuzzy matching rejects a needle that normalizes to empty", () => {
  const result = applyEditsToContent("abc\n", [{ old: "1 │ ", new: "x" }], false);
  assert.match(result.error, /becomes empty/);
});

test("fuzzy replacement preserves unrelated punctuation and whitespace on the touched line", () => {
  const result = applyEditsToContent("“hello” tail—  \n", [{ old: '"hello"', new: "hi" }], false);
  assert.equal(result.newContent, "hi tail—  \n");
  assert.equal(result.usedFuzzy, true);
});

test("fuzzy matching normalizes combining sequences without losing original offsets", () => {
  const result = applyEditsToContent("cafe\u0301 — keep\n", [{ old: "café -", new: "changed" }], false);
  assert.equal(result.newContent, "changed keep\n");
  assert.equal(result.usedFuzzy, true);
});

test("one fuzzy item does not broaden another exact item", () => {
  const content = 'He said "hello"\nHe said “hello”\ntarget  \n';
  const result = applyEditsToContent(content, [
    { old: 'He said "hello"', new: "ASCII only" },
    { old: "target\n", new: "done\n" },
  ], false);
  assert.equal(result.newContent, 'ASCII only\nHe said “hello”\ndone\n');
});
