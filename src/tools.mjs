/**
 * The tools the agent can call. Registry entries have this shape:
 *
 *   {
 *     name:        string        – unique name the model references
 *     description: string        – tells the model when/how to use it
 *     parameters:  JSON Schema   – describes/validates the arguments
 *     risk:        string        – model-invisible policy classification
 *     validate:    (args) => ?string  – optional semantic validation
 *     approval:    (args) => ?string  – optional approval reason
 *     execute:     (args, ctx) => any – returns a JSON-serialisable value
 *   }
 *
 * The schema is the contract between the model and your code: the model only
 * knows what you tell it here, so good descriptions matter.
 *
 * This file is the registry + the shell/fs execution layer. The pure engines
 * it delegates to live beside it:
 *   - src/edit-engine.mjs — exact/fuzzy/range text editing
 *   - src/read-bounds.mjs — bounded-memory scanning + line/byte caps
 *   - src/tool-state.mjs — same-turn range-edit freshness (owned by the loop)
 *
 * See docs/tools.md for the full contract and change workflow.
 */
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { applyEditsToContent, detectLineEnding, normalizeLineEndings, restoreLineEndings } from "./edit-engine.mjs";
import { formatBytes, readFileWindow } from "./read-bounds.mjs";

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
  const joined = String(command).replace(/\\\r?\n/g, " ");
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(joined));
}

/**
 * Write `data` to `file` atomically: write to a uniquely-named temp file in the
 * same directory, then rename() it over the target. A crash mid-write can never
 * leave the user's file truncated — the target only ever sees the old or the
 * new complete content. The temp name is created with "wx" so two concurrent
 * writers never clobber each other's scratch file.
 *
 * `noOverwrite` preserves the write tool's "protect existing files" promise
 * (rename() would silently replace them); a pre-rename existence probe mirrors
 * the old `flag: "wx"` error for callers that need it.
 */
async function atomicWriteFile(file, data, { noOverwrite = false } = {}) {
  if (noOverwrite) {
    try {
      await access(file);
      return { skipped: true };
    } catch {
      // target is free — fall through to the write
    }
  }
  const dir = dirname(file);
  const tmp = join(dir, `.argus-tmp-${basename(file)}-${randomUUID()}`);
  try {
    await writeFile(tmp, data, { encoding: "utf8", flag: "wx" });
    await rename(tmp, file);
    return {};
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

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
  {
    name: "bash",
    risk: "shell",
    description:
      "Run one shell command for search, listing, environment inspection, builds, tests, or other CLI work. " +
      "Do not use shell commands to read, create, or edit text files when read/write/edit applies. " +
      "Returns bounded stdout/stderr; cd changes the working directory for later tools. The timeout " +
      "is 60 seconds. A best-effort destructive-command backstop requires approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "The shell command to run" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    validate({ command }) {
      return command.trim() ? null : "bash argument command must not be blank";
    },
    approval({ command }) {
      return isDestructive(command) ? "command matched the destructive-shell backstop" : null;
    },
    async execute({ command }, ctx = {}) {
      const cwd = ctx.cwd || process.cwd();
      const cmd = String(command).trim();

      if (isDestructive(cmd) && !ctx.approved) {
        const request = {
          tool: "bash",
          args: { command },
          cwd,
          risk: "shell",
          reason: "command matched the destructive-shell backstop",
        };
        if (ctx.authorize) {
          const ok = await ctx.authorize(request);
          if (!ok) return { error: true, message: `denied: destructive command not approved: ${cmd.slice(0, 80)}` };
        } else if (ctx.confirm) {
          const ok = await ctx.confirm(command);
          if (!ok) return { error: true, message: `denied: destructive command not approved: ${cmd.slice(0, 80)}` };
        } else {
          return { error: true, message: `blocked: destructive command requires approval: ${cmd.slice(0, 80)}` };
        }
      }

      // A shell command can mutate any path even when it exits non-zero. Once
      // execution is authorized, conservatively invalidate every read stamp.
      ctx.toolState?.invalidateAll();

      // Ask the shell for its final cwd, rather than trying to parse `cd`
      // syntax. This handles quotes and compound commands without polluting
      // the command's stdout.
      const marker = `__ARGUS_CWD_${randomUUID()}__`;
      const wrapped = `{\n${command}\n}; __argus_status=$?; printf '\\n${marker}%s\\n' "$PWD" >&2; exit $__argus_status`;
      try {
        const { stdout, stderr } = await execAsync(wrapped, {
          cwd,
          timeout: ctx.timeoutMs ?? 60_000,
          maxBuffer: 1024 * 1024,
          // Always /bin/sh, never the caller's $SHELL: the {…}; $? cwd wrapper
          // is POSIX syntax and breaks under fish/csh aliases.
          shell: "/bin/sh",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const parsed = extractCwd(stderr, marker);
        return { stdout, stderr: parsed.stderr, ...(parsed.cwd ? { cwd: parsed.cwd } : {}) };
      } catch (err) {
        // execAsync throws on non-zero exit OR on abort; surface either cleanly.
        const parsed = extractCwd(err.stderr ?? "", marker);
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          // The command ran but its output overflowed the 1MB capture buffer.
          // That is a truncated success, not a failure: surface what was
          // captured so the model sees the output instead of a bogus error.
          return {
            stdout: err.stdout ?? "",
            stderr: parsed.stderr,
            truncated: true,
            ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
          };
        }
        if (err.name === "AbortError") {
          return { error: true, aborted: true, message: "command aborted" };
        }
        if (err.killed && err.signal) {
          return { error: true, timeout: true, message: `command timed out after ${ctx.timeoutMs ?? 60_000}ms` };
        }
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

function validateSchemaValue(value, schema, label) {
  const expected = schema?.type;
  const valid =
    expected === "array"
      ? Array.isArray(value)
      : expected === "object"
        ? value !== null && typeof value === "object" && !Array.isArray(value)
        : expected === "integer"
          ? Number.isInteger(value)
          : expected == null || typeof value === expected;
  if (!valid) return `${label} must be ${expected}`;

  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    return `${label} must not be empty`;
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) {
    return `${label} must be at least ${schema.minimum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${label} must contain at least ${schema.minItems} item`;
    for (let i = 0; i < value.length; i++) {
      const error = validateSchemaValue(value[i], schema.items ?? {}, `${label}[${i}]`);
      if (error) return error;
    }
  }
  if (expected === "object") {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) return `${label} is missing required argument: ${name}`;
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[name];
      if (!childSchema) {
        if (schema.additionalProperties === false) return `${label} has unknown argument: ${name}`;
        continue;
      }
      const error = validateSchemaValue(child, childSchema, `${label}.${name}`);
      if (error) return error;
    }
  }
  return null;
}

/** Validate the model's arguments against the advertised schema and semantics. */
export function validateToolArgs(tool, args) {
  const error = validateSchemaValue(args, tool.parameters ?? { type: "object" }, `${tool.name} arguments`);
  if (error) return error;
  return tool.validate?.(args) ?? null;
}
