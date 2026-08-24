/**
 * Pure text-edit engine for the edit tool.
 *
 * Exact matches first, then a normalised (trailing whitespace stripped,
 * quotes/dashes/spaces ASCII-folded, NFKC) fuzzy match. Normalized matches are
 * mapped back to exact original spans, so unrelated bytes on touched lines are
 * preserved too. CRLF and a UTF-8 BOM are preserved by the caller. Every
 * replacement refers to the original content and is applied bottom-up, so old
 * strings and line numbers never shift mid-batch.
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
  return normalizeForFuzzyWithMap(text).text;
}

function collectMatches(content, needle) {
  if (needle === "") throw new Error("cannot search for an empty string");
  const out = [];
  let from = 0;
  for (;;) {
    const i = content.indexOf(needle, from);
    if (i === -1) return out;
    out.push(i);
    from = i + needle.length;
  }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function foldFuzzySegment(segment) {
  return segment
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Build fuzzy-normalized text with a UTF-16 offset map back to the original.
 * The map lets a tolerant match replace only its requested original span
 * instead of rebuilding (and normalizing) the whole touched line.
 */
function normalizeForFuzzyWithMap(text) {
  let normalized = "";
  const starts = [];
  const ends = [];
  let base = 0;
  const lines = text.split("\n");

  const append = (value, start, end) => {
    normalized += value;
    for (let i = 0; i < value.length; i++) {
      starts.push(start);
      ends.push(end);
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const gutter = line.match(/^\s*\d{1,6}\s*[|│]\s*/u)?.[0] ?? "";
    const trimmed = line.slice(gutter.length).trimEnd();
    for (const { segment, index } of graphemeSegmenter.segment(trimmed)) {
      const start = base + gutter.length + index;
      append(foldFuzzySegment(segment), start, start + segment.length);
    }
    if (lineIndex < lines.length - 1) append("\n", base + line.length, base + line.length + 1);
    base += line.length + 1;
  }
  return { text: normalized, starts, ends };
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

function applyReplacements(content, replacements) {
  let result = content;
  const sorted = [...replacements].sort((a, b) => a.index - b.index);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    result = result.slice(0, r.index) + r.new + result.slice(r.index + r.length);
  }
  return result;
}

/** Number of lines in an LF-normalised string (a single trailing \n is not a line). */
function contentLineCount(content) {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "" && lines.length > 1) return lines.length - 1;
  return lines.length;
}

const READ_GUTTER_RE = /^\s*(\d{1,6})\s*│\s?/u;

/**
 * Return the displayed line numbers when every nonblank line looks copied
 * from read.numberedText. A null result means the text is ordinary file text.
 */
function numberedReadGutters(text) {
  const lines = normalizeLineEndings(text).split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const numbers = [];
  for (const line of lines) {
    const match = line.match(READ_GUTTER_RE);
    if (!match) return null;
    numbers.push(Number(match[1]));
  }
  return numbers;
}

function consecutiveFrom(numbers, start) {
  return numbers.every((number, index) => number === start + index);
}

function gutterLeakError(content, op) {
  const replacementNumbers = numberedReadGutters(op.new);
  if (!replacementNumbers) return null;

  if (typeof op.old === "string") {
    const selectorNumbers = numberedReadGutters(op.old);
    // An exact old match means the gutters really exist in the file. When the
    // numbered selector only works through fuzzy normalization, matching
    // gutters in new are almost certainly copied display metadata.
    if (selectorNumbers && !content.includes(op.old)) {
      return "replacement text appears copied from read.numberedText; remove the ‘N │’ line prefixes from new";
    }
    return null;
  }

  const start = op.startLine;
  const end = op.endLine ?? start;
  const inserting = end === start - 1;
  if (!consecutiveFrom(replacementNumbers, start)) return null;

  if (inserting) {
    // There is no original selection to distinguish copied display gutters
    // from intentionally inserted numbered data. Do not guess and block it.
    return null;
  }

  const originalLines = normalizeLineEndings(content).split("\n").slice(start - 1, end);
  const originalIsNumberedData = originalLines.length > 0 && originalLines.every((line) => READ_GUTTER_RE.test(line));
  return originalIsNumberedData
    ? null
    : "replacement text appears copied from read.numberedText; remove the ‘N │’ line prefixes from new";
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

  for (const op of [...contentOps, ...rangeOps]) {
    const error = gutterLeakError(content, op);
    if (error) return { error };
  }

  let usedFuzzy = false;
  let fuzzyBase = null;
  const replacements = [];
  for (const op of contentOps) {
    let needle = op.old;
    let matches = collectMatches(content, needle).map((index) => ({ index, length: needle.length }));
    if (matches.length === 0) {
      usedFuzzy = true;
      fuzzyBase ??= normalizeForFuzzyWithMap(content);
      needle = normalizeForFuzzy(op.old);
      if (needle === "") {
        return { error: "old string becomes empty after fuzzy normalization; copy more surrounding text from a fresh read" };
      }
      matches = collectMatches(fuzzyBase.text, needle).map((index) => ({
        index: fuzzyBase.starts[index],
        length: fuzzyBase.ends[index + needle.length - 1] - fuzzyBase.starts[index],
      }));
    }
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
    for (const match of matches) {
      replacements.push({ index: match.index, length: match.length, new: op.new });
    }
  }
  for (const op of rangeOps) {
    replacements.push(rangeOpToReplacement(content, op));
  }

  const sorted = [...replacements].sort((a, b) => a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].index + sorted[i - 1].length > sorted[i].index) {
      return { error: "edits overlap; merge them into one replacement" };
    }
  }

  const newContent = applyReplacements(content, sorted);
  if (newContent === content) return { error: "replacement produced identical content" };
  return { newContent, usedFuzzy, replacements: sorted.length };
}
