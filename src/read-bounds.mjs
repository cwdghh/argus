/**
 * Bounds for the read tool: never return an unbounded file into the context
 * window. Both a line cap and a byte cap apply — whichever hits first — and
 * the scan reports what the caller saw so the model can continue with
 * offset/limit paging.
 */
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024; // 50KB

export function formatBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}

/**
 * Scan a file with bounded memory, collecting only the requested line window.
 * The complete byte stream is hashed while scanning so range-edit freshness
 * can refer to the exact content the read observed without retaining the file.
 */
export async function readFileWindow(path, { offset = 1, limit, maxLines = READ_MAX_LINES, maxBytes = READ_MAX_BYTES } = {}) {
  const wantedLines = Math.min(limit ?? maxLines, maxLines);
  const lines = [];
  const hash = createHash("sha256");
  let totalLines = 0;
  let outputBytes = 0;
  let currentBytes = 0;
  let currentParts = [];
  let keepCurrent = false;
  let collectionStopped = false;
  let firstLineExceedsLimit = false;
  let firstLineBytes = 0;
  let oversizedCurrent = false;
  let sawBytes = false;
  let endsWithNewline = false;

  const beginLine = () => {
    const lineNumber = totalLines + 1;
    keepCurrent = !collectionStopped && lineNumber >= offset && lines.length < wantedLines;
    currentParts = [];
    currentBytes = 0;
  };

  const appendPart = (part) => {
    currentBytes += part.length;
    if (!keepCurrent) return;
    const separatorBytes = lines.length > 0 ? 1 : 0;
    if (outputBytes + separatorBytes + currentBytes > maxBytes) {
      if (lines.length === 0) {
        firstLineExceedsLimit = true;
        oversizedCurrent = true;
      }
      keepCurrent = false;
      collectionStopped = true;
      currentParts = [];
      return;
    }
    currentParts.push(part);
  };

  const finishLine = () => {
    totalLines++;
    if (keepCurrent) {
      const line = Buffer.concat(currentParts, currentBytes).toString("utf8");
      outputBytes += Buffer.byteLength(line, "utf8") + (lines.length > 0 ? 1 : 0);
      lines.push(line);
      if (lines.length >= wantedLines) collectionStopped = true;
    }
    if (oversizedCurrent) firstLineBytes = currentBytes;
    oversizedCurrent = false;
    beginLine();
  };

  beginLine();
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    sawBytes = true;
    hash.update(chunk);
    endsWithNewline = chunk[chunk.length - 1] === 0x0a;
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, from);
      if (newline === -1) {
        appendPart(chunk.subarray(from));
        break;
      }
      appendPart(chunk.subarray(from, newline));
      finishLine();
      from = newline + 1;
    }
  }
  if (sawBytes && !endsWithNewline) finishLine();

  return {
    lines,
    totalLines,
    endsWithNewline,
    firstLineExceedsLimit,
    firstLineBytes,
    hash: hash.digest("hex"),
    truncated: offset - 1 + lines.length < totalLines,
  };
}
