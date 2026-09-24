import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolCall } from "../src/agent/tool-call.mjs";
import { createToolState } from "../src/tool-state.mjs";

const call = (name, args, id = name) => ({ id, function: { name, arguments: JSON.stringify(args) } });

function fixture(fn) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "argus-tool-state-"));
    try {
      await fn({ cwd, file: (name) => join(cwd, name) });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test("range edit requires and accepts a fresh covering read", fixture(async ({ cwd, file }) => {
  writeFileSync(file("a.txt"), "a\nb\nc\n");
  const toolState = createToolState();
  const opts = { cwd, toolState, maxToolResultChars: 50_000 };

  const stale = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ startLine: 2, new: "B" }] }, "e1"),
    opts,
  );
  assert.equal(stale.result.error, true);
  assert.match(stale.result.message, /requires a fresh read/);

  await executeToolCall(call("read", { path: "a.txt" }, "r1"), opts);
  const fresh = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ startLine: 2, new: "B" }] }, "e2"),
    opts,
  );
  assert.equal(fresh.result.ok, true);
  assert.equal(readFileSync(file("a.txt"), "utf8"), "a\nB\nc\n");
}));

test("partial reads authorize only covered ranges and external changes invalidate them", fixture(async ({ cwd, file }) => {
  writeFileSync(file("a.txt"), "a\nb\nc\nd\n");
  const toolState = createToolState();
  const opts = { cwd, toolState, maxToolResultChars: 50_000 };

  await executeToolCall(call("read", { path: "a.txt", offset: 2, limit: 1 }), opts);
  const outside = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ startLine: 3, new: "C" }] }),
    opts,
  );
  assert.equal(outside.result.error, true);
  assert.match(outside.result.message, /outside the freshly read lines/);

  writeFileSync(file("a.txt"), "changed\nb\nc\nd\n");
  const changed = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ startLine: 2, new: "B" }] }),
    opts,
  );
  assert.equal(changed.result.error, true);
  assert.match(changed.result.message, /changed after it was read/);
}));

test("bash invalidates read freshness even when the command fails", fixture(async ({ cwd, file }) => {
  writeFileSync(file("a.txt"), "a\n");
  const toolState = createToolState();
  const opts = { cwd, toolState, maxToolResultChars: 50_000 };
  await executeToolCall(call("read", { path: "a.txt" }), opts);
  await executeToolCall(call("bash", { command: "false" }), opts);
  const edit = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ startLine: 1, new: "A" }] }),
    opts,
  );
  assert.equal(edit.result.error, true);
  assert.match(edit.result.message, /requires a fresh read/);
}));

test("malformed edit batches fail before file I/O and deliberate empty new still deletes", fixture(async ({ cwd, file }) => {
  writeFileSync(file("a.txt"), "KEEP\nother\n");
  const opts = { cwd, toolState: createToolState(), maxToolResultChars: 50_000 };
  const malformed = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ old: "KEEP", new: 123 }, { old: "other", new: "changed" }] }),
    opts,
  );
  assert.equal(malformed.result.error, true);
  assert.equal(readFileSync(file("a.txt"), "utf8"), "KEEP\nother\n");

  const deletion = await executeToolCall(
    call("edit", { path: "a.txt", edits: [{ old: "KEEP\n", new: "" }] }),
    opts,
  );
  assert.equal(deletion.result.ok, true);
  assert.equal(readFileSync(file("a.txt"), "utf8"), "other\n");
}));
