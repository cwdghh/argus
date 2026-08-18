/**
 * Session persistence for argus.
 *
 * Sessions are stored as append-only JSONL files under ~/.argus/sessions
 * (override the base dir with the ARGUS_HOME env var, e.g. for tests):
 *
 *   {"type":"meta","version":1,"tools":[...]}          <- written once
 *   {"type":"turn","config":{...},"messages":[...],"blocks":[...]}  <- per turn
 *
 * Why JSONL: each turn is one line, so nothing is lost and requests can be
 * reconstructed exactly. For a turn, `config` (baseUrl/model/systemPrompt) +
 * `messages` (verbatim) + the meta `tools` schemas uniquely determine every
 * request that turn made. `blocks` additionally preserves the on-screen
 * transcript (incl. thinking) so a session resumes exactly as it looked.
 *
 * The API key is never written to disk.
 *
 * This module owns the filesystem layer. Sibling modules:
 *   - ./resume.mjs — folder-scoped default-session resolution
 *   - ./data.mjs   — turn/session reconstruction + persisted config shape
 *   - ./index.mjs  — the public facade everything else imports
 */
/**
 * Session persistence for argus.
 *
 * Sessions are stored as append-only JSONL files under ~/.argus/sessions
 * (override the base dir with the ARGUS_HOME env var, e.g. for tests):
 *
 *   {"type":"meta","version":1,"tools":[...]}          <- written once
 *   {"type":"turn","config":{...},"messages":[...],"blocks":[...]}  <- per turn
 *
 * Why JSONL: each turn is one line, so nothing is lost and requests can be
 * reconstructed exactly. For a turn, `config` (baseUrl/model/systemPrompt) +
 * `messages` (verbatim) + the meta `tools` schemas uniquely determine every
 * request that turn made. `blocks` additionally preserves the on-screen
 * transcript (incl. thinking) so a session resumes exactly as it looked.
 *
 * The API key is never written to disk.
 */
import { mkdir, readdir, readFile, appendFile, stat, rm, access, rename, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { argusHome } from "../config.mjs";
import { tools } from "../tools.mjs";

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

async function ensureDir() {
  await mkdir(sessionsDir(), { recursive: true });
}

/** List sessions (name, file, mtime, size), newest first. */
export async function listSessions() {
  await ensureDir();
  const dir = sessionsDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const sessions = [];
  for (const e of entries) {
    if (!(e.isFile() && e.name.endsWith(".jsonl"))) continue;
    try {
      const st = await stat(join(dir, e.name));
      const name = sanitizeName(basename(e.name, ".jsonl"));
      if (name) sessions.push({ name, file: join(dir, e.name), mtime: st.mtimeMs, size: st.size });
    } catch {
      // ignore unreadable entries
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

export async function latestSessionName() {
  const list = await listSessions();
  return list.length ? list[0].name : null;
}

/** List concise session metadata for the TUI. */
export async function sessionSummaries(limit = 20) {
  const listed = (await listSessions()).slice(0, Math.max(0, limit));
  return Promise.all(
    listed.map(async (item) => {
      const loaded = await loadSession(item.name);
      const turns = loaded?.turns ?? [];
      let lastPrompt = "";
      for (let i = turns.length - 1; i >= 0 && !lastPrompt; i--) {
        const user = (turns[i].messages ?? []).find((message) => message.role === "user");
        if (user?.content) lastPrompt = String(user.content).replace(/\s+/g, " ").trim();
      }
      return { name: item.name, mtime: item.mtime, size: item.size, turns: turns.length, lastPrompt };
    })
  );
}

/**
 * Delete all but the newest `keep` sessions (by mtime), never touching
 * `exclude`. `keep <= 0` keeps everything. Returns how many were removed.
 */
export async function pruneSessions(keep, { exclude } = {}) {
  if (!Number.isInteger(keep) || keep <= 0) return 0;
  const listed = await listSessions();
  let kept = 0;
  let removed = 0;
  for (const item of listed) {
    if (item.name === exclude || kept < keep) {
      kept++;
      continue;
    }
    try {
      await rm(item.file, { force: true });
      removed++;
    } catch {
      // unreadable/racing file: leave it alone
    }
  }
  return removed;
}

/**
 * Rename a saved session. The session name lives only in the filename (never
 * inside the JSONL), so this is a validated file move: the new name must be
 * valid and unused, and renaming to the current name is a no-op.
 *
 * A session that hasn't materialized a file yet (e.g. one just created by
 * `/new`, which writes lazily on the first turn) has nothing to move: the
 * rename is then just the handle repoint. Pass the live Session handle to
 * repoint it atomically with the move, after letting any in-flight writes
 * settle, so a queued append can never resolve against the old path and
 * recreate the file we are moving away from.
 *
 * Returns the accepted name.
 */
export async function renameSession(oldName, nextName, handle = null) {
  const safe = sanitizeName(nextName);
  if (!safe) throw new Error(nameError(nextName) ?? `invalid session name: ${nextName}`);
  if (safe === oldName) return safe;
  if (handle?.writeQueue) await handle.writeQueue.catch(() => {});

  await ensureDir();
  const oldFile = sessionFilePath(oldName);
  const nextFile = sessionFilePath(safe);

  // Reserve the destination with O_CREAT|O_EXCL so rename() below can never
  // clobber a file another process created between a check and the move
  // (TOCTOU). The empty placeholder is replaced by the moved file, or removed
  // again when there is nothing to move / the move fails.
  let reserved = false;
  try {
    const fh = await open(nextFile, "wx");
    await fh.close();
    reserved = true;
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`session already exists: ${safe}`);
    throw err;
  }

  try {
    await access(oldFile);
  } catch (err) {
    if (err.code === "ENOENT") {
      if (reserved) await rm(nextFile, { force: true }).catch(() => {});
      handle?.renameTo?.(safe);
      return safe;
    }
    throw err;
  }

  try {
    await rename(oldFile, nextFile);
  } catch (err) {
    if (reserved) await rm(nextFile, { force: true }).catch(() => {});
    throw err;
  }
  handle?.renameTo?.(safe);
  return safe;
}

/**
 * Rebuild the on-screen transcript and model history from a session's raw
 * turns. Both the TUI (restore a session) and headless mode (resume history)
 * use this so the reconstruction logic has exactly one home. `blocks` mirrors
 * what was visible, `history` is the exact message list the model needs, and
 * `cwd`/`model` are the session's persisted meta (null when unset).
 */
/** Load a session: { meta, turns }. Returns null if it doesn't exist. */
export async function loadSession(name) {
  let text;
  try {
    text = await readFile(sessionFilePath(name), "utf8");
  } catch {
    return null;
  }
  const meta = {};
  const turns = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip corrupt lines
    }
    if (obj.type === "meta") Object.assign(meta, obj);
    else if (obj.type === "turn") turns.push(obj);
    else if (obj.type === "cwd") meta.cwd = obj.cwd;
    else if (obj.type === "model") meta.model = obj.model;
  }
  return { meta, turns };
}

/**
 * A writable session handle. Writes the meta line once (on first append) and
 * appends one JSONL line per turn.
 */
export class Session {
  constructor(name, config, opts = {}) {
    this.name = name;
    this.config = config;
    this.file = sessionFilePath(name);
    this.metaWritten = false;
    this.lastCwd = opts.initialCwd ?? null;
    this.lastModel = opts.initialModel ?? null;
    this.writeQueue = Promise.resolve();
  }

  /** Point this handle at a renamed file (the file was already moved). */
  renameTo(name) {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(nameError(name) ?? `invalid session name: ${name}`);
    this.name = safe;
    this.file = sessionFilePath(safe);
  }

  enqueue(write) {
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  /** Persist the session working directory (call whenever it changes). */
  async setCwd(cwd) {
    if (cwd === this.lastCwd) return this.writeQueue;
    this.lastCwd = cwd;
    return this.enqueue(async () => {
      await this.ensureMeta();
      await appendFile(this.file, JSON.stringify({ type: "cwd", cwd }) + "\n", "utf8");
    });
  }

  /** Persist a per-session model override (written once per distinct value). */
  async setModel(model) {
    if (model === this.lastModel) return this.writeQueue;
    this.lastModel = model;
    return this.enqueue(async () => {
      await this.ensureMeta();
      await appendFile(this.file, JSON.stringify({ type: "model", model }) + "\n", "utf8");
    });
  }

  async ensureMeta() {
    if (this.metaWritten) return;
    await ensureDir();
    try {
      await stat(this.file);
    } catch {
      const meta = {
        type: "meta",
        version: 1,
        tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      };
      await appendFile(this.file, JSON.stringify(meta) + "\n", "utf8");
    }
    this.metaWritten = true;
  }

  /** Append one turn: { config, messages, blocks }. */
  async appendTurn(turn) {
    return this.enqueue(async () => {
      await this.ensureMeta();
      await appendFile(this.file, JSON.stringify({ type: "turn", ...turn }) + "\n", "utf8");
    });
  }
}
