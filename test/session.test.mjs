import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set ARGUS_HOME before importing session.mjs (it reads it at module load).
process.env.ARGUS_HOME = mkdtempSync(join(tmpdir(), "argus-sess-test-"));

const { Session, loadSession, latestSessionName, newSessionName, sanitizeName } = await import("../src/session.mjs");

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
  assert.match(newSessionName(), /^argus-\d{8}-\d{6}$/);
});

test("no secrets written", async () => {
  const s = new Session("secrets", config);
  await s.appendTurn({ config, messages: [{ role: "user", content: "x" }], blocks: [] });
  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "secrets.jsonl"), "utf8");
  assert.ok(!file.includes("apiKey"));
  assert.ok(!file.includes("sk-"));
});
