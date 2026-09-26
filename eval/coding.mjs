#!/usr/bin/env node
/** Opt-in provider-backed coding trials in disposable local workspaces. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runTurn } from "../src/agent.mjs";
import { getConfig, loadHomeEnv, validateConfig } from "../src/config.mjs";
import { toolSurfaceHash } from "../src/session/index.mjs";
import { codingTasks, createFixture, fixtureHash } from "./coding-tasks.mjs";

function positiveInt(value, fallback, maximum) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= maximum ? n : fallback;
}

function sourceRevision() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return null; }
}

function sourceDirtyHash() {
  try {
    const limit = 16 * 1024 * 1024;
    const diff = execFileSync("git", ["diff", "--binary", "HEAD"], { maxBuffer: limit });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: limit })
      .toString("utf8").split("\0").filter(Boolean).sort();
    const hash = createHash("sha256").update(diff);
    let bytes = diff.length;
    for (const path of untracked) {
      const info = lstatSync(path);
      if (info.isFile() && bytes + info.size > limit) return null;
      const content = info.isSymbolicLink() ? Buffer.from(readlinkSync(path))
        : info.isFile() ? readFileSync(path) : null;
      if (!content || (bytes += content.length) > limit) return null;
      hash.update(path).update("\0").update(content).update("\0");
    }
    return hash.digest("hex");
  } catch { return null; }
}

function safeError(error, config) {
  let message = String(error?.message ?? error);
  for (const secret of [config.apiKey, config.baseUrl].filter(Boolean)) {
    message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 500);
}

export function selectTasks(names, tasks = codingTasks) {
  if (!names) return tasks;
  const requested = names.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !tasks.some((task) => task.name === name));
  if (unknown.length) throw new Error(`unknown coding task: ${unknown.join(", ")}`);
  return tasks.filter((task) => requested.includes(task.name));
}

export async function runCodingEval({ config, tasks = codingTasks, trials = 3, timeoutMs = 120_000,
  totalTimeoutMs = 600_000, run = runTurn } = {}) {
  const root = mkdtempSync(join(tmpdir(), "argus-coding-eval-"));
  const oldHome = process.env.ARGUS_HOME;
  process.env.ARGUS_HOME = join(root, "home");
  const results = [];
  const deadline = Date.now() + totalTimeoutMs;
  let stoppedEarly = false;
  try {
    outer:
    for (const task of tasks) {
      for (let trial = 1; trial <= trials; trial++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { stoppedEarly = true; break outer; }
        const cwd = join(root, `${task.name}-${trial}`);
        mkdirSync(cwd);
        createFixture(task, cwd);
        const trace = [];
        const attempts = new Map();
        const started = Date.now();
        let result = null;
        let infrastructureError = null;
        try {
          result = await run(config, [], task.prompt, (event) => {
            if (event.type === "tool_call") {
              const attempt = { tool: event.name, exitCode: null, outputTruncated: false, error: null };
              trace.push(attempt);
              attempts.set(event.attemptId, attempt);
            } else if (event.type === "tool_result") {
              const attempt = attempts.get(event.attemptId);
              if (attempt) {
                attempt.exitCode = event.result?.exitCode ?? null;
                attempt.outputTruncated = event.result?.outputTruncated === true;
                attempt.error = event.result?.error === true;
              }
            }
          }, { cwd, maxSteps: 12, signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)) });
        } catch (error) {
          infrastructureError = safeError(error, config);
        }
        let passed = false;
        try { passed = task.verify(cwd, trace) === true; }
        catch (error) { infrastructureError ??= `verifier: ${safeError(error, config)}`; }
        results.push({
          task: task.name, trial, fixtureHash: fixtureHash(task),
          passed: passed && result?.outcome === "completed" && !infrastructureError,
          verifierPassed: passed,
          outcome: result?.outcome ?? null,
          reason: result?.reason ?? null,
          infrastructureError,
          elapsedMs: Date.now() - started,
          toolCalls: trace.map((item) => item.tool),
          toolFailures: trace.filter((item) => item.error).length,
          requestUsage: result?.requestUsage?.totals ?? null,
        });
      }
    }
  } finally {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
  return {
    version: 1,
    sourceRevision: sourceRevision(),
    sourceDirtyHash: sourceDirtyHash(),
    toolSurfaceHash: toolSurfaceHash(),
    promptHash: createHash("sha256").update(config.systemPrompt ?? "").digest("hex"),
    node: process.version,
    platform: process.platform,
    endpoint: new URL(config.baseUrl).host,
    model: config.model,
    trials,
    stoppedEarly,
    passed: results.filter((entry) => entry.passed).length,
    total: results.length,
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadHomeEnv();
  const config = validateConfig(getConfig());
  const tasks = selectTasks(process.env.ARGUS_EVAL_TASKS ?? "");
  const trials = positiveInt(process.env.ARGUS_EVAL_TRIALS, 3, 20);
  const timeoutMs = positiveInt(process.env.ARGUS_EVAL_TIMEOUT_MS, 120_000, 600_000);
  const totalTimeoutMs = positiveInt(process.env.ARGUS_EVAL_TOTAL_TIMEOUT_MS, 600_000, 3_600_000);
  const report = await runCodingEval({ config, tasks, trials, timeoutMs, totalTimeoutMs });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.passed !== report.total) process.exitCode = 1;
}
