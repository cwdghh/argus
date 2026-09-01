import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARGUS_HOME = mkdtempSync(join(tmpdir(), "argus-headless-test-"));

const { runHeadless } = await import("../src/headless.mjs");
const { Session, loadSession } = await import("../src/session/index.mjs");
const { createMockServer } = await import("./helpers/mock-llm.mjs");

test("headless: text -> stdout, tool -> stderr, session + cwd saved", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [
        { content: "hello " },
        { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"cd src"}' } }] },
      ];
    }
    return [{ content: "world" }];
  });
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" };

  const out = [];
  const err = [];
  const session = new Session("hs", config);
  await runHeadless(config, "do it", {
    session,
    cwd: process.cwd(),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });

  assert.equal(out.join(""), "hello world\n", "stdout should be assistant text only");
  assert.ok(err.join("").includes("⚙ bash → cd src"), "tool line uses the shared label resolver");

  const loaded = await loadSession("hs");
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.meta.cwd, join(process.cwd(), "src"), "headless persists cwd");
  const toolBlock = loaded.turns[0].blocks.find((b) => b.kind === "tool");
  assert.equal(toolBlock.label, "bash → cd src", "the persisted block stores the resolved label, not raw args");
  assert.equal(toolBlock.id, "c1", "the call id is persisted so /show can link the result");
});

test("headless: error -> exitCode 1 and error block saved", async (t) => {
  const srv = await createMockServer(() => {
    throw new Error("boom");
  });
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" };
  const err = [];
  const session = new Session("hs-err", config);
  await runHeadless(config, "hi", { session, stderr: (s) => err.push(s) });
  assert.match(err.join(""), /boom/);
  assert.equal(process.exitCode, 1);
  const loaded = await loadSession("hs-err");
  assert.ok(loaded.turns[0].blocks.some((b) => b.kind === "error"), "error block saved");
  assert.equal(loaded.turns[0].messages[0].content, "hi", "failed request still records its user message");
  process.exitCode = 0;
});

test("headless: a session's stored model override is used for the request", async (t) => {
  const session = new Session("hs-model", { model: "base", systemPrompt: "s" });
  await session.setModel("deepseek-chat");
  let seenModel = null;
  const srv = await createMockServer((i, body) => {
    seenModel = body.model;
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  await runHeadless({ baseUrl: srv.url, apiKey: "", model: "base", systemPrompt: "s" }, "hi", {
    session,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(seenModel, "deepseek-chat");
  const loaded = await loadSession("hs-model");
  assert.equal(loaded.turns[0].config.model, "deepseek-chat", "the persisted turn records the override");
});

test("headless: resumed session uses its persisted cwd", async (t) => {
  const config = { apiKey: "", model: "mock", systemPrompt: "s" };
  const session = new Session("hs-resume-cwd", config);
  const expected = join(process.cwd(), "src");
  await session.setCwd(expected);
  let observedCwd = null;
  const srv = await createMockServer((i, body) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }];
    }
    const tool = JSON.parse(body.messages.at(-1).content);
    observedCwd = tool.stdout.trim();
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  config.baseUrl = srv.url;
  await runHeadless(config, "where", { session, stdout: () => {}, stderr: () => {} });
  assert.equal(observedCwd, expected);
});

test("headless: persisted usage drives real-token compaction on a resumed run", async (t) => {
  // Seed a session with 12 turns whose last timing block reports a real
  // context at/over the 200k-token budget (prompt 199900 + completion 150).
  const config = { apiKey: "", model: "mock", systemPrompt: "s" };
  const session = new Session("hs-compact", config);
  const mkTurn = (n) => ({
    config: { baseUrl: "http://mock", model: "mock", systemPrompt: "s" },
    messages: [
      { role: "user", content: `q${n}` },
      { role: "assistant", content: `a${n}`.repeat(80) },
    ],
    blocks: [
      { kind: "user", text: `q${n}` },
      { kind: "assistant", text: "ok" },
      {
        kind: "timing",
        summary: "completed in 100ms",
        durationMs: 100,
        usage: { prompt_tokens: 199_900, completion_tokens: 150, total_tokens: 200_050, reasoning_tokens: 0, cached_tokens: 0 },
      },
    ],
  });
  for (let i = 1; i <= 12; i++) await session.appendTurn(mkTurn(i));

  const err = [];
  let lastBody = null;
  const srv = await createMockServer((i, body) => {
    lastBody = body;
    return [{ content: "fresh" }];
  });
  t.after(() => srv.close());
  config.baseUrl = srv.url;

  await runHeadless(config, "next", { session, stdout: () => {}, stderr: (s) => err.push(s) });

  assert.ok(err.join("").includes("compacted"), "persisted real tokens trigger compaction on resume");
  assert.ok(
    lastBody.messages.some((m) => m.role === "system" && /Summary of earlier/.test(m.content)),
    "the compacted summary is sent",
  );
  const users = lastBody.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["q5", "q6", "q7", "q8", "q9", "q10", "q11", "q12", "next"], "keeps the last 8 turns plus the new prompt");
});

test("headless: later request failure preserves completed tools and cwd", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"cd src"}' } }] }];
    }
    throw new Error("after tool");
  });
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s", maxRetries: 0 };
  const session = new Session("hs-partial", config);
  await runHeadless(config, "change directory", { session, stdout: () => {}, stderr: () => {} });
  const loaded = await loadSession("hs-partial");
  assert.ok(loaded.turns[0].messages.some((message) => message.role === "tool"));
  assert.equal(loaded.meta.cwd, join(process.cwd(), "src"));
  process.exitCode = 0;
});
