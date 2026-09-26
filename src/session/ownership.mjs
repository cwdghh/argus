/** Conservative single-writer ownership for one local session file. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, rm } from "node:fs/promises";

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function createLock(path, identity) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(identity) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverDeadOwner(path, observed) {
  const guardPath = `${path}.recover`;
  const guard = await open(guardPath, "wx", 0o600);
  try {
    await guard.writeFile(`${process.pid}\n`, "utf8");
    await guard.sync();
    const current = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== observed) return;
    const owner = JSON.parse(current);
    if (owner.host !== hostname() || processIsAlive(owner.pid)) return;
    await rm(path);
  } finally {
    await guard.close();
    await rm(guardPath, { force: true });
  }
}

export async function acquireSessionOwnership(file) {
  const path = `${file}.lock`;
  const identity = { pid: process.pid, host: hostname(), token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await createLock(path, identity);
      return async () => {
        const current = await readFile(path, "utf8").catch(() => null);
        if (current && JSON.parse(current).token === identity.token) await rm(path);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let observed;
      try { observed = await readFile(path, "utf8"); }
      catch { throw new Error("session ownership is being established; retry after it settles"); }
      let owner;
      try { owner = JSON.parse(observed); }
      catch { throw new Error("session ownership record is incomplete; inspect it before recovery"); }
      if (owner.host !== hostname() || processIsAlive(owner.pid)) {
        throw new Error(`session is owned by another process (pid ${owner.pid ?? "unknown"})`);
      }
      try { await recoverDeadOwner(path, observed); }
      catch (recoveryError) {
        if (recoveryError.code === "EEXIST") throw new Error("session ownership recovery is in progress");
        throw recoveryError;
      }
    }
  }
  throw new Error("session ownership changed during recovery; retry");
}
