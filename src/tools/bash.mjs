/** Shell policy and execution; cwd is reported by the shell itself. */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

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

export const bashTool = {
    name: "bash",
    risk: "shell",
    description:
      "Run one shell command for search, listing, environment inspection, builds, tests, or other CLI work. " +
      "Do not use shell commands to read, create, or edit text files when read/write/edit applies. " +
      "Returns bounded stdout/stderr; output overflow reports an error because completion is unknown. " +
      "A reported final cwd becomes the working directory for later tools. The timeout is 60 seconds. " +
      "A best-effort destructive-command backstop requires approval.",
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
          // Node may kill the child on capture overflow, so its completion
          // status is unknown even if the captured text looks successful.
          return {
            error: true,
            stdout: err.stdout ?? "",
            stderr: parsed.stderr,
            truncated: true,
            message: "command output exceeded the 1MB capture limit; command completion is unknown",
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
  };

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
