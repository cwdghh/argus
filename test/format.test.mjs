import test from "node:test";
import assert from "node:assert/strict";
import { summarize, formatDuration, formatChars, formatTokens } from "../src/format.mjs";

test("formatDuration: sub-second, seconds, minutes, and hours", () => {
  assert.equal(formatDuration(0), "0.0s");
  assert.equal(formatDuration(50), "<0.1s");
  assert.equal(formatDuration(3_200), "3.2s");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_660_000), "1h 01m");
});

test("formatChars: human counts", () => {
  assert.equal(formatChars(999), "999");
  assert.equal(formatChars(1_234), "1.2K");
  assert.equal(formatChars(3_400_000), "3.4M");
});

test("formatTokens: prompt/completion with optional reasoning + cached", () => {
  assert.equal(formatTokens(null), null);
  assert.equal(formatTokens({ total_tokens: 120 }), null, "missing pi counts -> null");
  assert.equal(formatTokens({ total_tokens: 1_600, prompt_tokens: 1_000, completion_tokens: 600 }), "↑1.0K ↓600");
  assert.equal(
    formatTokens({ total_tokens: 2_000, prompt_tokens: 1_000, completion_tokens: 1_000, reasoning_tokens: 400, cached_tokens: 300 }),
    "↑1.0K ↓1.0K ✶400 ≡300"
  );
});

test("summarize: prefers stdout, then content, then ok payload", () => {
  assert.equal(summarize({ error: true, message: "boom" }), "boom");
  assert.equal(summarize({ stdout: "hello world\nnext\n" }), "stdout: hello world");
  assert.equal(summarize({ stdout: "" }), "ok (no output)");
  assert.equal(summarize({ content: "line one\nline two" }), "line one");
  assert.equal(summarize({ ok: true, matched: 3 }), "matched: 3 — ok");
  assert.equal(summarize({ ok: true }), "ok");
  assert.equal(summarize(null), "");
});
