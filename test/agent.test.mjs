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

test("multi-step usage reports the largest context, never a per-step sum", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [
        { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
        { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } }] },
      ];
    }
    return [
      { usage: { prompt_tokens: 130, completion_tokens: 25, total_tokens: 155 } },
      { content: "done" },
    ];
  });
  t.after(() => srv.close());
  const seen = [];
  const { finalText, usage } = await runTurn(config(srv), [], "go", (e) => {
    if (e.type === "usage") seen.push(e.usage);
  });
  assert.equal(finalText, "done");
  // The second request's prompt (130) already includes the first request's
  // context, so 100 + 130 = 230 would count the shared history twice. The
  // accumulated prompt is the largest context sent; only completion sums.
  assert.equal(usage.prompt_tokens, 130);
  assert.equal(usage.completion_tokens, 35); // 10 + 25
  assert.equal(usage.total_tokens, 165); // 130 + 35
  assert.deepEqual(seen[0], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, reasoning_tokens: 0, cached_tokens: 0 });
  assert.deepEqual(seen[1], { prompt_tokens: 130, completion_tokens: 35, total_tokens: 165, reasoning_tokens: 0, cached_tokens: 0 });
});

test("an interrupted turn records only the steps that reported usage", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [
        { usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } },
        { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } }] },
      ];
    }
    return [{ content: "a" }, { delay: 500 }, { content: "b" }];
  });
  t.after(() => srv.close());
  const ac = new AbortController();
  const p = runTurn(config(srv), [], "go", () => {}, { signal: ac.signal });
  // Let the first model step finish (and report usage) — wait until the client
  // has actually issued the second request — then abort mid-way through the
  // second stream, whose usage never arrives.
  const deadline = Date.now() + 2_000;
  while (srv.calls() < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(srv.calls() >= 2, "second model request never started");
  ac.abort();
  const res = await p;
  assert.equal(res.aborted, true);
  assert.deepEqual(res.usage, { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, reasoning_tokens: 0, cached_tokens: 0 });
});

test("real last-request tokens trigger compaction before the next turn", async (t) => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}`.repeat(40) });
  }
  let lastBody = null;
  const ev = [];
  const srv = await createMockServer((i, body) => {
    lastBody = body;
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  await runTurn(
    { baseUrl: srv.url, apiKey: "", model: "m", systemPrompt: "s" },
    history,
    "new",
    (e) => ev.push(e.type),
    { lastTokens: 200_000, keepTurns: 3 }
  );
  assert.ok(ev.includes("compacted"), "a real 200k-token context compacts before the next turn");
  assert.ok(
    lastBody.messages.some((m) => m.role === "system" && /Summary of earlier/.test(m.content)),
    "the compacted summary reaches the model",
  );
  const users = lastBody.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["q7", "q8", "q9", "new"], "only recent turns + the new prompt are sent");

  const ev2 = [];
  const srv2 = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv2.close());
  await runTurn(
    { baseUrl: srv2.url, apiKey: "", model: "m", systemPrompt: "s" },
    history,
    "again",
    (e) => ev2.push(e.type),
    { lastTokens: 1_000, keepTurns: 3 }
  );
  assert.ok(!ev2.includes("compacted"), "a small real context does not compact");
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

test("accumulateUsage never counts shared context more than once", () => {
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

  // The second request re-sends the same 10-token context plus 80 new tokens.
  // `prompt_tokens` stays at the largest context sent (never the sum, which
  // would count the shared history once per model step); only `completion`
  // accumulates, since each step's output tokens are distinct.
  const b = accumulateUsage(a, { prompt_tokens: 90, completion_tokens: 95, total_tokens: 185 });
  assert.deepEqual(b, { prompt_tokens: 90, completion_tokens: 100, total_tokens: 190, reasoning_tokens: 2, cached_tokens: 3 });

  // Even a request whose prompt does not grow leaves the running context
  // untouched — the re-sent history is never counted repeatedly.
  const c = accumulateUsage(b, { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
  assert.deepEqual(c, { prompt_tokens: 90, completion_tokens: 110, total_tokens: 200, reasoning_tokens: 2, cached_tokens: 3 });
  // A call with no reasoning/cached fields leaves those totals unchanged.
  assert.equal(c.reasoning_tokens + c.cached_tokens, 5);
});
