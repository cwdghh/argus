import test from "node:test";
import assert from "node:assert/strict";
import { summarize, previewResult, toolLabel, formatDuration, formatChars, formatTokens } from "../src/format.mjs";

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
  assert.equal(
    formatTokens({ total_tokens: 3_600, prompt_tokens: 1_600, completion_tokens: 1_000, cache_creation_input_tokens: 1_600, cached_tokens: 300 }),
    "↑1.6K ↓1.0K ✚1.6K ≡300",
    "cache creation renders between reasoning and cached read"
  );
});

test("summarize: prefers stdout, then numbered read text/content, then ok payload", () => {
  assert.equal(summarize({ error: true, message: "boom" }), "boom");
  assert.equal(summarize({ stdout: "hello world\nnext\n" }), "stdout: hello world");
  assert.equal(summarize({ stdout: "" }), "ok (no output)");
  assert.equal(summarize({ numberedText: "12 │ line one\n13 │ line two" }), "12 │ line one");
  assert.equal(summarize({ content: "line one\nline two" }), "line one");
  assert.equal(summarize({ ok: true, matched: 3 }), "matched: 3 — ok");
  assert.equal(summarize({ ok: true }), "ok");
  assert.equal(summarize(null), "");
});

test("summarize: marks paged and truncated results with the more-lines count", () => {
  assert.equal(
    summarize({ stdout: "step 1 ok\nstep 2 ok", truncated: true, nextOffset: 3001 }),
    "stdout: step 1 ok · … (truncated)"
  );
  assert.equal(
    summarize({ numberedText: "1 │ line one", truncated: true, totalLines: 3000, endLine: 2000 }),
    "1 │ line one · … 1000 more lines"
  );
  assert.equal(summarize({ numberedText: "1 │ line one", totalLines: 200, endLine: 200 }), "1 │ line one", "complete reads get no marker");
});

test("toolLabel: names the path or command, counts content instead of dumping it", () => {
  assert.equal(toolLabel("read", { path: "a.txt" }), "read → a.txt");
  assert.equal(toolLabel("read", { path: "a.txt", limit: 40 }), "read → a.txt");
  assert.equal(toolLabel("bash", { command: "npm run build" }), "bash → npm run build");
  assert.equal(toolLabel("bash", {}), "bash");
  assert.equal(
    toolLabel("write", { path: "src/a.mjs", content: "x".repeat(4_120) }),
    "write → src/a.mjs (content 4.1K chars)"
  );
  assert.equal(toolLabel("edit", { path: "README.md", edits: [{ old: "a", new: "b" }] }), "edit → README.md (edits 1)");
  assert.equal(toolLabel("", {}), "tool");
  const long = toolLabel("read", { path: "p".repeat(100) });
  assert.ok(long.startsWith("read → ") && long.endsWith("…") && long.length <= "read → ".length + 60, "long paths are capped");
});

test("previewResult: capped multi-line preview with a more-lines marker", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const p = previewResult({ stdout: lines.join("\n") });
  assert.ok(p.startsWith("line 1\nline 2"));
  assert.ok(p.includes("line 20"));
  assert.ok(!p.includes("line 21"));
  assert.ok(p.endsWith("… 10 more lines"));
  assert.equal(p.split("\n").length, 21, "20 preview lines + the marker");
});

test("previewResult: paged reads strip the hint and count remaining file lines", () => {
  const inner = Array.from({ length: 500 }, (_, i) => `${i + 1} │ row ${i + 1}`).join("\n");
  const p = previewResult({
    numberedText: inner + "\n\n[Showing lines 1-500 of 3000. Use offset=501 to continue.]",
    totalLines: 3000,
    startLine: 1,
    endLine: 500,
    truncated: true,
    nextOffset: 501,
  });
  assert.ok(!p.includes("[Showing lines"), "the tool's own continuation hint is not repeated");
  assert.ok(p.endsWith("… 2980 more lines"), "3000 total minus the 20 shown");
  assert.equal(p.split("\n").length, 21);
});

test("previewResult: errors and non-text results degrade cleanly", () => {
  assert.equal(previewResult({ error: true, message: "boom" }), "boom");
  assert.equal(previewResult({ error: true, message: "command failed", stdout: "test output", stderr: "failure detail" }),
    "stdout:\ntest output\nstderr:\nfailure detail");
  assert.equal(previewResult({ error: true }), "…");
  assert.equal(previewResult({ ok: true, replacements: 3 }), "");
  assert.equal(previewResult(null), "");
  assert.equal(
    previewResult({ truncated: true, originalChars: 4_000_000, preview: "{}", message: "tool result exceeded 50000 characters" }),
    "… result exceeded the tool-result limit (4.0M chars)"
  );
});
