/**
 * Folder-scoped default session resolution: pick the newest saved session
 * whose working directory sits inside the current folder, so re-running in
 * a repo picks the session that worked there — without ever auto-resuming
 * a session from an unrelated folder.
 */
import { loadSession, listSessions, newSessionName } from "./store.mjs";

// How many of the newest sessions the folder-matched default resume considers.
// A recency-prioritized search stays fast on startup; older sessions remain
// reachable via `/resume <tab>` or `--session`.
const RESUME_SCAN_LIMIT = 20;

/** Does `candidate` live inside (or equal) `folder`? Boundary-aware, so
 *  `/repo/src` matches `/repo` but `/repo-x` does not. */
function withinFolder(candidate, folder) {
  const norm = (p) => (p === "/" ? p : p.replace(/\/+$/, "").replace(/\\+$/, ""));
  const c = norm(candidate);
  const f = norm(folder);
  if (f === "/") return true; // the filesystem root contains everything
  return c === f || c.startsWith(f + "/") || c.startsWith(f + "\\");
}

/**
 * Newest saved session whose working directory is the given folder or one of
 * its subfolders (e.g. running in the repo root also matches sessions that
 * ended inside it), scanning the newest `limit` sessions. Returns null when
 * nothing recent relates to this folder.
 */
export async function latestSessionForCwd(cwd, { limit = RESUME_SCAN_LIMIT } = {}) {
  const listed = await listSessions();
  const bounded = limit > 0 ? listed.slice(0, limit) : listed;
  for (const item of bounded) {
    const loaded = await loadSession(item.name);
    const sessionCwd = loaded?.meta?.cwd;
    if (typeof sessionCwd === "string" && withinFolder(sessionCwd, cwd)) return item.name;
  }
  return null;
}

/** Default session name when none is forced or named: the newest session for
 *  `cwd`, or a fresh name when nothing relates to it (so an unrelated folder's
 *  session is never auto-resumed). */
export async function defaultSessionName(cwd) {
  return (await latestSessionForCwd(cwd)) ?? newSessionName();
}

