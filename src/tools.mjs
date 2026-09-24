/**
 * The model-visible four-tool registry. Schemas and descriptions live here;
 * pure editing/reading engines and filesystem/shell adapters own execution.
 * See docs/tools.md for the contract and docs/tool-surface.md for rationale.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyEditsToContent, detectLineEnding, normalizeLineEndings, restoreLineEndings } from "./edit-engine.mjs";
import { formatBytes, readFileWindow } from "./read-bounds.mjs";
import { atomicWriteFile } from "./tools/atomic-write.mjs";
import { bashTool } from "./tools/bash.mjs";
export { validateToolArgs } from "./tools/validate.mjs";

function fitReadResult({ file, lines, startDisplay, totalLines, endsWithNewline, maxChars = 50_000 }) {
  const gutter = String(Math.max(1, totalLines)).length;
  const build = (count) => {
    const endDisplay = startDisplay + count - 1;
    const hasMore = startDisplay - 1 + count < totalLines;
    let numberedText = lines
      .slice(0, count)
      .map((line, i) => String(startDisplay + i).padStart(gutter) + " │ " + line)
      .join("\n");
    if (hasMore) {
      numberedText = numberedText.trimEnd() +
        `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines}. Use offset=${endDisplay + 1} to continue.]`;
    } else if (endsWithNewline && count > 0) {
      numberedText += "\n";
    }
    return {
      path: file,
      numberedText,
      startLine: startDisplay,
      endLine: endDisplay,
      totalLines,
      ...(hasMore ? { truncated: true, nextOffset: endDisplay + 1 } : {}),
    };
  };

  let low = 1;
  let high = lines.length;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = middle > 0 ? build(middle) : null;
    if (candidate && JSON.stringify(candidate).length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? {
    error: true,
    path: file,
    message: `line ${startDisplay} cannot fit within the ${maxChars}-character tool-result limit; use bash to inspect a byte range`,
  };
}

export const tools = [
  {
    name: "read",
    risk: "read-only",
    description:
      "Read a text file as bounded numberedText with absolute 1-indexed line prefixes. " +
      "The prefixes select ranges and are not file content. Use offset/limit and nextOffset to page. " +
      "Paths are relative to the current working directory. Use this instead of bash for text files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Path to the file to read" },
        offset: { type: "integer", minimum: 1, description: "1-indexed first line to read (default 1)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    validate({ path }) {
      return path.trim() ? null : "read argument path must not be blank";
    },
    async execute({ path, offset, limit }, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), path);
      let window;
      try {
        window = await readFileWindow(file, { offset, limit });
      } catch (err) {
        return { error: true, path: file, message: `cannot read ${file}: ${err.message}`, ...(err.code ? { code: err.code } : {}) };
      }
      const totalLines = window.totalLines;
      if (totalLines === 0) {
        ctx.toolState?.recordReadHash(file, window.hash, 0, 0, 0);
        return { path: file, numberedText: "", startLine: 0, endLine: 0, totalLines: 0 };
      }

      const startDisplay = offset ?? 1;
      if (startDisplay > totalLines) {
        return { error: true, path: file, message: "offset " + offset + " is beyond the end of the file (" + totalLines + " lines)" };
      }
      if (window.firstLineExceedsLimit) {
        return {
          error: true,
          path: file,
          message:
            `line ${startDisplay} is ${formatBytes(window.firstLineBytes)}, ` +
            "over the 50KB line limit; use bash with a safely quoted path to inspect byte ranges",
        };
      }
      const result = fitReadResult({
        file,
        lines: window.lines,
        startDisplay,
        totalLines,
        endsWithNewline: window.endsWithNewline,
        maxChars: ctx.maxResultChars,
      });
      if (!result.error && ctx.toolState) {
        ctx.toolState.recordReadHash(file, window.hash, result.startLine, result.endLine, result.totalLines);
      }
      return result;
    },
  },
  {
    name: "write",
    risk: "filesystem-write",
    description:
      "Create a complete text file. Set ensureFinalNewline=true to append LF when content lacks one; " +
      "false writes content exactly. Existing files are protected unless overwrite=true. " +
      "Use this instead of bash redirection or heredocs for text files; use edit for targeted changes " +
      "to an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Path of the file to write" },
        content: {
          type: "string",
          description: "Complete file text; final-newline policy is controlled separately",
        },
        ensureFinalNewline: { type: "boolean", description: "Append LF if content has no final line break" },
        overwrite: { type: "boolean", description: "Allow replacing an existing file (default: false)" },
      },
      required: ["path", "content", "ensureFinalNewline"],
      additionalProperties: false,
    },
    validate({ path }) {
      return path.trim() ? null : "write argument path must not be blank";
    },
    async execute({ path, content, ensureFinalNewline, overwrite = false }, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), path);
      const output = ensureFinalNewline && !content.endsWith("\n") ? content + "\n" : content;
      try {
        const { skipped } = await atomicWriteFile(file, output, { noOverwrite: !overwrite });
        if (skipped) {
          return { error: true, message: `file already exists: ${file}; use edit or set overwrite=true` };
        }
      } catch (err) {
        return { error: true, path: file, message: `cannot write ${file}: ${err.message}`, ...(err.code ? { code: err.code } : {}) };
      }
      ctx.toolState?.recordMutation(file);
      return {
        ok: true,
        path: file,
        bytes: Buffer.byteLength(output),
        finalNewline: output.endsWith("\n"),
        newlineAdded: output !== content,
      };
    },
  },
  {
    name: "edit",
    risk: "filesystem-write",
    description:
      "Apply an atomic edits[] batch to an existing file. Each item uses exactly one selector: " +
      "{old,new} replaces unique content (all=true replaces every match), or " +
      "{startLine,endLine,new} replaces the freshly read inclusive lines (line-oriented, so a " +
      "single-line replacement with new='X' does not merge the next line; endLine=startLine-1 inserts; " +
      "new='' deletes). old may include read's line prefixes; new must contain only file text. " +
      "Exact content falls back to whitespace/punctuation-tolerant matching. Use " +
      "this instead of shell text-rewrite commands.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Path of the file to edit" },
        edits: {
          type: "array",
          description: "One or more targeted replacements, applied atomically in one call (content and/or range form)",
          items: {
            type: "object",
            properties: {
              old: { type: "string", minLength: 1, description: "File text to find; numberedText prefixes copied from read are accepted" },
              new: { type: "string", description: "Replacement file text only; never include read's line-number prefixes" },
              startLine: { type: "integer", minimum: 1, description: "Range form: first line to replace (1-indexed, from a read)" },
              endLine: { type: "integer", minimum: 0, description: "Range form: last line to replace (default startLine; startLine-1 inserts before startLine)" },
            },
            required: ["new"],
            additionalProperties: false,
          },
          minItems: 1,
        },
        all: { type: "boolean", description: "Replace every occurrence of old (default: false)" },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    validate(args) {
      if (!args.path.trim()) return "edit argument path must not be blank";
      for (let i = 0; i < args.edits.length; i++) {
        const item = args.edits[i];
        const hasOld = Object.hasOwn(item, "old");
        const hasStart = Object.hasOwn(item, "startLine");
        if (hasOld === hasStart) return `edit argument edits[${i}] must provide exactly one of old or startLine`;
        if (!Object.hasOwn(item, "new")) return `edit argument edits[${i}] is missing required argument: new`;
        if (hasStart && item.endLine !== undefined && item.endLine !== item.startLine - 1 && item.endLine < item.startLine) {
          return `edit argument edits[${i}].endLine must be startLine - 1 (insert) or >= startLine`;
        }
      }
      return null;
    },
    async execute(args, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), args.path);
      const edits = args.edits.map((item) => ({ ...item }));
      let raw;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        return { error: true, path: file, message: "cannot read " + file + ": " + err.message, ...(err.code ? { code: err.code } : {}) };
      }
      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const body = bom ? raw.slice(1) : raw;
      const ending = detectLineEnding(body);
      const freshnessError = ctx.toolState?.validateRangeEdit(file, raw, edits);
      if (freshnessError) return { error: true, path: file, message: freshnessError };
      const result = applyEditsToContent(normalizeLineEndings(body), edits, args.all === true);
      if (result.error) {
        return { error: true, path: file, message: "edit failed in " + file + ": " + result.error };
      }
      try {
        await atomicWriteFile(file, bom + restoreLineEndings(result.newContent, ending));
      } catch (err) {
        return { error: true, path: file, message: "cannot write " + file + ": " + err.message, ...(err.code ? { code: err.code } : {}) };
      }
      ctx.toolState?.recordMutation(file);
      const out = { ok: true, path: file, replacements: result.replacements };
      if (result.usedFuzzy) out.fuzzy = true;
      return out;
    },
  },
  bashTool,
];

/**
 * Look up a tool by name.
 * @param {string} name
 * @returns {object | undefined}
 */
export function findTool(name) {
  return tools.find((t) => t.name === name);
}
