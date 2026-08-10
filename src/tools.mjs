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
import { readFile, writeFile, stat } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const execAsync = promisify(exec);

/** Resolve a cd target to an absolute directory (handles ~, relative, ..). */
async function resolveCd(cwd, target) {
  let dir;
  if (target === "~") dir = homedir();
  else if (target.startsWith("~/")) dir = join(homedir(), target.slice(2));
  else if (target === "-") return null; // cd - (previous dir) unsupported for now
  else dir = resolve(cwd, target);
  try {
    const st = await stat(dir);
    return st.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

// Patterns that are dangerous enough to require confirmation before running.
const DESTRUCTIVE_PATTERNS = [
  /rm\s+(-{1,2}[a-z]*r[a-z]*|--recursive)/i, // recursive delete (rm -r / rm -rf)
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
      "Read a file and return its full contents as text. Use this to inspect files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" },
      },
      required: ["path"],
    },
    async execute({ path }) {
      return { path, content: await readFile(path, "utf8") };
    },
  },
  {
    name: "write",
    description:
      "Write text content to a file, overwriting it entirely (creating it if needed). " +
      "Use this for full-file changes or new files. For small precise changes, prefer edit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to write" },
        content: { type: "string", description: "Full text content to write" },
      },
      required: ["path", "content"],
    },
    async execute({ path, content }) {
      await writeFile(path, content, "utf8");
      return { ok: true, path, bytes: Buffer.byteLength(content) };
    },
  },
  {
    name: "edit",
    description:
      "Replace every occurrence of the exact string `old` with `new` in a file. " +
      "Errors if `old` is not found. Use for small, precise changes; use write for whole files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit" },
        old: { type: "string", description: "Exact text to find (must exist in the file)" },
        new: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old", "new"],
    },
    async execute({ path, old: oldText, new: newText }) {
      const original = await readFile(path, "utf8");
      if (!original.includes(oldText)) {
        return { error: true, message: `old string not found in ` };
      }
      const content = original.split(oldText).join(newText);
      const count = original.split(oldText).length - 1;
      await writeFile(path, content, "utf8");
      return { ok: true, path, replacements: count };
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
      let newCwd = null;
      const cdMatch = cmd.match(/^cd\s+(\S+)/);
      if (cmd === "cd") newCwd = await resolveCd(cwd, "~");
      else if (cdMatch) newCwd = await resolveCd(cwd, cdMatch[1]);

      if (isDestructive(cmd)) {
        if (ctx.confirm) {
          const ok = await ctx.confirm(command);
          if (!ok) return { error: true, message: `denied: destructive command not approved: ${cmd.slice(0, 80)}` };
        } else {
          return { error: true, message: `blocked: destructive command requires approval: ${cmd.slice(0, 80)}` };
        }
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return { stdout, stderr, ...(newCwd ? { cwd: newCwd } : {}) };
      } catch (err) {
        // execAsync throws on non-zero exit OR on abort; surface either cleanly.
        if (err.name === "AbortError") {
          return { error: true, aborted: true, message: "command aborted" };
        }
        return {
          error: true,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
          message: err.message,
          ...(newCwd ? { cwd: newCwd } : {}),
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
