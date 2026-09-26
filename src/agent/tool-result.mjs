import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { argusHome } from "../config.mjs";

/**
 * Keep any tool—present or future—from flooding the next model request.
 *
 * Truncation is tail-first: the last chunk of the serialized result is kept
 * (the part a failing build's error shows up in), and the full output is
 * spilled to a tmp file whose path rides in the result so the model can read
 * any range of it with the read tool instead of guessing from a head slice.
 */
export async function boundToolResult(result, maxChars = 50_000, artifactDir = null) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (err) {
    return { error: true, message: `tool result was not JSON-serializable: ${err.message}` };
  }
  if (serialized === undefined) return { error: true, message: "tool returned undefined" };
  if (serialized.length <= maxChars) return result;

  const context = {
    ...(typeof result?.path === "string" ? { path: result.path } : {}),
    ...(typeof result?.cwd === "string" ? { cwd: result.cwd } : {}),
    ...(Number.isInteger(result?.nextOffset) ? { nextOffset: result.nextOffset } : {}),
    ...(Object.hasOwn(result ?? {}, "exitCode") ? { exitCode: result.exitCode } : {}),
    ...(typeof result?.signal === "string" || result?.signal === null ? { signal: result.signal } : {}),
    ...(typeof result?.termination === "string" ? { termination: result.termination } : {}),
    ...(result?.outputTruncated === true ? { outputTruncated: true } : {}),
    ...(result?.aborted === true ? { aborted: true } : {}),
    ...(result?.timeout === true ? { timeout: true } : {}),
    ...(result?.artifact && typeof result.artifact === "object" ? { artifact: result.artifact } : {}),
    ...(result?.artifactTruncated === true ? { artifactTruncated: true } : {}),
    ...(result?.artifactError === true ? { artifactError: true } : {}),
  };
  // A very long path/cwd must not defeat the cap it is meant to help explain.
  // Keep exact continuation context when it is reasonably small; otherwise
  // prefer a useful result preview and the hard size guarantee.
  for (const key of ["path", "cwd", "artifact"]) {
    if (JSON.stringify(context[key] ?? "").length > maxChars / 3) delete context[key];
  }

  let fullPath = await spillFullResult(serialized, artifactDir);
  const overflowMessage = `tool result exceeded ${maxChars} characters`;
  const sourceMessage = result?.error && typeof result.message === "string"
    ? result.message.slice(0, 200)
    : null;
  const message = sourceMessage ? `${sourceMessage}; ${overflowMessage}` : overflowMessage;

  // Previews are JSON fragments, so embedding them re-escapes quotes/backslashes
  // and inflates the payload beyond a naive character count — binary-search the
  // largest tail that truly fits rather than trusting arithmetic. Dropping a
  // context field frees room and the search re-runs larger.
  const skeleton = () => ({
    ...(result?.error ? { error: true } : {}),
    ...context,
    truncated: true,
    originalChars: serialized.length,
    message,
    ...(fullPath ? { fullPath } : {}),
  });
  // Free context room (cwd first, then path) before ever giving the tail up —
  // the preview is the actionable part and context fields can be recovered from
  // the spilled file. nextOffset stays: dropping it would break read paging.
  for (;;) {
    const base = skeleton();
    let lo = 0;
    let hi = Math.min(serialized.length, maxChars);
    let best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = mid === 0 ? { ...base, preview: "" } : { ...base, preview: serialized.slice(-mid) };
      if (JSON.stringify(candidate).length <= maxChars) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
    if (Object.hasOwn(context, "cwd")) {
      delete context.cwd;
      continue;
    }
    if (Object.hasOwn(context, "path")) {
      delete context.path;
      continue;
    }
    if (Object.hasOwn(context, "artifact")) {
      delete context.artifact;
      continue;
    }
    if (fullPath) {
      // ARGUS_HOME itself can be longer than the result budget. The pointer
      // is optional; the cap and exact read continuation are not.
      fullPath = null;
      continue;
    }
    // Config validation keeps this limit >= 500, so this fixed metadata fits.
    return base;
  }
}

/** Write an oversized tool result's full payload to the spill dir. */
async function spillFullResult(serialized, artifactDir) {
  try {
    const dir = artifactDir ?? join(argusHome(), "tmp");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = join(dir, `tool-result-${randomUUID()}.json`);
    await writeFile(file, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return file;
  } catch {
    // A spill failure must never fail the turn; the preview still carries the
    // actionable tail.
    return null;
  }
}
