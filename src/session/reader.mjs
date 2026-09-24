/** Streaming session readers. Metadata may change between any two turns. */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { sessionFilePath } from "./paths.mjs";

/** Fold metadata in append order; the last record of each kind wins. */
function applyMetadata(meta, record) {
  if (record.type === "meta") Object.assign(meta, record);
  else if (record.type === "tools") {
    meta.tools = record.tools;
    meta.toolSurfaceHash = record.hash;
  } else if (record.type === "cwd") meta.cwd = record.cwd;
  else if (record.type === "model") meta.model = record.model;
  else if (record.type === "config") meta.config = record;
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
  try {
    await scanSessionFile(sessionFilePath(name), (line, lineNumber) => {
      if (!line.trim()) return;
      let record;
      try {
        record = parseRecord(line);
      } catch {
        warnings.push(`ignored unparseable session record at line ${lineNumber}`);
        return;
      }
      if (record.type === "turn") turns.push(record);
      else applyMetadata(meta, record);
    });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot load session ${name}: ${err.message}`);
  }
  if (warnings.length > 0) meta.warnings = warnings;
  return { meta, turns };
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
      if (!line.trim() || /^\s*\{\s*"type"\s*:\s*"turn"\s*[,}]/.test(line)) return;
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
