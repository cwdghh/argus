/** Serialized append-only session writer. Record format: docs/sessions.md. */
import { appendFile, stat, chmod, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tools } from "../tools.mjs";
import { configRecord } from "./data.mjs";
import { contextDir, ensureDir, nameError, sanitizeName, sessionFilePath } from "./paths.mjs";
import { acquireSessionOwnership } from "./ownership.mjs";
import { writeContextArtifact } from "./context.mjs";
import { scanSessionMeta } from "./reader.mjs";

export function toolSurfaceSnapshot() {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

export function toolSurfaceHash(snapshot = toolSurfaceSnapshot()) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function appendJsonLine(file, value) {
  await appendFile(file, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function appendSyncedJsonLine(file, value) {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
    this.activeRun = null;
    this.ownerRelease = null;
    this.pendingRun = false;
    this.sessionId = opts.initialSessionId ?? randomUUID();
    this.sessionIdWritten = Boolean(opts.initialSessionId);
  }

  /** Point this handle at a renamed file (the file was already moved). */
  renameTo(name) {
    const safe = sanitizeName(name);
    if (!safe) throw new Error(nameError(name) ?? `invalid session name: ${name}`);
    this.name = safe;
    this.file = sessionFilePath(safe);
  }

  artifactDir() { return contextDir(this.sessionId); }

  enqueue(write) {
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  enqueueOwned(write) {
    return this.enqueue(async () => {
      await ensureDir();
      const temporaryRelease = this.ownerRelease ? null : await acquireSessionOwnership(this.file);
      try { return await write(); }
      finally { if (temporaryRelease) await temporaryRelease(); }
    });
  }

  /** Persist the session working directory (call whenever it changes). */
  async setCwd(cwd) {
    return this.enqueueOwned(async () => {
      if (cwd === this.lastCwd) return;
      await this.ensureMeta();
      await appendJsonLine(this.file, { type: "cwd", cwd });
      this.lastCwd = cwd;
    });
  }

  /** Persist a per-session model override (written once per distinct value). */
  async setModel(model) {
    return this.enqueueOwned(async () => {
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
    return this.enqueueOwned(async () => {
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
      if (!this.sessionIdWritten) {
        const savedMeta = await scanSessionMeta(this.name);
        if (savedMeta.sessionId) {
          this.sessionId = savedMeta.sessionId;
          this.sessionIdWritten = true;
        }
      }
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
        version: 2,
        sessionId: this.sessionId,
        tools: snapshot,
        toolSurfaceHash: hash,
      };
      await appendJsonLine(this.file, meta);
      this.lastToolSurfaceHash = hash;
      this.sessionIdWritten = true;
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
    return this.enqueueOwned(async () => {
      if (this.activeRun) throw new Error("cannot append a legacy turn during a journaled run");
      await this.ensureMeta();
      const currentToolSurface = await this.ensureToolSurface();
      const { type: _type, ...payload } = turn;
      // Put the discriminator first so discovery can skip deserializing turns.
      await appendJsonLine(this.file, { type: "turn", ...payload, toolSurfaceHash: currentToolSurface });
    });
  }

  /** Sync the user instruction before a journaled run sends a model request. */
  async beginRun({ runId, prompt, cwd, model, parentRunId = null }) {
    if (this.activeRun || this.pendingRun) throw new Error("session already has an active run");
    this.pendingRun = true;
    try {
      await this.writeQueue;
      await ensureDir();
      this.ownerRelease = await acquireSessionOwnership(this.file);
      await this.enqueue(async () => {
        await this.ensureMeta();
        await appendSyncedJsonLine(this.file, {
          type: "run_start", version: 2, runId, seq: 0, prompt, cwd, model,
          ...(parentRunId ? { parentRunId } : {}),
        });
      });
      this.activeRun = { runId, seq: 0 };
    } catch (error) {
      if (this.ownerRelease) await this.ownerRelease();
      this.ownerRelease = null;
      throw error;
    } finally {
      this.pendingRun = false;
    }
  }

  /** Each acknowledged checkpoint is synced before the next effect starts. */
  async checkpoint(runId, kind, payload = {}) {
    return this.enqueue(async () => {
      if (this.activeRun?.runId !== runId) throw new Error("checkpoint has no active matching run");
      const seq = this.activeRun.seq + 1;
      await appendSyncedJsonLine(this.file, { type: "checkpoint", runId, seq, kind, ...payload });
      this.activeRun.seq = seq;
    });
  }

  /** Publish one final turn projection; no separate legacy turn is written. */
  async endRun(runId, turn) {
    try {
      return await this.enqueue(async () => {
        if (this.activeRun?.runId !== runId) throw new Error("run_end has no active matching run");
        const seq = this.activeRun.seq + 1;
        await appendSyncedJsonLine(this.file, { type: "run_end", runId, seq, turn });
        this.activeRun = null;
      });
    } finally {
      if (this.ownerRelease) await this.ownerRelease();
      this.ownerRelease = null;
      this.activeRun = null;
    }
  }

  /** Release this writer after an unexpected failure, leaving its synced prefix unfinished. */
  async leaveRunUnfinished() {
    await this.writeQueue;
    try {
      if (this.ownerRelease) await this.ownerRelease();
    } finally {
      this.ownerRelease = null;
      this.activeRun = null;
    }
  }

  /** Record the user's explicit disposition of an uncertain crash attempt. */
  async resolveRun(runId, action) {
    if (!["retry", "abandon"].includes(action)) throw new Error("resolution must be retry or abandon");
    return this.enqueueOwned(async () => {
      await this.ensureMeta();
      await appendSyncedJsonLine(this.file, { type: "resolution", version: 2, runId, action, at: new Date().toISOString() });
    });
  }

  async queueSteering(runId, id, text) {
    if (typeof text !== "string" || !text.trim() || text.length > 4_096) {
      throw new Error("steering text must be 1–4096 characters");
    }
    return this.enqueueOwned(async () => {
      await this.ensureMeta();
      await appendSyncedJsonLine(this.file, { type: "steering", version: 2, state: "queued", runId, id, text });
    });
  }

  async settleSteering(runId, id, state) {
    if (!["applied", "cancelled"].includes(state)) throw new Error("steering state must be applied or cancelled");
    return this.enqueueOwned(async () => {
      await this.ensureMeta();
      await appendSyncedJsonLine(this.file, { type: "steering", version: 2, state, runId, id });
    });
  }

  async saveContextRevision(revision, sourceMessages) {
    return this.enqueueOwned(async () => {
      if (!this.activeRun) throw new Error("context revision requires an active run");
      if (!this.sessionIdWritten) {
        await appendSyncedJsonLine(this.file, { type: "session_id", id: this.sessionId });
        this.sessionIdWritten = true;
      }
      const artifactPath = await writeContextArtifact(this.sessionId, revision, sourceMessages);
      const saved = { ...revision, artifactPath };
      await appendSyncedJsonLine(this.file, { type: "context_revision", version: 1, revision: saved });
      return saved;
    });
  }
}
