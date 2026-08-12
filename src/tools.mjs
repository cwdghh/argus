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

export const tools = [
  {
    name: "read",
    description:
      "Read a file and return its full contents as text. Use this to inspect files. " +
      "Paths are relative to the current working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" },
      },
      required: ["path"],
    },
    async execute({ path }, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), path);
      return { path: file, content: await readFile(file, "utf8") };
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
      "Replace one exact occurrence of `old` with `new` in a file. Errors if `old` is " +
      "missing or occurs more than once. Set `all` to true only when every occurrence should change.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit" },
        old: { type: "string", minLength: 1, description: "Exact non-empty text to find (must exist in the file)" },
        new: { type: "string", description: "Replacement text" },
        all: { type: "boolean", description: "Replace every occurrence (default: false)" },
      },
      required: ["path", "old", "new"],
    },
    async execute({ path, old: oldText, new: newText, all = false }, ctx = {}) {
      const file = resolve(ctx.cwd || process.cwd(), path);
      if (oldText === "") return { error: true, message: `old string must not be empty in ${file}` };
      const original = await readFile(file, "utf8");
      const count = original.split(oldText).length - 1;
      if (count === 0) {
        return { error: true, message: `old string not found in ${file}` };
      }
      if (count > 1 && !all) {
        return { error: true, message: `old string occurs ${count} times in ${file}; use all=true to replace every occurrence` };
      }
      const content = all ? original.split(oldText).join(newText) : original.replace(oldText, newText);
      await writeFile(file, content, "utf8");
      return { ok: true, path: file, replacements: all ? count : 1 };
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
