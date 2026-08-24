import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../src/tools.mjs";
import { executeToolCall } from "../src/agent.mjs";
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

test("recursive rm with split flags still requires approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-safe-"));
  const r = await bash.execute({ command: `rm -f -r "${dir}"` }, { cwd: process.cwd() });
  assert.equal(r.error, true);
  assert.match(r.message, /blocked|approval/);
  assert.ok(existsSync(dir), "dir should still exist");
});

test("recursive rm split with a shell line continuation still requires approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-safe-"));
  const r = await bash.execute({ command: `rm \\\n-rf "${dir}"` }, { cwd: process.cwd() });
  assert.equal(r.error, true);
  assert.ok(existsSync(dir), "dir should still exist");
});

test("central authorization receives tool, cwd, risk, args, and reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-safe-"));
  let request = null;
  const call = { id: "c", function: { name: "bash", arguments: JSON.stringify({ command: `rm -rf "${dir}"` }) } };
  const result = await executeToolCall(call, {
    cwd: process.cwd(),
    maxToolResultChars: 50_000,
    authorize: async (value) => {
      request = value;
      return false;
    },
  });
  assert.equal(result.result.error, true);
  assert.deepEqual(Object.keys(request).sort(), ["args", "cwd", "reason", "risk", "tool"]);
  assert.equal(request.tool, "bash");
  assert.equal(request.risk, "shell");
  assert.ok(existsSync(dir));
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

test("bash distinguishes its hard timeout from user abort", async () => {
  const timedOut = await bash.execute(
    { command: 'node -e "setTimeout(() => {}, 1000)"' },
    { cwd: process.cwd(), timeoutMs: 10 },
  );
  assert.equal(timedOut.error, true);
  assert.equal(timedOut.timeout, true);
  assert.equal(timedOut.aborted, undefined);

  const ac = new AbortController();
  const running = bash.execute(
    { command: 'node -e "setTimeout(() => {}, 1000)"' },
    { cwd: process.cwd(), signal: ac.signal },
  );
  ac.abort();
  const aborted = await running;
  assert.equal(aborted.error, true);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.timeout, undefined);
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
