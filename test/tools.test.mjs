import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool, tools, validateToolArgs } from "../src/tools.mjs";

const read = findTool("read");
const writeTool = findTool("write");
const edit = findTool("edit");

test("edit advertises a single canonical edits[] shape to the model", () => {
  const props = edit.parameters.properties;
  for (const legacy of ["old", "new", "startLine", "endLine"]) {
    assert.equal(props[legacy], undefined, `legacy top-level ${legacy} is not in the schema`);
  }
  assert.ok(props.edits, "edits[] is the canonical shape");
  assert.deepEqual(edit.parameters.required, ["path", "edits"]);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read", "write", "edit", "bash"],
    "the default tool set stays four focused tools",
  );
});

function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-tools-test-"));
    const tmp = (name) => join(dir, name);
    const write = (name, content) => writeFileSync(tmp(name), content);
    const content = (name) => readFileSync(tmp(name), "utf8");
    try {
      await fn({ dir, tmp, write, content });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("read numbers every line with its absolute 1-indexed line number", withDir(async ({ tmp, write }) => {
  write("small.txt", "a\nb\nc\n");
  const r = await read.execute({ path: "small.txt" }, { cwd: tmp("") });
  assert.equal(r.error, undefined);
  assert.equal(r.numberedText, "1 │ a\n2 │ b\n3 │ c\n");
  assert.equal(r.truncated, undefined);

  // paging keeps absolute numbers, so the model never has to count
  const p = await read.execute({ path: "small.txt", offset: 2 }, { cwd: tmp("") });
  assert.equal(p.numberedText, "2 │ b\n3 │ c\n");
}));

test("read truncates huge files and tells the model how to continue", withDir(async ({ tmp, write }) => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  write("big.txt", lines.join("\n") + "\n");
  const r = await read.execute({ path: "big.txt" }, { cwd: tmp("") });
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 2001);
  assert.equal(r.numberedText.split("\n").length, 2002); // 2000 numbered lines + blank + notice
  assert.match(r.numberedText, /\[Showing lines 1-2000 of 3000\. Use offset=2001 to continue\.\]/);
  assert.ok(r.numberedText.includes("   1 │ line 0"), "head of the file is present");
  assert.ok(!r.numberedText.includes("line 2999"), "tail is not present");
}));

test("read pages with offset/limit", withDir(async ({ tmp, write }) => {
  const lines = Array.from({ length: 200 }, (_, i) => `n${i}`);
  write("paged.txt", lines.join("\n") + "\n");
  const r = await read.execute({ path: "paged.txt", offset: 95, limit: 10 }, { cwd: tmp("") });
  assert.ok(r.numberedText.startsWith(" 95 │ n94"), "absolute line 95 at 1-indexed offset 95");
  assert.ok(r.numberedText.includes("104 │ n103"), "includes the whole window");
  assert.match(r.numberedText, /Showing lines 95-104 of 200\. Use offset=105 to continue/);
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 105);
  const tail = await read.execute({ path: "paged.txt", offset: 200 }, { cwd: tmp("") });
  assert.ok(tail.numberedText.endsWith("│ n199\n"), "reproduces the file's final newline");
}));

test("read refuses an offset beyond the end of the file", withDir(async ({ tmp, write }) => {
  write("short.txt", "only one line");
  const r = await read.execute({ path: "short.txt", offset: 3 }, { cwd: tmp("") });
  assert.equal(r.error, true);
  assert.match(r.message, /offset 3 is beyond/);
}));

test("read handles empty files and single huge lines", withDir(async ({ tmp, write }) => {
  write("empty.txt", "");
  const e = await read.execute({ path: "empty.txt" }, { cwd: tmp("") });
  assert.deepEqual(e, { path: e.path, numberedText: "", startLine: 0, endLine: 0, totalLines: 0 });

  write("huge.txt", "y".repeat(200_000) + "\n");
  const h = await read.execute({ path: "huge.txt" }, { cwd: tmp("") });
  assert.equal(h.error, true);
  assert.match(h.message, /over the 50KB line limit/);
  assert.equal(h.nextOffset, undefined, "an oversized line must not point back to itself");
}));

test("runtime validation enforces the full canonical schema", () => {
  assert.match(validateToolArgs(read, { path: "x", offset: 0 }), /at least 1/);
  assert.match(validateToolArgs(read, { path: "x", limit: -1 }), /at least 1/);
  assert.match(validateToolArgs(writeTool, { path: "x", content: "body" }), /ensureFinalNewline/);
  assert.equal(validateToolArgs(writeTool, { path: "x", content: "body", ensureFinalNewline: true }), null);
  assert.match(validateToolArgs(edit, { path: "x", edits: [] }), /at least 1 item/);
  assert.match(validateToolArgs(edit, { path: "x", edits: [{ old: "x" }] }), /missing required argument: new/);
  assert.match(validateToolArgs(edit, { path: "x", edits: [{ old: "x", startLine: 1, new: "y" }] }), /exactly one/);
  assert.match(validateToolArgs(edit, { path: "x", edits: [{ startLine: 1.5, new: "y" }] }), /must be integer/);
  assert.match(validateToolArgs(edit, { path: "x", edits: [{ old: "", new: "y" }] }), /must not be empty/);
  assert.match(validateToolArgs(edit, { path: "x", edits: [{ old: "x", new: "y", surprise: true }] }), /unknown argument/);
  assert.equal(validateToolArgs(edit, { path: "x", edits: [{ startLine: 1, endLine: 0, new: "y" }] }), null);
});

test("write applies an explicit final-newline policy and reports the result", withDir(async ({ tmp, content }) => {
  const added = await writeTool.execute(
    { path: "with-newline.txt", content: "body", ensureFinalNewline: true },
    { cwd: tmp("") },
  );
  assert.equal(content("with-newline.txt"), "body\n");
  assert.deepEqual(
    { finalNewline: added.finalNewline, newlineAdded: added.newlineAdded, bytes: added.bytes },
    { finalNewline: true, newlineAdded: true, bytes: 5 },
  );

  const exact = await writeTool.execute(
    { path: "exact.txt", content: "body", ensureFinalNewline: false },
    { cwd: tmp("") },
  );
  assert.equal(content("exact.txt"), "body");
  assert.equal(exact.finalNewline, false);
  assert.equal(exact.newlineAdded, false);

  const existing = await writeTool.execute(
    { path: "already.txt", content: "body\n", ensureFinalNewline: true },
    { cwd: tmp("") },
  );
  assert.equal(content("already.txt"), "body\n", "ensure does not duplicate an existing newline");
  assert.equal(existing.newlineAdded, false);
}));

test("edit canonical content form works", withDir(async ({ tmp, write, content }) => {
  write("a.txt", "hello");
  const r = await edit.execute({ path: "a.txt", edits: [{ old: "hello", new: "bye" }] }, { cwd: tmp("") });
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 1);
  assert.equal(content("a.txt"), "bye");
}));

test("edit matches despite trailing whitespace differences (fuzzy)", withDir(async ({ tmp, write, content }) => {
  // the model copied the line without its trailing spaces, so the old text
  // (ending in the newline) does not match exactly and fuzzy matching kicks in
  write("b.txt", "const a = 1;  \nconst b = 2;\n");
  const r = await edit.execute({ path: "b.txt", edits: [{ old: "const a = 1;\n", new: "const a = 1; // ok\n" }] }, { cwd: tmp("") });
  assert.equal(r.ok, true);
  assert.equal(r.fuzzy, true, "reports the relaxed match");
  // the untouched line keeps its exact bytes
  assert.equal(content("b.txt"), "const a = 1; // ok\nconst b = 2;\n");
}));

test("edit tolerates line-number gutters copied from a read", withDir(async ({ tmp, write, content }) => {
  write("g.txt", "const a = 1;\nconst b = 2;\n");
  const r = await edit.execute({ path: "g.txt", edits: [{ old: "  2 │ const b = 2;\n", new: "const c = 3;\n" }] }, { cwd: tmp("") });
  assert.equal(r.ok, true);
  assert.equal(r.fuzzy, true, "relaxed matching strips the gutter");
  assert.equal(content("g.txt"), "const a = 1;\nconst c = 3;\n");
}));

test("edit rejects read gutters copied into replacement text before any mutation", withDir(async ({ tmp, write, content }) => {
  write("leak.txt", "const a = 1;\nconst b = 2;\n");
  const original = content("leak.txt");
  const copiedContent = await edit.execute(
    {
      path: "leak.txt",
      edits: [
        { old: "const a = 1;", new: "const a = 10;" },
        { old: "2 │ const b = 2;", new: "2 │ const b = 20;" },
      ],
    },
    { cwd: tmp("") },
  );
  assert.equal(copiedContent.error, true);
  assert.match(copiedContent.message, /copied from read\.numberedText/);
  assert.equal(content("leak.txt"), original, "the whole batch remains atomic");

  const copiedRange = await edit.execute(
    { path: "leak.txt", edits: [{ startLine: 1, endLine: 2, new: "1 │ const a = 10;\n2 │ const b = 20;" }] },
    { cwd: tmp("") },
  );
  assert.equal(copiedRange.error, true);
  assert.match(copiedRange.message, /remove the ‘N │’ line prefixes/);
  assert.equal(content("leak.txt"), original);
}));

test("edit permits numbered text that is actual file content", withDir(async ({ tmp, write, content }) => {
  write("table.txt", "12 │ old\n13 │ keep\n");
  const exact = await edit.execute(
    { path: "table.txt", edits: [{ old: "12 │ old", new: "12 │ new" }] },
    { cwd: tmp("") },
  );
  assert.equal(exact.ok, true);
  assert.equal(content("table.txt"), "12 │ new\n13 │ keep\n");

  const range = await edit.execute(
    { path: "table.txt", edits: [{ startLine: 1, new: "12 │ newer" }] },
    { cwd: tmp("") },
  );
  assert.equal(range.ok, true);
  assert.equal(content("table.txt"), "12 │ newer\n13 │ keep\n");

  const insert = await edit.execute(
    { path: "table.txt", edits: [{ startLine: 3, endLine: 2, new: "3 │ third\n4 │ fourth" }] },
    { cwd: tmp("") },
  );
  assert.equal(insert.ok, true, "ambiguous insertion data is not rejected heuristically");
  assert.equal(content("table.txt"), "12 │ newer\n13 │ keep\n3 │ third\n4 │ fourth\n");
}));

test("edit matches smart quotes and preserves CRLF + BOM", withDir(async ({ tmp, write, content }) => {
  write("c.txt", "\uFEFFHe said \u201Chello\u201D\r\nSecond\r\n");
  const r = await edit.execute({ path: "c.txt", edits: [{ old: 'He said "hello"', new: "She said hi" }] }, { cwd: tmp("") });
  assert.equal(r.ok, true);
  assert.equal(r.fuzzy, true);
  assert.equal(content("c.txt"), "\uFEFFShe said hi\r\nSecond\r\n");
}));

test("edit applies several content replacements atomically via edits[]", withDir(async ({ tmp, write, content }) => {
  write("d.txt", "a1\nb2\nc3\n");
  const r = await edit.execute(
    { path: "d.txt", edits: [{ old: "a1", new: "A1" }, { old: "c3", new: "C3" }] },
    { cwd: tmp("") }
  );
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 2);
  assert.equal(content("d.txt"), "A1\nb2\nC3\n");
}));

test("edit still refuses ambiguous matches unless all=true", withDir(async ({ tmp, write, content }) => {
  write("e.txt", "x x");
  const r = await edit.execute({ path: "e.txt", edits: [{ old: "x", new: "y" }] }, { cwd: tmp("") });
  assert.equal(r.error, true);
  assert.match(r.message, /occurs 2 times/);
  const all = await edit.execute({ path: "e.txt", edits: [{ old: "x", new: "y" }], all: true }, { cwd: tmp("") });
  assert.equal(all.ok, true);
  assert.equal(content("e.txt"), "y y");
}));

test("edit not-found error is actionable", withDir(async ({ tmp, write }) => {
  write("f.txt", "some content");
  const r = await edit.execute({ path: "f.txt", edits: [{ old: "zzz", new: "x" }] }, { cwd: tmp("") });
  assert.equal(r.error, true);
  assert.match(r.message, /old string not found/);
  assert.match(r.message, /fresh read/);
}));

test("edit range mode replaces an inclusive line range", withDir(async ({ tmp, write, content }) => {
  write("r.txt", "a\nb\nc\nd\n");
  const r = await edit.execute({ path: "r.txt", edits: [{ startLine: 2, endLine: 3, new: "X\nY" }] }, { cwd: tmp("") });
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 1);
  assert.equal(content("r.txt"), "a\nX\nY\nd\n");
}));

test("edit range mode is line-oriented and never merges lines", withDir(async ({ tmp, write, content }) => {
  write("m.txt", "a\nb\nc\n");
  await edit.execute({ path: "m.txt", edits: [{ startLine: 2, new: "B" }] }, { cwd: tmp("") });
  assert.equal(content("m.txt"), "a\nB\nc\n");
}));

test("edit range mode inserts before a line and appends at EOF", withDir(async ({ tmp, write, content }) => {
  write("i.txt", "a\nb\nc\n");
  await edit.execute({ path: "i.txt", edits: [{ startLine: 2, endLine: 1, new: "X" }] }, { cwd: tmp("") });
  assert.equal(content("i.txt"), "a\nX\nb\nc\n");

  await edit.execute({ path: "i.txt", edits: [{ startLine: 5, endLine: 4, new: "z" }] }, { cwd: tmp("") });
  assert.equal(content("i.txt"), "a\nX\nb\nc\nz\n");

  write("one.txt", "solo");
  await edit.execute({ path: "one.txt", edits: [{ startLine: 2, endLine: 1, new: "second" }] }, { cwd: tmp("") });
  assert.equal(content("one.txt"), "solo\nsecond", "separates the inserted line");
}));

test("edit range mode deletes lines", withDir(async ({ tmp, write, content }) => {
  write("d.txt", "a\nb\nc\nd\n");
  await edit.execute({ path: "d.txt", edits: [{ startLine: 2, endLine: 3, new: "" }] }, { cwd: tmp("") });
  assert.equal(content("d.txt"), "a\nd\n");
}));

test("edit range mode validates bounds and meaning of endLine", withDir(async ({ tmp, write }) => {
  write("b.txt", "a\nb\nc\n");
  const oob = await edit.execute({ path: "b.txt", edits: [{ startLine: 99, new: "x" }] }, { cwd: tmp("") });
  assert.equal(oob.error, true);
  assert.match(oob.message, /out of bounds: the file has 3 lines/);
  const bad = await edit.execute({ path: "b.txt", edits: [{ startLine: 3, endLine: 5, new: "x" }] }, { cwd: tmp("") });
  assert.equal(bad.error, true);
  assert.match(bad.message, /out of bounds/);
  const weird = await edit.execute({ path: "b.txt", edits: [{ startLine: 3, endLine: 1, new: "x" }] }, { cwd: tmp("") });
  assert.equal(weird.error, true);
  assert.match(weird.message, /endLine must be startLine - 1/);
}));

test("edit mixes content and range edits atomically against the original", withDir(async ({ tmp, write, content }) => {
  write("x.txt", "a1\nb2\nc3\nd4\n");
  const r = await edit.execute(
    { path: "x.txt", edits: [{ old: "a1", new: "A1" }, { startLine: 3, endLine: 3, new: "C3!" }] },
    { cwd: tmp("") }
  );
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 2);
  assert.equal(content("x.txt"), "A1\nb2\nC3!\nd4\n");
}));

test("edit range mode preserves CRLF line endings", withDir(async ({ tmp, write, content }) => {
  write("crlf.txt", "a\r\nb\r\nc\r\n");
  await edit.execute({ path: "crlf.txt", edits: [{ startLine: 2, new: "B" }] }, { cwd: tmp("") });
  assert.equal(content("crlf.txt"), "a\r\nB\r\nc\r\n");
}));

test("edit range mode can fill an empty file", withDir(async ({ tmp, write, content }) => {
  write("empty.txt", "");
  await edit.execute({ path: "empty.txt", edits: [{ startLine: 1, endLine: 0, new: "hello" }] }, { cwd: tmp("") });
  assert.equal(content("empty.txt"), "hello");
}));
