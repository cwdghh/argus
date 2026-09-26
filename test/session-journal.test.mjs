import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalReader } from "../src/session/journal.mjs";
import { loadSession, sessionFilePath, Session } from "../src/session/index.mjs";

const start = { type: "run_start", version: 2, runId: "run-a", seq: 0, prompt: "do it", model: "mock" };
const call = { id: "provider-1", type: "function", function: { name: "bash", arguments: '{"command":"touch x"}' } };
const assistant = { type: "checkpoint", runId: "run-a", seq: 1, kind: "assistant",
  message: { role: "assistant", content: "", tool_calls: [call] } };
const intent = { type: "checkpoint", runId: "run-a", seq: 2, kind: "tool_intent", ordinal: 1 };

test("journal prefix distinguishes unstarted and uncertain tool calls", () => {
  const unstarted = new JournalReader();
  unstarted.accept(start);
  unstarted.accept(assistant);
  let turn = unstarted.unfinished()[0];
  assert.deepEqual(turn.uncertainCalls, []);
  assert.match(turn.messages[2].content, /not_executed/);

  const uncertain = new JournalReader();
  uncertain.accept(start);
  uncertain.accept(assistant);
  uncertain.accept(intent);
  turn = uncertain.unfinished()[0];
  assert.deepEqual(turn.uncertainCalls, [1]);
  assert.match(turn.messages[2].content, /execution_uncertain/);
});

test("crash recovery keeps acknowledged partial text once and reasoning as display data", () => {
  const reader = new JournalReader();
  reader.accept(start);
  reader.accept({ type: "checkpoint", runId: "run-a", seq: 1, kind: "partial_delta", text: "hel", reasoning: "thought" });
  reader.accept({ type: "checkpoint", runId: "run-a", seq: 2, kind: "partial_delta", text: "lo", reasoning: "" });
  const recovered = reader.unfinished()[0];
  assert.equal(recovered.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(recovered.messages[1].content, "hello");
  assert.equal(recovered.blocks.find((block) => block.kind === "thinking").text, "thought");
});

test("journal final turn is folded once; gaps recover only the valid prefix", () => {
  const reader = new JournalReader();
  reader.accept(start);
  reader.accept(assistant);
  reader.accept(intent);
  const end = reader.accept({ type: "run_end", runId: "run-a", seq: 3,
    turn: { messages: [{ role: "user", content: "do it" }], blocks: [] } });
  assert.equal(end.recovered, undefined);
  assert.equal(reader.unfinished().length, 0);

  const damaged = new JournalReader();
  damaged.accept(start);
  damaged.accept(assistant);
  damaged.accept({ ...intent, seq: 3 });
  const recovered = damaged.accept({ type: "run_end", runId: "run-a", seq: 4, turn: { messages: [], blocks: [] } });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.uncertainCalls, []);
  assert.match(recovered.messages[2].content, /not_executed/);
});

test("session reader exposes an unfinished crash prefix without duplicating legacy turns", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-journal-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const file = sessionFilePath("crash-prefix");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(file, [
    { type: "turn", messages: [{ role: "user", content: "old" }], blocks: [] },
    start, assistant, intent,
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const loaded = await loadSession("crash-prefix");
  assert.equal(loaded.turns.length, 2);
  assert.equal(loaded.turns[1].recovered, true);
  assert.equal(loaded.meta.unfinishedRuns[0].runId, "run-a");
});

test("session writer syncs journal boundaries and the reader folds a completed run once", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-journal-write-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const writer = new Session("journal-write", { model: "mock" });
  await writer.beginRun({ runId: "r1", prompt: "hello", model: "mock", cwd: home });
  const rival = new Session("journal-write", { model: "mock" });
  await assert.rejects(rival.beginRun({ runId: "r2", prompt: "rival", model: "mock", cwd: home }), /owned by another process/);
  await writer.checkpoint("r1", "assistant", { message: { role: "assistant", content: "done" } });
  await writer.endRun("r1", {
    config: { model: "mock" }, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "done" }],
    blocks: [{ kind: "user", text: "hello" }, { kind: "assistant", text: "done" }],
  });
  const loaded = await loadSession("journal-write");
  assert.equal(loaded.meta.version, 2);
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.turns[0].messages[1].content, "done");
  await rival.beginRun({ runId: "r2", prompt: "rival", model: "mock", cwd: home });
  await rival.endRun("r2", { messages: [{ role: "user", content: "rival" }], blocks: [] });
});

test("an unfinished run stays before its later continuation in restored history", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-journal-order-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(sessionFilePath("ordered"), [
    start,
    { type: "run_start", version: 2, runId: "run-b", parentRunId: "run-a", seq: 0, prompt: "continue", model: "mock" },
    { type: "run_end", runId: "run-b", seq: 1, turn: { messages: [{ role: "user", content: "continue" }], blocks: [] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const loaded = await loadSession("ordered");
  assert.deepEqual(loaded.turns.map((turn) => turn.messages[0].content), ["do it", "continue"]);
  assert.equal(loaded.meta.unfinishedRuns[0].resolution, "continued");
});
