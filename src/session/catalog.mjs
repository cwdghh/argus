/** Saved-session discovery and explicit housekeeping operations. */
import { readdir, stat, rm, access, rename, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { contextDir, ensureDir, nameError, sanitizeName, sessionFilePath, sessionsDir } from "./paths.mjs";
import { loadSession, scanSessionMeta } from "./reader.mjs";
import { acquireSessionOwnership } from "./ownership.mjs";

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
  const removed = await Promise.all(doomed.map(async (file) => {
    let release;
    try {
      release = await acquireSessionOwnership(file);
      const metadata = await scanSessionMeta(basename(file, ".jsonl"));
      await rm(file, { force: true });
      if (metadata.sessionId) await rm(contextDir(metadata.sessionId), { recursive: true, force: true });
      return true;
    } catch {
      return false; // active owner or unreadable/racing file: leave it alone
    } finally {
      if (release) await release();
    }
  }));
  return removed.filter(Boolean).length;
}

/** Delete one saved session by exact name, never the explicitly excluded one. */
export async function deleteSession(name, { exclude } = {}) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(nameError(name) ?? `invalid session name: ${name}`);
  if (safe === exclude) throw new Error(`cannot delete the active session: ${safe}`);
  const release = await acquireSessionOwnership(sessionFilePath(safe));
  try {
    const metadata = await scanSessionMeta(safe);
    await rm(sessionFilePath(safe));
    if (metadata.sessionId) await rm(contextDir(metadata.sessionId), { recursive: true, force: true });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`session not found: ${safe}`);
    throw err;
  } finally {
    await release();
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
  if (handle?.activeRun) throw new Error("cannot rename a session while a run is active");

  await ensureDir();
  const oldFile = sessionFilePath(oldName);
  const nextFile = sessionFilePath(safe);
  const release = await acquireSessionOwnership(oldFile);
  try {
    return await moveSession(oldFile, nextFile, safe, handle);
  } finally {
    await release();
  }
}

async function moveSession(oldFile, nextFile, safe, handle) {
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
