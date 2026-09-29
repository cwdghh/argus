import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent.mjs";
import { MinimalTui } from "../src/tui.mjs";
import { Session, loadSession } from "../src/session/index.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

test("steering before tool dispatch skips obsolete calls and reaches the next model request once", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-steer-agent-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let secondBody;
  const srv = await createMockServer((index, body) => index === 0
    ? [{ tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: '{"path":"obsolete.txt","content":"x","ensureFinalNewline":true}' } }] }]
    : (secondBody = body, [{ content: "steered" }]));
  t.after(() => srv.close());
  const queued = [
    { id: "steer-1", text: "Do not create obsolete.txt" },
    { id: "steer-2", text: "Explain the change instead" },
  ];
  const checkpoints = [];
  const applied = [];
  const result = await runTurn({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" }, [], "create it", () => {}, {
    cwd,
    onCheckpoint: async (entry) => checkpoints.push(entry),
    takeSteering: async () => [...queued],
    markSteeringApplied: async (entry) => {
      applied.push(entry.id);
      queued.splice(queued.findIndex((item) => item.id === entry.id), 1);
    },
  });
  assert.equal(result.outcome, "completed");
  assert.equal(existsSync(join(cwd, "obsolete.txt")), false);
  assert.deepEqual(applied, ["steer-1", "steer-2"]);
  assert.equal(result.messages.filter((message) => message.role === "user").length, 3);
  assert.equal(JSON.parse(result.messages.find((message) => message.role === "tool").content).code, "not_executed");
  assert.equal(secondBody.messages.filter((message) => message.role === "user" && /Do not create/.test(message.content)).length, 1);
  assert.equal(secondBody.messages.filter((message) => message.role === "user" && /Explain the change/.test(message.content)).length, 1);
  assert.deepEqual(checkpoints.map((entry) => entry.kind), ["assistant", "tool_result", "steering", "steering", "partial_delta", "assistant"]);
});

test("TUI acknowledges steering only after saving it, then applies it before a pending tool", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-steer-tui-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = join(cwd, "home");
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const srv = await createMockServer((index) => index === 0
    ? [{ delay: 120 }, { tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: '{"path":"obsolete.txt","content":"x","ensureFinalNewline":true}' } }] }]
    : [{ content: "done" }]);
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" };
  const tui = new MinimalTui(config, { session: new Session("steered", config), initialCwd: cwd });
  tui.editor.buffer = "create obsolete.txt";
  const running = tui.submit();
  for (let i = 0; !tui.activeRunId && i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(tui.activeRunId);
  tui.editor.buffer = "/steer Do not create obsolete.txt";
  await tui.submit();
  assert.ok(tui.blocks.some((block) => /steering queued/.test(block.summary ?? "")));
  await running;
  assert.equal(existsSync(join(cwd, "obsolete.txt")), false);
  const loaded = await loadSession("steered");
  assert.deepEqual(loaded.meta.pendingSteering, []);
  assert.equal(loaded.turns.length, 1);
});

test("steering during approval cancels the obsolete command", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-steer-approval-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = join(cwd, "home");
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const victim = join(cwd, "victim");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(victim, "keep");
  const srv = await createMockServer((index) => index === 0
    ? [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"rm -rf victim"}' } }] }]
    : [{ content: "changed plan" }]);
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" };
  const tui = new MinimalTui(config, { session: new Session("approval-steer", config), initialCwd: cwd });
  tui.editor.buffer = "remove victim";
  const running = tui.submit();
  for (let i = 0; !tui.pendingConfirm && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(tui.pendingConfirm);
  tui.editor.buffer = "/steer Keep victim";
  await tui.submit();
  await running;
  assert.equal(existsSync(victim), true);
  assert.equal(tui.pendingConfirm, null);
  assert.ok(tui.history.some((message) => message.role === "user" && message.content === "Keep victim"));
});

test("late steering becomes a persisted follow-up draft after a completed reply", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-steer-late-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = join(cwd, "home");
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const srv = await createMockServer((index) => index === 0 ? [{ delay: 120 }, { content: "first done" }] : [{ content: "followed up" }]);
  t.after(() => srv.close());
  const config = { baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" };
  const tui = new MinimalTui(config, { session: new Session("late-steer", config), initialCwd: cwd });
  tui.editor.buffer = "first";
  const running = tui.submit();
  for (let i = 0; !tui.activeRunId && i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  tui.editor.buffer = "/steer Next instruction";
  await tui.submit();
  await running;
  assert.equal(tui.editor.buffer, "Next instruction");
  assert.equal((await loadSession("late-steer")).meta.pendingSteering.length, 1);
  await tui.submit();
  assert.equal((await loadSession("late-steer")).meta.pendingSteering.length, 0);
  assert.equal(tui.history.filter((message) => message.role === "user" && message.content === "Next instruction").length, 1);
});

test("pending steering survives restart as a visible draft without auto-execution", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-steer-restart-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
  });
  const session = new Session("steer-restart", { model: "mock" });
  await session.beginRun({ runId: "r1", prompt: "original", cwd: home, model: "mock" });
  await session.queueSteering("r1", "steer-1", "Keep the existing file");
  await session.leaveRunUnfinished();
  const restored = await loadSession("steer-restart");
  assert.deepEqual(restored.meta.pendingSteering.map((item) => item.text), ["Keep the existing file"]);
  const tui = new MinimalTui({ model: "mock" }, { pendingSteering: restored.meta.pendingSteering,
    unfinishedRuns: restored.meta.unfinishedRuns, sessionName: "steer-restart" });
  assert.equal(tui.editor.buffer, "Keep the existing file");
  assert.equal(tui.mode, "idle");
});

test("idle steering commands list and cancel a persisted correction", async () => {
  const settled = [];
  const item = { id: "steer-1234", runId: "r1", text: "Keep the file" };
  const tui = new MinimalTui({ model: "mock" }, { pendingSteering: [item],
    session: { settleSteering: async (...args) => settled.push(args) } });
  tui.editor.buffer = "/steer list";
  await tui.submit();
  assert.ok(tui.blocks.some((block) => block.text?.includes("Keep the file")));
  tui.editor.buffer = "/steer cancel steer-1";
  await tui.submit();
  assert.deepEqual(settled, [["r1", "steer-1234", "cancelled"]]);
  assert.deepEqual(tui.steeringQueue, []);
});
