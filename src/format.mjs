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
 * `↓` = completion (output) tokens; reasoning and cached tokens appear only
 * when the provider reported them.
 */
export function formatTokens(u) {
  if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) return null;
  const parts = [`↑${formatChars(u.prompt_tokens)}`, `↓${formatChars(u.completion_tokens)}`];
  if (u.reasoning_tokens > 0) parts.push(`✶${formatChars(u.reasoning_tokens)}`);
  if (u.cached_tokens > 0) parts.push(`≡${formatChars(u.cached_tokens)}`);
  return parts.join(" ");
}

/**
 * One-line summary of a tool result for transcript blocks and stderr logs.
 * Prefers the most informative field (stdout first line, read text first
 * line), falls back to the `ok` payload, and never throws on weird values.
 */
export function summarize(result) {
  if (!result) return "";
  if (result.error) return result.message ?? "error";
  if (result.stdout != null) {
    const first = String(result.stdout).trim().split("\n")[0];
    return first ? `stdout: ${first.slice(0, 80)}${first.length > 80 ? "…" : ""}` : "ok (no output)";
  }
  const readText = result.numberedText ?? result.content;
  if (readText != null) {
    const c = String(readText).trim();
    return c ? `${c.split("\n")[0].slice(0, 80)}${c.length > 80 ? "…" : ""}` : "ok";
  }
  if (result.ok) {
    const extra = Object.entries(result)
      .filter(([k]) => k !== "ok")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return extra ? `${extra} — ok` : "ok";
  }
  return JSON.stringify(result).slice(0, 80);
}
