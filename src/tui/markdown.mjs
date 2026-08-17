/**
 * Markdown rendering for the transcript (GFM subset: headings, lists, fenced
 * code, blockquotes, horizontal rules, tables, and the inline styles bold /
 * italic / strikethrough / code / links).
 *
 * Streaming-tolerant by design: unclosed markers render as literal text so
 * half-arrived output doesn't flicker between styled and plain, and a table
 * only appears once its delimiter row has arrived. Pure functions over
 * strings — no terminal or controller state.
 */
import {
  styleText,
  stripAnsi,
  dispWidth,
  charWidth,
  wrap,
} from "./renderers.mjs";
import { theme } from "../theme.mjs";
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
/** Render a single run of plain text with a base style, wrapped to width. */
export function renderSimple(text, base, width) {
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

