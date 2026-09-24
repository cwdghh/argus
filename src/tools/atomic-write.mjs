/** Complete-file replacement with exclusive creation and preserved file modes. */
import { chmod, link, lstat, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function atomicWriteFile(file, data, { noOverwrite = false } = {}) {
  let target = file;
  let mode;
  if (!noOverwrite) {
    try {
      // Editing through a symlink must update its target, preserving the link.
      const info = await lstat(file);
      if (info.isSymbolicLink()) target = await realpath(file);
      mode = (await stat(target)).mode & 0o777;
    } catch (err) {
      // A dangling symlink cannot be resolved safely; leave it intact.
      if (err.code !== "ENOENT" || (await isSymlink(file))) throw err;
    }
  }

  const temporary = join(dirname(target), `.argus-tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, data, { encoding: "utf8", flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) await chmod(temporary, mode);
    if (noOverwrite) {
      try {
        // Unlike an existence probe followed by rename, link cannot replace a
        // destination created by another writer between those two operations.
        await link(temporary, target);
      } catch (err) {
        if (err.code === "EEXIST") return { skipped: true };
        throw err;
      }
    } else {
      await rename(temporary, target);
    }
    return {};
  } finally {
    await rm(temporary, { force: true });
  }
}

async function isSymlink(file) {
  try {
    return (await lstat(file)).isSymbolicLink();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
