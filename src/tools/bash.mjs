/** Shell policy and execution; cwd is reported by the shell itself. */
import { runShell } from "./shell-process.mjs";
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
      "Run a command under /bin/sh for search, listing, environment inspection, builds, or tests. " +
      'The only argument is command, for example {"command":"npm test"}. ' +
      "Use portable shell commands; bash-only features such as PIPESTATUS may not work. " +
      "Use read/write/edit for ordinary text files. Results separate exitCode and termination from bounded stdout/stderr; " +
      "truncated output does not prove success. Run verification alone so exitCode belongs to that check. " +
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

      return runShell(command, { cwd, signal: ctx.signal, timeoutMs: ctx.timeoutMs ?? 60_000,
        onOutput: ctx.onOutput, artifactDir: ctx.artifactDir });
    },
  };
