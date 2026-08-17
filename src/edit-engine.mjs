/**
 * Pure text-edit engine for the edit tool.
 *
 * Exact matches first, then a normalised (trailing whitespace stripped,
 * quotes/dashes/spaces ASCII-folded, NFKC) fuzzy match. Fuzzy replacements
 * run in normalised space and are overlaid back onto the original content
 * line-by-line, so untouched lines keep their bytes. CRLF and a UTF-8 BOM
 * are preserved by the caller. Every replacement refers to the original
 * content and is applied bottom-up, so old strings and line numbers never
 * shift mid-batch.
 */

export function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text, ending) {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function detectLineEnding(text) {
  const crlf = text.indexOf("\r\n");
  const lf = text.indexOf("\n");
  if (lf === -1 || crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

export function normalizeForFuzzy(text) {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    // Tolerate `  87 | ` line-number gutters copied from a read result.
    .replace(/^\s*\d{1,6}\s*[|│]\s*/gm, "");
}

function collectMatches(content, needle) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = content.indexOf(needle, from);
    if (i === -1) return out;
    out.push(i);
    from = i + needle.length;
  }
}

function splitLinesWithEndings(content) {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function lineSpans(content) {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(lines, index, length) {
  const end = index + length;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (index >= lines[i].start && index < lines[i].end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) throw new Error("replacement is outside the file content");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < end) endLine++;
  if (endLine >= lines.length) throw new Error("replacement is outside the file content");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content, replacements) {
  let result = content;
  const sorted = [...replacements].sort((a, b) => a.index - b.index);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    result = result.slice(0, r.index) + r.new + result.slice(r.index + r.length);
  }
  return result;
}

/**
 * Apply replacements matched against the normalised `baseContent`, writing back
 * onto `originalContent` so unchanged line blocks keep their exact bytes. The
 * two contents must have the same line count (normalisation never changes it).
 */
function applyWithOverlay(originalContent, baseContent, replacements) {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = lineSpans(baseContent);
  const groups = [];
  for (const r of [...replacements].sort((a, b) => a.index - b.index)) {
    const range = replacementLineRange(baseLines, r.index, r.length);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(r);
      continue;
    }
    groups.push({ ...range, replacements: [r] });
  }
  let originalIndex = 0;
  let result = "";
  for (const g of groups) {
    result += originalLines.slice(originalIndex, g.startLine).join("");
    const startOffset = baseLines[g.startLine].start;
    const endOffset = baseLines[g.endLine - 1].end;
    result += applyReplacements(
      baseContent.slice(startOffset, endOffset),
      g.replacements.map((r) => ({ ...r, index: r.index - startOffset }))
    );
    originalIndex = g.endLine;
  }
  result += originalLines.slice(originalIndex).join("");
  return result;
}

/** Number of lines in an LF-normalised string (a single trailing \n is not a line). */
function contentLineCount(content) {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "" && lines.length > 1) return lines.length - 1;
  return lines.length;
}

/**
 * Convert a {startLine, endLine, new} range edit into a char-space replacement
 * on `content` (LF-normalised). endLine = startLine - 1 inserts before
 * startLine; otherwise the inclusive line range [startLine, endLine] is
 * replaced. Range mode is line-oriented (sed-like): the block occupies whole
 * lines, so a preceding unterminated line is terminated on insert and the
 * block is terminated when anything follows it (a later line, or the file's
 * original final newline). This keeps "replace line 12 with X" from ever
 * merging line 12 with line 13.
 */
function rangeOpToReplacement(content, op) {
  const spans = lineSpans(content);
  const total = spans.length;
  const start = op.startLine;
  const end = op.endLine ?? start;
  const inserting = end === start - 1;
  let index;
  let length;
  if (inserting) {
    index = start - 1 < total ? spans[start - 1].start : content.length;
    length = 0;
  } else {
    index = spans[start - 1].start;
    length = spans[end - 1].end - index;
  }

  let block = op.new;
  if (inserting && index > 0 && content[index - 1] !== "\n") {
    block = "\n" + block;
  }
  const somethingAfter = inserting ? start - 1 < total : end < total;
  if (block !== "" && (somethingAfter || content.endsWith("\n")) && !block.endsWith("\n")) {
    block += "\n";
  }
  return { index, length, new: block };
}

/**
 * Resolve content edits ({old, new}) and line-range edits ({startLine, endLine,
 * new}) against the LF-normalised original file. Every replacement refers to
 * the original file and is applied bottom-up later, so old strings and line
 * numbers never shift mid-batch. Returns { newContent, usedFuzzy, replacements }
 * or { error }.
 */
export function applyEditsToContent(content, edits, all) {
  const contentOps = [];
  const rangeOps = [];
  for (const e of edits) {
    const item = {
      old: typeof e.old === "string" ? normalizeLineEndings(e.old) : undefined,
      new: normalizeLineEndings(typeof e.new === "string" ? e.new : ""),
      startLine: typeof e.startLine === "number" ? e.startLine : undefined,
      endLine: typeof e.endLine === "number" ? e.endLine : undefined,
    };
    if (typeof item.old === "string") {
      if (item.old === "") return { error: "old string must not be empty" };
      contentOps.push(item);
    } else if (typeof item.startLine === "number") {
      rangeOps.push(item);
    } else {
      return { error: "each edit must provide old (content) or startLine (line range)" };
    }
  }

  const totalLines = contentLineCount(content);
  for (const op of rangeOps) {
    const start = op.startLine;
    const end = op.endLine ?? start;
    if (end === start - 1) {
      // insertion: valid up to one past the last line
      if (start > totalLines + 1) {
        return { error: "cannot insert before line " + start + ": the file has " + totalLines + " lines" };
      }
    } else if (end >= start) {
      if (start > totalLines || end > totalLines) {
        return { error: "line range " + start + "-" + end + " is out of bounds: the file has " + totalLines + " lines" };
      }
    } else {
      return { error: "endLine must be startLine - 1 (insert) or >= startLine (got startLine=" + start + ", endLine=" + end + ")" };
    }
  }

  let usedFuzzy = false;
  for (const op of contentOps) {
    if (collectMatches(content, op.old).length === 0) {
      usedFuzzy = true;
      break;
    }
  }
  const base = usedFuzzy ? normalizeForFuzzy(content) : content;

  const replacements = [];
  for (const op of contentOps) {
    const needle = usedFuzzy ? normalizeForFuzzy(op.old) : op.old;
    const matches = collectMatches(base, needle);
    if (matches.length === 0) {
      return {
        error:
          "old string not found. Copy the exact text from a fresh read — whitespace, smart " +
          "quotes and line endings (CRLF) must line up; trailing whitespace, line numbers " +
          "and unicode quotes/dashes are tolerated.",
      };
    }
    if (matches.length > 1 && !all) {
      return {
        error:
          "old string occurs " + matches.length + " times; add more context to make it unique, " +
          "or set all=true to replace every occurrence",
      };
    }
    for (const m of matches) {
      replacements.push({ index: m, length: needle.length, new: op.new });
    }
  }
  for (const op of rangeOps) {
    replacements.push(rangeOpToReplacement(base, op));
  }

  const sorted = [...replacements].sort((a, b) => a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].index + sorted[i - 1].length > sorted[i].index) {
      return { error: "edits overlap; merge them into one replacement" };
    }
  }

  const newContent = usedFuzzy
    ? applyWithOverlay(content, base, sorted)
    : applyReplacements(base, sorted);
  if (newContent === content) return { error: "replacement produced identical content" };
  return { newContent, usedFuzzy, replacements: sorted.length };
}

