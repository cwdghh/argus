import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent.mjs";
import { runHeadless } from "../src/headless.mjs";
import { MinimalTui } from "../src/tui.mjs";
import { Session, loadSession } from "../src/session/index.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

const call = { index: 0, id: "c1", function: {
  name: "write", arguments: '{"path":"effect.txt","content":"done","ensureFinalNewline":true}',
} };

test("an intent sync failure prevents the filesystem effect", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-intent-fail-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const srv = await createMockServer(() => [{ tool_calls: [call] }]);
  t.after(() => srv.close());
  await assert.rejects(runTurn({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" },
    [], "write it", () => {}, { cwd, onCheckpoint: async ({ kind }) => {
      if (kind === "tool_intent") throw new Error("simulated disk full");
    } }), /simulated disk full/);
  assert.equal(existsSync(join(cwd, "effect.txt")), false);
});

test("a result sync failure leaves an intent-only recovery state after the effect", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-result-fail-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const srv = await createMockServer(() => [{ tool_calls: [call] }]);
  t.after(() => srv.close());
  const session = new Session("result-fail", { model: "mock" });
  await assert.rejects(runTurn({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" },
    [], "write it", () => {}, { cwd: home,
      onRunStart: (data) => session.beginRun(data),
      onCheckpoint: ({ runId, kind, ...payload }) => kind === "tool_result"
        ? Promise.reject(new Error("simulated result sync failure"))
        : session.checkpoint(runId, kind, payload),
    }), /simulated result sync failure/);
  assert.equal(existsSync(join(home, "effect.txt")), true);
  await session.ownerRelease(); // simulate the process ending before run_end
  const loaded = await loadSession("result-fail");
  assert.deepEqual(loaded.meta.unfinishedRuns[0].uncertainCalls, [1]);
});

test("frontends do not seal a run after a result checkpoint failure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-frontend-result-fail-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const oldHome = process.env.ARGUS_HOME;
  const oldExitCode = process.exitCode;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
    process.exitCode = oldExitCode;
  });
  const srv = await createMockServer(() => [{ tool_calls: [call] }]);
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" };
  for (const frontend of ["headless", "tui"]) {
    const session = new Session(frontend, config);
    const realCheckpoint = session.checkpoint.bind(session);
    session.checkpoint = (runId, kind, payload) => kind === "tool_result"
      ? Promise.reject(new Error("simulated result sync failure"))
      : realCheckpoint(runId, kind, payload);
    if (frontend === "headless") {
      const errors = [];
      await runHeadless(config, "write it", { session, cwd: home,
        stdout: () => {}, stderr: (value) => errors.push(value) });
      assert.match(errors.join(""), /simulated result sync failure/);
    } else {
      const tui = new MinimalTui(config, { session, sessionName: frontend, initialCwd: home });
      tui.editor.buffer = "write it";
      await tui.submit();
      assert.ok(tui.blocks.some((block) => /simulated result sync failure/.test(block.text ?? "")));
      assert.equal(tui.recoveryRequired, true);
      tui.editor.buffer = "try again";
      await tui.submit();
      assert.ok(tui.blocks.some((block) => /use \/resume tui/.test(block.text ?? "")));
    }
    assert.equal(session.ownerRelease, null);
    const loaded = await loadSession(frontend);
    assert.deepEqual(loaded.meta.unfinishedRuns[0].uncertainCalls, [1]);
    assert.equal(loaded.turns[0].recovered, true);
  }
});
