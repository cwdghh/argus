#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of the model-visible tool contract.
 *
 * Run with `npm run eval:tools` after configuring the same environment as
 * argus. Every task uses an isolated temporary cwd; destructive shell calls
 * remain blocked because the evaluator supplies no authorization callback.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/agent.mjs";
import { getConfig, loadHomeEnv, validateConfig } from "../src/config.mjs";

loadHomeEnv();
const config = validateConfig(getConfig());

const allTasks = [
  {
    name: "content-edit",
    setup(cwd) {
      writeFileSync(join(cwd, "small.js"), "export const value = 1;\n");
    },
    prompt: "In small.js change the exported numeric value from 1 to 2. Make the change and report the result.",
    verify(cwd) {
      return readFileSync(join(cwd, "small.js"), "utf8") === "export const value = 2;\n";
    },
    requiredTools: ["read", "edit"],
    allowedTools: ["read", "edit"],
    diagnose(cwd) {
      return { actual: readFileSync(join(cwd, "small.js"), "utf8") };
    },
  },
  {
    name: "range-edit",
    setup(cwd) {
      writeFileSync(join(cwd, "block.js"), "export function greet() {\n  return 'old';\n}\n");
    },
    prompt: "Read block.js, then use a line-range edit to make greet return 'hello argus'. Verify the file afterward.",
    verify(cwd) {
      return /return 'hello argus';/.test(readFileSync(join(cwd, "block.js"), "utf8"));
    },
    requiredTools: ["read", "edit", "read"],
    allowedTools: ["read", "edit"],
    diagnose(cwd) {
      return { actual: readFileSync(join(cwd, "block.js"), "utf8") };
    },
  },
  {
    name: "uncued-numbered-edit",
    setup(cwd) {
      writeFileSync(
        join(cwd, "label.js"),
        "export function label(name) {\n  return `hello ${name}`;\n}\n",
      );
    },
    prompt:
      "Update label.js so label trims name into a local clean variable and returns `hello ${clean}`. " +
      "Inspect the file, make the change, verify it, and report the result.",
    verify(cwd) {
      const actual = readFileSync(join(cwd, "label.js"), "utf8");
      return /const clean = name\.trim\(\);/.test(actual) && /`hello \$\{clean\}`/.test(actual) && !/\d+\s*│/.test(actual);
    },
    requiredTools: ["read", "edit"],
    allowedTools: ["read", "edit", "bash"],
    diagnose(cwd) {
      return { actual: readFileSync(join(cwd, "label.js"), "utf8") };
    },
  },
  {
    name: "search-with-bash",
    setup(cwd) {
      writeFileSync(join(cwd, "one.txt"), "nothing\n");
      writeFileSync(join(cwd, "two.txt"), "ARGUS_NEEDLE\n");
    },
    prompt: "Find which .txt file contains ARGUS_NEEDLE. Do not change any files; answer with the filename.",
    verify(cwd, result) {
      return /two\.txt/.test(result.finalText) && readFileSync(join(cwd, "two.txt"), "utf8") === "ARGUS_NEEDLE\n";
    },
    requiredTools: ["bash"],
    allowedTools: ["bash"],
  },
  {
    name: "new-file",
    setup() {},
    prompt: "Create note.txt with exactly `tool surface ok` followed by one newline, then report completion.",
    verify(cwd) {
      return readFileSync(join(cwd, "note.txt"), "utf8") === "tool surface ok\n";
    },
    requiredTools: ["write"],
    allowedTools: ["write", "read", "bash"],
    diagnose(cwd) {
      try {
        return { actual: readFileSync(join(cwd, "note.txt"), "utf8") };
      } catch {
        return { actual: null };
      }
    },
  },
  {
    name: "new-file-no-newline",
    setup() {},
    prompt: "Create raw.txt with exactly `no final newline` and no newline after it, then report completion.",
    verify(cwd) {
      return readFileSync(join(cwd, "raw.txt"), "utf8") === "no final newline";
    },
    requiredTools: ["write"],
    allowedTools: ["write", "read", "bash"],
    diagnose(cwd) {
      try {
        return { actual: readFileSync(join(cwd, "raw.txt"), "utf8") };
      } catch {
        return { actual: null };
      }
    },
  },
];

const requestedNames = String(process.env.ARGUS_EVAL_TASKS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const tasks = requestedNames.length > 0
  ? allTasks.filter((task) => requestedNames.includes(task.name))
  : allTasks;
if (tasks.length === 0) {
  throw new Error(`ARGUS_EVAL_TASKS selected no known tasks: ${requestedNames.join(", ")}`);
}

const report = [];
const containsSubsequence = (values, required) => {
  let next = 0;
  for (const value of values) if (value === required[next]) next++;
  return next === required.length;
};
for (const task of tasks) {
  const cwd = mkdtempSync(join(tmpdir(), `argus-eval-${task.name}-`));
  const trace = [];
  let result = null;
  let error = null;
  try {
    task.setup(cwd);
    result = await runTurn(config, [], task.prompt, (event) => {
      if (event.type === "tool_call") trace.push({ tool: event.name, args: event.args });
      if (event.type === "tool_result" && !event.ok) trace.push({ error: event.result?.message ?? "tool failed" });
    }, { cwd, maxSteps: 12 });
  } catch (caught) {
    error = caught.message;
  }
  let outcomePassed = false;
  try {
    outcomePassed = !error && task.verify(cwd, result);
  } catch (caught) {
    error ??= caught.message;
  }
  const tools = trace.filter((item) => item.tool).map((item) => item.tool);
  const invalidCalls = trace.filter((item) => item.error).length;
  const toolChoicePassed =
    containsSubsequence(tools, task.requiredTools) &&
    tools.every((tool) => task.allowedTools.includes(tool));
  const passed = outcomePassed && toolChoicePassed && invalidCalls === 0;
  const item = {
    task: task.name,
    passed,
    outcomePassed,
    requiredTools: task.requiredTools,
    allowedTools: task.allowedTools,
    tools,
    toolChoicePassed,
    invalidCalls,
    error,
    calls: trace.filter((entry) => entry.tool),
  };
  if (!passed) {
    item.diagnostics = task.diagnose?.(cwd) ?? null;
  }
  report.push(item);
  rmSync(cwd, { recursive: true, force: true });
}

const passed = report.filter((item) => item.passed).length;
process.stdout.write(JSON.stringify({ model: config.model, passed, total: report.length, tasks: report }, null, 2) + "\n");
if (passed !== report.length) process.exitCode = 1;
