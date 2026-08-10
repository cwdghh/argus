import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARGUS_HOME = mkdtempSync(join(tmpdir(), "argus-headless-test-"));

const { runHeadless } = await import("../src/headless.mjs");
const { Session, loadSession } = await import("../src/session.mjs");
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
  assert.ok(err.join("").includes("⚙ bash"), "tool call on stderr");

  const loaded = await loadSession("hs");
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.meta.cwd, join(process.cwd(), "src"), "headless persists cwd");
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
  process.exitCode = 0;
});
