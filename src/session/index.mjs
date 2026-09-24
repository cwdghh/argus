/** Public session API. Callers outside session/ import only from here. */
export { Session, toolSurfaceHash, toolSurfaceSnapshot } from "./store.mjs";
export { deleteSession, listSessions, pruneSessions, renameSession, sessionSummaries } from "./catalog.mjs";
export { loadSession, scanSessionMeta } from "./reader.mjs";
export { nameError, newSessionName, sanitizeName, sessionFilePath, sessionsDir } from "./paths.mjs";
export { defaultSessionName, latestSessionForCwd } from "./resume.mjs";
export { configRecord, sessionConfig, sessionData } from "./data.mjs";
