import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep all session fixtures out of the user's real ~/.argus directory.
process.env.ARGUS_HOME = mkdtempSync(join(tmpdir(), "argus-sess-test-"));

const { Session, loadSession, latestSessionName, newSessionName, sanitizeName, sessionSummaries, sessionsDir } = await import("../src/session.mjs");

const config = { baseUrl: "http://x", model: "mock", systemPrompt: "s" };

test("round-trip: turn + cwd persisted, latest detected", async () => {
  const s = new Session("abc", config);
  await s.setCwd("/tmp");
  await s.setCwd("/tmp"); // dedupe
  await s.appendTurn({ config, messages: [{ role: "user", content: "hi" }], blocks: [{ kind: "user", text: "hi" }] });
  await s.appendTurn({ config, messages: [{ role: "user", content: "yo" }], blocks: [] });

  const loaded = await loadSession("abc");
  assert.equal(loaded.turns.length, 2);
  assert.equal(loaded.meta.cwd, "/tmp");
  assert.equal(loaded.turns[0].messages[0].content, "hi");
  assert.equal(await latestSessionName(), "abc");

  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "abc.jsonl"), "utf8");
  const cwdLines = file.split("\n").filter((l) => l.includes('"type":"cwd"'));
  assert.equal(cwdLines.length, 1, "cwd should be deduped");
});

test("naming helpers", () => {
  assert.equal(sanitizeName("my-session_1"), "my-session_1");
  assert.equal(sanitizeName("../evil"), null);
  assert.match(newSessionName(), /^argus-\d{8}-\d{6}-\d{3}$/);
});

test("no secrets written", async () => {
  const s = new Session("secrets", config);
  await s.appendTurn({ config, messages: [{ role: "user", content: "x" }], blocks: [] });
  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "secrets.jsonl"), "utf8");
  assert.ok(!file.includes("apiKey"));
  assert.ok(!file.includes("sk-"));
});

test("concurrent writes are serialized with metadata first", async () => {
  const s = new Session("ordered", config);
  await Promise.all([
    s.setCwd("/one"),
    s.appendTurn({ config, messages: [{ role: "user", content: "one" }], blocks: [] }),
    s.setCwd("/two"),
  ]);
  const lines = readFileSync(join(process.env.ARGUS_HOME, "sessions", "ordered.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(lines[0].type, "meta");
  assert.deepEqual(lines.slice(1).map((line) => line.type), ["cwd", "turn", "cwd"]);
});

test("a resumed session deduplicates its already-persisted cwd", async () => {
  const s = new Session("resume-cwd", config);
  await s.setCwd("/saved");
  const resumed = new Session("resume-cwd", config, { initialCwd: "/saved" });
  await resumed.setCwd("/saved");
  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "resume-cwd.jsonl"), "utf8");
  assert.equal(file.split("\n").filter((line) => line.includes('"type":"cwd"')).length, 1);
});

test("session summaries expose useful discovery metadata", async () => {
  const s = new Session("summary", config);
  await s.appendTurn({
    config,
    messages: [{ role: "user", content: "review\nthis repository" }, { role: "assistant", content: "ok" }],
    blocks: [],
  });
  const item = (await sessionSummaries()).find((entry) => entry.name === "summary");
  assert.equal(item.turns, 1);
  assert.equal(item.lastPrompt, "review this repository");
  assert.ok(Number.isFinite(item.mtime));
});

test("ARGUS_HOME is resolved lazily after module import", () => {
  const original = process.env.ARGUS_HOME;
  const lateHome = mkdtempSync(join(tmpdir(), "argus-late-home-"));
  process.env.ARGUS_HOME = lateHome;
  try {
    assert.equal(sessionsDir(), join(lateHome, "sessions"));
  } finally {
    process.env.ARGUS_HOME = original;
  }
});
