import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeCompact, sourceHash } from "../src/compact.mjs";
import { deleteSession, loadSession, renameSession, Session } from "../src/session/index.mjs";
import { runTurn } from "../src/agent.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

function pair(n) {
  return [{ role: "user", content: `task ${n}` }, { role: "assistant", content: `reply ${n}` }];
}

test("context revisions stay bounded, lower trust, and stable between runs", () => {
  const history = Array.from({ length: 40 }, (_, n) => pair(n)).flat();
  const first = maybeCompact(history, { compactAtChars: 10, keepTurns: 2,
    turnSizes: Array(40).fill(2), summaryLimitChars: 500 });
  assert.equal(first.history[0].role, "assistant");
  assert.ok(first.revision.summary.length <= 500);
  assert.equal(first.revision.sourceHash, sourceHash(history.slice(0, first.revision.coveredMessages)));
  const later = maybeCompact([...history, ...pair(40)], { lastTokens: 0,
    previousRevision: first.revision, turnSizes: Array(41).fill(2), keepTurns: 2 });
  assert.equal(later.compacted, false);
  assert.equal(later.revision.sourceHash, first.revision.sourceHash);
  assert.equal(later.history[0].role, "assistant");
  assert.equal(later.history.filter((message) => message.role === "user").length, 3);
});

test("logical run sizes keep steering inside the same covered unit", () => {
  const history = [
    { role: "user", content: "original constraint" },
    { role: "assistant", content: "working" },
    { role: "user", content: "later user correction" },
    { role: "assistant", content: "updated" },
    ...pair(2),
  ];
  const projected = maybeCompact(history, { compactAtChars: 1, keepTurns: 1, turnSizes: [4, 2] });
  assert.match(projected.revision.summary, /later user correction/);
  assert.deepEqual(projected.history.filter((message) => message.role === "user").map((message) => message.content), ["task 2"]);
});

test("private context artifact is retrievable after rename and removed with its session", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-context-artifact-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const history = [pair(1), pair(2), pair(3)].flat();
  const revision = maybeCompact(history, { compactAtChars: 1, keepTurns: 1, turnSizes: [2, 2, 2] }).revision;
  const session = new Session("context-old", { model: "mock" });
  await session.beginRun({ runId: "r1", prompt: "new", model: "mock", cwd: home });
  const saved = await session.saveContextRevision(revision, history.slice(0, revision.coveredMessages));
  await session.endRun("r1", { messages: [{ role: "user", content: "new" }], blocks: [] });
  assert.match(readFileSync(saved.artifactPath, "utf8"), /Message 1: line/);
  assert.match(readFileSync(saved.artifactPath, "utf8"), /task 1/);
  if (process.platform !== "win32") assert.equal(statSync(saved.artifactPath).mode & 0o777, 0o600);
  assert.equal((await loadSession("context-old")).meta.contextRevision.artifactPath, saved.artifactPath);
  await renameSession("context-old", "context-new", session);
  assert.equal(existsSync(saved.artifactPath), true);
  await deleteSession("context-new");
  assert.equal(existsSync(saved.artifactPath), false);
});

test("repeated revisions replace one complete source artifact", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-context-replace-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const session = new Session("context-replace", { model: "mock" });
  await session.beginRun({ runId: "r1", prompt: "new", model: "mock", cwd: home });
  const history = [pair(1), pair(2), pair(3)].flat();
  const first = maybeCompact(history, { compactAtChars: 1, keepTurns: 1,
    turnSizes: [2, 2, 2] }).revision;
  const savedFirst = await session.saveContextRevision(first, history.slice(0, first.coveredMessages));
  const extended = [...history, ...pair(4)];
  const second = maybeCompact(extended, { compactAtChars: 1, keepTurns: 1,
    turnSizes: [2, 2, 2, 2], previousRevision: savedFirst }).revision;
  const savedSecond = await session.saveContextRevision(second, extended.slice(0, second.coveredMessages));
  await session.endRun("r1", { messages: [{ role: "user", content: "new" }], blocks: [] });
  assert.equal(savedSecond.artifactPath, savedFirst.artifactPath);
  assert.deepEqual(readdirSync(session.artifactDir()), ["source.txt"]);
  assert.match(readFileSync(savedSecond.artifactPath, "utf8"), /task 1/);
  assert.match(readFileSync(savedSecond.artifactPath, "utf8"), /task 3/);
});

test("agent saves a context revision before sending its bounded model request", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-context-run-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  let request;
  const srv = await createMockServer((_index, body) => (request = body, [{ content: "ok" }]));
  t.after(() => srv.close());
  const history = Array.from({ length: 10 }, (_, n) => pair(n)).flat();
  const session = new Session("context-run", { model: "mock" });
  let runId;
  const result = await runTurn({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" },
    history, "new", () => {}, {
      cwd: home, compactAtChars: 10, keepTurns: 2, historyTurnSizes: Array(10).fill(2),
      onRunStart: async (data) => { runId = data.runId; await session.beginRun(data); },
      onCheckpoint: ({ runId: id, kind, ...payload }) => session.checkpoint(id, kind, payload),
      onContextRevision: (revision, source) => session.saveContextRevision(revision, source),
    });
  await session.endRun(runId, { messages: result.messages, blocks: [] });
  const digest = request.messages.find((message) => message.role === "assistant" && /context digest/.test(message.content));
  assert.ok(digest);
  assert.match(digest.content, /Source detail: use read on/);
  assert.equal(existsSync(result.contextRevision.artifactPath), true);
  assert.equal((await loadSession("context-run")).meta.contextRevision.sourceHash, result.contextRevision.sourceHash);
});

test("an omitted early constraint remains available through the existing read tool", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-context-retrieve-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const constraint = "PRESERVE_THE_RED_MARKER";
  const history = [
    { role: "user", content: `${"background ".repeat(20)} ${constraint}` },
    { role: "assistant", content: "acknowledged" },
    ...Array.from({ length: 9 }, (_, n) => pair(n)).flat(),
  ];
  let retrievalSeen = false;
  const srv = await createMockServer((index, body) => {
    if (index === 0) {
      const digest = body.messages.find((message) => message.role === "assistant" && /context digest/.test(message.content));
      assert.ok(digest);
      assert.equal(digest.content.includes(constraint), false);
      const path = digest.content.match(/Source detail: use read on (.+\.txt)\./)?.[1];
      assert.ok(path);
      return [{ tool_calls: [{ index: 0, id: "source-1", function: { name: "read", arguments: JSON.stringify({ path }) } }] }];
    }
    retrievalSeen = body.messages.some((message) => message.role === "tool" && message.content.includes(constraint));
    return [{ content: "source inspected" }];
  });
  t.after(() => srv.close());
  const session = new Session("context-retrieve", { model: "mock" });
  let runId;
  const result = await runTurn({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" },
    history, "retrieve the old constraint", () => {}, {
      cwd: home, compactAtChars: 10, keepTurns: 2, historyTurnSizes: Array(10).fill(2),
      onRunStart: async (data) => { runId = data.runId; await session.beginRun(data); },
      onCheckpoint: ({ runId: id, kind, ...payload }) => session.checkpoint(id, kind, payload),
      onContextRevision: (revision, source) => session.saveContextRevision(revision, source),
    });
  await session.endRun(runId, { messages: result.messages, blocks: [] });
  assert.equal(result.outcome, "completed");
  assert.equal(retrievalSeen, true);
});

test("named-session shell and spill artifacts are removed with the session", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "argus-shell-artifact-session-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const command = `node -e ${JSON.stringify("process.stdout.write('x'.repeat(2_000_000))")}`;
  const srv = await createMockServer((index) => index === 0
    ? [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }]
    : [{ content: "done" }]);
  t.after(() => srv.close());
  const session = new Session("shell-artifacts", { model: "mock" });
  let runId;
  const result = await runTurn({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" },
    [], "run", () => {}, {
      cwd: home, artifactDir: session.artifactDir(),
      onRunStart: async (data) => { runId = data.runId; await session.beginRun(data); },
      onCheckpoint: ({ runId: id, kind, ...payload }) => session.checkpoint(id, kind, payload),
    });
  await session.endRun(runId, { messages: result.messages, blocks: [] });
  const tool = JSON.parse(result.messages.find((message) => message.role === "tool").content);
  assert.equal(tool.exitCode, 0);
  assert.equal(tool.outputTruncated, true);
  assert.equal(existsSync(tool.artifact.stdout), true);
  assert.equal(existsSync(tool.fullPath), true);
  await deleteSession("shell-artifacts");
  assert.equal(existsSync(tool.artifact.stdout), false);
  assert.equal(existsSync(tool.fullPath), false);
});
