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
import { mkdir, readdir, readFile, appendFile, stat, rm, access, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import { argusHome } from "../config.mjs";
import { tools } from "../tools.mjs";

export function sessionsDir() {
  // Resolve lazily so `.env` loaded by the standalone executable is honored.
  return join(argusHome(), "sessions");
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function sanitizeName(name) {
  const n = String(name ?? "").trim();
  return NAME_RE.test(n) ? n : null;
}

export function sessionFilePath(name) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(`invalid session name: ${name}`);
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
 * Rename a saved session file. The session name lives only in the filename
 * (never inside the JSONL), so this is a validated file move: the new name
 * must be valid and unused, and renaming to the current name is a no-op.
 * Returns the accepted name. The caller updates any live Session handle.
 */
export async function renameSession(oldName, nextName) {
  const safe = sanitizeName(nextName);
  if (!safe) throw new Error(`invalid session name: ${nextName}`);
  if (safe === oldName) return safe;
  const oldFile = sessionFilePath(oldName);
  const nextFile = sessionFilePath(safe);
  try {
    await access(nextFile);
    throw new Error(`session already exists: ${safe}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await rename(oldFile, nextFile);
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
    if (!safe) throw new Error(`invalid session name: ${name}`);
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
