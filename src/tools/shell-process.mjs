/** Bounded capture and owned-process cancellation for one shell command. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argusHome } from "../config.mjs";

const PREVIEW_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const ARTIFACT_BYTES = 8 * 1024 * 1024;
const STOP_GRACE_MS = 500;
const CLEANUP_WAIT_MS = 2_000;

function extractCwd(stderr, marker) {
  const index = stderr.lastIndexOf(marker);
  if (index === -1) return { stderr, cwd: null };
  const end = stderr.indexOf("\n", index);
  const cwd = stderr.slice(index + marker.length, end === -1 ? undefined : end).trim();
  const before = stderr.slice(0, index).replace(/\n$/, "");
  const after = end === -1 ? "" : stderr.slice(end + 1);
  return { stderr: before + after, cwd: cwd || null };
}

function removeCwdMarker(buffer, marker) {
  const at = buffer.lastIndexOf(Buffer.from(marker));
  if (at < 0) return buffer;
  const before = at > 0 && buffer[at - 1] === 10 ? at - 1 : at;
  const end = buffer.indexOf(10, at + marker.length);
  return Buffer.concat([buffer.subarray(0, before), end < 0 ? Buffer.alloc(0) : buffer.subarray(end + 1)]);
}

async function saveOutputArtifact(chunks, marker, artifactDir) {
  const dir = artifactDir ?? join(argusHome(), "tmp");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const id = randomUUID();
  const paths = {
    stdout: join(dir, `shell-${id}.stdout`),
    stderr: join(dir, `shell-${id}.stderr`),
  };
  try {
    await writeFile(paths.stdout, Buffer.concat(chunks.stdout), { flag: "wx", mode: 0o600 });
    await writeFile(paths.stderr, removeCwdMarker(Buffer.concat(chunks.stderr), marker), { flag: "wx", mode: 0o600 });
    return paths;
  } catch (error) {
    await Promise.all(Object.values(paths).map((path) => rm(path, { force: true }).catch(() => {})));
    throw error;
  }
}

/**
 * Return separate exit, termination, output-completeness, and cwd facts.
 * A shell process group is owned on POSIX; children that detach themselves
 * can escape it, so cleanup is never described as a sandbox guarantee.
 */
export async function runShell(command, { cwd, signal, timeoutMs = 60_000, onOutput = null, artifactDir = null } = {}) {
  if (signal?.aborted) {
    return { error: true, aborted: true, termination: "cancelled", exitCode: null,
      signal: null, stdout: "", stderr: "", outputTruncated: false, message: "command aborted before start" };
  }

  const marker = `__ARGUS_CWD_${randomUUID()}__`;
  const wrapped = `{\n${command}\n}; __argus_status=$?; printf '\\n${marker}%s\\n' "$PWD" >&2; exit $__argus_status`;
  const grouped = process.platform !== "win32";
  const child = spawn("/bin/sh", ["-c", wrapped], {
    cwd, detached: grouped, stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve) => {
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const previews = { stdout: "", stderr: "" };
    const liveDecoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const livePending = { stdout: "", stderr: "" };
    const lastLiveAt = { stdout: 0, stderr: 0 };
    let capturedBytes = 0;
    let outputTruncated = false;
    let stderrTail = Buffer.alloc(0);
    const artifactChunks = { stdout: [], stderr: [] };
    let artifactBytes = 0;
    let artifactTruncated = false;
    let stopCause = null;
    let spawnError = null;
    let settled = false;
    let graceTimer = null;
    let cleanupTimer = null;

    const signalGroup = (name) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error.code !== "ESRCH") spawnError ??= error;
      }
    };

    const finish = async (code, exitSignal, forced = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", onAbort);
      previews.stdout += decoders.stdout.end();
      previews.stderr += decoders.stderr.end();
      for (const name of ["stdout", "stderr"]) {
        livePending[name] += liveDecoders[name].end();
        if (livePending[name]) {
          try { onOutput?.(name, livePending[name].slice(-2_000)); } catch { /* UI output is advisory */ }
        }
      }
      const parsed = extractCwd(previews.stderr, marker);
      const tailCwd = parsed.cwd ?? extractCwd(stderrTail.toString("utf8"), marker).cwd;
      const termination = forced ? "cleanup_uncertain" : stopCause ?? (spawnError ? "spawn_error" : "completed");
      const result = {
        stdout: previews.stdout,
        stderr: parsed.stderr,
        exitCode: Number.isInteger(code) ? code : null,
        signal: exitSignal ?? null,
        termination,
        outputTruncated,
      };
      if (outputTruncated) {
        result.artifactTruncated = artifactTruncated;
        try { result.artifact = await saveOutputArtifact(artifactChunks, marker, artifactDir); }
        catch { result.artifactError = true; }
      }
      if (termination === "completed" && tailCwd) result.cwd = tailCwd;
      if (termination === "cancelled") {
        result.error = true;
        result.aborted = true;
        result.message = "command cancelled";
      } else if (termination === "timeout") {
        result.error = true;
        result.timeout = true;
        result.message = `command timed out after ${timeoutMs}ms`;
      } else if (termination !== "completed") {
        result.error = true;
        result.message = termination === "cleanup_uncertain"
          ? "command cleanup did not settle; completion and remaining child effects are uncertain"
          : `could not start command: ${spawnError?.message ?? "unknown error"}`;
      } else if (result.exitCode !== 0) {
        result.error = true;
        result.message = result.exitCode === null
          ? `command ended with signal ${result.signal ?? "unknown"}`
          : `command exited with status ${result.exitCode}`;
      }
      resolve(result);
    };

    const requestStop = (reason) => {
      if (settled || stopCause) return;
      stopCause = reason;
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => signalGroup("SIGKILL"), STOP_GRACE_MS);
      cleanupTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, null, true);
      }, STOP_GRACE_MS + CLEANUP_WAIT_MS);
    };
    const onAbort = () => requestStop("cancelled");
    const deadlineTimer = setTimeout(() => requestStop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    for (const name of ["stdout", "stderr"]) {
      child[name]?.on("data", (chunk) => {
        const artifactRemaining = ARTIFACT_BYTES - artifactBytes;
        if (artifactRemaining > 0) {
          const piece = chunk.subarray(0, artifactRemaining);
          artifactChunks[name].push(piece);
          artifactBytes += piece.length;
          if (piece.length < chunk.length) artifactTruncated = true;
        } else {
          artifactTruncated = true;
        }
        if (onOutput) {
          livePending[name] = (livePending[name] + liveDecoders[name].write(chunk)).slice(-2_000);
          if (Date.now() - lastLiveAt[name] >= 100 && livePending[name]) {
            try { onOutput(name, livePending[name]); } catch { /* UI output is advisory */ }
            livePending[name] = "";
            lastLiveAt[name] = Date.now();
          }
        }
        if (name === "stderr") {
          stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
        }
        const remaining = PREVIEW_BYTES - capturedBytes;
        const captured = chunk.subarray(0, Math.max(0, remaining));
        if (captured.length > 0) {
          previews[name] += decoders[name].write(captured);
          capturedBytes += captured.length;
        }
        if (captured.length < chunk.length) outputTruncated = true;
      });
    }
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, exitSignal) => finish(code, exitSignal));
  });
}
