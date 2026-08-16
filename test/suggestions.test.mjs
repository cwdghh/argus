import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSuggestion, acceptSuggestion, suggestionLines } from "../src/tui/suggestions.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("suggestions: slash commands match a bare / prefix and hide otherwise", () => {
  const s = computeSuggestion({ buffer: "/st", cursor: 3, mode: "idle", cwd: "/", prev: null });
  assert.equal(s.kind, "slash");
  assert.deepEqual(s.items.map((i) => i.label), ["/status"]);
  assert.equal(s.start, 0);
  assert.equal(s.end, 3);
  // Not a bare command (space follows) -> no popup.
  assert.equal(computeSuggestion({ buffer: "/st x", cursor: 5, mode: "idle", cwd: "/", prev: null }), null);
  // A running turn hides the popup.
  assert.equal(computeSuggestion({ buffer: "/", cursor: 1, mode: "working", cwd: "/", prev: null }), null);
});

test("suggestions: the highlighted row survives recomputes that shrink the list", () => {
  const prev = {
    kind: "slash",
    items: [
      { label: "/status", description: "x" },
      { label: "/sessions", description: "y" },
    ],
    selected: 1,
  };
  const s = computeSuggestion({ buffer: "/s", cursor: 2, mode: "idle", cwd: "/", prev });
  assert.equal(s.kind, "slash");
  assert.equal(s.selected, 1, "same label keeps its highlight");
  const fewer = computeSuggestion({ buffer: "/st", cursor: 3, mode: "idle", cwd: "/", prev });
  assert.equal(fewer.selected, 0, "missing label clamps into the smaller list");
});

test("suggestions: @path lists entries, dotfiles hidden unless the prefix dots", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-sugg-"));
  writeFileSync(join(dir, "agent.mjs"), "x");
  writeFileSync(join(dir, "main.mjs"), "x");
  writeFileSync(join(dir, ".env"), "x");
  let s = computeSuggestion({ buffer: "read @", cursor: 6, mode: "idle", cwd: dir, prev: null });
  assert.equal(s.kind, "path");
  assert.deepEqual(s.items.map((i) => i.label).sort(), ["agent.mjs", "main.mjs"]);
  assert.equal(s.start, 5);
  assert.equal(s.end, 6);
  s = computeSuggestion({ buffer: "read @.", cursor: 7, mode: "idle", cwd: dir, prev: null });
  assert.deepEqual(s.items.map((i) => i.label), [".env"]);
  // Missing directory hides the popup instead of crashing.
  assert.equal(computeSuggestion({ buffer: "read @nope", cursor: 9, mode: "idle", cwd: dir, prev: null }), null);
});

test("suggestions: accepting replaces the token (file: trailing space; dir: slash)", () => {
  const file = { kind: "path", items: [{ label: "agent.mjs", isDirectory: false, symlinkTarget: null }], start: 5, end: 7, dirPart: "", quoted: false, selected: 0 };
  assert.deepEqual(acceptSuggestion(file, "read @a", 7), { buffer: "read @agent.mjs ", cursor: 16 });
  const dir = { kind: "path", items: [{ label: "src/", isDirectory: true, symlinkTarget: null }], start: 5, end: 7, dirPart: "", quoted: false, selected: 0 };
  assert.deepEqual(acceptSuggestion(dir, "read @a", 7), { buffer: "read @src/", cursor: 10 });
});

test("suggestions: accepting a slash command replaces the whole input", () => {
  const s = { kind: "slash", items: [{ label: "/status", description: "" }], start: 0, end: 3, selected: 0 };
  assert.deepEqual(acceptSuggestion(s, "/st", 3), { buffer: "/status ", cursor: 8 });
});

test("suggestions: quoted @path tokens stay quoted and descend into the dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-sugg-"));
  mkdirSync(join(dir, "space dir"));
  writeFileSync(join(dir, "space dir", "file name.txt"), "x");
  const buffer = 'Review @"space dir/';
  const s = computeSuggestion({ buffer, cursor: buffer.length, mode: "idle", cwd: dir, prev: null });
  assert.equal(s.kind, "path");
  assert.equal(s.quoted, true);
  assert.deepEqual(s.items.map((i) => i.label), ["file name.txt"]);
  const next = acceptSuggestion(s, buffer, buffer.length);
  assert.equal(next.buffer, 'Review @"space dir/file name.txt" ');
});

test("suggestions: popup rows keep a constant height with a status row", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ label: `file${i}.mjs`, isDirectory: false, symlinkTarget: null }));
  const s = { kind: "path", items, start: 5, end: 6, dirPart: "", quoted: false, selected: 0 };
  const lines = suggestionLines(s, { width: 40, height: 12, editorHeight: 1, cwd: "/" });
  // header + 7 item rows + status row, exactly the reserved budget
  assert.equal(lines.length, 9);
  const plain = lines.map(strip);
  assert.match(plain[0], /files in \./);
  assert.match(plain.at(-1), /more|matches/);
});
