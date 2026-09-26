/** Small task fixtures; verifiers live outside each model-writable workspace. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function text(cwd, name) {
  try { return readFileSync(join(cwd, name), "utf8"); }
  catch { return ""; }
}

function has(code, pattern) { return pattern.test(code); }

// Construct fixture imports so the repository's lightweight static import
// checker does not mistake generated task source for this module's imports.
const answerImport = ["import { answer }", "fro" + "m", "'./answer.mjs';"].join(" ");

function probe(cwd, name, assertions) {
  try {
    const target = JSON.stringify(pathToFileURL(join(cwd, name)).href);
    execFileSync(process.execPath, ["--input-type=module", "-e",
      `import assert from 'node:assert/strict'; const mod = await import(${target}); ${assertions}`],
    { cwd, timeout: 2_000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

export const codingTasks = [
  {
    name: "bug-fix",
    prompt: "Fix clamp.mjs so clamp(value, low, high) returns low below the range, high above it, and value inside it. Inspect the file and verify the result.",
    files: { "clamp.mjs": "export function clamp(value, low, high) {\n  return Math.min(low, Math.max(value, high));\n}\n" },
    verify(cwd) {
      return probe(cwd, "clamp.mjs",
        "assert.equal(mod.clamp(-2, 0, 10), 0); assert.equal(mod.clamp(5, 0, 10), 5); assert.equal(mod.clamp(20, 0, 10), 10);");
    },
  },
  {
    name: "multi-file-refactor",
    prompt: "Move the slug normalization logic from title.mjs into a new slug.mjs module. Keep the public titleSlug export and its behavior for spaces and uppercase letters. Verify the result.",
    files: { "title.mjs": "export function titleSlug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, '-');\n}\n" },
    verify(cwd) {
      return has(text(cwd, "title.mjs"), /from ["']\.\/slug\.mjs["']/) &&
        probe(cwd, "title.mjs", "assert.equal(mod.titleSlug('  Hello   WORLD  '), 'hello-world');");
    },
  },
  {
    name: "small-feature",
    prompt: "Add a decrement(amount = 1) method to Counter in counter.mjs. It must reject negative amounts and must never make the count negative. Preserve increment. Verify success and failure cases.",
    files: { "counter.mjs": "export class Counter {\n  constructor() { this.value = 0; }\n  increment(amount = 1) { this.value += amount; return this.value; }\n}\n" },
    verify(cwd) {
      return probe(cwd, "counter.mjs", "const c = new mod.Counter(); assert.equal(c.increment(3), 3); assert.equal(c.decrement(), 2); assert.throws(() => c.decrement(-1)); try { c.decrement(100); } catch {} assert.ok(c.value >= 0);");
    },
  },
  {
    name: "dirty-worktree",
    prompt: "Fix flag.mjs so enabled() returns true when the input is 'yes'. Preserve the existing user note and unrelated code. Verify the change.",
    files: { "flag.mjs": "// user note: keep this comment\nexport function enabled(value) { return value === 'true'; }\nexport const unrelated = 42;\n" },
    verify(cwd) {
      const code = text(cwd, "flag.mjs");
      return has(code, /user note: keep this comment/) && has(code, /unrelated = 42/) &&
        probe(cwd, "flag.mjs", "assert.equal(mod.enabled('yes'), true); assert.equal(mod.unrelated, 42);");
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
    verify(cwd, trace) {
      return text(cwd, "answer.mjs") === "export const answer = 42;\n" &&
        trace.some((item) => item.tool === "bash" && item.exitCode !== null && item.exitCode !== 0) &&
        trace.some((item) => item.tool === "bash" && item.exitCode === 0);
    },
  },
  {
    name: "large-output",
    prompt: "Run `node check.mjs`. It emits a large diagnostic and exits nonzero. Fix answer.mjs so the check exits zero, then rerun it. Do not treat truncated output as proof of success.",
    files: {
      "answer.mjs": "export const answer = 0;\n",
      "check.mjs": answerImport + "\nif (answer !== 1) { process.stdout.write('diagnostic\\n'.repeat(100000)); process.exitCode = 1; }\n",
    },
    verify(cwd, trace) {
      return text(cwd, "answer.mjs") === "export const answer = 1;\n" &&
        trace.some((item) => item.tool === "bash" && item.outputTruncated && item.exitCode === 1) &&
        trace.some((item) => item.tool === "bash" && item.exitCode === 0);
    },
  },
];

export function fixtureHash(task) {
  return createHash("sha256").update(JSON.stringify({
    name: task.name, prompt: task.prompt, files: task.files,
    setup: task.setup?.toString() ?? null, verify: task.verify.toString(),
  })).digest("hex");
}

export function createFixture(task, cwd) {
  for (const [name, content] of Object.entries(task.files)) writeFileSync(join(cwd, name), content);
  task.setup?.(cwd);
}
