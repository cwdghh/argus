/** Serialized append-only session writer. Record format: docs/sessions.md. */
import { appendFile, stat, chmod, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tools } from "../tools.mjs";
import { configRecord } from "./data.mjs";
import { ensureDir, nameError, sanitizeName, sessionFilePath } from "./paths.mjs";

export function toolSurfaceSnapshot() {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

export function toolSurfaceHash(snapshot = toolSurfaceSnapshot()) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function appendJsonLine(file, value) {
  await appendFile(file, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
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
    return this.enqueue(async () => {
      if (cwd === this.lastCwd) return;
      await this.ensureMeta();
      await appendJsonLine(this.file, { type: "cwd", cwd });
      this.lastCwd = cwd;
    });
  }

  /** Persist a per-session model override (written once per distinct value). */
  async setModel(model) {
    return this.enqueue(async () => {
      if (model === this.lastModel) return;
      await this.ensureMeta();
      await appendJsonLine(this.file, { type: "model", model });
      this.lastModel = model;
    });
  }

  /** Persist the static config (incl. systemPrompt) once per distinct value —
   *  written once, not with every turn, so a 10KB prompt never multiplies by
   *  the number of turns in the session file. */
  setConfig(config = {}) {
    const record = configRecord(config);
    const signature = JSON.stringify(record);
    return this.enqueue(async () => {
      if (signature === this.lastConfigSignature) return;
      await this.ensureMeta();
      await appendJsonLine(this.file, { type: "config", ...record });
      this.lastConfigSignature = signature;
    });
  }

  async ensureMeta() {
    if (this.metaWritten) return;
    await ensureDir();
    try {
      await stat(this.file);
      await chmod(this.file, 0o600);
      // A crash may leave the last record without its newline. Separate it
      // before appending so recovery cannot swallow the next valid record.
      const file = await open(this.file, "r+");
      try {
        const { size } = await file.stat();
        if (size > 0) {
          const tail = Buffer.alloc(1);
          await file.read(tail, 0, 1, size - 1);
          if (tail[0] !== 10) await file.write("\n", size, "utf8");
        }
      } finally {
        await file.close();
      }
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
      const { type: _type, ...payload } = turn;
      // Put the discriminator first so discovery can skip deserializing turns.
      await appendJsonLine(this.file, { type: "turn", ...payload, toolSurfaceHash: currentToolSurface });
    });
  }
}
