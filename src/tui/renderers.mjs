/**
 * Pure rendering utilities for the TUI.
 *
 * This module contains all text formatting, ANSI styling, markdown parsing,
 * and block rendering logic. It has zero coupling to the TUI class itself —
 * just pure functions operating on strings and theme objects.
 */
import { theme } from "../theme.mjs";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

// ---------------------------------------------------------------------------
// ANSI + text helpers
// ---------------------------------------------------------------------------

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function styleText(text, { fg, bold, dim, italic, underline, strike } = {}) {
  // Never let model/tool/file content inject terminal control sequences.
  text = String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const codes = [];
  if (fg) codes.push(`38;2;${rgb(fg).join(";")}`);
  if (bold) codes.push("1");
  if (dim) codes.push("2");
  if (italic) codes.push("3");
  if (underline) codes.push("4");
  if (strike) codes.push("9");
  if (!codes.length) return text;
  return `${ESC}[${codes.join(";")}m${text}${RESET}`;
}

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function wrap(text, width) {
  width = Math.max(1, width);
  const out = [];
  let line = "";
  let columns = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (line && columns + cw > width) {
      out.push(line);
      line = "";
      columns = 0;
    }
    line += ch;
    columns += cw;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

export function previousCharIndex(text, index) {
  if (index <= 0) return 0;
  const cp = text.codePointAt(index - 1);
  return index - (cp >= 0xdc00 && cp <= 0xdfff ? 2 : 1);
}

export function nextCharIndex(text, index) {
  if (index >= text.length) return text.length;
  const cp = text.codePointAt(index);
  return index + (cp > 0xffff ? 2 : 1);
}

export function previousWordIndex(text, index) {
  let i = index;
  while (i > 0 && /\s/.test(text.slice(previousCharIndex(text, i), i))) i = previousCharIndex(text, i);
  while (i > 0 && !/\s/.test(text.slice(previousCharIndex(text, i), i))) i = previousCharIndex(text, i);
  return i;
}

export function truncateMiddle(text, max) {
  if (max <= 0) return "";
  if (dispWidth(text) <= max) return text;
  if (max === 1) return "…";

  const chars = [...text];
  const leftBudget = Math.ceil((max - 1) / 2);
  const rightBudget = Math.floor((max - 1) / 2);
  let left = "";
  let leftWidth = 0;
  for (const ch of chars) {
    const width = charWidth(ch);
    if (leftWidth + width > leftBudget) break;
    left += ch;
    leftWidth += width;
  }
  let right = "";
  let rightWidth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const width = charWidth(chars[i]);
    if (rightWidth + width > rightBudget) break;
    right = chars[i] + right;
    rightWidth += width;
  }
  return `${left}…${right}`;
}

export function truncateEnd(text, max) {
  if (max <= 0) return "";
  if (dispWidth(text) <= max) return text;
  if (max === 1) return "…";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const charColumns = charWidth(ch);
    if (width + charColumns > max - 1) break;
    out += ch;
    width += charColumns;
  }
  return `${out}…`;
}

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
 * Compact token summary, e.g. "↑1.6K ↓120 tok". `↑` = prompt (input) tokens,
 * `↓` = completion (output) tokens; reasoning and cached tokens appear only
 * when the provider reported them.
 */
export function formatTokens(u) {
  if (!u || !Number.isFinite(u.total_tokens)) return null;
  const parts = [`↑${formatChars(u.prompt_tokens)}`, `↓${formatChars(u.completion_tokens)}`];
  if (u.reasoning_tokens > 0) parts.push(`✶${formatChars(u.reasoning_tokens)}`);
  if (u.cached_tokens > 0) parts.push(`≡${formatChars(u.cached_tokens)}`);
  return parts.join(" ") + " tok";
}

export function summarize(result) {
  if (!result) return "";
  if (result.error) return result.message ?? "error";
  if (result.stdout != null) {
    const first = String(result.stdout).trim().split("\n")[0];
    return first ? `stdout: ${first.slice(0, 80)}${first.length > 80 ? "…" : ""}` : "ok (no output)";
  }
  if (result.content != null) {
    const c = String(result.content).trim();
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

function formatArgs(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// ---------------------------------------------------------------------------
// Markdown: inline tokenisation (streaming-tolerant, nested)
// ---------------------------------------------------------------------------

/**
 * Parse inline markdown into a token tree. Unclosed markers are treated as
 * literal text so streaming output doesn't flicker between styled/plain.
 * Supports: backtick code, **bold**, *italic*, ~~strikethrough~~, [text](url),
 * and backslash escapes — with nesting (e.g. bold containing code).
 */
function parseInlineTokens(text) {
  const tokens = [];
  let plain = "";
  let i = 0;
  const flushPlain = () => {
    if (plain) {
      tokens.push({ type: "text", text: plain });
      plain = "";
    }
  };

  const findCloser = (marker) => text.indexOf(marker, i + marker.length);

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const closer = findCloser("`");
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "code", text: text.slice(i + 1, closer) });
        i = closer + 1;
      } else {
        plain += ch;
        i++;
      }
      continue;
    }
    if (text.startsWith("**", i)) {
      const closer = text.indexOf("**", i + 2);
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "strong", children: parseInlineTokens(text.slice(i + 2, closer)) });
        i = closer + 2;
      } else {
        plain += text.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (text.startsWith("~~", i)) {
      const closer = text.indexOf("~~", i + 2);
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "del", children: parseInlineTokens(text.slice(i + 2, closer)) });
        i = closer + 2;
      } else {
        plain += text.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        if (end !== -1) {
          flushPlain();
          tokens.push({
            type: "link",
            children: parseInlineTokens(text.slice(i + 1, close)),
            href: text.slice(close + 2, end),
          });
          i = end + 1;
          continue;
        }
      }
      plain += ch;
      i++;
      continue;
    }
    if (ch === "*" || ch === "_") {
      const closer = text.indexOf(ch, i + 1);
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "em", children: parseInlineTokens(text.slice(i + 1, closer)) });
        i = closer + 1;
      } else {
        plain += ch;
        i++;
      }
      continue;
    }
    plain += ch;
    i++;
  }
  flushPlain();
  return tokens;
}

function plainOf(tokens) {
  let s = "";
  for (const t of tokens) {
    if (t.type === "text") s += t.text;
    else if (t.type === "code") s += t.text;
    else if (t.children) s += plainOf(t.children);
  }
  return s;
}

/** Flatten an inline token tree into styled text segments. */
function segsFromInline(text, base) {
  const out = [];
  const render = (tok, style) => {
    if (tok.type === "text") {
      out.push({ text: tok.text, style });
      return;
    }
    if (tok.type === "code") {
      out.push({ text: tok.text, style: { ...base, fg: theme.code } });
      return;
    }
    if (tok.type === "link") {
      for (const c of tok.children) render(c, { ...style, underline: true });
      const textPlain = plainOf(tok.children);
      if (tok.href && tok.href !== textPlain) {
        out.push({ text: ` (${tok.href})`, style: { ...base, fg: theme.dim } });
      }
      return;
    }
    const childStyle =
      tok.type === "strong"
        ? { ...style, bold: true }
        : tok.type === "em"
          ? { ...style, italic: true }
          : { ...style, strike: true };
    for (const c of tok.children) render(c, childStyle);
  };
  for (const t of parseInlineTokens(text)) render(t, base);
  return out;
}

/** Approximate terminal column width of one char (East Asian wide = 2). */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo init. consonants
      cp === 0x2329 || cp === 0x232a || // angle brackets
      (0x2e80 <= cp && cp <= 0xa4cf && cp !== 0x303f) || // CJK ... Yi
      (0xac00 <= cp && cp <= 0xd7a3) || // Hangul Syllables
      (0xf900 <= cp && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (0xfe10 <= cp && cp <= 0xfe19) || // Vertical forms
      (0xfe30 <= cp && cp <= 0xfe6f) || // CJK Compatibility Forms
      (0xff00 <= cp && cp <= 0xff60) || // Fullwidth Forms
      (0xffe0 <= cp && cp <= 0xffe6) || // Fullwidth Signs
      (0x1f300 <= cp && cp <= 0x1f64f) || // Emoji
      (0x1f900 <= cp && cp <= 0x1f9ff) || // Supplemental Emoji
      (0x20000 <= cp && cp <= 0x2fffd) || // CJK Ext B
      (0x30000 <= cp && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

/** Approximate terminal display width of a string. */
export function dispWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Wrap styled segments into lines of `width` visible columns. */
function wrapSegments(segs, width) {
  const max = Math.max(1, width);
  const lines = [];
  let cur = [];
  let len = 0;
  for (const seg of segs) {
    let rest = seg.text;
    while (rest.length > 0) {
      if (len >= max) {
        lines.push(cur);
        cur = [];
        len = 0;
      }
      let take = 0;
      let tw = 0;
      for (const ch of rest) {
        const cw = charWidth(ch);
        if (len + tw + cw > max) break;
        tw += cw;
        take += ch.length;
      }
      if (take === 0) {
        take = rest[0].length;
        tw = charWidth(rest.slice(0, take));
      }
      cur.push({ text: rest.slice(0, take), style: seg.style });
      len += tw;
      rest = rest.slice(take);
    }
  }
  if (cur.length || lines.length === 0) lines.push(cur);
  return lines.map((ls) => ls.map((s) => styleText(s.text, s.style)).join(""));
}

/** Render a single run of plain text with a base style, wrapped to width. */
function renderSimple(text, base, width) {
  return wrapSegments(segsFromInline(text, base), width);
}

/** Render markdown (block-level) to wrapped, styled lines. */
export function markdownLines(text, width) {
  const lines = [];
  const src = text.split("\n");
  let i = 0;
  let fence = false;
  let fenceLang = "";
  while (i < src.length) {
    const raw = src[i];
    const trimmed = raw.trim();

    if (!fence && /^```/.test(trimmed)) {
      fence = true;
      fenceLang = trimmed.slice(3).trim();
      lines.push(styleText(`  ${"```"}${fenceLang}`, { fg: theme.dim }));
      i++;
      continue;
    }
    if (fence) {
      if (/^```/.test(trimmed)) {
        fence = false;
        lines.push(styleText("  ```", { fg: theme.dim }));
        i++;
        continue;
      }
      for (const piece of wrap(raw, Math.max(1, width - 2))) lines.push(styleText(`  ${piece}`, { fg: theme.code }));
      i++;
      continue;
    }
    if (trimmed === "") {
      lines.push("");
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      lines.push(...renderSimple(heading[2], { fg: theme.heading, bold: true }, width));
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      lines.push(styleText("─".repeat(Math.min(28, width)), { fg: theme.dim }));
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      lines.push(...renderSimple(trimmed.replace(/^>\s?/, ""), { fg: theme.dim, italic: true }, width));
      i++;
      continue;
    }

    const list = trimmed.match(/^([-*+]|\d+\.)\s+(.*)/);
    if (list) {
      const prefix = `${list[1]} `;
      const contentWidth = Math.max(1, width - prefix.length);
      const wrapped = wrapSegments(segsFromInline(list[2], { fg: theme.text }), contentWidth);
      wrapped.forEach((ln, idx) => {
        lines.push((idx === 0 ? prefix : " ".repeat(prefix.length)) + ln);
      });
      i++;
      continue;
    }

        // Preserve the model's newlines as hard line breaks (chat rendering),
    // so single newlines in output stay as separate lines.
    lines.push(...renderSimple(raw.trim(), { fg: theme.text }, width));
    i++;
  }
  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------
// Block -> display lines
// ---------------------------------------------------------------------------

export function blockLines(block, width) {
  switch (block.kind) {
    case "user": {
      const out = [];
      block.text.split("\n").forEach((l, idx) => {
        out.push(...renderSimple(`${idx === 0 ? "❯ " : "  "}${l}`, { fg: theme.user, bold: true }, width));
      });
      return out;
    }
    case "thinking": {
      const out = [];
      const contentWidth = Math.max(1, width - 2);
      for (const l of block.text.split("\n")) {
        const t = l.trim();
        if (!t) continue;
        const pieces = renderSimple(t, { fg: theme.think, italic: true }, contentWidth);
        pieces.forEach((ln, idx) => {
          out.push(styleText("│", { fg: theme.think }) + " " + ln);
        });
      }
      return out;
    }
    case "assistant":
      return markdownLines(block.text, width);
    case "tool": {
      const contentWidth = Math.max(1, width - 4);
      const pieces = renderSimple(`⚙ ${block.name}(${formatArgs(block.args)})`, { fg: theme.tool, bold: true }, contentWidth);
      return pieces.map((ln, idx) => styleText("│", { fg: theme.tool, bold: true }) + " " + ln);
    }
    case "result": {
      const timing = block.durationMs == null ? "" : `${formatDuration(block.durationMs)} · `;
      const prefix = block.summary === "interrupted" ? "" : `${block.ok ? "✓" : "✗"} `;
      const contentWidth = Math.max(1, width - 4);
      const pieces = renderSimple(`${prefix}${timing}${block.summary}`, {
        fg: block.ok ? theme.good : theme.bad,
        bold: true,
      }, contentWidth);
      return pieces.map((ln, idx) => styleText("│", { fg: block.ok ? theme.good : theme.bad, bold: true }) + " " + ln);
    }
    case "timing": {
      const usage = formatTokens(block.usage);
      return renderSimple(`  ◷ ${block.summary}${usage ? ` · ${usage}` : ''}`, { fg: theme.dim, dim: true }, width);
    }
    case "error":
      return renderSimple(`error: ${block.text}`, { fg: theme.bad }, width);
    default:
      return [];
  }
}
