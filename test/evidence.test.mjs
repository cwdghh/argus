import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidence, summarizeEvidence, workspaceFingerprint } from "../src/agent/evidence.mjs";
import { parseArgs } from "../src/main.mjs";

test("designated checks distinguish passed, not run, and stale evidence in a dirty worktree", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-evidence-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, "file.txt"), "base\n");
  execFileSync("git", ["add", "file.txt"], { cwd });
  execFileSync("git", ["-c", "user.name=Argus Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base"], { cwd });
  writeFileSync(join(cwd, "file.txt"), "pre-existing user change\n");
  const initial = workspaceFingerprint(cwd);
  assert.equal(initial.dirty, true);
  assert.equal(initial.complete, true);
  const evidence = createEvidence(["node check.mjs", "npm test"], initial);
  const before = evidence.beforeTool("bash", { command: "node check.mjs" }, cwd);
  evidence.afterTool({ name: "bash", args: { command: "node check.mjs" }, result: {
    exitCode: 0, signal: null, termination: "completed", outputTruncated: false,
  }, cwd, attemptId: "a1", before });
  assert.equal(evidence.checks[0].state, "passed");
  assert.equal(evidence.checks[0].freshness, "fresh");
  assert.equal(evidence.checks[1].state, "not_run");
  evidence.afterTool({ name: "bash", args: { command: "rm -rf protected" }, result: {
    error: true, message: "blocked: approval required",
  }, cwd, attemptId: "denied", executed: false });
  assert.equal(evidence.checks[0].freshness, "fresh", "a denied shell call did not run");
  evidence.afterTool({ name: "edit", args: { path: "file.txt" }, result: { ok: true }, cwd, attemptId: "a2" });
  assert.equal(evidence.checks[0].freshness, "stale");
  assert.match(summarizeEvidence(evidence.result()), /passed \(stale\).*not_run \(unknown\)/);
});

test("CLI accepts repeated optional exact check commands", () => {
  assert.deepEqual(parseArgs(["fix", "--check", "npm test", "--check", "npm run check"]).checkCommands,
    ["npm test", "npm run check"]);
  assert.throws(() => parseArgs(["fix", "--check"]), /requires a command/);
});

test("a timeout that prints success and a non-Git scope remain unknown", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "argus-evidence-nongit-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const evidence = createEvidence(["node test.mjs"]);
  const before = evidence.beforeTool("bash", { command: "node test.mjs" }, cwd);
  assert.equal(before.complete, false);
  evidence.afterTool({ name: "bash", args: { command: "node test.mjs" }, cwd,
    result: { stdout: "passed", exitCode: null, termination: "timeout", timeout: true },
    before, attemptId: "timeout" });
  assert.equal(evidence.checks[0].state, "unknown");
  assert.equal(evidence.checks[0].freshness, "unknown");
});
