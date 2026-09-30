#!/usr/bin/env node
/** Opt-in sequential provider trials with external scoring and sanitized reports. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runTurn } from "../src/agent.mjs";
import { getConfig, loadHomeEnv, validateConfig } from "../src/config.mjs";
import { toolSurfaceHash } from "../src/session/index.mjs";
import { findTool } from "../src/tools.mjs";
import { validateToolArgs } from "../src/tools/validate.mjs";
import { reportedRequestUsage, totalReportedUsage } from "../src/agent/usage.mjs";
import { codingTasks, codingQualificationTasks, createFixture, fixtureHash, isTaskCheck } from "./coding-tasks.mjs";
import { changeDetails, identifiers, positiveInt, sanitizer, snapshot, writeReport } from "./report.mjs";

export function selectTasks(names, tasks = codingTasks) {
  if (!names) return tasks;
  const requested = names.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !tasks.some((task) => task.name === name));
  if (unknown.length || !requested.length) throw new Error(`unknown evaluation task: ${unknown.join(", ")}`);
  return tasks.filter((task) => requested.includes(task.name));
}

/** Recompute aggregate counts from saved trial observations, including omissions. */
export function summarizeEval(report) {
  const results = report.results;
  const behaviorPassed = (item) => item.verifierPassed === true && item.outcome === "completed" &&
    !item.infrastructureError && !item.protectedFilesChanged?.length &&
    !["trial_timeout", "cancelled", "request_limit"].includes(item.failureCategory);
  const passed = (item) => behaviorPassed(item) && (!item.workflowRequired || item.workflowPassed === true) &&
    (report.suite !== "tools" || item.toolChoicePassed === true);
  const cleanPassed = (item) => passed(item) && item.unexpectedToolFailures === 0;
  return {
    passed: results.filter(passed).length,
    behaviorPassed: results.filter(behaviorPassed).length,
    cleanPassed: results.filter(cleanPassed).length,
    verifierPassed: results.filter((item) => item.verifierPassed === true).length,
    workflowPassed: results.filter((item) => item.workflowRequired && item.workflowPassed === true).length,
    workflowRequired: results.filter((item) => item.workflowRequired).length,
    toolChoicePassed: results.filter((item) => item.toolChoicePassed === true).length,
    total: results.length, planned: report.tasks.length * report.trials,
    complete: results.length === report.tasks.length * report.trials && !report.stopReason,
    byTask: report.tasks.map((task) => {
      const items = results.filter((item) => item.task === task);
      return { task, passed: items.filter(passed).length, behaviorPassed: items.filter(behaviorPassed).length,
        cleanPassed: items.filter(cleanPassed).length, verifierPassed: items.filter((item) => item.verifierPassed === true).length,
        attempted: items.length, planned: report.trials };
    }),
  };
}

export async function runCodingEval({ config, tasks = codingTasks, trials = 3, timeoutMs = 120_000,
  totalTimeoutMs = 600_000, maxSteps = 12, run = runTurn, suite = "coding", signal = null,
  maxRequests = 1_000 } = {}) {
  const identity = identifiers(config);
  const clean = sanitizer(config);
  const root = mkdtempSync(join(tmpdir(), "argus-coding-eval-"));
  const oldHome = process.env.ARGUS_HOME;
  const results = [];
  const requestAttempts = [];
  const requestMap = new Map();
  const deadline = Date.now() + totalTimeoutMs;
  let stopReason = null;
  try {
    outer:
    for (const task of tasks) {
      for (let trial = 1; trial <= trials; trial++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted || requestAttempts.length >= maxRequests) {
          stopReason = remaining <= 0 ? "suite_timeout" : signal?.aborted ? "cancelled" : "request_limit";
          break outer;
        }
        const trialRoot = join(root, `${task.name}-${trial}`);
        const cwd = join(trialRoot, "workspace");
        process.env.ARGUS_HOME = join(trialRoot, "home");
        const trace = [];
        const attempts = new Map();
        const protectedFilesChanged = new Set();
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("evaluation deadline")), Math.min(timeoutMs, remaining));
        const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const trialRequests = [];
        let result = null;
        let infrastructureError = null;
        let failureCategory = null;
        let verifierPassed = null;
        let workflowPassed = null;
        let toolChoicePassed = null;
        let details = null;
        const verifierDiagnostics = [];
        let before = null;
        let latest = null;
        let currentCwd = cwd;
        const inspectProtected = () => {
          const now = snapshot(cwd);
          for (const path of task.protectedFiles ?? []) {
            if (now.files[path]?.hash !== before.files[path]?.hash) protectedFilesChanged.add(path);
          }
          latest = now;
          return now;
        };
        try {
          mkdirSync(cwd, { recursive: true });
          createFixture(task, cwd);
          before = snapshot(cwd);
          latest = before;
          result = await run(config, [], task.prompt, (event) => {
            if (event.type === "cwd_change") currentCwd = event.cwd;
            else if (event.type === "request_attempt") {
              // The callback runs before fetch, including HTTP and stream retries.
              if (requestAttempts.length >= maxRequests) {
                stopReason = "request_limit";
                controller.abort(new Error("evaluation request limit"));
                throw new Error("evaluation request limit reached before network call");
              }
              const attempt = { usage: null };
              requestAttempts.push(attempt);
              trialRequests.push(attempt);
              requestMap.set(event.attemptId, attempt);
            } else if (event.type === "request_usage") {
              const attempt = requestMap.get(event.attemptId);
              if (attempt) attempt.usage = reportedRequestUsage(event.usage);
            } else if (event.type === "tool_call") {
              if (trace.length >= 200) throw new Error("evaluation tool trace limit exceeded");
              const tool = findTool(event.name);
              let validationError = null;
              try { if (event.raw !== undefined) JSON.parse(event.raw); }
              catch { validationError = "invalid JSON"; }
              validationError ??= tool ? validateToolArgs(tool, event.args) : "unknown tool";
              let cwdIsFixture = false;
              try { cwdIsFixture = realpathSync(currentCwd) === realpathSync(cwd); } catch { /* unknown scope */ }
              const attempt = { tool: clean(event.name, 100), command: clean(event.args?.command ?? "", 500),
                commandTruncated: String(event.args?.command ?? "").length > 500,
                cwdIsFixture, answerHashBefore: latest.files["answer.mjs"]?.hash ?? null,
                args: clean(JSON.stringify(event.args), 2_000), validationError: validationError ? clean(validationError) : null,
                writePolicy: event.name === "write" ? {
                  specified: Object.hasOwn(event.args ?? {}, "ensureFinalNewline"),
                  value: event.args?.ensureFinalNewline ?? null,
                  contentEndsLf: typeof event.args?.content === "string" ? event.args.content.endsWith("\n") : null,
                } : null,
                editForms: event.name === "edit" && Array.isArray(event.args?.edits) ? event.args.edits.slice(0, 20).map((edit) =>
                  edit?.old !== undefined ? "content" : edit?.startLine !== undefined ? "range" : "invalid") : null,
                editOperations: event.name === "edit" && Array.isArray(event.args?.edits) ? event.args.edits.slice(0, 20).map((edit) =>
                  edit?.startLine !== undefined && edit?.endLine === edit.startLine - 1 ? "insert" :
                    edit?.new === "" ? "delete" : "replace") : null,
                exitCode: null, termination: null, outputTruncated: false, error: false, errorMessage: null };
              trace.push(attempt);
              attempts.set(event.attemptId ?? event.id, attempt);
            } else if (event.type === "tool_result") {
              const attempt = attempts.get(event.attemptId ?? event.id);
              if (attempt) {
                attempt.exitCode = event.result?.exitCode ?? null;
                attempt.termination = event.result?.termination ?? null;
                attempt.outputTruncated = event.result?.outputTruncated === true;
                attempt.error = event.result?.error === true;
                attempt.errorMessage = attempt.error ? clean(event.result?.message ?? "tool failed") : null;
                attempt.stdout = typeof event.result?.stdout === "string" ? clean(event.result.stdout, 1_000) : null;
                attempt.stderr = typeof event.result?.stderr === "string" ? clean(event.result.stderr, 1_000) : null;
                attempt.outputPreview = typeof event.result?.preview === "string" ? clean(event.result.preview, 1_000) : null;
                attempt.diagnosticsTruncated = (event.result?.stdout?.length ?? 0) > 1_000 ||
                  (event.result?.stderr?.length ?? 0) > 1_000 || (event.result?.preview?.length ?? 0) > 1_000;
                attempt.expectedFailure = attempt.error && ((task.checkCommands?.includes("node check.mjs") && isTaskCheck(attempt.command) &&
                  attempt.termination === "completed" && attempt.exitCode === 1) || task.expectedFailure?.(attempt) === true);
              }
              inspectProtected();
            }
          }, { cwd, maxSteps, signal: runSignal, checkCommands: task.checkCommands ?? [] });
        } catch (error) {
          infrastructureError = clean(error.message ?? error);
          failureCategory = before ? "runner_error" : "fixture_setup";
        } finally {
          clearTimeout(timer);
        }
        if (before) {
          try {
            const after = inspectProtected();
            details = changeDetails(before, after, clean);
            verifierPassed = await task.verify(cwd, trace, result, { onProbe: (probe) => {
              if (verifierDiagnostics.length < 4) verifierDiagnostics.push({ ...probe, stderr: clean(probe.stderr) });
            } }) === true;
            if (task.verifyWorkflow) workflowPassed = task.verifyWorkflow(trace);
            if (task.verifyTools) toolChoicePassed = task.verifyTools(trace);
          } catch (error) {
            infrastructureError ??= clean(`verifier: ${error.message ?? error}`);
            failureCategory ??= "verifier_error";
          }
        }
        if (runSignal.aborted) failureCategory = stopReason === "request_limit" ? "request_limit"
          : signal?.aborted ? "cancelled" : "trial_timeout";
        else if (result?.reason === "model_error") failureCategory = "transport_or_protocol";
        else if (!failureCategory && protectedFilesChanged.size) failureCategory = "verifier_integrity";
        else if (!failureCategory && result?.outcome !== "completed") failureCategory = "agent_" + (result?.outcome ?? "unknown");
        else if (!failureCategory && !verifierPassed) failureCategory = "task_incorrect";
        else if (!failureCategory && task.verifyWorkflow && workflowPassed !== true) failureCategory =
          workflowPassed === null ? "workflow_unknown" : "workflow_incomplete";
        else if (!failureCategory && suite === "tools" && !toolChoicePassed) failureCategory = "tool_choice";
        else if (!failureCategory && suite === "tools" && trace.some((item) => item.error && !item.expectedFailure)) failureCategory = "tool_recovery";
        const item = {
          task: task.name, trial, fixtureHash: fixtureHash(task), verifierPassed, verifierDiagnostics,
          workflowRequired: Boolean(task.verifyWorkflow), workflowPassed,
          truncationObserved: trace.some((item) => item.outputTruncated),
          outcome: result?.outcome ?? null, reason: result?.reason ?? null,
          message: result?.message ? clean(result.message) : null, infrastructureError, failureCategory,
          protectedFilesChanged: [...protectedFilesChanged], elapsedMs: Date.now() - started,
          toolCalls: trace.map((item) => item.tool), toolFailures: trace.filter((item) => item.error).length,
          schemaMistakes: trace.filter((item) => item.validationError).length,
          unexpectedToolFailures: trace.filter((item) => item.error && !item.expectedFailure).length,
          toolChoicePassed, trace, changes: details,
          requestAttempts: trialRequests.length, requestUsage: totalReportedUsage(trialRequests),
          verificationHonesty: { assessment: "unassessed", finalText: clean(result?.finalText ?? "", 2_000),
            designatedChecks: (result?.evidence?.checks ?? []).map(({ command, state, freshness }) => ({ command: clean(command), state, freshness })) },
        };
        const score = summarizeEval({ suite, tasks: [task.name], trials: 1, results: [item] });
        item.passed = score.passed === 1;
        item.behaviorPassed = score.behaviorPassed === 1;
        item.cleanPassed = score.cleanPassed === 1;
        results.push(item);
        rmSync(trialRoot, { recursive: true, force: true });
        if (stopReason) break outer;
      }
    }
  } finally {
    if (oldHome === undefined) delete process.env.ARGUS_HOME;
    else process.env.ARGUS_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
  const report = { version: 3, suite, ...identity, toolSurfaceHash: toolSurfaceHash(),
    tasks: tasks.map((task) => task.name), trials, limits: { timeoutMs, totalTimeoutMs, maxSteps, maxRequests },
    stopReason, stoppedEarly: Boolean(stopReason), results, requestUsage: totalReportedUsage(requestAttempts) };
  Object.assign(report, summarizeEval(report));
  return report;
}

export async function evalMain(tasks = codingTasks, suite = "coding", availableTasks = tasks) {
  loadHomeEnv();
  const config = validateConfig(getConfig());
  const names = process.env.ARGUS_EVAL_TASKS ?? "";
  const selected = names ? selectTasks(names, availableTasks) : tasks;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("evaluation cancelled"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const report = await runCodingEval({ config, tasks: selected, suite, signal: controller.signal,
      trials: positiveInt(process.env.ARGUS_EVAL_TRIALS, 3, 20),
      timeoutMs: positiveInt(process.env.ARGUS_EVAL_TIMEOUT_MS, 120_000, 600_000),
      totalTimeoutMs: positiveInt(process.env.ARGUS_EVAL_TOTAL_TIMEOUT_MS, 600_000, 3_600_000),
      maxRequests: positiveInt(process.env.ARGUS_EVAL_MAX_REQUESTS, 1_000, 10_000) });
    if (process.env.ARGUS_EVAL_REPORT) writeReport(resolve(process.env.ARGUS_EVAL_REPORT), report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.complete || report.cleanPassed !== report.planned) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await evalMain(codingTasks, "coding", [...codingTasks, ...codingQualificationTasks]);
}
