/** Private, paged source artifact for one deterministic context revision. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { sourceHash } from "../compact.mjs";
import { contextDir } from "./paths.mjs";

function linesFor(message) {
  const raw = JSON.stringify(message);
  const lines = [];
  for (let offset = 0; offset < raw.length; offset += 2_000) lines.push(raw.slice(offset, offset + 2_000));
  return lines.length ? lines : [""];
}

export async function writeContextArtifact(sessionId, revision, messages) {
  if (sourceHash(messages) !== revision.sourceHash || messages.length !== revision.coveredMessages) {
    throw new Error("context revision source does not match its recorded prefix");
  }
  const dir = contextDir(sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // A later revision contains the earlier prefix. Replace one indexed source
  // file atomically instead of retaining another full copy at every reduction.
  const file = join(dir, "source.txt");
  const sections = messages.map(linesFor);
  const header = [
    "# Argus context source (private session artifact)",
    `Source hash: ${revision.sourceHash}`,
    "Message index (read the numbered source range below):",
  ];
  let nextLine = header.length + sections.length + 2;
  for (let index = 0; index < sections.length; index++) {
    header.push(`Message ${index + 1}: line ${nextLine} (${messages[index].role})`);
    nextLine += sections[index].length + 2;
  }
  const content = [...header, ""];
  for (let index = 0; index < sections.length; index++) {
    content.push(`## Message ${index + 1} (${messages[index].role})`, ...sections[index], "");
  }
  const temporary = join(dir, `.context-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content.join("\n") + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  try {
    const directory = await open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* directory sync is unavailable on some filesystems */ }
  return file;
}
