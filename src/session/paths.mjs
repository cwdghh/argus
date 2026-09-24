/** Session naming and private storage paths, resolved lazily from ARGUS_HOME. */
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { argusHome } from "../config.mjs";

export function sessionsDir() {
  // Resolve lazily so `.env` loaded by the standalone executable is honored.
  return join(argusHome(), "sessions");
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// NAME_MAX on common filesystems is 255 bytes per path component, and names
// map 1:1 to filenames, so enforce the cap up front instead of leaking a raw
// ENAMETOOLONG from the filesystem. The suffix counts toward the component:
// "<name>.jsonl" must fit in 255 bytes.
const NAME_MAX_LEN = 255 - ".jsonl".length;

/** Sanitize a proposed session name, or null when it can't be a filename. */
export function sanitizeName(name) {
  const n = String(name ?? "").trim();
  return NAME_RE.test(n) && n.length <= NAME_MAX_LEN ? n : null;
}

/** A human-readable reason a session name is invalid, or null when valid. */
export function nameError(name) {
  const raw = String(name ?? "").trim();
  if (raw.length > NAME_MAX_LEN) {
    return `invalid session name: too long (max ${NAME_MAX_LEN} characters)`;
  }
  if (!NAME_RE.test(raw)) {
    return `invalid session name: ${JSON.stringify(raw)} — use letters, digits, "-" and "_" (no spaces)`;
  }
  return null;
}

export function sessionFilePath(name) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(nameError(name) ?? `invalid session name: ${name}`);
  return join(sessionsDir(), `${safe}.jsonl`);
}

export function newSessionName(date = new Date()) {
  const pad = (x) => String(x).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `argus-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${millis}`;
}

export async function ensureDir() {
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Session transcripts can contain source code and tool output. Do not rely
  // on the process umask to keep the store private.
  await chmod(dir, 0o700);
}
