import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep all session fixtures out of the user's real ~/.argus directory.
process.env.ARGUS_HOME = mkdtempSync(join(tmpdir(), "argus-sess-test-"));

const { Session, configRecord, deleteSession, listSessions, loadSession, latestSessionForCwd, defaultSessionName, nameError, newSessionName, pruneSessions, renameSession, sanitizeName, scanSessionMeta, sessionConfig, sessionData, sessionSummaries, sessionsDir, toolSurfaceHash } = await import("../src/session/index.mjs");

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
  assert.equal((await listSessions())[0].name, "abc");

  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "abc.jsonl"), "utf8");
  const cwdLines = file.split("\n").filter((l) => l.includes('"type":"cwd"'));
  assert.equal(cwdLines.length, 1, "cwd should be deduped");
});

test("naming helpers", () => {
  assert.equal(sanitizeName("my-session_1"), "my-session_1");
  assert.equal(sanitizeName("  padded  "), "padded", "outer whitespace is trimmed");
  assert.equal(sanitizeName("../evil"), null);
  assert.equal(sanitizeName("my session"), null, "internal spaces are rejected");
  assert.equal(sanitizeName("\u4e2d\u6587"), null, "non-ASCII is rejected");
  assert.equal(sanitizeName("a".repeat(249)), "a".repeat(249));
  assert.equal(sanitizeName("a".repeat(250)), null, "the name plus .jsonl must fit in NAME_MAX");
  assert.match(newSessionName(), /^argus-\d{8}-\d{6}-\d{3}$/);
});

test("nameError explains why a name is invalid", () => {
  assert.equal(nameError("ok-name"), null);
  assert.match(nameError("my session"), /invalid session name: "my session"/);
  assert.match(nameError("my session"), /no spaces/);
  assert.match(nameError("a".repeat(250)), /too long/);
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

test("per-session model override persists and dedupes", async () => {
  const s = new Session("model-ovr", config);
  await s.setModel("gpt-4o-mini");
  await s.setModel("gpt-4o-mini"); // dedupe
  let loaded = await loadSession("model-ovr");
  assert.equal(loaded.meta.model, "gpt-4o-mini");
  await s.setModel("deepseek-chat");
  loaded = await loadSession("model-ovr");
  assert.equal(loaded.meta.model, "deepseek-chat");
  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "model-ovr.jsonl"), "utf8");
  assert.equal(file.split("\n").filter((l) => l.includes('"type":"model"')).length, 2);
});

test("a resumed session skips a redundant model rewrite", async () => {
  const s = new Session("resume-model", config);
  await s.setModel("deepseek-chat");
  const resumed = new Session("resume-model", config, { initialModel: "deepseek-chat" });
  await resumed.setModel("deepseek-chat");
  const file = readFileSync(join(process.env.ARGUS_HOME, "sessions", "resume-model.jsonl"), "utf8");
  assert.equal(file.split("\n").filter((l) => l.includes('"type":"model"')).length, 1);
});

test("listSessions and sessionSummaries expose file sizes", async () => {
  const s = new Session("size-check", config);
  await s.appendTurn({ config, messages: [{ role: "user", content: "x".repeat(500) }], blocks: [] });
  const item = (await listSessions()).find((entry) => entry.name === "size-check");
  assert.ok(item.size > 0, "listSessions carries the JSONL size");
  const summary = (await sessionSummaries()).find((entry) => entry.name === "size-check");
  assert.ok(summary.size > 0, "sessionSummaries carries the JSONL size");
});

test("pruneSessions keeps the newest N and never removes the excluded active one", async () => {
  const original = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = mkdtempSync(join(tmpdir(), "argus-prune-test-"));
  try {
    const names = ["oldest", "older", "newer", "newest"];
    for (const n of names) {
      const s = new Session(n, config);
      await s.appendTurn({ config, messages: [{ role: "user", content: n }], blocks: [] });
    }
    const now = Date.now() / 1000;
    utimesSync(join(sessionsDir(), "oldest.jsonl"), now - 400, now - 400);
    utimesSync(join(sessionsDir(), "older.jsonl"), now - 300, now - 300);
    utimesSync(join(sessionsDir(), "newer.jsonl"), now - 200, now - 200);
    utimesSync(join(sessionsDir(), "newest.jsonl"), now - 100, now - 100);

    const removed = await pruneSessions(2, { exclude: "oldest" });
    assert.equal(removed, 1, "only the oldest non-excluded session is pruned");
    const remaining = (await listSessions()).map((entry) => entry.name).sort();
    assert.deepEqual(remaining, ["newer", "newest", "oldest"], "the excluded active session survives");
  } finally {
    process.env.ARGUS_HOME = original;
  }
});

test("pruneSessions with keep <= 0 removes nothing", async () => {
  const s = new Session("keep-all", config);
  await s.appendTurn({ config, messages: [{ role: "user", content: "x" }], blocks: [] });
  assert.equal(await pruneSessions(0), 0);
  assert.equal(await pruneSessions(-1), 0);
  assert.ok((await listSessions()).some((entry) => entry.name === "keep-all"));
});

test("deleteSession removes only an exact inactive session", async () => {
  const doomed = new Session("delete-me", config);
  await doomed.appendTurn({ config, messages: [], blocks: [] });
  const active = new Session("keep-active", config);
  await active.appendTurn({ config, messages: [], blocks: [] });

  assert.equal(await deleteSession("delete-me", { exclude: "keep-active" }), "delete-me");
  assert.equal(existsSync(doomed.file), false);
  assert.equal(existsSync(active.file), true);
  await assert.rejects(deleteSession("keep-active", { exclude: "keep-active" }), /cannot delete the active session/);
  await assert.rejects(deleteSession("missing"), /session not found/);
  await assert.rejects(deleteSession("../outside"), /invalid session name/);
});

test("session directories and newly written transcripts are private", async () => {
  const session = new Session("private-mode", config);
  await session.appendTurn({ config, messages: [], blocks: [] });
  if (process.platform !== "win32") {
    assert.equal(statSync(sessionsDir()).mode & 0o777, 0o700);
    assert.equal(statSync(session.file).mode & 0o777, 0o600);
  }
});

test("sessionConfig persists the model delta; configRecord the static config, never the API key", () => {
  const cfg = {
    baseUrl: "http://x",
    apiKey: "secret",
    model: "m",
    systemPrompt: "s",
    requestTimeoutMs: 42,
    streamIdleTimeoutMs: 1,
    maxRetries: 2,
    maxSteps: 3,
    maxToolResultChars: 500,
    maxTurnToolResultChars: 4_000,
    sessionKeep: 9,
  };
  assert.deepEqual(sessionConfig(cfg), { model: "m" });
  assert.deepEqual(configRecord(cfg), {
    baseUrl: "http://x",
    systemPrompt: "s",
    requestTimeoutMs: 42,
    maxRetries: 2,
    maxSteps: 3,
    maxToolResultChars: 500,
    maxTurnToolResultChars: 4_000,
  });
  assert.ok(!("apiKey" in configRecord(cfg)), "the API key never persists");
  assert.ok(!("model" in configRecord(cfg)), "the model has its own record and can change per turn");
  assert.ok(!("streamIdleTimeoutMs" in configRecord(cfg)) && !("sessionKeep" in configRecord(cfg)), "stream-only and host-only knobs stay out");
});

test("turns identify their exact tool surface and schema changes append a snapshot", async () => {
  const first = new Session("surface-version", config);
  await first.appendTurn({ config, messages: [], blocks: [] });
  const resumed = new Session("surface-version", config, { initialToolSurfaceHash: "outdated" });
  await resumed.appendTurn({ config, messages: [], blocks: [] });

  const lines = readFileSync(resumed.file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.type), ["meta", "turn", "tools", "turn"]);
  assert.equal(lines[0].toolSurfaceHash, toolSurfaceHash());
  assert.equal(lines[1].toolSurfaceHash, toolSurfaceHash());
  assert.equal(lines[2].hash, toolSurfaceHash());
  assert.equal(lines[3].toolSurfaceHash, toolSurfaceHash());
});

test("sessionData rebuilds transcript, history, and meta in one place", () => {
  const data = {
    meta: { cwd: "/w", model: "model-x" },
    turns: [
      { messages: [{ role: "user", content: "a" }], blocks: [{ kind: "user", text: "a" }] },
      { messages: [{ role: "assistant", content: "b" }], blocks: [{ kind: "assistant", text: "b" }] },
    ],
  };
  const { blocks, history, cwd, model } = sessionData(data);
  assert.deepEqual(history.map((m) => m.content), ["a", "b"]);
  assert.deepEqual(blocks.map((b) => b.kind), ["user", "assistant"]);
  assert.equal(cwd, "/w");
  assert.equal(model, "model-x");
  assert.deepEqual(sessionData(null), { blocks: [], history: [], cwd: null, model: null, warnings: [] });
});

test("loadSession skips any torn line with a warning instead of bricking the session", async () => {
  const corruptFile = join(sessionsDir(), "corrupt-middle.jsonl");
  const tornFile = join(sessionsDir(), "torn-tail.jsonl");
  const badHead = join(sessionsDir(), "bad-head.jsonl");
  writeFileSync(corruptFile, '{"type":"meta","version":1}\nnot-json\n{"type":"turn","messages":[{"role":"user","content":"hi"}]}\n');
  writeFileSync(tornFile, '{"type":"meta","version":1}\n{"type":"turn"');
  writeFileSync(badHead, 'garbage\n{"type":"cwd","cwd":"/x"}\n');
  try {
    const interior = await loadSession("corrupt-middle");
    assert.equal(interior.turns.length, 1, "the valid turn after the bad line still loads");
    assert.equal(interior.turns[0].messages[0].content, "hi");
    assert.deepEqual(interior.meta.warnings, ["ignored unparseable session record at line 2"]);

    const torn = await loadSession("torn-tail");
    assert.equal(torn.turns.length, 0);
    assert.deepEqual(torn.meta.warnings, ["ignored unparseable session record at line 2"]);

    const head = await loadSession("bad-head");
    assert.equal(head.meta.cwd, "/x", "the record after the bad head line still parses");
    assert.deepEqual(head.meta.warnings, ["ignored unparseable session record at line 1"]);
  } finally {
    rmSync(corruptFile, { force: true });
    rmSync(tornFile, { force: true });
    rmSync(badHead, { force: true });
  }
});

test("the static config is persisted once, never per turn", async () => {
  const s = new Session("cfg-once", config);
  await s.setConfig(config);
  await s.appendTurn({ config: sessionConfig(config), messages: [], blocks: [] });
  await s.appendTurn({ config: sessionConfig(config), messages: [], blocks: [] });

  const lines = readFileSync(s.file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.type), ["meta", "config", "turn", "turn"]);
  assert.equal(lines[1].systemPrompt, "s", "the config record carries the prompt");
  assert.ok(!Object.hasOwn(lines[2], "systemPrompt"), "turn records no longer re-store the prompt");
  assert.equal(lines[2].config.model, "mock", "each turn still records which model saw it");

  const loaded = await loadSession("cfg-once");
  assert.equal(loaded.meta.config.systemPrompt, "s");
  assert.equal(loaded.meta.config.baseUrl, "http://x");
});

test("scanSessionMeta returns metadata without retaining turn payloads", async () => {
  const s = new Session("head-scan", config);
  await s.setCwd("/work");
  await s.setConfig(config);
  // A rich turn full of content the meta scan need not deserialize.
  await s.appendTurn({
    config: sessionConfig(config),
    messages: [{ role: "user", content: "boom".repeat(10_000) }],
    blocks: [{ kind: "assistant", text: "x".repeat(10_000) }],
  });
  const meta = await scanSessionMeta("head-scan");
  assert.equal(meta.cwd, "/work");
  assert.equal(meta.config.systemPrompt, "s");
  assert.ok(!meta.warnings, "discovery does not collect full-load warnings");
});

test("a torn/corrupt session cannot block default-session resolution", async () => {
  await withSessionHome(async (dir) => {
    await mkSession(dir, "good", "/repo", 1000);
    writeFileSync(join(dir, "corrupt-latest.jsonl"), 'garbage-mid\n{"type":"cwd","cwd":"/repo"}\n{"type":"turn"');
    utimesSync(join(dir, "corrupt-latest.jsonl"), new Date(2000), new Date(2000));
    // The corrupt session is newest and for the right folder; resolution must
    // skip past it and still find a usable match (or fail cleanly).
    const resolved = await latestSessionForCwd("/repo");
    assert.ok(resolved === "corrupt-latest" || resolved === "good", `resolved ${resolved} without bricking`);
  });
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

test("renameSession moves the file and preserves its contents", async () => {
  const s = new Session("keep-old", config);
  await s.appendTurn({ config, messages: [{ role: "user", content: "keep me" }], blocks: [] });

  assert.equal(await renameSession("keep-old", "keep-new"), "keep-new");
  const moved = readFileSync(join(process.env.ARGUS_HOME, "sessions", "keep-new.jsonl"), "utf8");
  assert.ok(moved.includes("keep me"), "contents survive the rename");
  const dir = readdirSync(join(process.env.ARGUS_HOME, "sessions"));
  assert.ok(!dir.includes("keep-old.jsonl"), "old file is gone");
  assert.ok(dir.includes("keep-new.jsonl"), "new file exists");
  assert.equal((await loadSession("keep-new")).turns.length, 1);
  assert.equal(await loadSession("keep-old"), null);
});

test("renameSession rejects invalid names and collisions, no-ops on itself", async () => {
  const s = new Session("r-a", config);
  await s.appendTurn({ config, messages: [], blocks: [] });
  await assert.rejects(() => renameSession("r-a", "bad name!"), /invalid session name/);
  const other = new Session("r-b", config);
  await other.appendTurn({ config, messages: [{ role: "user", content: "untouched" }], blocks: [] });
  await assert.rejects(() => renameSession("r-a", "r-b"), /session already exists/);
  const untouched = await loadSession("r-b");
  assert.equal(untouched.turns[0].messages[0].content, "untouched", "the existing session is never clobbered");
  assert.equal((await loadSession("r-a")).turns.length, 1, "the source session is untouched");
  assert.equal(await renameSession("r-a", "r-a"), "r-a", "renaming to the same name is a no-op");
});

test("Session#renameTo repoints the handle so later writes hit the new file", async () => {
  const s = new Session("handle-old", config);
  await s.appendTurn({ config, messages: [], blocks: [] });
  await renameSession("handle-old", "handle-new");
  s.renameTo("handle-new");
  await s.appendTurn({ config, messages: [{ role: "user", content: "after rename" }], blocks: [] });

  const loaded = await loadSession("handle-new");
  assert.equal(loaded.turns.length, 2);
  assert.equal(loaded.turns[1].messages[0].content, "after rename");
  const dir = readdirSync(join(process.env.ARGUS_HOME, "sessions"));
  assert.ok(!dir.includes("handle-old.jsonl"), "the handle must not recreate the old file");
});

/** Run `fn` against a throwaway ARGUS_HOME so folder-matching tests never
 *  see sessions left behind by earlier tests in this file. */
async function withSessionHome(fn) {
  const original = process.env.ARGUS_HOME;
  const home = mkdtempSync(join(tmpdir(), "argus-sess-home-"));
  process.env.ARGUS_HOME = home;
  try {
    await fn(join(home, "sessions"));
  } finally {
    process.env.ARGUS_HOME = original;
    rmSync(home, { recursive: true, force: true });
  }
}

const mkSession = async (dir, name, cwd, mtime) => {
  const s = new Session(name, config);
  await s.setCwd(cwd);
  utimesSync(join(dir, `${name}.jsonl`), new Date(mtime), new Date(mtime));
};

test("latestSessionForCwd prefers the newest session inside the folder", async () => {
  await withSessionHome(async (dir) => {
    // Newest overall is /elsewhere, so the folder-scoped default must differ
    // from the plain "latest session" behavior.
    await mkSession(dir, "elsewhere", "/elsewhere", 3000);
    await mkSession(dir, "outside", "/other-repo", 2000);
    await mkSession(dir, "in-root", "/repo", 1000);
    await mkSession(dir, "in-sub", "/repo/src", 500);

    assert.equal(await latestSessionForCwd("/repo"), "in-root");
    assert.equal(await latestSessionForCwd("/repo/src"), "in-sub", "only sessions at/below the folder match");
    assert.equal(await latestSessionForCwd("/elsewhere"), "elsewhere");
    assert.equal((await listSessions())[0].name, "elsewhere", "newest overall stays elsewhere");
  });
});

test("latestSessionForCwd respects folder boundaries, trailing slashes, and the root", async () => {
  await withSessionHome(async (dir) => {
    await mkSession(dir, "sibling", "/repo-x", 4000);
    await mkSession(dir, "nested", "/repo/sub", 3500);

    assert.equal(await latestSessionForCwd("/repo"), "nested", "/repo-x is a sibling, not inside /repo");
    assert.equal(await latestSessionForCwd("/repo/"), "nested", "a trailing slash is tolerated");
    assert.equal(await latestSessionForCwd("/"), "sibling", "the filesystem root matches every session");
    assert.equal(await latestSessionForCwd("/no-such-folder"), null);
  });
});

test("latestSessionForCwd scans only the newest `limit` sessions", async () => {
  await withSessionHome(async (dir) => {
    await mkSession(dir, "limit-new-other", "/limit-elsewhere", 9000);
    await mkSession(dir, "limit-old-repo", "/limit-repo", 100);

    assert.equal(await latestSessionForCwd("/limit-repo", { limit: 1 }), null, "the folder session is beyond the window");
    assert.equal(await latestSessionForCwd("/limit-repo"), "limit-old-repo", "without a limit it is found");
  });
});

test("defaultSessionName falls back to a fresh name when nothing relates to the folder", async () => {
  await withSessionHome(async (dir) => {
    await mkSession(dir, "folder-work", "/d-repo", 1000);
    assert.equal(await latestSessionForCwd("/no-such-folder-xyz"), null);
    assert.match(await defaultSessionName("/no-such-folder-xyz"), /^argus-/, "a fresh session starts when no folder session exists");
    assert.equal(await defaultSessionName("/d-repo"), "folder-work", "otherwise the newest session for the folder wins");
  });
});

test("renameSession repoints a session that has no file yet (fresh /new)", async () => {
  const handle = new Session("fresh-old", config);
  // The file is written lazily on the first append; nothing exists yet.
  const dir = readdirSync(join(process.env.ARGUS_HOME, "sessions"));
  assert.ok(!dir.includes("fresh-old.jsonl"), "fresh session has no file yet");

  assert.equal(await renameSession("fresh-old", "fresh-new", handle), "fresh-new");

  // No stray file was created by the rename itself.
  const after = readdirSync(join(process.env.ARGUS_HOME, "sessions"));
  assert.ok(!after.includes("fresh-old.jsonl"));
  assert.ok(!after.includes("fresh-new.jsonl"), "rename of an unwritten session creates nothing");

  // Later turns land under the new name only.
  await handle.appendTurn({ config, messages: [{ role: "user", content: "first turn" }], blocks: [] });
  assert.equal((await loadSession("fresh-new")).turns.length, 1);
  assert.equal(await loadSession("fresh-old"), null);
});

test("renameSession(old, next, handle) drains in-flight writes and repoints the handle", async () => {
  const handle = new Session("drain-old", config);
  await handle.appendTurn({ config, messages: [{ role: "user", content: "before" }], blocks: [] });

  // A write is queued but not yet flushed when the rename starts.
  const pending = handle.appendTurn({ config, messages: [{ role: "user", content: "queued" }], blocks: [] });
  assert.equal(await renameSession("drain-old", "drain-new", handle), "drain-new");
  await pending;

  const loaded = await loadSession("drain-new");
  assert.equal(loaded.turns.length, 2);
  assert.equal(loaded.turns[1].messages[0].content, "queued", "the queued turn lands in the renamed file");
  assert.equal(await loadSession("drain-old"), null);
});
