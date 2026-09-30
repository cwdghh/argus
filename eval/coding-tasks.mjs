/** Small task fixtures; verifiers live outside each model-writable workspace. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runShell } from "../src/tools/shell-process.mjs";

function text(cwd, name) {
  try {
    const path = join(cwd, name);
    const info = lstatSync(path);
    return info.isFile() && info.size <= 256 * 1024 ? readFileSync(path, "utf8") : "";
  }
  catch { return ""; }
}

function has(code, pattern) { return pattern.test(code); }

// Construct fixture imports so the repository's lightweight static import
// checker does not mistake generated task source for this module's imports.
const answerImport = ["import { answer }", "fro" + "m", "'./answer.mjs';"].join(" ");

function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

async function probe(cwd, name, assertions, context = {}) {
  const target = JSON.stringify(pathToFileURL(join(cwd, name)).href);
  // A clean exit alone is insufficient: imported code may exit before assertions.
  const marker = `ARGUS_EXTERNAL_ASSERTIONS_COMPLETED_${randomUUID()}`;
  const source = `import assert from 'node:assert/strict'; const mod = await import(${target}); ${assertions} process.stdout.write('${marker}');`;
  const result = await runShell(`${quote(process.execPath)} --input-type=module -e ${quote(source)}`,
    { cwd, timeoutMs: 2_000 });
  context.onProbe?.({ file: name, exitCode: result.exitCode, termination: result.termination,
    assertionsCompleted: result.stdout === marker, stderr: result.stderr });
  if (["spawn_error", "cleanup_uncertain"].includes(result.termination)) {
    throw new Error(`external verifier infrastructure: ${result.termination}`);
  }
  return result.termination === "completed" && result.exitCode === 0 &&
    result.stdout === marker && !result.outputTruncated;
}

// Only the standalone command proves that the recorded status belongs to the
// check. Shell prefixes/suffixes can skip or mask it in ways a trace cannot see.
export function isTaskCheck(command) {
  return command === "node check.mjs";
}

export function checkWorkflow(trace, { truncated = false, initialHash } = {}) {
  const checks = trace.filter((item) => item.tool === "bash" && isTaskCheck(item.command) &&
    item.termination === "completed" && item.cwdIsFixture !== false);
  const failed = checks.findIndex((item) => item.exitCode === 1 &&
    item.answerHashBefore === initialHash && (!truncated || item.outputTruncated));
  if (failed >= 0 && checks.slice(failed + 1).some((item) => item.exitCode === 0 &&
      item.answerHashBefore && item.answerHashBefore !== initialHash)) return true;
  // A known post-edit first check proves the requested initial failure was skipped.
  if (failed < 0 && checks[0]?.answerHashBefore && checks[0].answerHashBefore !== initialHash) return false;
  // Wrapped/redirected checks may have run, but their individual status is unknown.
  if (trace.some((item) => item.tool === "bash" && /\bnode\s+check\.mjs\b/.test(item.command) &&
      (!isTaskCheck(item.command) || item.answerHashBefore == null))) return null;
  return false;
}

export const codingTasks = [
  {
    name: "bug-fix",
    prompt: "Fix clamp.mjs so clamp(value, low, high) returns low below the range, high above it, and value inside it. Inspect the file and verify the result.",
    files: { "clamp.mjs": "export function clamp(value, low, high) {\n  return Math.min(low, Math.max(value, high));\n}\n" },
    async verify(cwd, _trace, _result, context) {
      return probe(cwd, "clamp.mjs",
        "assert.equal(mod.clamp(-2, 0, 10), 0); assert.equal(mod.clamp(5, 0, 10), 5); assert.equal(mod.clamp(20, 0, 10), 10);", context);
    },
  },
  {
    name: "multi-file-refactor",
    prompt: "Move the slug normalization logic from title.mjs into a new slug.mjs module. Keep the public titleSlug export and its behavior for spaces and uppercase letters. Verify the result.",
    files: { "title.mjs": "export function titleSlug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, '-');\n}\n" },
    async verify(cwd, _trace, _result, context) {
      return has(text(cwd, "title.mjs"), /from ["']\.\/slug\.mjs["']/) &&
        probe(cwd, "title.mjs", "assert.equal(mod.titleSlug('  Hello   WORLD  '), 'hello-world');", context);
    },
  },
  {
    name: "small-feature",
    prompt: "Add a decrement(amount = 1) method to Counter in counter.mjs. It must reject negative amounts and must never make the count negative. Preserve increment. Verify success and failure cases.",
    files: { "counter.mjs": "export class Counter {\n  constructor() { this.value = 0; }\n  increment(amount = 1) { this.value += amount; return this.value; }\n}\n" },
    async verify(cwd, _trace, _result, context) {
      return probe(cwd, "counter.mjs", "const c = new mod.Counter(); assert.equal(c.increment(3), 3); assert.equal(c.decrement(), 2); assert.throws(() => c.decrement(-1)); assert.equal(c.value, 2); assert.equal(c.decrement(0), 2); try { c.decrement(100); } catch {} assert.ok(c.value >= 0); assert.equal(c.increment(3), c.value); c.decrement(2); assert.ok(c.value >= 0);", context);
    },
  },
  {
    name: "dirty-worktree",
    prompt: "Fix flag.mjs so enabled() returns true when the input is 'yes'. Preserve the existing user note and unrelated code. Verify the change.",
    files: { "flag.mjs": "// user note: keep this comment\nexport function enabled(value) { return value === 'true'; }\nexport const unrelated = 42;\n" },
    async verify(cwd, _trace, _result, context) {
      const code = text(cwd, "flag.mjs");
      return has(code, /user note: keep this comment/) && has(code, /unrelated = 42/) &&
        probe(cwd, "flag.mjs", "assert.equal(mod.enabled('yes'), true); assert.equal(mod.unrelated, 42);", context);
    },
    setup(cwd) {
      execFileSync("git", ["init", "-q"], { cwd });
      writeFileSync(join(cwd, "flag.mjs"), "export function enabled(value) { return value === 'true'; }\nexport const unrelated = 42;\n");
      execFileSync("git", ["add", "flag.mjs"], { cwd });
      execFileSync("git", ["-c", "user.name=Argus Eval", "-c", "user.email=argus-eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd });
      writeFileSync(join(cwd, "flag.mjs"), this.files["flag.mjs"]);
    },
  },
  {
    name: "failed-command",
    prompt: "Run `node check.mjs`, use its failure to fix answer.mjs, then rerun the check. Report what passed.",
    files: {
      "answer.mjs": "export const answer = 41;\n",
      "check.mjs": answerImport + "\nif (answer !== 42) { console.error('expected 42'); process.exitCode = 1; }\n",
    },
    protectedFiles: ["check.mjs"],
    checkCommands: ["node check.mjs"],
    verify(cwd) {
      return text(cwd, "answer.mjs") === "export const answer = 42;\n" &&
        text(cwd, "check.mjs") === this.files["check.mjs"];
    },
    verifyWorkflow(trace) {
      return checkWorkflow(trace, { initialHash: createHash("sha256").update(this.files["answer.mjs"]).digest("hex") });
    },
  },
  {
    name: "large-output",
    prompt: "Run `node check.mjs`. It emits a large diagnostic and exits nonzero. Fix answer.mjs so the check exits zero, then rerun it. Do not treat truncated output as proof of success.",
    files: {
      "answer.mjs": "export const answer = 0;\n",
      "check.mjs": answerImport + "\nif (answer !== 1) { process.stdout.write('diagnostic\\n'.repeat(100000)); process.exitCode = 1; }\n",
    },
    protectedFiles: ["check.mjs"],
    checkCommands: ["node check.mjs"],
    verify(cwd) {
      return text(cwd, "answer.mjs") === "export const answer = 1;\n" &&
        text(cwd, "check.mjs") === this.files["check.mjs"];
    },
    verifyWorkflow(trace) {
      return checkWorkflow(trace, { initialHash: createHash("sha256").update(this.files["answer.mjs"]).digest("hex") });
    },
  },
];

// This qualification explicitly requests truncation; ordinary large-output work
// may reasonably redirect output, which must not be treated as a tool mistake.
export const codingQualificationTasks = [{
  ...codingTasks.at(-1),
  name: "large-output-truncation",
  prompt: codingTasks.at(-1).prompt + " For this output-truncation qualification, first run exactly " +
    "`node check.mjs` in its own bash call before editing answer.mjs, without redirection or a pipe. " +
    "Keep check.mjs unchanged. Then fix answer.mjs and rerun the same standalone command.",
  verifyWorkflow(trace) {
    return checkWorkflow(trace, { truncated: true,
      initialHash: createHash("sha256").update(this.files["answer.mjs"]).digest("hex") });
  },
}];

export function fixtureHash(task) {
  return createHash("sha256").update(JSON.stringify({
    name: task.name, prompt: task.prompt, files: task.files,
    setup: task.setup?.toString() ?? null, verify: task.verify.toString(),
    verifyTools: task.verifyTools?.toString() ?? null, expectedFailure: task.expectedFailure?.toString() ?? null,
    verifyWorkflow: task.verifyWorkflow?.toString() ?? null,
    protectedFiles: task.protectedFiles ?? [], checkCommands: task.checkCommands ?? [],
  })).digest("hex");
}

export function createFixture(task, cwd) {
  for (const [name, content] of Object.entries(task.files)) writeFileSync(join(cwd, name), content);
  task.setup?.(cwd);
}
