import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../src/tools.mjs";

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "argus-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("concurrent exclusive writes create exactly one complete file", async (t) => {
  const dir = await workspace(t);
  const contents = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(10_000));
  const results = await Promise.all(contents.map((content) => findTool("write").execute({
    path: "shared.txt", content, ensureFinalNewline: false,
  }, { cwd: dir })));
  const winners = results.flatMap((result, i) => result.ok ? [i] : []);
  assert.equal(winners.length, 1);
  assert.equal(await readFile(join(dir, "shared.txt"), "utf8"), contents[winners[0]]);
  assert.deepEqual(await readdir(dir), ["shared.txt"]);
});

test("edit and overwrite preserve executable permissions", { skip: process.platform === "win32" }, async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "script");
  await writeFile(path, "old\n");
  await chmod(path, 0o751);
  assert.equal((await findTool("edit").execute({ path, edits: [{ old: "old", new: "new" }] })).ok, true);
  assert.equal((await stat(path)).mode & 0o777, 0o751);
  assert.equal((await findTool("write").execute({ path, content: "again", ensureFinalNewline: true, overwrite: true })).ok, true);
  assert.equal((await stat(path)).mode & 0o777, 0o751);
});

test("edits through a symlink change its target and preserve the link", async (t) => {
  const dir = await workspace(t);
  const target = join(dir, "target");
  const path = join(dir, "alias");
  await writeFile(target, "old");
  await symlink("target", path);
  assert.equal((await findTool("edit").execute({ path, edits: [{ old: "old", new: "new" }] })).ok, true);
  assert.equal(await readFile(target, "utf8"), "new");
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal((await findTool("write").execute({ path, content: "written", ensureFinalNewline: false, overwrite: true })).ok, true);
  assert.equal(await readFile(target, "utf8"), "written");
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test("a dangling symlink is protected even with overwrite requested", async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "dangling");
  await symlink("missing", path);
  for (const overwrite of [false, true]) {
    const result = await findTool("write").execute({ path, content: "replacement", ensureFinalNewline: false, overwrite });
    assert.equal(result.error, true);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
  }
  assert.deepEqual(await readdir(dir), ["dangling"]);
});
