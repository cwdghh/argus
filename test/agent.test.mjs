import test from "node:test";
import assert from "node:assert/strict";
import { createMockServer } from "./helpers/mock-llm.mjs";
import { runTurn, executeToolCall, accumulateUsage } from "../src/agent.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = (srv) => ({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" });

test("text-only turn returns the streamed content", async (t) => {
  const srv = await createMockServer(() => [{ content: "**ok**" }]);
  t.after(() => srv.close());
  const { finalText, aborted, messages } = await runTurn(config(srv), [], "hi", () => {});
  assert.equal(finalText, "**ok**");
  assert.equal(aborted, false);
  assert.equal(messages.length, 2); // user + assistant
});

test("tool call then final text feeds results back", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] }];
    }
    return [{ content: "done" }];
  });
  t.after(() => srv.close());
  const seen = [];
  const { finalText, messages } = await runTurn(config(srv), [], "go", (e) => seen.push(e.type));
  assert.equal(finalText, "done");
  assert.equal(srv.calls(), 2);
  assert.ok(seen.includes("tool_call") && seen.includes("tool_result"));
  assert.ok(messages.some((m) => m.role === "tool"), "tool result present in messages");
});

test("abort mid-stream returns aborted without incomplete reply", async (t) => {
  const srv = await createMockServer(() => [{ content: "a" }, { delay: 500 }, { content: "b" }]);
  t.after(() => srv.close());
  const ac = new AbortController();
  const p = runTurn(config(srv), [], "hi", () => {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const res = await p;
  assert.equal(res.aborted, true);
  assert.equal(res.finalText, "");
});

test("persistent cwd: cd then pwd", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"cd src"}' } }] }];
    if (i === 1) return [{ tool_calls: [{ index: 0, id: "c2", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }];
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  const { cwd } = await runTurn(config(srv), [], "cd", () => {}, { cwd: process.cwd() });
  assert.equal(cwd, new URL("../src", import.meta.url).pathname, "cwd should be <repo>/src");
});

test("executeToolCall: unknown tool, unparseable args, and a clean run", async () => {
  const events = [];
  const emit = (e) => events.push(e);

  const unknown = await executeToolCall({ id: "1", function: { name: "nope", arguments: "{}" } }, { cwd: process.cwd(), maxToolResultChars: 50_000, onEvent: emit });
  assert.equal(unknown.result.error, true);
  assert.match(unknown.result.message, /unknown tool/);

  const badJson = await executeToolCall({ id: "2", function: { name: "bash", arguments: "not json" } }, { cwd: process.cwd(), maxToolResultChars: 50_000, onEvent: emit });
  assert.equal(badJson.result.error, true);
  assert.match(badJson.result.message, /not valid JSON/);

  const ok = await executeToolCall({ id: "3", function: { name: "bash", arguments: JSON.stringify({ command: "printf ok" }) } }, { cwd: process.cwd(), maxToolResultChars: 50_000, onEvent: emit });
  assert.equal(ok.result.error, undefined);
  assert.match(ok.result.stdout, /ok/);
  assert.equal(ok.cwd, process.cwd());

  assert.equal(events[0].type, "tool_call");
  assert.equal(events[1].type, "tool_result");
});

test("executeToolCall: a bash cd updates the returned cwd", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "argus-ctc-"));
  const { result, cwd } = await executeToolCall(
    { id: "c", function: { name: "bash", arguments: JSON.stringify({ command: `cd "${tmp}"` }) } },
    { cwd: process.cwd(), maxToolResultChars: 50_000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(cwd, tmp);
  rmSync(tmp, { recursive: true, force: true });
});

test("accumulateUsage sums members and reports reasoning/cached when present", () => {
  assert.equal(accumulateUsage(null, null), null);
  assert.equal(accumulateUsage(null, { prompt_tokens: "nope" }), null);
  const a = accumulateUsage(null, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    completion_tokens_details: { reasoning_tokens: 2 },
    prompt_tokens_details: { cached_tokens: 3 },
  });
  assert.deepEqual(a, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 2, cached_tokens: 3 });
  const b = accumulateUsage(a, { prompt_tokens: 90, completion_tokens: 95, total_tokens: 185 });
  assert.deepEqual(b, { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, reasoning_tokens: 2, cached_tokens: 3 });
  // A call with no reasoning/cached fields leaves those totals unchanged.
  assert.equal(b.reasoning_tokens + b.cached_tokens, 5);
});
