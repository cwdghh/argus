import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell } from "../src/tools/shell-process.mjs";

test("shell reports exit, output, and cwd independently", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-shell-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = await runShell("printf 'out'; printf 'err' >&2; sh -c 'exit 7'", { cwd });
  assert.equal(result.exitCode, 7);
  assert.equal(result.termination, "completed");
  assert.equal(result.error, true);
  assert.equal(result.outputTruncated, false);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(realpathSync(result.cwd), realpathSync(cwd));
});

test("shell exposes a bounded live preview before the command exits", async () => {
  const updates = [];
  const result = await runShell("printf 'started'; sleep 0.1; printf 'finished'", {
    cwd: tmpdir(), onOutput: (stream, value) => updates.push({ stream, value }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(updates.some((update) => update.stream === "stdout" && update.value.includes("started")));
  assert.ok(updates.every((update) => update.value.length <= 2_000));
});

test("shell cancellation retains output and stops an owned background child", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runShell("printf 'before'; sleep 10 & wait", { cwd: tmpdir(), signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await running;
  assert.equal(result.termination, "cancelled");
  assert.equal(result.aborted, true);
  assert.match(result.stdout, /before/);
  assert.ok(Date.now() - started < 3_000);
});

test("shell timeout reports a timeout while retaining output", async () => {
  const result = await runShell("printf 'before'; sleep 10", { cwd: tmpdir(), timeoutMs: 50 });
  assert.equal(result.termination, "timeout");
  assert.equal(result.timeout, true);
  assert.match(result.stdout, /before/);
});

test("shell escalates when the command ignores SIGTERM", async () => {
  const started = Date.now();
  const result = await runShell("trap '' TERM; while :; do sleep 1; done", {
    cwd: tmpdir(), timeoutMs: 50,
  });
  assert.equal(result.termination, "timeout");
  assert.equal(result.error, true);
  assert.ok(Date.now() - started < 3_000);
});

test("shell does not wait for an inherited pipe after its deadline", async () => {
  const started = Date.now();
  const result = await runShell("sleep 10 &", { cwd: tmpdir(), timeoutMs: 50 });
  assert.equal(result.timeout, true);
  assert.ok(Date.now() - started < 3_000);
});

test("shell decodes split UTF-8 and discovers cwd after stderr overflow", async () => {
  const command = `cd /tmp; node -e ${JSON.stringify(
    "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => { process.stdout.write(Buffer.from([0x82,0xac])); process.stderr.write('x'.repeat(2_000_000)); }, 10)",
  )}`;
  const result = await runShell(command, { cwd: tmpdir() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout, "€");
  assert.equal(result.cwd, "/tmp");
});

test("artifact write failure never blocks pipe draining or hides a known exit", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-shell-artifact-error-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const blockedHome = join(cwd, "not-a-directory");
  writeFileSync(blockedHome, "x");
  const previous = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = blockedHome;
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = previous;
  });
  const result = await runShell(`node -e ${JSON.stringify("process.stdout.write('x'.repeat(2_000_000))")}`, { cwd });
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, "completed");
  assert.equal(result.artifactError, true);
  assert.equal(result.outputTruncated, true);
});
