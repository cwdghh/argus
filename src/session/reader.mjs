/** Streaming session readers. Metadata may change between any two turns. */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { sessionFilePath } from "./paths.mjs";
import { JournalReader } from "./journal.mjs";

/** Fold metadata in append order; the last record of each kind wins. */
function applyMetadata(meta, record) {
  if (record.type === "meta") Object.assign(meta, record);
  else if (record.type === "tools") {
    meta.tools = record.tools;
    meta.toolSurfaceHash = record.hash;
  } else if (record.type === "cwd") meta.cwd = record.cwd;
  else if (record.type === "model") meta.model = record.model;
  else if (record.type === "config") meta.config = record;
  else if (record.type === "context_revision") meta.contextRevision = record.revision;
  else if (record.type === "session_id") meta.sessionId = record.id;
  else if (record.type === "run_start") {
    if (typeof record.cwd === "string") meta.cwd = record.cwd;
    if (typeof record.model === "string") meta.model = record.model;
  }
}

function parseRecord(line) {
  const record = JSON.parse(line);
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
    throw new Error("expected a session record object with a type");
  }
  return record;
}

/** Load {meta, turns}; retain valid records and report each damaged line. */
export async function loadSession(name) {
  const meta = {};
  const turns = [];
  const warnings = [];
  const journal = new JournalReader();
  const resolutions = new Map();
  const recoveredRuns = [];
  const continuedRuns = new Set();
  const journalSlots = new Map();
  const steering = new Map();
  try {
    await scanSessionFile(sessionFilePath(name), (line, lineNumber) => {
      if (!line.trim()) return;
      let record;
      try {
        record = parseRecord(line);
      } catch {
        warnings.push(`ignored unparseable session record at line ${lineNumber}`);
        journal.damageActive(lineNumber);
        return;
      }
      if (record.type === "turn") turns.push(record);
      else if (record.type === "steering" && typeof record.id === "string") {
        if (record.state === "queued" && typeof record.text === "string") {
          steering.set(record.id, { id: record.id, runId: record.runId, text: record.text, state: "queued" });
        } else if (["applied", "cancelled"].includes(record.state) && steering.has(record.id)) {
          steering.get(record.id).state = record.state;
        }
      }
      else if (record.type === "resolution" && typeof record.runId === "string" && ["retry", "abandon"].includes(record.action)) {
        resolutions.set(record.runId, record.action);
      }
      else if (["run_start", "checkpoint", "run_end"].includes(record.type)) {
        if (record.type === "run_start") {
          applyMetadata(meta, record);
          if (typeof record.parentRunId === "string") continuedRuns.add(record.parentRunId);
        }
        const active = journal.active.get(record.runId);
        const validCheckpoint = record.type === "checkpoint" && active && !active.damaged && record.seq === active.expected;
        const turn = journal.accept(record);
        if (validCheckpoint && record.kind === "steering" && typeof record.id === "string" && steering.has(record.id)) {
          steering.get(record.id).state = "applied";
        }
        if (record.type === "run_start" && journal.active.has(record.runId) && !journalSlots.has(record.runId)) {
          journalSlots.set(record.runId, turns.length);
          turns.push(null);
        }
        if (turn) {
          const slot = journalSlots.get(record.runId);
          if (slot == null) turns.push(turn);
          else turns[slot] = turn;
          journalSlots.delete(record.runId);
          if (turn.recovered) recoveredRuns.push(turn);
        }
      }
      else applyMetadata(meta, record);
    });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot load session ${name}: ${err.message}`);
  }
  const unfinished = journal.unfinished();
  for (const turn of unfinished) {
    const slot = journalSlots.get(turn.runId);
    if (slot == null) turns.push(turn);
    else turns[slot] = turn;
  }
  recoveredRuns.push(...unfinished);
  meta.pendingSteering = [...steering.values()].filter((item) => item.state === "queued");
  if (recoveredRuns.length) {
    meta.unfinishedRuns = recoveredRuns.map((turn) => ({
      runId: turn.runId, uncertainCalls: turn.uncertainCalls,
      resolution: continuedRuns.has(turn.runId) ? "continued" : resolutions.get(turn.runId) ?? null,
    }));
    for (const turn of recoveredRuns) warnings.push(`unfinished run ${turn.runId} recovered from its saved prefix; it was not restarted`);
  }
  warnings.push(...journal.warnings);
  if (warnings.length > 0) meta.warnings = warnings;
  return { meta, turns: turns.filter(Boolean) };
}

/**
 * Scan the whole file but deserialize only metadata in current-format files.
 * Older writers put type after the turn payload; parse those records without
 * retaining them. Stopping at the first turn would miss later cwd/model changes.
 */
export async function scanSessionMeta(name) {
  const meta = {};
  try {
    await scanSessionFile(sessionFilePath(name), (line) => {
      if (!line.trim() || /^\s*\{\s*"type"\s*:\s*"(?:turn|checkpoint|run_end)"\s*[,}]/.test(line)) return;
      try {
        applyMetadata(meta, parseRecord(line));
      } catch {
        // Full loads surface recovery warnings; discovery skips damaged lines.
      }
    });
  } catch {
    // An unreadable file must not be chosen using partially scanned metadata.
    return {};
  }
  return meta;
}

/** Hold one JSONL line at a time, closing both readers on completion or failure. */
async function scanSessionFile(file, onLine) {
  const stream = createReadStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let lineNumber = 0;
    for await (const line of lines) onLine(line, ++lineNumber);
  } finally {
    lines.close();
    stream.destroy();
  }
}
