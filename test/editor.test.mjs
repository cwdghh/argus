import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/tui/editor.mjs";

test("Editor.insert inserts at the caret and advances it", () => {
  const e = new Editor();
  e.insert("abc");
  assert.equal(e.buffer, "abc");
  assert.equal(e.cursor, 3);
  e.cursor = 1;
  e.insert("XY");
  assert.equal(e.buffer, "aXYbc");
  assert.equal(e.cursor, 3);
});

test("Editor.rows wraps long buffers to width - 4", () => {
  const e = new Editor();
  e.insert("abcdefghijklmnop");
  assert.deepEqual(e.rows(12), ["abcdefgh", "ijklmnop"]);
  const empty = new Editor();
  assert.deepEqual(empty.rows(12), [""]);
});

test("Editor.caretPos tracks the caret across wrapped rows", () => {
  const e = new Editor();
  e.insert("abcdefghijklmnop"); // rows at width 12: ["abcdefgh", "ijklmnop"]
  e.cursor = 0;
  assert.deepEqual(e.caretPos(12), { row: 0, col: 0, rows: ["abcdefgh", "ijklmnop"] });
  assert.equal(e.caretPos(12).rows.length, 2);
  // A caret exactly at a segment boundary belongs to the next row (col 0).
  e.cursor = 8;
  assert.equal(e.caretPos(12).row, 1);
  assert.equal(e.caretPos(12).col, 0);
  e.cursor = 13; // 5 chars into the second row
  assert.equal(e.caretPos(12).row, 1);
  assert.equal(e.caretPos(12).col, 5);
  e.cursor = 16; // end of the buffer
  assert.equal(e.caretPos(12).row, 1);
  assert.equal(e.caretPos(12).col, 8);
});

test("Editor.view returns the visible rows, caret row, and column", () => {
  const e = new Editor();
  e.insert("abcdefghijklmnop");
  e.cursor = 13;
  const view = e.view(12, 10);
  assert.deepEqual(view.rows, ["abcdefgh", "ijklmnop"]);
  assert.equal(view.height, 2);
  assert.equal(view.caretRow, 1);
  assert.equal(view.col, 2 + 5);
});

test("Editor.insertNewline splits the buffer at the caret", () => {
  const e = new Editor();
  e.insert("ab");
  e.cursor = 1;
  e.insertNewline();
  assert.equal(e.buffer, "a\nb");
  assert.equal(e.cursor, 2);
});

test("Editor.moveCaretVertical steps between wrapped rows and stops at edges", () => {
  const e = new Editor();
  e.insert("abcdefghijklmnop");
  e.cursor = 13; // row 1, col 5
  assert.equal(e.moveCaretVertical(-1, 12), true);
  assert.equal(e.cursor, 5, "moves to the same column on the row above");
  assert.equal(e.moveCaretVertical(-1, 12), false, "no row above");
  assert.equal(e.moveCaretVertical(1, 12), true);
  assert.equal(e.cursor, 13);
  assert.equal(e.moveCaretVertical(1, 12), false, "no row below");
});

test("Editor.deleteToLineEnd and deleteToLineStart clip the current logical line", () => {
  const e = new Editor();
  e.insert("hello\nworld");
  e.cursor = 2;
  e.deleteToLineEnd();
  assert.equal(e.buffer, "he\nworld");
  e.buffer = "hello\nworld";
  e.cursor = 2;
  e.deleteToLineStart();
  assert.equal(e.buffer, "llo\nworld");
  assert.equal(e.cursor, 0);
});

test("Editor.backspace and deleteAtCursor delete before / under the caret", () => {
  const e = new Editor();
  e.insert("abc");
  e.cursor = 2;
  e.backspace();
  assert.equal(e.buffer, "ac");
  assert.equal(e.cursor, 1);
  e.deleteAtCursor();
  assert.equal(e.buffer, "a");
});

test("Editor history recall walks recall history and resets", () => {
  const e = new Editor();
  e.history = ["first", "second"];
  e.historyUp();
  assert.equal(e.buffer, "second");
  e.historyUp();
  assert.equal(e.buffer, "first");
  e.historyUp(); // clamped at the oldest
  assert.equal(e.buffer, "first");
  e.historyDown();
  assert.equal(e.buffer, "second");
  e.historyDown();
  assert.equal(e.historyIndex, -1);
  assert.equal(e.buffer, "");
});
