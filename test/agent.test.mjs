import test from "node:test";
import assert from "node:assert/strict";
import { createMockServer } from "./helpers/mock-llm.mjs";
import { runTurn } from "../src/agent.mjs";

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
