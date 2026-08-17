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
 * Compact token summary, e.g. "↑1.6K ↓120". `↑` = prompt (input) tokens,
 * `↓` = completion (output) tokens; reasoning and cached tokens appear only
 * when the provider reported them.
 */
export function formatTokens(u) {
  if (!u || !Number.isFinite(u.total_tokens)) return null;
  const parts = [`↑${formatChars(u.prompt_tokens)}`, `↓${formatChars(u.completion_tokens)}`];
  if (u.reasoning_tokens > 0) parts.push(`✶${formatChars(u.reasoning_tokens)}`);
  if (u.cached_tokens > 0) parts.push(`≡${formatChars(u.cached_tokens)}`);
  return parts.join(" ");
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

/**
 * Terminal display column width of a single code point:
 * 0 for combining/format marks (accents, variation selectors, ZWJ, skin-tone
 *   modifiers, bidi controls, ...),
 * 2 for East Asian wide characters and presentation-width emoji,
 * 1 otherwise (halfwidth forms, regional indicators, ASCII, ...).
 *
 * This is what keeps table borders aligned: a CJK char or an emoji takes two
 * terminal columns, while ZWJ/VS16/skin-tone joiners take none.
 */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  return isZeroWidthCp(cp) ? 0 : isWideCp(cp) ? 2 : 1;
}

/** Zero-width code points: never occupy a terminal column. */
function isZeroWidthCp(cp) {
  return (
    /[\p{Mn}\p{Me}\p{Cf}]/u.test(String.fromCodePoint(cp)) ||
    (0x1160 <= cp && cp <= 0x11ff) || // Hangul Jungseong/Jongseong jamo (compose)
    (0x1f3fb <= cp && cp <= 0x1f3ff) // emoji skin tone modifiers
  );
}

/** Code points rendered two columns wide (East Asian wide + emoji). */
function isWideCp(cp) {
  return (
    (0x1100 <= cp && cp <= 0x115f) || // Hangul Jamo init. consonants
    cp === 0x2329 || cp === 0x232a || // CJK angle brackets
    (0x2e80 <= cp && cp <= 0x303e) || // CJK Radicals .. CJK Symbols
    (0x3041 <= cp && cp <= 0x33ff) || // Hiragana .. CJK Compatibility
    (0x3400 <= cp && cp <= 0x4dbf) || // CJK Ext A
    (0x4e00 <= cp && cp <= 0x9fff) || // CJK Unified Ideographs
    (0xa000 <= cp && cp <= 0xa4cf) || // Yi Syllables
    (0xac00 <= cp && cp <= 0xd7a3) || // Hangul Syllables
    (0xf900 <= cp && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (0xfe10 <= cp && cp <= 0xfe19) || // Vertical Forms
    (0xfe30 <= cp && cp <= 0xfe6f) || // CJK Compatibility Forms
    (0xff00 <= cp && cp <= 0xff60) || // Fullwidth Forms
    (0xffe0 <= cp && cp <= 0xffe6) || // Fullwidth Signs
    (0x20000 <= cp && cp <= 0x2fffd) || // CJK Ext B+
    (0x30000 <= cp && cp <= 0x3fffd) || // CJK Ext G+
    isBmpEmojiCp(cp) ||
    isAstralEmojiCp(cp)
  );
}

/** BMP emoji that render wide even without VS16. */
function isBmpEmojiCp(cp) {
  return (
    cp === 0x231a || cp === 0x231b || // watch, hourglass
    (0x23e9 <= cp && cp <= 0x23ec) || // fast-forward/rewind arrows
    cp === 0x23f0 || cp === 0x23f3 || // alarm clock, hourglass done
    (0x25fd <= cp && cp <= 0x25fe) || // ◽ ◾
    (0x2614 <= cp && cp <= 0x2615) || // umbrella with rain, hot beverage
    (0x2648 <= cp && cp <= 0x2653) || // zodiac signs
    cp === 0x267f || // wheelchair symbol
    cp === 0x2693 || // anchor
    cp === 0x26a1 || // high voltage
    (0x26aa <= cp && cp <= 0x26ab) || // ⚪ ⚫
    (0x26bd <= cp && cp <= 0x26be) || // soccer, baseball
    (0x26c4 <= cp && cp <= 0x26c5) || // snowman, sun behind cloud
    cp === 0x26ce || cp === 0x26d4 || // ophiuchus, no entry
    cp === 0x26ea || // church
    (0x26f2 <= cp && cp <= 0x26f3) || // fountain, flag in hole
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || // sailboat, tent, fuel pump
    cp === 0x2705 || // white heavy check mark
    (0x270a <= cp && cp <= 0x270b) || // raised fist, raised hand
    cp === 0x2728 || // sparkles
    cp === 0x274c || cp === 0x274e || // cross mark, cross button
    (0x2753 <= cp && cp <= 0x2755) || // question/ exclamation marks
    cp === 0x2757 || // heavy exclamation mark
    (0x2795 <= cp && cp <= 0x2797) || // heavy plus/minus/division
    cp === 0x27b0 || cp === 0x27bf // curly loop, double curly loop
  );
}

/** Astral-plane emoji (U+1F000+). Skin tones are zero-width, checked first. */
function isAstralEmojiCp(cp) {
  return (
    cp === 0x1f004 || // mahjong red dragon
    cp === 0x1f0cf || // joker
    cp === 0x1f18e || // AB button
    (0x1f191 <= cp && cp <= 0x1f19a) || // squared Latin letters
    (0x1f200 <= cp && cp <= 0x1f320) || // squared CJK .. shooting star
    (0x1f32d <= cp && cp <= 0x1f335) || // hot dog .. cactus
    (0x1f337 <= cp && cp <= 0x1f37c) || // tulip .. baby bottle
    (0x1f37e <= cp && cp <= 0x1f393) || // champagne .. graduation cap
    (0x1f3a0 <= cp && cp <= 0x1f3ca) || // carousel .. swimmer
    (0x1f3cf <= cp && cp <= 0x1f3d3) || // cricket .. ping pong
    (0x1f3e0 <= cp && cp <= 0x1f3f0) || // houses .. castle
    cp === 0x1f3f4 || // black flag
    (0x1f3f8 <= cp && cp <= 0x1f43e) || // badminton .. paw prints
    cp === 0x1f440 || // eyes
    (0x1f442 <= cp && cp <= 0x1f4fc) || // ear .. videocassette
    (0x1f4ff <= cp && cp <= 0x1f53d) || // prayer beads .. down button
    (0x1f54b <= cp && cp <= 0x1f54e) || // kaaba .. menorah
    (0x1f550 <= cp && cp <= 0x1f567) || // clocks
    cp === 0x1f57a || // man dancing
    (0x1f595 <= cp && cp <= 0x1f596) || // middle finger, vulcan salute
    cp === 0x1f5a4 || // black heart
    (0x1f5fb <= cp && cp <= 0x1f64f) || // mount fuji .. person with folded hands
    (0x1f680 <= cp && cp <= 0x1f6c5) || // rocket .. left luggage
    cp === 0x1f6cc || // person in bed
    (0x1f6d0 <= cp && cp <= 0x1f6d2) || // synagogue, mosque, hindu temple
    (0x1f6d5 <= cp && cp <= 0x1f6d7) || // hut .. elevator
    (0x1f6eb <= cp && cp <= 0x1f6ec) || // airplane departure/arrival
    (0x1f6f4 <= cp && cp <= 0x1f6fc) || // scooter .. roller skate
    (0x1f7e0 <= cp && cp <= 0x1f7eb) || // colored circles/squares
    cp === 0x1f7f0 || // heavy equals sign
    (0x1f90c <= cp && cp <= 0x1f93a) || // pinched fingers .. fencer
    (0x1f93c <= cp && cp <= 0x1f945) || // wrestlers .. goal net
    (0x1f947 <= cp && cp <= 0x1f9ff) || // medals .. nazar amulet
    (0x1fa70 <= cp && cp <= 0x1fa7c) || // ballet shoes .. crutch
    (0x1fa80 <= cp && cp <= 0x1fa88) || // yo-yo .. flute
    (0x1fa90 <= cp && cp <= 0x1fabe) || // ringed planet .. labrador
    (0x1fabf <= cp && cp <= 0x1fac5) || // mouse .. pregnant person
    cp === 0x1face || // moose
    (0x1fae0 <= cp && cp <= 0x1fae8) || // melting face .. shaking face
    (0x1faf0 <= cp && cp <= 0x1faf8) // handshake .. heart hands
  );
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

// ---------------------------------------------------------------------------
// Markdown tables
// ---------------------------------------------------------------------------

/*
 * GFM-style tables are rendered as aligned box-drawing tables. Like the rest
 * of the parser this is streaming-tolerant: a table only appears once its
 * delimiter row has arrived, and any line that doesn't fit the strict shape is
 * rendered as ordinary text instead.
 *
 * A table is: a header row containing `|`, immediately followed by a delimiter
 * row (`| --- | :---: |` etc.), then zero or more `|`-separated body rows.
 * Leading/trailing pipes on each row are optional; `\|` escapes a literal pipe.
 */

const TABLE_MAX_WORD_WIDTH = 30; // cap for unbroken words inside cells

function isTableDelimiter(line) {
  const t = line.trim();
  return t.includes("|") && t.includes("-") && /^\|?[\s:|-]+\|?$/.test(t);
}

function isTableRow(line) {
  return line.trim().includes("|");
}

function splitTableRow(line) {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableAlignments(delimiter) {
  return splitTableRow(delimiter).map((seg) => {
    const left = seg.startsWith(":");
    const right = seg.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

function longestWordWidth(text) {
  let max = 0;
  for (const word of text.split(/\s+/)) max = Math.max(max, dispWidth(word));
  return max;
}

/**
 * Width per column. Returns null when the terminal is too narrow to keep even
 * the longest word of each column on its own line.
 */
function tableColumnWidths(cellsByColumn, width) {
  const numCols = cellsByColumn.length;
  const borderOverhead = 3 * numCols + 1;
  const available = width - borderOverhead;
  if (available < numCols) return null;

  const natural = cellsByColumn.map((col) =>
    Math.max(1, ...col.map((cell) => dispWidth(cell)))
  );
  const min = cellsByColumn.map((col) =>
    Math.max(1, ...col.map((cell) => Math.min(TABLE_MAX_WORD_WIDTH, longestWordWidth(cell))))
  );
  const minTotal = min.reduce((a, b) => a + b, 0);
  if (minTotal > available) return null;

  if (natural.reduce((a, b) => a + b, 0) <= available) return natural;

  const growPotential = natural.map((n, i) => Math.max(0, n - min[i]));
  const growTotal = growPotential.reduce((a, b) => a + b, 0);
  const extra = available - minTotal;
  const widths = min.map((w, i) =>
    growTotal > 0 ? w + Math.floor((growPotential[i] / growTotal) * extra) : w
  );
  if (growTotal > 0) {
    const allocated = widths.reduce((a, b) => a + b, 0);
    let leftover = available - allocated;
    let i = 0;
    while (leftover > 0 && i < numCols * (extra + 1)) {
      const idx = i % numCols;
      if (growPotential[idx] > 0 && widths[idx] < natural[idx]) {
        widths[idx]++;
        leftover--;
      }
      i++;
    }
  }
  return widths;
}

/** Pad each wrapped cell line to `width`, honouring `align` (left/center/right). */
function padCellLines(lines, width, align) {
  return lines.map((line) => {
    const extra = Math.max(0, width - dispWidth(stripAnsi(line)));
    if (extra === 0) return line;
    if (align === "right") return " ".repeat(extra) + line;
    if (align === "center") {
      const left = Math.floor(extra / 2);
      return " ".repeat(left) + line + " ".repeat(extra - left);
    }
    return line + " ".repeat(extra);
  });
}

/** Render one table row (header or body); cells wrap to multiple lines. */
function renderTableRow(cells, widths, aligns, bold) {
  const style = { fg: theme.text, ...(bold ? { bold: true } : {}) };
  const wrapped = cells.map((cell, i) =>
    padCellLines(wrapSegments(segsFromInline(cell, style), Math.max(1, widths[i])), widths[i], aligns[i])
  );
  const height = Math.max(1, ...wrapped.map((w) => w.length));
  const out = [];
  for (let r = 0; r < height; r++) {
    out.push(`│ ${wrapped.map((lines, i) => lines[r] ?? " ".repeat(widths[i])).join(" │ ")} │`);
  }
  return out;
}

function tableBorder(widths, left, mid, right) {
  return left + widths.map((w) => "─".repeat(w)).join(mid) + right;
}

/**
 * Render a scanned table, or return null when the terminal is too narrow to do
 * it justice (the caller then falls back to plain lines).
 */
function renderTable(table, width) {
  const numCols = table.header.length;
  const cellsByColumn = [];
  for (let c = 0; c < numCols; c++) {
    cellsByColumn.push([table.header[c], ...table.rows.map((row) => row[c] ?? "")]);
  }
  const widths = tableColumnWidths(cellsByColumn, width);
  if (!widths) return null;
  const aligns = Array.from({ length: numCols }, (_, i) => table.alignments[i] ?? "left");

  const out = [];
  out.push(tableBorder(widths, "┌─", "─┬─", "─┐"));
  out.push(...renderTableRow(table.header, widths, aligns, true));
  out.push(tableBorder(widths, "├─", "─┼─", "─┤"));
  table.rows.forEach((row, i) => {
    out.push(...renderTableRow(row, widths, aligns, false));
    if (i < table.rows.length - 1) out.push(tableBorder(widths, "├─", "─┼─", "─┤"));
  });
  out.push(tableBorder(widths, "└─", "─┴─", "─┘"));
  return out;
}

/** Scan a table starting at `start`, or null when the lines aren't a table. */
function scanTable(src, start) {
  if (
    start + 1 >= src.length ||
    !isTableRow(src[start]) ||
    !isTableDelimiter(src[start + 1])
  ) {
    return null;
  }
  const header = splitTableRow(src[start]);
  const alignments = tableAlignments(src[start + 1]);
  const rows = [];
  let i = start + 2;
  while (i < src.length && isTableRow(src[i])) {
    rows.push(splitTableRow(src[i]));
    i++;
  }
  return { end: i, header, alignments, rows };
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

    if (!fence) {
      const table = scanTable(src, i);
      if (table) {
        const rendered = renderTable(table, width);
        if (rendered) {
          lines.push(...rendered);
          i = table.end;
          continue;
        }
      }
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
