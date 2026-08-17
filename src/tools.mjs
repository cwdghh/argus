/**
 * The tools the agent can call. Each tool is the same shape:
 *
 *   {
 *     name:        string        – unique name the model references
 *     description: string        – tells the model when/how to use it
 *     parameters:  JSON Schema   – describes/validates the arguments
 *     execute:     (args) => any – runs the tool, returns a JSON-serialisable value
 *   }
 *
 * The schema is the contract between the model and your code: the model only
 * knows what you tell it here, so good descriptions matter.
 *
 * See docs/tools.md for the full contract and how to add tools.
 */
import { readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const execAsync = promisify(exec);

// Patterns that are dangerous enough to require confirmation before running.
const DESTRUCTIVE_PATTERNS = [
  /\brm\b[^\n;&|]*(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$)/i, // recursive rm, incl. split flags
  /\bdd\b/, // raw block-device copy
  /\bmkfs(\.\w+)?\b/,
  /\bmke2fs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*:/, // fork bomb
];

function isDestructive(command) {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// ---- file reading: bounded reads with offset/limit paging -----------------
// Mirrors pi's read tool: never return an unbounded file into the context
// window. Line and byte caps both apply (whichever hits first); the model is
// told exactly which window it saw and how to continue.

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024; // 50KB

function formatBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}

/**
 * Truncate text from the head, never splitting a line. Returns the output plus
 * enough metadata for the read tool to print a precise continuation notice.
 */
function truncateRead(text, maxLines = READ_MAX_LINES, maxBytes = READ_MAX_BYTES) {
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

// ---- editing: exact + fuzzy text replacement ------------------------------
// Mirrors pi's edit-diff machinery: exact matches first, then a normalised
// (trailing whitespace stripped, quotes/dashes/spaces ASCII-folded, NFKC)
// fuzzy match. Fuzzy replacements run in normalised space and are overlaid
// back onto the original content line-by-line, so untouched lines keep their
// bytes. CRLF and a UTF-8 BOM are preserved.

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text, ending) {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function detectLineEnding(text) {
  const crlf = text.indexOf("\r\n");
  const lf = text.indexOf("\n");
  if (lf === -1 || crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

function normalizeForFuzzy(text) {
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
function applyEditsToContent(content, edits, all) {
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

export const tools = [
  {
    name: "read",
    description:
      "Read a file and return its contents as text, with every line prefixed by its absolute " +
      "1-indexed line number (copy these for startLine/endLine edits). Large files are truncated " +
      "to at most 2000 lines or 50KB; pass offset/limit to page through big files instead of " +
      "reading them whole. Paths are relative to the current working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" },
        offset: { type: "integer", minimum: 1, description: "1-indexed first line to read (default 1)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async execute({ path, offset, limit }, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), path);
      const text = await readFile(file, "utf8");
      const allLines = text === "" ? [] : text.split("\n");
      if (allLines[allLines.length - 1] === "" && allLines.length > 1) allLines.pop();
      const totalLines = allLines.length;
      if (totalLines === 0) return { path: file, content: "" };

      const start = offset ? Math.max(0, offset - 1) : 0;
      if (start >= allLines.length) {
        return { error: true, path: file, message: "offset " + offset + " is beyond the end of the file (" + totalLines + " lines)" };
      }
      let window = allLines.slice(start);
      if (limit !== undefined) window = window.slice(0, limit);

      const endsWithNewline = text.endsWith("\n");
      const windowText = window.join("\n");
      const t = truncateRead(windowText);
      const startDisplay = start + 1;
      const endDisplay = startDisplay + t.outputLines - 1;
      let content;
      const notes = [];
      if (t.firstLineExceedsLimit) {
        content =
          "[Line " + startDisplay + " is " + formatBytes(Buffer.byteLength(window[0] ?? "", "utf8")) +
          ", over the 50KB read limit. Use bash to read it in chunks, e.g.: sed -n '" + startDisplay + "p' " + path + " | head -c 50000]";
      } else {
        const gutter = String(Math.max(1, totalLines)).length;
        content = t.lines
          .map((line, i) => String(startDisplay + i).padStart(gutter) + " │ " + line)
          .join("\n");
        if (t.truncated) {
          notes.push("[Showing lines " + startDisplay + "-" + endDisplay + " of " + totalLines + ". Use offset=" + (endDisplay + 1) + " to continue.]");
        } else if (limit !== undefined && start + window.length < totalLines) {
          const remaining = totalLines - (start + window.length);
          notes.push("[" + remaining + " more line" + (remaining === 1 ? "" : "s") + " in the file. Use offset=" + (start + window.length + 1) + " to continue.]");
        } else if (endsWithNewline && start + window.length >= totalLines) {
          content += "\n"; // reproduce the file's final newline
        }
        if (notes.length > 0) content = content.trimEnd() + "\n\n" + notes.join("\n");
      }
      const result = { path: file, content };
      if (t.truncated) {
        result.truncated = true;
        result.nextOffset = endDisplay + 1;
      }
      return result;
    },
  },
  {
    name: "write",
    description:
      "Write text content to a new file. Existing files are protected unless `overwrite` is true. " +
      "Use this for full-file changes or new files. For small precise changes, prefer edit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to write" },
        content: { type: "string", description: "Full text content to write" },
        overwrite: { type: "boolean", description: "Allow replacing an existing file (default: false)" },
      },
      required: ["path", "content"],
    },
    async execute({ path, content, overwrite = false }, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), path);
      try {
        await writeFile(file, content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
      } catch (err) {
        if (err.code === "EEXIST") {
          return { error: true, message: `file already exists: ${file}; use edit or set overwrite=true` };
        }
        throw err;
      }
      return { ok: true, path: file, bytes: Buffer.byteLength(content) };
    },
  },
  {
    name: "edit",
    description:
      "Edit a file: replace an exact string (content mode) or an inclusive 1-indexed line " +
      "range (range mode). Use edits[] to apply several targeted replacements to one file " +
      "atomically, all matched against the original file (applied bottom-up, so they never " +
      "shift each other). Content mode matches exactly first, then tolerates small " +
      "differences: trailing whitespace, line numbers, smart quotes, unicode dashes and CRLF " +
      "are normalised; errors if old is missing or ambiguous unless all=true. Range mode " +
      "replaces lines [startLine, endLine] with new; set endLine = startLine - 1 to insert " +
      "before startLine, and new='' to delete. Line numbers must come from the most recent " +
      "read of the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit" },
        edits: {
          type: "array",
          description: "One or more targeted replacements, applied atomically in one call",
          items: {
            type: "object",
            properties: {
              old: { type: "string", minLength: 1, description: "Content form: text to find (unique in the file unless all=true)" },
              new: { type: "string", description: "Replacement text" },
              startLine: { type: "integer", minimum: 1, description: "Range form: first line to replace (1-indexed, from a read)" },
              endLine: { type: "integer", minimum: 1, description: "Range form: last line to replace (default startLine; startLine-1 inserts before startLine)" },
            },
          },
        },
        old: { type: "string", minLength: 1, description: "Legacy single-edit content form: text to find" },
        new: { type: "string", description: "Replacement text (content or range form)" },
        startLine: { type: "integer", minimum: 1, description: "Legacy single-edit range form: first line to replace (1-indexed, from a read)" },
        endLine: { type: "integer", minimum: 1, description: "Legacy single-edit range form: last line to replace (default startLine; startLine-1 inserts before startLine)" },
        all: { type: "boolean", description: "Replace every occurrence (default: false)" },
      },
      required: ["path"],
    },
    async execute(args, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), args.path);
      const edits = [];
      if (Array.isArray(args.edits)) {
        for (const e of args.edits) {
          if (!e || typeof e !== "object") continue;
          const item = {};
          if (typeof e.old === "string") item.old = e.old;
          if (typeof e.new === "string") item.new = e.new;
          if (typeof e.startLine === "number") item.startLine = e.startLine;
          if (typeof e.endLine === "number") item.endLine = e.endLine;
          if (typeof item.old === "string" || typeof item.startLine === "number") edits.push(item);
        }
      }
      if (typeof args.old === "string" && typeof args.new === "string") edits.push({ old: args.old, new: args.new });
      if (typeof args.startLine === "number") {
        edits.push({
          startLine: args.startLine,
          endLine: typeof args.endLine === "number" ? args.endLine : undefined,
          new: typeof args.new === "string" ? args.new : "",
        });
      }
      if (edits.length === 0) {
        return { error: true, message: "edit requires old/new, startLine/endLine, or edits[] in " + file };
      }
      let raw;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        return { error: true, message: "cannot read " + file + ": " + err.message };
      }
      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const body = bom ? raw.slice(1) : raw;
      const ending = detectLineEnding(body);
      const result = applyEditsToContent(normalizeLineEndings(body), edits, args.all === true);
      if (result.error) {
        return { error: true, path: file, message: "edit failed in " + file + ": " + result.error };
      }
      try {
        await writeFile(file, bom + restoreLineEndings(result.newContent, ending), "utf8");
      } catch (err) {
        return { error: true, message: "cannot write " + file + ": " + err.message };
      }
      const out = { ok: true, path: file, replacements: result.replacements };
      if (result.usedFuzzy) out.fuzzy = true;
      return out;
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command and return its stdout and stderr. Use this to inspect the " +
      "environment, list files, run builds, or any command-line task. The working " +
      "directory persists across calls: use cd to move around and it is remembered. " +
      "Destructive commands (recursive rm, dd, mkfs, shutdown, ...) require approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
    async execute({ command }, ctx = {}) {
      const cwd = ctx.cwd || process.cwd();
      const cmd = String(command).trim();

      if (isDestructive(cmd)) {
        if (ctx.confirm) {
          const ok = await ctx.confirm(command);
          if (!ok) return { error: true, message: `denied: destructive command not approved: ${cmd.slice(0, 80)}` };
        } else {
          return { error: true, message: `blocked: destructive command requires approval: ${cmd.slice(0, 80)}` };
        }
      }

      // Ask the shell for its final cwd, rather than trying to parse `cd`
      // syntax. This handles quotes and compound commands without polluting
      // the command's stdout.
      const marker = `__ARGUS_CWD_${randomUUID()}__`;
      const wrapped = `{\n${command}\n}; __argus_status=$?; printf '\\n${marker}%s\\n' "$PWD" >&2; exit $__argus_status`;
      try {
        const { stdout, stderr } = await execAsync(wrapped, {
          cwd,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          shell: process.env.SHELL || "/bin/sh",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const parsed = extractCwd(stderr, marker);
        return { stdout, stderr: parsed.stderr, ...(parsed.cwd ? { cwd: parsed.cwd } : {}) };
      } catch (err) {
        // execAsync throws on non-zero exit OR on abort; surface either cleanly.
        if (err.name === "AbortError") {
          return { error: true, aborted: true, message: "command aborted" };
        }
        const parsed = extractCwd(err.stderr ?? "", marker);
        return {
          error: true,
          stdout: err.stdout ?? "",
          stderr: parsed.stderr,
          message: err.message,
          ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        };
      }
    },
  },
];

/**
 * Look up a tool by name.
 * @param {string} name
 * @returns {object | undefined}
 */
export function findTool(name) {
  return tools.find((t) => t.name === name);
}

function extractCwd(stderr, marker) {
  const text = String(stderr);
  const index = text.lastIndexOf(marker);
  if (index === -1) return { stderr: text, cwd: null };
  const end = text.indexOf("\n", index);
  const cwd = text.slice(index + marker.length, end === -1 ? undefined : end).trim();
  const before = text.slice(0, index).replace(/\n$/, "");
  const after = end === -1 ? "" : text.slice(end + 1);
  return { stderr: before + after, cwd: cwd || null };
}

/** Minimal runtime validation for the simple JSON Schemas used by tools. */
export function validateToolArgs(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `${tool.name} arguments must be a JSON object`;
  }
  const schema = tool.parameters ?? {};
  for (const name of schema.required ?? []) {
    if (!(name in args)) return `${tool.name} is missing required argument: ${name}`;
  }
  for (const [name, value] of Object.entries(args)) {
    const expected = schema.properties?.[name]?.type;
    if (!expected) continue;
    const valid =
      expected === "array"
        ? Array.isArray(value)
        : expected === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : expected === "integer"
            ? Number.isInteger(value)
            : typeof value === expected;
    if (!valid) return `${tool.name} argument ${name} must be ${expected}`;
    const minLength = schema.properties?.[name]?.minLength;
    if (typeof value === "string" && minLength != null && value.length < minLength) {
      return `${tool.name} argument ${name} must not be empty`;
    }
  }
  return null;
}
