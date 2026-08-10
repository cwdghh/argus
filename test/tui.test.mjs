import test from "node:test";
import assert from "node:assert/strict";
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
