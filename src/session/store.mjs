/**
 * Session persistence for argus.
 *
 * Sessions are stored as append-only JSONL files under ~/.argus/sessions
 * (override the base dir with the ARGUS_HOME env var, e.g. for tests):
 *
 *   {"type":"meta","version":1,"tools":[...],"toolSurfaceHash":"..."}
 *   {"type":"cwd","cwd":"/path"}                     <- on change
 *   {"type":"model","model":"..."}                   <- on change
 *   {"type":"config", ...}                           <- once per distinct config
 *   {"type":"tools","hash":"...","tools":[...]}      <- when schemas change
 *   {"type":"turn","toolSurfaceHash":"...",...}        <- per turn
 *
 * Why JSONL: each turn is one line, so nothing is lost and requests can be
 * reconstructed exactly. For a turn, `config` (the model) + `messages`
 * (verbatim) + the turn's tool-surface hash uniquely determine the request
 * surface. `blocks` preserves the on-screen transcript (including thinking
 * and approvals) so a session resumes exactly as it looked. Meta records
 * (meta/cwd/model/config/tools) always precede turns, so startup can scan
 * just the head of a file instead of parsing every turn; a torn line anywhere
 * is skipped with a warning rather than bricking the session.
 *
 * The API key is never written to disk.
 */
import { mkdir, readdir, appendFile, stat, rm, access, rename, open, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { argusHome } from "../config.mjs";
import { tools } from "../tools.mjs";
import { configRecord } from "./data.mjs";

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

/** List sessions (name, file, mtime, size), newest first. Stats run
 *  concurrently — startup calls this a few times in a row and a directory with
 *  hundreds of sessions used to serialize one stat() at a time. */
export async function listSessions() {
  await ensureDir();
  const dir = sessionsDir();
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    (e) => e.isFile() && e.name.endsWith(".jsonl")
  );
  const sessions = (
    await Promise.all(
      entries.map(async (e) => {
        try {
          const st = await stat(join(dir, e.name));
          const name = sanitizeName(basename(e.name, ".jsonl"));
          return name ? { name, file: join(dir, e.name), mtime: st.mtimeMs, size: st.size } : null;
        } catch {
          return null; // ignore unreadable entries
        }
      })
    )
  ).filter(Boolean);
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
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
  const doomed = [];
  let kept = 0;
  for (const item of listed) {
    if (item.name === exclude || kept < keep) {
      kept++;
      continue;
    }
    doomed.push(item.file);
  }
  await Promise.all(
    doomed.map((file) =>
      rm(file, { force: true }).catch(() => {
        // unreadable/racing file: leave it alone
      })
    )
  );
  return doomed.length;
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
 * `cwd`/`model`/`config` are the session's persisted meta (null when unset).
 *
 * Streaming and tolerant: each line is parsed as it is read (never the whole
 * file held and split at once), and an unparseable line anywhere — a torn
 * final record from a crash, or interior corruption — is skipped with a
 * warning so one bad append can never brick the session.
 */
/** Load a session: { meta, turns }. Returns null only when it doesn't exist. */
export async function loadSession(name) {
  const file = sessionFilePath(name);
  const meta = {};
  const turns = [];
  const warnings = [];
  let lineNumber = 0;
  const feed = (raw) => {
    lineNumber++;
    const line = raw.trim();
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      warnings.push(`ignored unparseable session record at line ${lineNumber}`);
      return;
    }
    if (obj.type === "meta") Object.assign(meta, obj);
    else if (obj.type === "turn") turns.push(obj);
    else if (obj.type === "tools") {
      meta.tools = obj.tools;
      meta.toolSurfaceHash = obj.hash;
    } else if (obj.type === "cwd") meta.cwd = obj.cwd;
    else if (obj.type === "model") meta.model = obj.model;
    else if (obj.type === "config") meta.config = obj;
  };
  try {
    await scanSessionFile(file, feed);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot load session ${name}: ${err.message}`);
  }
  if (warnings.length > 0) meta.warnings = warnings;
  return { meta, turns };
}

/**
 * Stream one session file line-by-line, stopping when the callback returns
 * `false` (used by the meta scanner so startup never parses whole turns).
 * Memory-bounded: the old `readFile` + `split("\n")` held ~2× the file plus
 * every deserialized turn at once.
 */
async function scanSessionFile(file, onLine) {
  let stopped = false;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    // readline re-emits its input stream's errors on the Interface; without a
    // listener they crash the process. The `stopped` guard ignores the errors
    // our own early-stop `destroy()` produces (ERR_STREAM_PREMATURE_CLOSE).
    const fail = (err) => {
      if (!stopped) reject(err);
    };
    stream.on("error", fail);
    rl.on("error", fail);
    rl.on("line", (line) => {
      if (stopped) return;
      if (onLine(line) === false) {
        stopped = true;
        rl.close();
        stream.destroy();
      }
    });
    rl.on("close", () => resolve());
  });
}

/**
 * The head-only meta of a session — cwd/model/config/tool-surface records,
 * which every writer places before the first turn. `loadSession` rebuilds the
 * whole transcript and must parse every turn; startup and folder-matching
 * only need these few leading records, so a full load is wasted work. Stops
 * reading at the first turn record.
 */
export async function scanSessionMeta(name) {
  const meta = {};
  try {
    await scanSessionFile(sessionFilePath(name), (line) => {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // ignore torn head lines here; loadSession warns about them
      }
      if (obj.type === "turn") return false; // meta records always lead
      if (obj.type === "meta") Object.assign(meta, obj);
      else if (obj.type === "tools") {
        meta.tools = obj.tools;
        meta.toolSurfaceHash = obj.hash;
      } else if (obj.type === "cwd") meta.cwd = obj.cwd;
      else if (obj.type === "model") meta.model = obj.model;
      else if (obj.type === "config") meta.config = obj;
    });
  } catch {
    // A missing or unreadable head must never block startup — the caller skips
    // this session and keeps looking (a resumed loadSession surfaces warnings).
  }
  return meta;
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
    // The static config is persisted once (systemPrompt is the heavy field);
    // `null` means a fresh handle writes it on its first turn.
    this.lastConfigSignature = null;
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

  /** Persist the static config (incl. systemPrompt) once per distinct value —
   *  written once, not with every turn, so a 10KB prompt never multiplies by
   *  the number of turns in the session file. */
  setConfig(config = {}) {
    const record = configRecord(config);
    const signature = JSON.stringify(record);
    if (signature === this.lastConfigSignature) return this.writeQueue;
    this.lastConfigSignature = signature;
    return this.enqueue(async () => {
      await this.ensureMeta();
      await appendJsonLine(this.file, { type: "config", ...record });
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
