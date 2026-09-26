/**
 * Neutral value-formatting helpers shared by every frontend (the TUI, headless
 * mode, and anything that renders tool results or token usage).
 *
 * These live outside the TUI so a non-terminal frontend never has to reach
 * into the UI layer just to format a number. They are pure: string in,
 * string out, no state.
 */

/**
 * A compact human duration, e.g. "3.2s", "1m 05s", "2h 30m". Sub-100ms
 * durations render as "<0.1s" so live feedback never shows a bare "0s".
 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  if (seconds > 0 && seconds < 0.1) return "<0.1s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Format a count in human-readable form (e.g., "1.2K", "3.4M"). */
export function formatChars(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
}

/**
 * Compact token summary, e.g. "↑1.6K ↓120". `↑` = prompt (input) tokens,
 * `↓` = completion (output) tokens; `✚` = tokens newly written into a context
 * cache, `≡` = tokens served from the cache; reasoning appears only when the
 * provider reported it.
 */
export function formatTokens(u) {
  if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) return null;
  const parts = [`↑${formatChars(u.prompt_tokens)}`, `↓${formatChars(u.completion_tokens)}`];
  if (u.reasoning_tokens > 0) parts.push(`✶${formatChars(u.reasoning_tokens)}`);
  if (u.cache_creation_input_tokens > 0) parts.push(`✚${formatChars(u.cache_creation_input_tokens)}`);
  if (u.cached_tokens > 0) parts.push(`≡${formatChars(u.cached_tokens)}`);
  return parts.join(" ");
}

/**
 * One-line summary of a tool result for transcript blocks and stderr logs.
 * Prefers the most informative field (stdout first line, read text first
 * line), falls back to the `ok` payload, and never throws on weird values.
 *
 * When the result was paged or cut (`truncated` / `outputTruncated` / `nextOffset`), the line ends
 * with a ` … N more lines` marker so a truncated read or build log is never
 * mistaken for the whole story.
 */
export function summarize(result) {
  if (!result) return "";
  const suffix = truncationSuffix(result);
  if (result.error) return (result.message ?? "error") + suffix;
  if (result.stdout != null) {
    const first = String(result.stdout).trim().split("\n")[0];
    return (first ? `stdout: ${first.slice(0, 80)}${first.length > 80 ? "…" : ""}` : "ok (no output)") + suffix;
  }
  const readText = result.numberedText ?? result.content;
  if (readText != null) {
    const c = String(readText).trim();
    return (c ? `${c.split("\n")[0].slice(0, 80)}${c.length > 80 ? "…" : ""}` : "ok") + suffix;
  }
  if (result.ok) {
    const extra = Object.entries(result)
      .filter(([k]) => k !== "ok")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return extra ? `${extra} — ok` : "ok";
  }
  return JSON.stringify(result).slice(0, 80) + suffix;
}

/** "… N more lines" (or "… (truncated)") when a result was paged or cut. */
function truncationSuffix(result) {
  if (result.truncated !== true && result.outputTruncated !== true && result.nextOffset == null) return "";
  if (Number.isInteger(result.totalLines) && Number.isInteger(result.endLine)) {
    const remaining = result.totalLines - result.endLine;
    if (remaining > 0) return ` · … ${remaining} more line${remaining === 1 ? "" : "s"}`;
  }
  return " · … (truncated)";
}

/**
 * A short, frontend-neutral label for one tool call, so the TUI and headless
 * render identical tool lines. Names the primary object — the path for file
 * tools, the command for bash — and shows content-like payloads as char
 * counts instead of dumping them:
 *   toolLabel("write", { path: "src/a.mjs", content: "…" })
 *     -> "write → src/a.mjs (content 4.1K chars)"
 */
const TOOL_LABEL_MAX = 60;
const CONTENT_KEYS = ["content", "numberedText", "old", "new", "data", "output", "text"];

export function toolLabel(name, args = {}) {
  const parts = [name || "tool"];
  const file = args.file ?? args.path;
  const command = args.command;
  const primary = name === "bash" || name === "sh" ? command : file;
  if (typeof primary === "string" && primary.trim()) {
    const trimmed = primary.trim();
    parts.push(`→ ${trimmed.length > TOOL_LABEL_MAX ? `${trimmed.slice(0, TOOL_LABEL_MAX - 1)}…` : trimmed}`);
  }
  const contents = [];
  for (const key of CONTENT_KEYS) {
    if (typeof args[key] === "string" && args[key].length > 0) {
      contents.push(`${key} ${formatChars(args[key].length)} chars`);
    }
  }
  if (Array.isArray(args.edits) && args.edits.length > 0) contents.unshift(`edits ${args.edits.length}`);
  if (contents.length) parts.push(`(${contents.join(" · ")})`);
  return parts.join(" ");
}

/**
 * A multi-line preview of a tool result for the transcript, derived from the
 * fullest text field (stdout for bash, numberedText for reads) and capped at
 * ~20 lines / ~2KB, ending in a `… N more lines` marker when the result was
 * paged or cut. The read tool appends a continuation hint to numberedText;
 * previews strip it and derive the count from totalLines/startLine instead, so
 * paging is never reported twice. Failed shell output remains visible beneath
 * its error summary. Pure and renderer-neutral — the caller adds
 * the display rail.
 */
const PREVIEW_MAX_LINES = 20;
const PREVIEW_MAX_CHARS = 2_000;
const SHOWING_HINT = /\n?\[Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.\]\s*$/;

export function previewResult(result, { maxLines = PREVIEW_MAX_LINES, maxChars = PREVIEW_MAX_CHARS } = {}) {
  if (!result) return "";
  const errorOutput = result.error
    ? [
      result.stdout ? `stdout:\n${result.stdout}` : null,
      result.stderr ? `stderr:\n${result.stderr}` : null,
    ].filter(Boolean).join("\n")
    : null;
  if (result.error && !errorOutput) return result.message ? String(result.message) : "…";
  const source = errorOutput || pickNonEmpty(result.stdout, result.stderr, result.numberedText, result.content);
  if (source == null) {
    if (result.truncated === true && typeof result.preview === "string" && result.preview) {
      const where = result.fullPath ? `; full output at ${result.fullPath}` : "";
      return `… result exceeded the tool-result limit (${Number.isInteger(result.originalChars) ? formatChars(result.originalChars) : "?"} chars)${where}`;
    }
    return "";
  }
  const lines = String(source).replace(SHOWING_HINT, "").split("\n");
  const cut = Math.max(1, maxLines);
  const shown = lines.slice(0, cut);
  // Prefer the read tool's own paging metadata for the count (total minus the
  // last line the preview shows), so "… N more lines" reflects the whole file,
  // not just the window of the current call.
  let more = null;
  if (result.truncated === true || result.outputTruncated === true || result.nextOffset != null) {
    if (Number.isInteger(result.totalLines) && Number.isInteger(result.startLine)) {
      more = Math.max(0, result.totalLines + 1 - (result.startLine + shown.length));
    }
  }
  if (more == null && lines.length > cut) more = lines.length - cut;
  let out = shown.join("\n");
  if (more != null && more > 0) {
    out += `\n… ${more} more line${more === 1 ? "" : "s"}`;
  } else if (more == null && (result.truncated === true || result.outputTruncated === true || result.nextOffset != null)) {
    out += "\n… (truncated)";
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 8);
    const at = out.lastIndexOf("\n");
    out = (at > 0 ? out.slice(0, at) : out) + "\n…";
  }
  return out;
}

function pickNonEmpty(...values) {
  return values.find((value) => value != null && String(value).length > 0) ?? null;
}
