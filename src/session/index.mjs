/**
 * Public API of the session layer (the former src/session.mjs).
 *
 * Everything outside this package imports from here:
 *   - store.mjs  — filesystem + JSONL store, naming, listing, deletion,
 *                  renaming, pruning, and the writable Session handle
 *   - resume.mjs — folder-scoped default session resolution
 *   - data.mjs   — sessionData / sessionConfig reconstruction
 */
export {
  Session,
  deleteSession,
  latestSessionName,
  listSessions,
  loadSession,
  nameError,
  newSessionName,
  pruneSessions,
  renameSession,
  sanitizeName,
  sessionFilePath,
  sessionSummaries,
  sessionsDir,
  toolSurfaceHash,
  toolSurfaceSnapshot,
} from "./store.mjs";
export { defaultSessionName, latestSessionForCwd } from "./resume.mjs";
export { sessionConfig, sessionData } from "./data.mjs";
