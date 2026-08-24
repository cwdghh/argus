/**
 * Session persistence for argus.
 *
 * Sessions are stored as append-only JSONL files under ~/.argus/sessions
 * (override the base dir with the ARGUS_HOME env var, e.g. for tests):
 *
 *   {"type":"meta","version":1,"tools":[...],"toolSurfaceHash":"..."}
 *   {"type":"tools","hash":"...","tools":[...]}      <- when schemas change
 *   {"type":"turn","toolSurfaceHash":"...",...}        <- per turn
 *
 * Why JSONL: each turn is one line, so nothing is lost and requests can be
 * reconstructed exactly. For a turn, `config` (baseUrl/model/systemPrompt) +
 * `messages` (verbatim) + the turn's tool-surface hash uniquely determine the
 * request surface. `blocks` preserves the on-screen transcript (including
 * thinking and approvals) so a session resumes exactly as it looked.
 *
 * The API key is never written to disk.
 */
import { mkdir, readdir, readFile, appendFile, stat, rm, access, rename, open, chmod } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { argusHome } from "../config.mjs";
import { tools } from "../tools.mjs";

export function toolSurfaceSnapshot() {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

export function toolSurfaceHash(snapshot = toolSurfaceSnapshot()) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

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
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Session transcripts can contain source code and tool output. Do not rely
  // on the process umask to keep the store private.
  await chmod(dir, 0o700);
}

async function appendJsonLine(file, value) {
  await appendFile(file, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
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
      let loaded;
      try {
        loaded = await loadSession(item.name);
      } catch (err) {
        return { name: item.name, mtime: item.mtime, size: item.size, turns: 0, lastPrompt: "", error: err.message };
      }
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

/** Delete one saved session by exact name, never the explicitly excluded one. */
export async function deleteSession(name, { exclude } = {}) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(nameError(name) ?? `invalid session name: ${name}`);
  if (safe === exclude) throw new Error(`cannot delete the active session: ${safe}`);
  try {
    await rm(sessionFilePath(safe));
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`session not found: ${safe}`);
    throw err;
  }
  return safe;
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
/** Load a session: { meta, turns }. Returns null only when it doesn't exist. */
export async function loadSession(name) {
  let text;
  try {
    text = await readFile(sessionFilePath(name), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot load session ${name}: ${err.message}`);
  }
  const meta = {};
  const turns = [];
  const lines = text.split("\n");
  let lastRecord = lines.length - 1;
  while (lastRecord >= 0 && !lines[lastRecord].trim()) lastRecord--;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      if (index === lastRecord) {
        meta.warnings = [...(meta.warnings ?? []), `ignored incomplete final session record at line ${index + 1}`];
        continue;
      }
      throw new Error(`session ${name} is corrupt at line ${index + 1}: ${err.message}`);
    }
    if (obj.type === "meta") Object.assign(meta, obj);
    else if (obj.type === "turn") turns.push(obj);
    else if (obj.type === "tools") {
      meta.tools = obj.tools;
      meta.toolSurfaceHash = obj.hash;
    }
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
    this.lastToolSurfaceHash = opts.initialToolSurfaceHash ?? null;
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
      await appendJsonLine(this.file, { type: "cwd", cwd });
    });
  }

  /** Persist a per-session model override (written once per distinct value). */
  async setModel(model) {
    if (model === this.lastModel) return this.writeQueue;
    this.lastModel = model;
    return this.enqueue(async () => {
      await this.ensureMeta();
      await appendJsonLine(this.file, { type: "model", model });
    });
  }

  async ensureMeta() {
    if (this.metaWritten) return;
    await ensureDir();
    try {
      await stat(this.file);
      await chmod(this.file, 0o600);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const snapshot = toolSurfaceSnapshot();
      const hash = toolSurfaceHash(snapshot);
      const meta = {
        type: "meta",
        version: 1,
        tools: snapshot,
        toolSurfaceHash: hash,
      };
      await appendJsonLine(this.file, meta);
      this.lastToolSurfaceHash = hash;
    }
    this.metaWritten = true;
  }

  async ensureToolSurface() {
    const snapshot = toolSurfaceSnapshot();
    const hash = toolSurfaceHash(snapshot);
    if (hash === this.lastToolSurfaceHash) return hash;
    await appendJsonLine(this.file, { type: "tools", hash, tools: snapshot });
    this.lastToolSurfaceHash = hash;
    return hash;
  }

  /** Append one turn: { config, messages, blocks }. */
  async appendTurn(turn) {
    return this.enqueue(async () => {
      await this.ensureMeta();
      const currentToolSurface = await this.ensureToolSurface();
      await appendJsonLine(this.file, { ...turn, type: "turn", toolSurfaceHash: currentToolSurface });
    });
  }
}
