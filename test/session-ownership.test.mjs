import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { acquireSessionOwnership } from "../src/session/ownership.mjs";

test("only one process may own a session at a time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "task.jsonl");
  const release = await acquireSessionOwnership(file);
  await assert.rejects(acquireSessionOwnership(file), /owned by another process/);
  await release();
  const nextRelease = await acquireSessionOwnership(file);
  await nextRelease();
});

test("a dead local owner is recovered under a separate recovery guard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-dead-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "task.jsonl");
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 99999999, host: hostname(), token: "dead" }) + "\n");
  const release = await acquireSessionOwnership(file);
  await release();
});
