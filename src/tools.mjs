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

const execAsync = promisify(exec);

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
      "environment, list files, run builds, or any command-line task.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
    async execute({ command }, ctx = {}) {
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return { stdout, stderr };
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
