import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundToolResult } from "../src/agent/tool-result.mjs";

test("a long spill path cannot exceed the result cap or discard read continuation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "argus-long-spill-"));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = join(root, ...Array(6).fill("long-home".repeat(10)));
  t.after(async () => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const result = await boundToolResult({ error: true, nextOffset: 42, stdout: "x".repeat(2000) + "TAIL" }, 500);
  assert.ok(JSON.stringify(result).length <= 500);
  assert.equal(result.nextOffset, 42);
  assert.equal(result.error, true);
  assert.match(result.preview, /TAIL/);
});

test("spilled output stays complete and owner-private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "argus-private-spill-"));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const original = { stdout: "x".repeat(2000) };
  const result = await boundToolResult(original, 700);
  assert.deepEqual(JSON.parse(await readFile(result.fullPath, "utf8")), original);
  if (process.platform !== "win32") assert.equal((await stat(result.fullPath)).mode & 0o777, 0o600);
});

test("a bounded error keeps its failure reason visible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "argus-error-spill-"));
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const result = await boundToolResult({
    error: true,
    stdout: "x".repeat(2_000),
    message: "command completion is unknown",
  }, 700);
  assert.equal(result.error, true);
  assert.match(result.message, /command completion is unknown/);
  assert.ok(JSON.stringify(result).length <= 700);
});

test("bounding large shell output retains its observed exit and truncation facts", async () => {
  const result = await boundToolResult({
    stdout: "x".repeat(2_000), stderr: "", exitCode: 0, signal: null,
    termination: "completed", outputTruncated: true,
  }, 700);
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, "completed");
  assert.equal(result.outputTruncated, true);
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length <= 700);
});
