import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSession, Session } from "../src/session/index.mjs";

test("a process crash after tool intent recovers the prefix and releases dead ownership", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-crash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/session/index.mjs", import.meta.url).href;
  const child = `const { Session } = await import(${JSON.stringify(moduleUrl)});
    const s = new Session('crashed', { model: 'mock' });
    await s.beginRun({ runId: 'r1', prompt: 'do it', cwd: process.cwd(), model: 'mock' });
    await s.checkpoint('r1', 'assistant', { message: { role: 'assistant', content: '', tool_calls:
      [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"touch x"}' } }] } });
    await s.checkpoint('r1', 'tool_intent', { ordinal: 1, callId: 'c1', tool: 'bash', cwd: process.cwd() });
    process.kill(process.pid, 'SIGKILL');`;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    env: { ...process.env, ARGUS_HOME: home }, timeout: 5_000, encoding: "utf8",
  });
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const recovered = await loadSession("crashed");
  assert.deepEqual(recovered.meta.unfinishedRuns[0].uncertainCalls, [1]);
  const next = new Session("crashed", { model: "mock" });
  await next.beginRun({ runId: "r2", parentRunId: "r1", prompt: "continue", cwd: home, model: "mock" });
  await next.endRun("r2", { messages: [{ role: "user", content: "continue" }], blocks: [] });
  const loaded = await loadSession("crashed");
  assert.equal(loaded.turns.length, 2);
  assert.equal(loaded.meta.unfinishedRuns[0].resolution, "continued");
});

test("SIGKILL before intent is unstarted; after result retains the known effect", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-crash-boundaries-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/session/index.mjs", import.meta.url).href;
  for (const phase of ["before-intent", "after-result"]) {
    const child = `const { Session } = await import(${JSON.stringify(moduleUrl)});
      const { writeFileSync } = await import('node:fs');
      const s = new Session(${JSON.stringify(phase)}, { model: 'mock' });
      const call = { id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"effect.txt","content":"done"}' } };
      await s.beginRun({ runId: 'r1', prompt: 'write it', cwd: process.cwd(), model: 'mock' });
      await s.checkpoint('r1', 'assistant', { message: { role: 'assistant', content: '', tool_calls: [call] } });
      if (${JSON.stringify(phase)} === 'after-result') {
        await s.checkpoint('r1', 'tool_intent', { ordinal: 1, callId: 'c1', tool: 'write', cwd: process.cwd() });
        writeFileSync(${JSON.stringify(join(home, `${phase}-effect.txt`))}, 'done');
        await s.checkpoint('r1', 'tool_result', { ordinal: 1, message: { role: 'tool', tool_call_id: 'c1', content: '{"path":"effect.txt"}' } });
      }
      process.kill(process.pid, 'SIGKILL');`;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, ARGUS_HOME: home }, timeout: 5_000, encoding: "utf8",
    });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  }
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const before = await loadSession("before-intent");
  assert.deepEqual(before.meta.unfinishedRuns[0].uncertainCalls, []);
  assert.match(before.turns[0].messages[2].content, /not_executed/);
  const after = await loadSession("after-result");
  assert.deepEqual(after.meta.unfinishedRuns[0].uncertainCalls, []);
  assert.equal(JSON.parse(after.turns[0].messages[2].content).path, "effect.txt");
  assert.equal(readFileSync(join(home, "after-result-effect.txt"), "utf8"), "done");
  assert.equal(existsSync(join(home, "before-intent-effect.txt")), false);
});
