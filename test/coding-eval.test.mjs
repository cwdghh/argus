import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingTasks, codingQualificationTasks, createFixture, fixtureHash, isTaskCheck } from "../eval/coding-tasks.mjs";
import { runCodingEval, selectTasks, summarizeEval } from "../eval/coding.mjs";
import { toolTasks } from "../eval/tool-tasks.mjs";
import { runShell } from "../src/tools/shell-process.mjs";
import { findTool } from "../src/tools.mjs";
import { createToolState } from "../src/tool-state.mjs";

test("coding fixtures reject their broken baseline and keep verifiers outside the workspace", async (t) => {
  for (const task of codingTasks) {
    const cwd = mkdtempSync(join(tmpdir(), "argus-eval-test-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    createFixture(task, cwd);
    assert.equal(await task.verify(cwd, []), false, task.name);
    assert.match(fixtureHash(task), /^[a-f0-9]{64}$/);
  }
  assert.equal(selectTasks("bug-fix").length, 1);
  assert.throws(() => selectTasks("unknown"), /unknown evaluation task/);
});

test("coding runner scores an external behavioral fix and restores its temporary home", async () => {
  const task = codingTasks.find((item) => item.name === "bug-fix");
  const before = process.env.ARGUS_HOME;
  const report = await runCodingEval({
    config: { baseUrl: "http://localhost:1234/v1", model: "mock", systemPrompt: "test" },
    tasks: [task], trials: 1,
    run: async (_config, _history, _prompt, _onEvent, { cwd }) => {
      writeFileSync(join(cwd, "clamp.mjs"), "export function clamp(v, low, high) { return Math.max(low, Math.min(high, v)); }\n");
      return { outcome: "completed", requestUsage: { totals: null } };
    },
  });
  assert.equal(report.total, 1);
  assert.equal(report.passed, 1);
  assert.equal(process.env.ARGUS_HOME, before);
});

test("a later trial cannot see the prior trial's workspace or artifacts", async () => {
  const task = codingTasks[0];
  const before = process.env.ARGUS_HOME;
  let previousWorkspace;
  let previousHome;
  const report = await runCodingEval({ config: mockConfig, tasks: [task], trials: 2,
    run: async (_config, _history, _prompt, _event, { cwd }) => {
      if (previousWorkspace) {
        assert.equal(existsSync(previousWorkspace), false);
        assert.equal(existsSync(previousHome), false);
      }
      previousWorkspace = cwd;
      previousHome = process.env.ARGUS_HOME;
      writeFileSync(join(cwd, "clamp.mjs"), "export function clamp(v, low, high) { return Math.max(low, Math.min(high, v)); }\n");
      return { outcome: "completed" };
    } });
  assert.equal(report.passed, 2);
  assert.equal(existsSync(previousWorkspace), false);
  assert.equal(existsSync(previousHome), false);
  assert.equal(process.env.ARGUS_HOME, before);
});

test("coding reports redact configured secrets from infrastructure failures", async () => {
  const task = codingTasks.find((item) => item.name === "bug-fix");
  const report = await runCodingEval({
    config: { baseUrl: "https://user:password@example.test/v1", apiKey: "private-token", model: "mock" },
    tasks: [task], trials: 1,
    run: async () => { throw new Error("private-token at https://user:password@example.test/v1 failed"); },
  });
  assert.equal(report.results[0].passed, false);
  assert.equal(report.results[0].infrastructureError, "[redacted] at [redacted] failed");
  assert.equal(JSON.stringify(report).includes("private-token"), false);
});

test("coding verifiers accept distinct valid outcomes across all six task families", async (t) => {
  const solutions = {
    "bug-fix": (cwd) => writeFileSync(join(cwd, "clamp.mjs"), "export function clamp(v, low, high) { return Math.max(low, Math.min(high, v)); }\n"),
    "multi-file-refactor": (cwd) => {
      writeFileSync(join(cwd, "slug.mjs"), "export const slug = (value) => value.trim().toLowerCase().replace(/\\s+/g, '-');\n");
      writeFileSync(join(cwd, "title.mjs"), ["import { slug }", "fro" + "m", "'./slug.mjs';"].join(" ") + "\nexport const titleSlug = slug;\n");
    },
    "small-feature": (cwd) => writeFileSync(join(cwd, "counter.mjs"),
      "export class Counter { constructor() { this.value = 0; } increment(n=1) { this.value += n; return this.value; } decrement(n=1) { if (n < 0) throw Error('negative'); this.value = Math.max(0, this.value - n); return this.value; } }\n"),
    "dirty-worktree": (cwd) => writeFileSync(join(cwd, "flag.mjs"),
      "// user note: keep this comment\nexport function enabled(value) { return value === 'yes'; }\nexport const unrelated = 42;\n"),
    "failed-command": (cwd) => writeFileSync(join(cwd, "answer.mjs"), "export const answer = 42;\n"),
    "large-output": (cwd) => writeFileSync(join(cwd, "answer.mjs"), "export const answer = 1;\n"),
  };
  for (const task of codingTasks) {
    const cwd = mkdtempSync(join(tmpdir(), "argus-eval-valid-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    createFixture(task, cwd);
    solutions[task.name](cwd);
    const trace = [
      { tool: "bash", command: "node check.mjs", termination: "completed", exitCode: 1, outputTruncated: task.name === "large-output" },
      { tool: "bash", command: "node check.mjs", termination: "completed", exitCode: 0, outputTruncated: false },
    ];
    assert.equal(await task.verify(cwd, trace), true, task.name);
  }
});

const mockConfig = { baseUrl: "http://localhost:1234/v1", model: "mock", systemPrompt: "test" };

test("completion after the evaluation deadline cannot pass even with correct final code", async () => {
  const report = await runCodingEval({ config: mockConfig, tasks: [codingTasks[0]], trials: 1, timeoutMs: 10,
    run: async (_config, _history, _prompt, _event, { cwd, signal }) => {
      writeFileSync(join(cwd, "clamp.mjs"), "export function clamp(v, low, high) { return Math.max(low, Math.min(high, v)); }\n");
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { outcome: "completed" };
    } });
  assert.equal(report.results[0].verifierPassed, true);
  assert.equal(report.results[0].failureCategory, "trial_timeout");
  assert.equal(report.passed, 0);
});

test("external assertions cannot be bypassed by a fixture exiting zero", async (t) => {
  const task = codingTasks[0];
  const cwd = mkdtempSync(join(tmpdir(), "argus-eval-exit-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  createFixture(task, cwd);
  writeFileSync(join(cwd, "clamp.mjs"), "process.exit(0);\n");
  assert.equal(await task.verify(cwd, []), false);
});

test("command fixtures score behavior separately from ordered check observations", async (t) => {
  for (const name of ["failed-command", "large-output"]) {
    const task = codingTasks.find((item) => item.name === name);
    const cwd = mkdtempSync(join(tmpdir(), "argus-eval-check-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    createFixture(task, cwd);
    writeFileSync(join(cwd, "answer.mjs"), `export const answer = ${name === "failed-command" ? 42 : 1};\n`);
    const digest = (text) => createHash("sha256").update(text).digest("hex");
    const trace = [1, 0].map((exitCode) => ({ tool: "bash", command: "node check.mjs", termination: "completed", exitCode, outputTruncated: true,
      cwdIsFixture: true, answerHashBefore: digest(exitCode ? task.files["answer.mjs"] : readFileSync(join(cwd, "answer.mjs"))) }));
    assert.equal(await task.verify(cwd, trace), true);
    assert.equal(task.verifyWorkflow(trace), true);
    assert.equal(task.verifyWorkflow([...trace].reverse()), false);
    assert.equal(task.verifyWorkflow(trace.map((item) => ({ ...item, command: "true" }))), false);
    assert.equal(task.verifyWorkflow([trace[0], { ...trace[1], command: 'cat answer.mjs; node check.mjs && echo "CHECK OK (exit 0)"' }]), null);
    assert.equal(task.verifyWorkflow([trace[0], { ...trace[1], command: 'node check.mjs; echo "exit=$?"' }]), null);
    assert.equal(task.verifyWorkflow([{ ...trace[0], command: "exit 1; node check.mjs" }, trace[1]]), false);
    assert.equal(task.verifyWorkflow(trace.map((item) => ({ ...item, cwdIsFixture: false }))), false);
    writeFileSync(join(cwd, "check.mjs"), "process.exit(0);\n");
    assert.equal(await task.verify(cwd, trace), false);
  }
});

test("check scoring requires the exact standalone command", () => {
  assert.equal(isTaskCheck("node check.mjs"), true);
  assert.equal(isTaskCheck('node check.mjs && echo "passed"'), false);
  assert.equal(isTaskCheck("node check.mjs; echo passed"), false);
  assert.equal(isTaskCheck("node check.mjs | cat"), false);
  assert.equal(isTaskCheck("false && node check.mjs"), false);
  assert.equal(isTaskCheck("exit 1; node check.mjs"), false);
});

test("incomplete suites retain planned counts and reproduce their score from JSON", async () => {
  const report = await runCodingEval({ config: mockConfig, tasks: [codingTasks[0]], trials: 3,
    totalTimeoutMs: 1,
    run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { outcome: "completed" }; } });
  assert.equal(report.complete, false);
  assert.equal(report.planned, 3);
  assert.equal(report.total, 1);
  assert.equal(report.stopReason, "suite_timeout");
  const saved = JSON.parse(JSON.stringify(report));
  assert.equal(summarizeEval(saved).passed, report.passed);
  assert.deepEqual(summarizeEval(saved).byTask, report.byTask);
});

test("fixture and verifier errors remain separate from incorrect task results", async () => {
  const setup = { ...codingTasks[0], setup() { throw new Error("setup failed"); } };
  const fixture = await runCodingEval({ config: mockConfig, tasks: [setup], trials: 1, run: async () => assert.fail("must not call provider") });
  assert.equal(fixture.results[0].failureCategory, "fixture_setup");
  assert.equal(fixture.results[0].verifierPassed, null);
  const verify = { ...codingTasks[0], verify() { throw new Error("verifier failed"); } };
  const verifier = await runCodingEval({ config: mockConfig, tasks: [verify], trials: 1, run: async () => ({ outcome: "completed" }) });
  assert.equal(verifier.results[0].failureCategory, "verifier_error");
  const transport = await runCodingEval({ config: mockConfig, tasks: [codingTasks[0]], trials: 1,
    run: async () => ({ outcome: "failed", reason: "model_error", message: "HTTP 500" }) });
  assert.equal(transport.results[0].failureCategory, "transport_or_protocol");
  assert.equal(transport.results[0].infrastructureError, null);
});

test("bounded reports distinguish schema errors from expected check failures and unknown usage", async () => {
  const task = codingTasks.find((item) => item.name === "failed-command");
  const report = await runCodingEval({ config: mockConfig, tasks: [task], trials: 1,
    run: async (_config, _history, _prompt, onEvent, { cwd }) => {
      for (const [attemptId, command, exitCode] of [["one", "node check.mjs", 1], ["two", "node check.mjs", 0]]) {
        if (exitCode === 0) {
          onEvent({ type: "tool_call", attemptId: "fix", name: "edit", args: { path: "answer.mjs", edits: [{ old: "41", new: "42" }] } });
          writeFileSync(join(cwd, "answer.mjs"), "export const answer = 42;\n");
          onEvent({ type: "tool_result", attemptId: "fix", result: { ok: true } });
        }
        onEvent({ type: "tool_call", attemptId, name: "bash", args: { command } });
        onEvent({ type: "tool_result", attemptId, result: { error: exitCode !== 0, exitCode, termination: "completed", stdout: "x".repeat(5_000), stderr: "diagnostic" } });
      }
      onEvent({ type: "tool_call", attemptId: "three", name: "write", args: { path: "bad.txt", content: "x", unsupported: true } });
      onEvent({ type: "tool_result", attemptId: "three", result: { error: true, message: "write arguments has unknown argument: unsupported" } });
      onEvent({ type: "request_attempt", attemptId: "missing" });
      writeFileSync(join(cwd, "answer.mjs"), "export const answer = 42;\n");
      writeFileSync(join(cwd, "large.txt"), "x".repeat(100_000));
      return { outcome: "completed", finalText: "verified " + "x".repeat(10_000) };
    } });
  const item = report.results[0];
  assert.equal(item.passed, true);
  assert.equal(item.toolFailures, 2);
  assert.equal(item.schemaMistakes, 1);
  assert.equal(item.unexpectedToolFailures, 1);
  assert.equal(item.requestUsage.total_tokens, null);
  assert.equal(item.requestUsage.complete, false);
  assert.ok(JSON.stringify(item.changes).length < 16_000);
  assert.ok(item.verificationHonesty.finalText.length < 2_100);
  assert.ok(item.trace[0].stdout.length < 1_100);
  assert.equal(item.trace[0].diagnosticsTruncated, true);
});

test("trial deadline waits for owned child cleanup before removing the workspace", async (t) => {
  const witness = mkdtempSync(join(tmpdir(), "argus-eval-child-"));
  t.after(() => rmSync(witness, { recursive: true, force: true }));
  const pidFile = join(witness, "pid");
  let workspace;
  const report = await runCodingEval({ config: mockConfig, tasks: [codingTasks[0]], trials: 1, timeoutMs: 150,
    run: async (_config, _history, _prompt, _event, { cwd, signal }) => {
      workspace = cwd;
      await runShell(`sleep 30 & echo $! > '${pidFile}'; wait`, { cwd, signal });
      assert.equal(existsSync(cwd), true);
      return { outcome: "interrupted", reason: "user_abort" };
    } });
  assert.equal(report.results[0].failureCategory, "trial_timeout");
  assert.equal(existsSync(workspace), false);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("request ceiling stops before another paid request and leaves missing usage unknown", async () => {
  let requests = 0;
  const report = await runCodingEval({ config: mockConfig, tasks: [codingTasks[0]], trials: 3, maxRequests: 1,
    run: async (_config, _history, _prompt, event) => {
      event({ type: "request_attempt", attemptId: "first" }); requests++;
      event({ type: "request_attempt", attemptId: "second" }); requests++;
      return { outcome: "completed" };
    } });
  assert.equal(requests, 1);
  assert.equal(report.stopReason, "request_limit");
  assert.equal(report.complete, false);
  assert.equal(report.requestUsage.complete, false);
});

test("range tool-choice scoring rejects a content edit with the same final file", async () => {
  const task = toolTasks.find((item) => item.name === "range-edit");
  const report = await runCodingEval({ config: mockConfig, tasks: [task], suite: "tools", trials: 1,
    run: async (_config, _history, _prompt, event, { cwd }) => {
      for (const [index, name] of ["read", "edit", "read"].entries()) {
        const args = name === "edit" ? { path: "block.js", edits: [{ old: "old", new: "hello argus" }] } : { path: "block.js" };
        event({ type: "tool_call", attemptId: String(index), name, args });
        event({ type: "tool_result", attemptId: String(index), result: { ok: true } });
      }
      writeFileSync(join(cwd, "block.js"), "export function greet() {\n  return 'hello argus';\n}\n");
      return { outcome: "completed" };
    } });
  assert.equal(report.results[0].verifierPassed, true);
  assert.equal(report.results[0].toolChoicePassed, false);
  assert.equal(report.passed, 0);
  assert.equal(report.behaviorPassed, 1);
  assert.equal(report.cleanPassed, 0);
});

test("focused reports explain a recovered schema error despite correct tool choice and final file", async () => {
  const task = toolTasks.find((item) => item.name === "new-file");
  const report = await runCodingEval({ config: mockConfig, tasks: [task], suite: "tools", trials: 1,
    run: async (_config, _history, _prompt, event, { cwd }) => {
      event({ type: "tool_call", attemptId: "bad", name: "write", args: { path: "note.txt", content: "tool surface ok", unsupported: true } });
      event({ type: "tool_result", attemptId: "bad", result: { error: true, message: "write arguments has unknown argument: unsupported" } });
      event({ type: "tool_call", attemptId: "good", name: "write", args: { path: "note.txt", content: "tool surface ok", ensureFinalNewline: true } });
      event({ type: "tool_result", attemptId: "good", result: { ok: true } });
      writeFileSync(join(cwd, "note.txt"), "tool surface ok\n");
      return { outcome: "completed" };
    } });
  assert.equal(report.results[0].verifierPassed, true);
  assert.equal(report.results[0].toolChoicePassed, true);
  assert.equal(report.results[0].schemaMistakes, 1);
  assert.equal(report.results[0].failureCategory, "tool_recovery");
  assert.equal(report.passed, 1);
  assert.equal(report.cleanPassed, 0);
});

test("output truncation is a separate opt-in qualification with the same final behavior", async (t) => {
  const ordinary = codingTasks.find((item) => item.name === "large-output");
  const qualification = codingQualificationTasks[0];
  const cwd = mkdtempSync(join(tmpdir(), "argus-output-qualification-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  createFixture(ordinary, cwd);
  writeFileSync(join(cwd, "answer.mjs"), "export const answer = 1;\n");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const trace = [1, 0].map((exitCode) => ({ tool: "bash", command: "node check.mjs", termination: "completed", exitCode,
    answerHashBefore: hash(exitCode ? ordinary.files["answer.mjs"] : "export const answer = 1;\n"), outputTruncated: false }));
  assert.equal(await ordinary.verify(cwd), true);
  assert.equal(await qualification.verify(cwd), true);
  assert.equal(ordinary.verifyWorkflow(trace), true);
  assert.equal(qualification.verifyWorkflow(trace), false);
  assert.equal(qualification.verifyWorkflow([{ ...trace[0], outputTruncated: true }, trace[1]]), true);
  assert.equal(ordinary.verifyWorkflow([trace[1]]), false, "post-edit check alone skips the initial failure");
});

test("focused policy allows behavioral verification and search confirmation", () => {
  const range = toolTasks.find((item) => item.name === "range-edit");
  assert.equal(range.verifyTools([{ tool: "read" }, { tool: "edit", editForms: ["range"] }, { tool: "read" }, { tool: "bash" }]), true);
  const search = toolTasks.find((item) => item.name === "search-with-bash");
  assert.equal(search.verifyTools([{ tool: "bash" }, { tool: "read" }]), true);
});

test("advanced edit fixtures accept real atomic range and mixed tool batches", async (t) => {
  const batches = {
    "range-insert-delete": [{ startLine: 2, endLine: 1, new: "inserted" }, { startLine: 3, new: "" }],
    "mixed-edit": [{ old: "'old'", new: "'new'" }, { startLine: 2, new: "" }],
  };
  for (const [name, edits] of Object.entries(batches)) {
    const task = toolTasks.find((item) => item.name === name);
    const cwd = mkdtempSync(join(tmpdir(), "argus-edit-fixture-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    createFixture(task, cwd);
    assert.equal(task.verify(cwd), false);
    const path = Object.keys(task.files)[0];
    const context = { cwd, toolState: createToolState() };
    await findTool("read").execute({ path }, context);
    const result = await findTool("edit").execute({ path, edits }, context);
    assert.equal(result.ok, true, result.message);
    assert.equal(task.verify(cwd), true);
  }
});
