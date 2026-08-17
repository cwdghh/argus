/**
 * Bounds for the read tool: never return an unbounded file into the context
 * window. Both a line cap and a byte cap apply — whichever hits first — and
 * truncateRead reports what the caller saw so the model can continue with
 * offset/limit paging.
 */

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024; // 50KB

export function formatBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}

/**
 * Truncate text from the head, never splitting a line. Returns the output plus
 * enough metadata for the read tool to print a precise continuation notice.
 */
export function truncateRead(text, maxLines = READ_MAX_LINES, maxBytes = READ_MAX_BYTES) {
  const lines = text === "" ? [] : text.split("\n");
  const totalBytes = Buffer.byteLength(text, "utf8");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { output: text, lines, truncated: false, outputLines: totalLines, firstLineExceedsLimit: false };
  }
  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf8");
  if (firstLineBytes > maxBytes) {
    return { output: "", lines: [], truncated: true, outputLines: 0, firstLineExceedsLimit: true };
  }
  const out = [];
  let bytes = 0;
  let truncatedBy = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf8") + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    out.push(lines[i]);
    bytes += lineBytes;
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";
  return {
    output: out.join("\n"),
    lines: out,
    truncated: out.length < totalLines,
    outputLines: out.length,
    firstLineExceedsLimit: false,
    truncatedBy,
  };
}

