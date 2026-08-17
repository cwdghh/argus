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
 * This file is the registry + the shell/fs execution layer. The pure engines
 * it delegates to live beside it:
 *   - src/edit-engine.mjs — exact/fuzzy/range text editing
 *   - src/read-bounds.mjs — line/byte bounds + truncation for read
 *
 * See docs/tools.md for the full contract and how to add tools.
 */
import { readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { applyEditsToContent, detectLineEnding, normalizeLineEndings, restoreLineEndings } from "./edit-engine.mjs";
import { formatBytes, truncateRead } from "./read-bounds.mjs";

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
