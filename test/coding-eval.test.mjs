import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingTasks, createFixture, fixtureHash } from "../eval/coding-tasks.mjs";
import { runCodingEval, selectTasks } from "../eval/coding.mjs";

test("coding fixtures reject their broken baseline and keep verifiers outside the workspace", (t) => {
  for (const task of codingTasks) {
    const cwd = mkdtempSync(join(tmpdir(), "argus-eval-test-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    createFixture(task, cwd);
    assert.equal(task.verify(cwd, []), false, task.name);
    assert.match(fixtureHash(task), /^[a-f0-9]{64}$/);
  }
  assert.equal(selectTasks("bug-fix").length, 1);
  assert.throws(() => selectTasks("unknown"), /unknown coding task/);
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

test("coding verifiers accept distinct valid outcomes across all six task families", (t) => {
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
      { tool: "bash", exitCode: 1, outputTruncated: task.name === "large-output" },
      { tool: "bash", exitCode: 0, outputTruncated: false },
    ];
    assert.equal(task.verify(cwd, trace), true, task.name);
  }
});
