import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, loadSession, scanSessionMeta, latestSessionForCwd } from "../src/session/index.mjs";

const config = { model: "mock", baseUrl: "http://localhost", systemPrompt: "test" };
async function isolatedHome(t) {
  const previous = process.env.ARGUS_HOME;
  const dir = await mkdtemp(join(tmpdir(), "argus-recovery-"));
  process.env.ARGUS_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("discovery uses cwd, model, and config updates after earlier turns", async (t) => {
  await isolatedHome(t);
  const session = new Session("moving", config);
  await session.setCwd("/old-repo");
  await session.appendTurn({ config, messages: [], blocks: [] });
  await session.setCwd("/new-repo/sub");
  await session.setModel("new-model");
  await session.setConfig({ ...config, systemPrompt: "updated" });
  const meta = await scanSessionMeta(session.name);
  assert.equal(meta.cwd, "/new-repo/sub");
  assert.equal(meta.model, "new-model");
  assert.equal(meta.config.systemPrompt, "updated");
  assert.equal(await latestSessionForCwd("/old-repo"), null);
  assert.equal(await latestSessionForCwd("/new-repo"), session.name);
});

test("metadata discovery accepts legacy turns with type serialized last", async (t) => {
  await isolatedHome(t);
  const session = new Session("legacy", config);
  await session.setCwd("/first");
  await writeFile(session.file, '\n{"messages":[],"type":"turn"}\n{"type":"cwd","cwd":"/last"}\n', { flag: "a" });
  assert.equal((await scanSessionMeta(session.name)).cwd, "/last");
});

test("failed metadata writes can retry the same cwd, model, and config", async (t) => {
  const dir = await isolatedHome(t);
  const session = new Session("retry", config);
  const blocked = join(dir, "sessions");
  await writeFile(blocked, "not a directory");
  await assert.rejects(session.setCwd("/work"));
  await assert.rejects(session.setModel("alternate"));
  await assert.rejects(session.setConfig(config));
  await rm(blocked);
  await Promise.all([session.setCwd("/work"), session.setModel("alternate"), session.setConfig(config)]);
  const { meta } = await loadSession(session.name);
  assert.equal(meta.cwd, "/work");
  assert.equal(meta.model, "alternate");
  assert.equal(meta.config.systemPrompt, "test");
});

test("resuming after a torn final record preserves the next appended turn", async (t) => {
  await isolatedHome(t);
  const first = new Session("torn", config);
  await first.setCwd("/work");
  const before = await readFile(first.file, "utf8");
  await writeFile(first.file, '{"type":"turn","messages":', { flag: "a" });
  const resumed = new Session(first.name, config);
  await resumed.appendTurn({ config, messages: [{ role: "user", content: "survives" }], blocks: [] });
  const loaded = await loadSession(first.name);
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.turns[0].messages[0].content, "survives");
  assert.equal(loaded.meta.warnings.length, 1);
  assert.ok((await readFile(first.file, "utf8")).startsWith(before), "existing history is unchanged");
});

test("valid JSON that is not a record warns without stopping recovery", async (t) => {
  await isolatedHome(t);
  const session = new Session("invalid-shapes", config);
  await session.setCwd("/work");
  await writeFile(session.file, '\nnull\n[]\n42\n{"type":"cwd","cwd":"/latest"}\n', { flag: "a" });
  const loaded = await loadSession(session.name);
  assert.equal(loaded.meta.cwd, "/latest");
  assert.equal(loaded.meta.warnings.length, 3);
  assert.equal((await scanSessionMeta(session.name)).cwd, "/latest");
});
