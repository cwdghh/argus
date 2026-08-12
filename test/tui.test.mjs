import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalTui } from "../src/tui.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("markdown: nested inline, strikethrough, links, code fence", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 20;
  t.append("assistant", "## T\n\n**b `c`** and ~~gone~~ [l](https://x).\n\n```js\nconst a = 1;\n```");
  const out = strip(t.transcriptLines().join("\n"));
  assert.ok(out.includes("T"), "heading");
  assert.ok(out.includes("b c"), "nested bold+code");
  assert.ok(out.includes("gone"), "strikethrough");
  assert.ok(out.includes("(https://x)"), "link url fallback");
  assert.ok(out.includes("```js") && out.includes("const a = 1;"), "code fence");
});

test("newlines are hard breaks (model convention)", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 20;
  t.append("assistant", "a\nb");
  const lines = t.transcriptLines();
  assert.equal(strip(lines[0]), "a");
  assert.equal(strip(lines[1]), "b");
});

test("footer: mode on the left, no 'mode' prefix, meta right-aligned", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 100;
  t.height = 12;
  t.git = { branch: "main", dirty: false, dirtyCount: 0 };
  t.mode = "working";
  t.cwd = "/workspace/argus";
  const f = strip(t.footer());
  assert.ok(f.startsWith("working"), "mode should be first");
  assert.ok(!f.includes("mode working"), "no 'mode ' prefix");
  assert.ok(f.includes("model mock-model"), "model present");
  assert.ok(f.includes("git main"), "git present");
  assert.ok(f.includes("/workspace/argus"), "ANSI bytes must not crowd out the working directory");
  assert.ok(f.length <= 100, "footer should fit the terminal width");
});

test("input history navigation", () => {
  const t = new MinimalTui({ model: "m" });
  t.inputHistory = ["first", "second"];
  t.historyUp();
  assert.equal(t.inputBuffer, "second");
  t.historyUp();
  assert.equal(t.inputBuffer, "first");
  t.historyDown();
  t.historyDown();
  assert.equal(t.inputBuffer, "");
});

test("abortTurn aborts controller and sets aborting mode", () => {
  const t = new MinimalTui({ model: "m" });
  t.mode = "working";
  let aborted = false;
  t.abortController = { abort: () => (aborted = true) };
  t.abortTurn();
  assert.equal(t.mode, "aborting");
  assert.equal(aborted, true);
});

test("scrolling: wheel up/down + clamp", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.height = 10;
  for (let i = 0; i < 30; i++) t.pushBlock({ kind: "assistant", text: `line ${i}` });
  t.runAction({ type: "wheel", dir: 1 });
  assert.ok(t.scrollOffset > 0);
  t.runAction({ type: "wheel", dir: -1 });
  t.runAction({ type: "wheel", dir: -1 });
  assert.equal(t.scrollOffset, 0);
});

test("local slash commands do not enter model history", async () => {
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "old",
      initialHistory: [{ role: "user", content: "earlier" }],
      newSession: () => ({ sessionName: "fresh", session: {}, cwd: "/fresh" }),
      listSessions: () => [{ name: "saved", mtime: 1, turns: 2, lastPrompt: "last task" }],
      resumeSession: (name) => ({
        sessionName: name,
        session: { name },
        cwd: "/saved",
        history: [{ role: "user", content: "saved prompt" }],
        blocks: [{ kind: "user", text: "saved prompt" }],
      }),
    }
  );
  await t.runCommand("/help");
  assert.ok(t.blocks.some((b) => b.kind === "assistant" && b.text.includes("/status") && b.text.includes("Ctrl-W")));
  assert.equal(t.history.length, 1);
  await t.runCommand("/keys");
  assert.ok(t.blocks.at(-1).text.includes("Keyboard shortcuts"));
  assert.ok(!t.blocks.at(-1).text.includes("Local commands"));
  await t.runCommand("/status");
  assert.ok(t.blocks.at(-1).text.includes("Session: `old`"));
  assert.ok(t.blocks.at(-1).text.includes("chars/tool result"));
  await t.runCommand("/sessions");
  assert.ok(t.blocks.at(-1).text.includes("`saved`") && t.blocks.at(-1).text.includes("last task"));
  await t.runCommand("/resume saved");
  assert.equal(t.sessionName, "saved");
  assert.equal(t.cwd, "/saved");
  assert.deepEqual(t.inputHistory, ["saved prompt"]);
  await t.runCommand("/new");
  assert.equal(t.sessionName, "fresh");
  assert.equal(t.cwd, "/fresh");
  assert.deepEqual(t.history, []);
});

test("Tab completes only @path tokens and preserves surrounding input", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-complete-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "space dir"));
  writeFileSync(join(dir, "src", "agent.mjs"), "");
  writeFileSync(join(dir, "src", "another.mjs"), "");
  writeFileSync(join(dir, "space dir", "file name.txt"), "");
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });

  t.inputBuffer = "Review @src/ag";
  t.inputCursor = t.inputBuffer.length;
  t.completePath();
  assert.equal(t.inputBuffer, "Review @src/agent.mjs ");

  t.inputBuffer = "Review src/ag";
  t.inputCursor = t.inputBuffer.length;
  t.completePath();
  assert.equal(t.inputBuffer, "Review src/ag", "plain paths are not implicitly completed");

  t.inputBuffer = "Review @sr";
  t.inputCursor = t.inputBuffer.length;
  t.completePath();
  assert.equal(t.inputBuffer, "Review @src/");

  t.inputBuffer = "Review @sp";
  t.inputCursor = t.inputBuffer.length;
  t.completePath();
  assert.equal(t.inputBuffer, 'Review @"space dir/');
  t.inputBuffer += "fi";
  t.inputCursor = t.inputBuffer.length;
  t.completePath();
  assert.equal(t.inputBuffer, 'Review @"space dir/file name.txt" ');
});

test("bracketed multiline paste becomes one editor input", () => {
  const t = new MinimalTui({ model: "m" });
  let submits = 0;
  t.submit = () => submits++;
  t.onData(Buffer.from("\x1b[200~first\nsecond\r\nthird\x1b[201~"));
  assert.equal(t.inputBuffer, "first second third");
  assert.equal(submits, 0);
});

test("terminal editing hotkeys manipulate input predictably", () => {
  const t = new MinimalTui({ model: "m" });
  t.inputBuffer = "one two";
  t.inputCursor = t.inputBuffer.length;
  t.insertText("\x17"); // Ctrl-W
  assert.equal(t.inputBuffer, "one ");
  t.insertText("two");
  t.insertText("\x01"); // Ctrl-A
  t.insertText("X");
  assert.equal(t.inputBuffer, "Xone two");
  t.insertText("\x05"); // Ctrl-E
  t.insertText("\x15"); // Ctrl-U
  assert.equal(t.inputBuffer, "");
  t.inputBuffer = "abc";
  t.inputCursor = 1;
  t.insertText("\x04"); // Ctrl-D
  assert.equal(t.inputBuffer, "ac");
});
