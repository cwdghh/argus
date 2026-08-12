import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../src/tools.mjs";
import { MinimalTui } from "../src/tui.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

test("TUI handles a turn error without crashing (ac scope fix)", async (t) => {
  const srv = await createMockServer(() => {
    throw new Error("boom");
  });
  t.after(() => srv.close());
  const tui = new MinimalTui({ baseUrl: srv.url, apiKey: "", model: "m", systemPrompt: "s" });
  tui.width = 60;
  tui.height = 20;
  tui.inputBuffer = "hi";
  await tui.submit();
  assert.ok(tui.blocks.some((b) => b.kind === "error"), "error block should be shown");
  assert.equal(tui.mode, "idle", "mode should return to idle");
});

test("TUI persists failed turns, including the visible error", async (t) => {
  const srv = await createMockServer(() => {
    throw new Error("boom");
  });
  t.after(() => srv.close());
  let saved = null;
  const session = { appendTurn: async (turn) => (saved = turn), setCwd: async () => {} };
  const tui = new MinimalTui(
    { baseUrl: srv.url, apiKey: "", model: "m", systemPrompt: "s" },
    { session }
  );
  tui.inputBuffer = "remember me";
  await tui.submit();
  assert.equal(saved.messages[0].content, "remember me");
  assert.ok(saved.blocks.some((b) => b.kind === "error" && /boom/.test(b.text)));
});

test("TUI persists its cwd even when no command changes directory", async (t) => {
  const srv = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv.close());
  let savedCwd = null;
  const session = { appendTurn: async () => {}, setCwd: async (cwd) => (savedCwd = cwd) };
  const tui = new MinimalTui(
    { baseUrl: srv.url, apiKey: "", model: "m", systemPrompt: "s" },
    { session, initialCwd: "/project" }
  );
  tui.inputBuffer = "hello";
  await tui.submit();
  assert.equal(savedCwd, "/project");
});

test("read/write/edit resolve relative to the session cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-tools-cwd-"));
  try {
    const write = findTool("write");
    const read = findTool("read");
    const edit = findTool("edit");
    const w = await write.execute({ path: "a.txt", content: "hello" }, { cwd: dir });
    assert.equal(w.path, join(dir, "a.txt"));
    const protectedWrite = await write.execute({ path: "a.txt", content: "lost" }, { cwd: dir });
    assert.equal(protectedWrite.error, true, "write should protect existing files by default");
    assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).content, "hello");
    const e = await edit.execute({ path: "a.txt", old: "hello", new: "bye" }, { cwd: dir });
    assert.equal(e.ok, true);
    assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).content, "bye");
    const bad = await edit.execute({ path: "a.txt", old: "zzz", new: "x" }, { cwd: dir });
    assert.match(bad.message, /a\.txt/, "edit error should name the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty transcript shows a centered hint", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 12;
  const frame = t.buildFrame();
  assert.ok(frame.some((row) => row.includes("Type a task")), "hint should be visible");
});

test("turn divider separates later user blocks", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 20;
  t.pushBlock({ kind: "user", text: "first" });
  t.pushBlock({ kind: "assistant", text: "a1" });
  t.pushBlock({ kind: "user", text: "second" });
  t.pushBlock({ kind: "assistant", text: "a2" });
  const lines = t.transcriptLines();
  const div = lines.filter((l) => l.includes("─"));
  assert.equal(div.length, 1, "one divider between the two turns");
});

test("CJK display width: cursor column tracks double-width chars", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 20;
  t.inputBuffer = "你好世界";
  t.inputCursor = 4;
  assert.equal(t.inputView().col, 2 + 8, "4 CJK chars should be 8 columns");
});

test("CJK text wraps within the terminal width", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 20;
  t.height = 20;
  t.append("assistant", "你".repeat(40));
  const strip = (s2) => s2.replace(/\x1b\[[0-9;]*m/g, "");
  const width = (s2) => {
    let w = 0;
    for (const ch of s2) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
    return w;
  };
  for (const l of t.transcriptLines()) {
    assert.ok(width(strip(l)) <= 20, `line too wide: ${JSON.stringify(strip(l))}`);
  }
});

test("blank submit stays idle and Backspace at column zero is harmless", async () => {
  const t = new MinimalTui({ model: "m" });
  t.inputBuffer = "   ";
  await t.submit();
  assert.equal(t.mode, "idle");
  t.inputBuffer = "abc";
  t.inputCursor = 0;
  t.runAction({ type: "backspace" });
  assert.equal(t.inputBuffer, "abc");
});

test("editor movement and deletion preserve emoji surrogate pairs", () => {
  const t = new MinimalTui({ model: "m" });
  t.inputBuffer = "a😀b";
  t.inputCursor = 3;
  t.runAction({ type: "left" });
  assert.equal(t.inputCursor, 1);
  t.runAction({ type: "right" });
  assert.equal(t.inputCursor, 3);
  t.runAction({ type: "backspace" });
  assert.equal(t.inputBuffer, "ab");
});
