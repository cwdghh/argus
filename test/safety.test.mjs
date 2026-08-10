import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../src/tools.mjs";
import { MinimalTui } from "../src/tui.mjs";

const bash = findTool("bash");

test("destructive command blocked when no confirm available", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-safe-"));
  const r = await bash.execute({ command: `rm -rf "${dir}"` }, { cwd: process.cwd() });
  assert.equal(r.error, true);
  assert.match(r.message, /blocked|approval/);
  assert.ok(existsSync(dir), "dir should still exist");
});

test("destructive command denied by confirm returning false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-safe-"));
  const r = await bash.execute({ command: `rm -rf "${dir}"` }, { cwd: process.cwd(), confirm: async () => false });
  assert.equal(r.error, true);
  assert.match(r.message, /denied/);
  assert.ok(existsSync(dir), "dir should still exist");
});

test("destructive command runs when approved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-safe-"));
  const r = await bash.execute({ command: `rm -rf "${dir}"` }, { cwd: process.cwd(), confirm: async () => true });
  assert.ok(!r.error, JSON.stringify(r));
  assert.ok(!existsSync(dir), "dir should be removed");
});

test("safe command runs without confirm", async () => {
  const r = await bash.execute({ command: "echo hi" }, { cwd: process.cwd() });
  assert.equal(r.stdout.trim(), "hi");
});

test("TUI confirm prompt: y approves, n denies, Esc denies", async () => {
  const t = new MinimalTui({ model: "m" });
  const p = t.confirm("rm -rf /x");
  assert.equal(t.mode, "confirm");
  assert.ok(t.pendingConfirm);
  t.insertText("y");
  assert.equal(await p, true);
  assert.equal(t.pendingConfirm, null);

  const p2 = t.confirm("rm -rf /x");
  t.insertText("n");
  assert.equal(await p2, false);

  const p3 = t.confirm("rm -rf /x");
  t.runAction({ type: "escape" });
  assert.equal(await p3, false);
});
