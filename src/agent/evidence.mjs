/** Conservative task check evidence; labels come from the user, not shell guesses. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"] });
}

/** Hash a bounded Git worktree scope without storing its contents. */
export function workspaceFingerprint(cwd) {
  try {
    const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    const diff = git(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD"]);
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
      .toString("utf8").split("\0").filter(Boolean);
    const hash = createHash("sha256").update(status).update(diff);
    let complete = untracked.length <= MAX_UNTRACKED_FILES;
    let bytes = 0;
    for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      try {
        const full = join(cwd, path);
        const stat = lstatSync(full);
        if (!stat.isFile() || bytes + stat.size > MAX_UNTRACKED_BYTES) { complete = false; continue; }
        bytes += stat.size;
        hash.update(path).update(readFileSync(full));
      } catch { complete = false; }
    }
    return { hash: hash.digest("hex"), complete, dirty: status.length > 0 };
  } catch {
    return { hash: null, complete: false, dirty: null };
  }
}

export function createEvidence(checkCommands = [], initial = null, initialCwd = null) {
  const requested = [...new Set(checkCommands.map((command) => String(command).trim()).filter(Boolean))];
  const checks = requested.map((command) => ({ command, state: "not_run", freshness: "unknown", attempts: [] }));
  const observations = [];
  return {
    initial,
    checks,
    observations,
    beforeTool(name, args, cwd) {
      return name === "bash" && checks.some((check) => check.command === args?.command)
        ? workspaceFingerprint(cwd) : null;
    },
    afterTool({ name, args, result, cwd, attemptId, before, startedAt, endedAt, executed = true }) {
      const mutating = executed && (name === "write" || name === "edit" || name === "bash");
      if (mutating) {
        for (const check of checks) if (check.state !== "not_run") check.freshness = "stale";
      }
      if (name !== "bash") return;
      const observation = {
        attemptId, command: args?.command ?? "", cwd,
        exitCode: result?.exitCode ?? null, signal: result?.signal ?? null,
        termination: result?.termination ?? "unknown",
        outputTruncated: result?.outputTruncated === true,
        artifact: result?.artifact ?? result?.fullPath ?? null,
        startedAt: startedAt ?? null,
        endedAt: endedAt ?? null,
      };
      observations.push(observation);
      const check = checks.find((entry) => entry.command === observation.command);
      if (!check || !executed) return;
      const after = workspaceFingerprint(cwd);
      const state = observation.termination !== "completed" ? "unknown"
        : observation.exitCode === 0 ? "passed" : "failed";
      check.state = state;
      check.freshness = before?.complete && after.complete && before.hash === after.hash ? "fresh" : "unknown";
      check.attempts.push({ ...observation, before, after });
    },
    result() {
      return { initial, final: initialCwd && initial ? workspaceFingerprint(initialCwd) : null, checks, observations };
    },
  };
}

export function summarizeEvidence(evidence) {
  if (!evidence?.checks?.length) return null;
  return evidence.checks.map((check) => `${check.command}: ${check.state} (${check.freshness})`).join("; ");
}

/** Keep per-task check instructions in the same saved user message sent to the model. */
export function promptWithChecks(prompt, checks) {
  if (!checks.length) return prompt;
  return prompt + "\n\nDesignated verification commands for this task (JSON strings):\n" +
    checks.map(({ command }) => JSON.stringify(command)).join("\n") +
    "\nIf the task calls for one of these checks, use its exact command as the entire bash call: " +
    "no prefix, suffix, pipe, or redirection. If asked to observe a failure before fixing it, " +
    "run the check before editing and again after the final edit. Finish other inspection before " +
    "the final check so its evidence stays current. Designation alone does not require running it. " +
    "Report any check not run or not passed.";
}
