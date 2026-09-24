import test from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../src/agent.mjs";
import { accumulateUsage } from "../src/agent/usage.mjs";
import { buildBody } from "../src/llm.mjs";
import { runHeadless } from "../src/headless.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

const config = (srv, extra = {}) => ({
  baseUrl: `${srv.url}/`,
  apiKey: "",
  model: "mock",
  systemPrompt: "s",
  ...extra,
});

test("buildBody adds cache markers only when contextCache is on", () => {
  const plain = buildBody({ model: "mock", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(plain.messages[0].content, "s");
  assert.deepEqual(plain.messages[1], { role: "user", content: "hi" });

  const cached = buildBody({ model: "mock", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [], contextCache: true });
  assert.deepEqual(cached.messages[0], { role: "system", content: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] });
  assert.deepEqual(cached.messages[1], { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] });
});

test("contextCache stamps the system + newest message only, never intermediate ones", async (t) => {
  const bodies = [];
  const srv = await createMockServer((i, body) => {
    bodies.push(body.messages);
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } }] }];
    }
    return [{ content: "done" }];
  });
  t.after(() => srv.close());
  const { finalText } = await runTurn(config(srv, { contextCache: true }), [], "go");
  assert.equal(finalText, "done");

  // Request 1: system + user, both marked.
  const [m1] = bodies;
  assert.deepEqual(m1[0], { role: "system", content: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] });
  assert.deepEqual(m1[1], { role: "user", content: [{ type: "text", text: "go", cache_control: { type: "ephemeral" } }] });

  // Request 2: the newest message is the tool result; it carries the rolling
  // marker while earlier messages keep their plain string shapes.
  const [m2] = bodies.slice(-1);
  const toolMsg = m2.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.ok(Array.isArray(toolMsg.content), "tool content rewritten to blocks to carry the marker");
  assert.equal(toolMsg.content[0].type, "text");
  assert.deepEqual(toolMsg.content[0].cache_control, { type: "ephemeral" });
  const userMsg = m2.find((m) => m.role === "user");
  assert.equal(typeof userMsg.content, "string", "intermediate messages are not rewritten");
});

test("cache creation tokens are accumulated alongside cached reads", () => {
  const u = accumulateUsage(null, {
    prompt_tokens: 1600,
    completion_tokens: 100,
    total_tokens: 1700,
    prompt_tokens_details: { cache_creation_input_tokens: 1605, cached_tokens: 1500 },
  });
  assert.equal(u.cache_creation_input_tokens, 1605);
  assert.equal(u.cached_tokens, 1500);
  // A later, smaller creation does not pull the running total back down.
  const v = accumulateUsage(u, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(v.cache_creation_input_tokens, 1605);
});

test("HTTP 429 insufficient-quota retries on its own budget, independent of ARGUS_MAX_RETRIES", async (t) => {
  const events = [];
  const srv = await createMockServer((i) => {
    if (i < 2) return { status: 429, body: { error: { code: "insufficientquota", message: "You exceeded your current quota" } } };
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  const res = await runTurn(config(srv, { maxRetries: 0, quotaRetries: 2, quotaRetryDelayMs: 1 }), [], "go", (e) => {
    if (e.type === "retrying") events.push(e);
  });
  assert.equal(res.finalText, "ok");
  assert.equal(srv.calls(), 3, "original + 2 quota retries");
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.reason === "quota" && e.attempt <= e.budget), "never retries past its budget");
});

test("exhausting the quota budget still fails the request", async (t) => {
  const srv = await createMockServer(() => ({ status: 429, body: { error: { code: "insufficientquota", message: "exceeded" } } }));
  t.after(() => srv.close());
  await assert.rejects(
    () => runTurn(config(srv, { maxRetries: 0, quotaRetries: 2, quotaRetryDelayMs: 1 }), [], "go"),
    /LLM request failed \(429\)/
  );
  assert.equal(srv.calls(), 3, "1 request + 2 retries");
});

test("a non-quota 429 respects only the generic retry budget", async (t) => {
  const srv = await createMockServer(() => ({ status: 429, body: { error: { code: "RateLimit" } } }));
  t.after(() => srv.close());
  await assert.rejects(
    () => runTurn(config(srv, { maxRetries: 0, quotaRetries: 2, quotaRetryDelayMs: 1 }), [], "go"),
    /LLM request failed \(429\)/
  );
  assert.equal(srv.calls(), 1, "generic budget 0 means no retry even with quotaRetries set");
});

test("headless surfaces quota retries on stderr", async (t) => {
  const srv = await createMockServer((i) => {
    if (i < 1) return { status: 429, body: { error: { code: "insufficientquota", message: "exceeded" } } };
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  const err = [];
  await runHeadless(config(srv, { maxRetries: 0, quotaRetries: 2, quotaRetryDelayMs: 1 }), "hi", {
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  assert.ok(err.some((l) => l.includes("retrying (insufficient quota, attempt 1/2)")), `stderr was: ${err.join("")}`);
});
