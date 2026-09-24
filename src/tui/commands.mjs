/**
 * Local slash commands for the TUI.
 *
 * `COMMANDS` is the single source of truth: the same table drives the
 * in-editor suggestion popup (see suggestions.mjs), the `/help` reference
 * text, and dispatch in the controller. Adding a command means adding one
 * entry with a `run` handler — nothing else in the controller changes.
 *
 * Handlers receive the controller instance as `tui` plus the
 * whitespace-split argument list, and report back through `tui.pushBlock`
 * (assistant / result / error blocks). Long-running handlers wrap work in
 * `tui.withLocalTask` so the footer shows a live "working" phase.
 */
import { formatChars, formatDuration, formatTokens, toolLabel } from "../format.mjs";
import { contextUsage } from "./frames.mjs";

/** The keyboard reference shown by /keys and at the bottom of /help. */
export const KEY_HELP = `## Keyboard shortcuts

### Edit the prompt

- Left / Right — move the cursor
- Ctrl-A / Ctrl-E — move to the start / end
- Backspace / Delete — delete before / under the cursor
- Ctrl-U / Ctrl-K — delete to the start / end
- Ctrl-W — delete the previous word
- Up / Down — move through the suggestion popup; recall earlier prompts otherwise
- Tab — accept the suggested @path, /command, or saved-session name
- Shift+Enter — insert a newline
- Enter — submit

### Control Argus

- Esc — abort the active turn
- Ctrl-C — abort; press again to force quit (or quit immediately when idle)
- Ctrl-D — delete under the cursor, or quit when idle and the prompt is empty
- Ctrl-L — clear and redraw the screen

### Browse the transcript

- PgUp / PgDn or mouse wheel — scroll the transcript by a page
- Home / End — jump to the top / bottom`;

export const COMMANDS = [
  {
    name: "/help",
    description: "show commands and keyboard shortcuts",
    run(tui) {
      tui.pushBlock({ kind: "assistant", text: HELP_TEXT });
    },
  },
  {
    name: "/keys",
    description: "show keyboard shortcuts",
    run(tui) {
      tui.pushBlock({ kind: "assistant", text: KEY_HELP });
    },
  },
  {
    name: "/status",
    description: "show the active session, model, cwd, context, and limits",
    run(tui) {
      const turns = tui.history.filter((message) => message.role === "user").length;
      const { tokens: ctx, budget: ctxBudget, ratio: ctxRatio } = contextUsage(tui);
      tui.pushBlock({
        kind: "assistant",
        text:
          `## Status\n\n- Session: \`${tui.sessionName ?? "none"}\`\n` +
          `- Model: \`${tui.config.model}\`\n- Cwd: \`${tui.cwd}\`\n` +
          `- Last turn: ${tui.lastTurnDurationMs == null ? "none yet" : formatDuration(tui.lastTurnDurationMs)}` +
          `${tui.lastTurnUsage ? ` (${formatTokens(tui.lastTurnUsage)})` : ""}\n` +
          `- Context: ${ctx == null ? "—" : formatChars(ctx)} / ${formatChars(ctxBudget)} tokens (${ctxRatio}%)\n` +
          `- Turns: ${turns}\n` +
          `- Limits: ${tui.config.maxSteps ?? 100} model steps, ${tui.config.maxRetries ?? 2} retries, ` +
          `${tui.config.requestTimeoutMs ?? 600_000}ms/request, ` +
          `${(tui.config.maxToolResultChars ?? 50_000).toLocaleString()} chars/tool result, ` +
          `${(tui.config.maxTurnToolResultChars ?? 400_000).toLocaleString()} chars/turn`,
      });
    },
  },
  {
    name: "/show",
    args: "<n>",
    description: "print transcript block n in full (tool results and read previews)",
    run(tui, args) {
      if (args.length !== 1) {
        tui.pushBlock({ kind: "error", text: "usage: /show <n> — print transcript block n in full" });
        return;
      }
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1) {
        tui.pushBlock({ kind: "error", text: "usage: /show <n> — n must be a whole number (1 = first block)" });
        return;
      }
      const block = tui.blocks[n - 1];
      if (!block) {
        const count = tui.blocks.length;
        tui.pushBlock({ kind: "error", text: `no block ${n}: the transcript has ${count} block${count === 1 ? "" : "s"}` });
        return;
      }
      tui.pushBlock({ kind: "assistant", text: formatBlock(tui, n, block) });
    },
  },
  {
    name: "/model",
    args: "<name>",
    description: "show or switch the model (e.g. /model gpt-4o-mini)",
    async run(tui, args) {
      if (args.length === 0) {
        tui.pushBlock({
          kind: "assistant",
          text:
            `## Model\n\nCurrent model: \`${tui.config.model}\`\n` +
            `Use \`/model <name>\` to switch. The override is saved with this session ` +
            `and restored on resume; \`/new\` resets to \`${tui.defaultModel}\`.`,
        });
      } else if (args.length > 1) {
        tui.pushBlock({ kind: "error", text: "usage: /model <name>" });
      } else {
        const model = args[0].trim();
        if (!model) {
          tui.pushBlock({ kind: "error", text: "usage: /model <name>" });
        } else if (model === tui.config.model) {
          tui.pushBlock({ kind: "result", ok: true, summary: `model is already ${model}` });
        } else {
          tui.config.model = model;
          if (tui.session) {
            await tui.session.setModel(model).catch((err) => {
              tui.pushBlock({ kind: "error", text: `could not save the model to this session: ${err.message}` });
            });
          }
          tui.pushBlock({ kind: "result", ok: true, summary: `model switched to ${model}` });
        }
      }
    },
  },
  {
    name: "/sessions",
    description: "list recent saved sessions",
    async run(tui, args) {
      if (args.length) {
        tui.pushBlock({ kind: "error", text: "/sessions does not take arguments" });
      } else if (!tui.listSessions) {
        tui.pushBlock({ kind: "error", text: "session listing is unavailable in this frontend" });
      } else {
        await tui.withLocalTask(async () => {
          const sessions = await tui.listSessions();
          const lines = sessions.map((item) => {
            const active = item.name === tui.sessionName ? "→" : "-";
            if (item.error) return `${active} \`${item.name}\` — unavailable: ${item.error}`;
            const date = new Date(item.mtime).toLocaleString();
            const size = item.size != null ? ` · ${formatChars(item.size)}B` : "";
            const prompt = item.lastPrompt
              ? ` — ${item.lastPrompt.replace(/`/g, "'").slice(0, 80)}${item.lastPrompt.length > 80 ? "…" : ""}`
              : "";
            return `${active} \`${item.name}\` — ${item.turns} turn${item.turns === 1 ? "" : "s"}, ${date}${size}${prompt}`;
          });
          tui.pushBlock({
            kind: "assistant",
            text: `## Recent sessions\n\n${lines.length ? lines.join("\n") : "No saved sessions yet."}\n\nUse \`/resume <name>\` to switch.`,
          });
        });
      }
    },
  },
  {
    name: "/delete",
    args: "<name>",
    description: "permanently delete a saved, inactive session",
    async run(tui, args) {
      if (args.length !== 1) {
        tui.pushBlock({ kind: "error", text: "usage: /delete <name>" });
      } else if (!tui.deleteSession) {
        tui.pushBlock({ kind: "error", text: "session deletion is unavailable in this frontend" });
      } else if (args[0] === tui.sessionName) {
        tui.pushBlock({ kind: "error", text: `cannot delete the active session: ${tui.sessionName}` });
      } else {
        await tui.withLocalTask(async () => {
          const target = args[0];
          const approved = await tui.confirm({
            tool: "session delete",
            args: { command: target },
            risk: "destructive",
            reason: `permanently deletes saved session ${target}; this cannot be undone`,
          });
          if (!approved) {
            tui.pushBlock({ kind: "result", ok: false, summary: `session deletion cancelled: ${target}` });
            return;
          }
          const deleted = await tui.deleteSession(target, tui.sessionName);
          await tui.refreshSessionNames();
          tui.pushBlock({ kind: "result", ok: true, summary: `deleted session ${deleted}; it cannot be recovered` });
        });
      }
    },
  },
  {
    name: "/resume",
    args: "<name>",
    description: "switch to a saved session",
    async run(tui, args) {
      if (args.length !== 1) {
        tui.pushBlock({ kind: "error", text: "usage: /resume <name>" });
      } else if (!tui.resumeSession) {
        tui.pushBlock({ kind: "error", text: "session switching is unavailable in this frontend" });
      } else if (args[0] === tui.sessionName) {
        tui.pushBlock({ kind: "result", ok: true, summary: `already in session ${tui.sessionName}` });
      } else {
        await tui.withLocalTask(async () => {
          const next = await tui.resumeSession(args[0]);
          tui.applySession(next, `resumed session ${next.sessionName}`);
          tui.refreshSessionNames();
        });
      }
    },
  },
  {
    name: "/name",
    args: "<name>",
    description: "rename the current session",
    async run(tui, args) {
      if (!args.length) {
        tui.pushBlock({ kind: "error", text: "usage: /name <name> — rename the current session" });
      } else if (!tui.renameSession) {
        tui.pushBlock({ kind: "error", text: "session renaming is unavailable in this frontend" });
      } else if (!tui.sessionName) {
        tui.pushBlock({ kind: "error", text: "no active session to rename" });
      } else {
        // Join the whitespace-split words (like /new) so a multi-word name is
        // rejected as an invalid name with the reason, not as a usage mistake.
        const nextName = args.join(" ").trim();
        if (nextName === tui.sessionName) {
          tui.pushBlock({ kind: "result", ok: true, summary: `already named ${tui.sessionName}` });
        } else {
          await tui.withLocalTask(async () => {
            const safe = await tui.renameSession(tui.sessionName, nextName, tui.session);
            // Defensive repoint for frontends whose renameSession ignores the
            // handle argument; idempotent when the store already repointed it.
            if (tui.session && typeof tui.session.renameTo === "function") tui.session.renameTo(safe);
            tui.sessionName = safe;
            tui.pushBlock({ kind: "result", ok: true, summary: `session renamed to ${safe}` });
            tui.refreshSessionNames();
          });
        }
      }
    },
  },
  {
    name: "/new",
    args: "[<name>]",
    description: "start a fresh session (optionally named)",
    async run(tui, args) {
      if (!tui.newSession) {
        tui.pushBlock({ kind: "error", text: "starting a new session is unavailable in this frontend" });
        return;
      }
      const name = args.length ? args.join(" ") : undefined;
      try {
        const next = await tui.newSession(name);
        tui.applySession({ ...next, blocks: [], history: [] }, `started session ${next.sessionName}`);
        tui.refreshSessionNames();
      } catch (err) {
        tui.pushBlock({ kind: "error", text: err.message });
      }
    },
  },
  {
    name: "/exit",
    description: "quit Argus",
    run(tui) {
      tui.stop();
    },
  },
  {
    name: "/quit",
    description: "quit Argus (same as /exit)",
    run(tui) {
      tui.stop();
    },
  },
];

/**
 * Render one transcript block in full for /show. Blocks persisted by anything
 * older than W2 may carry raw `args` instead of a `label`; both are handled,
 * and when the block links to a stored tool message (`block.id`), that full
 * result is included too — it lives in the session record whether the turn is
 * live or resumed.
 */
function formatBlock(tui, n, block) {
  const title = (t) => `## Block ${n} — ${t}\n\n`;
  switch (block.kind) {
    case "user":
    case "thinking":
    case "assistant":
      return title(block.kind) + block.text;
    case "confirm":
      return title("confirmation") + block.text;
    case "error":
      return title("error") + block.text;
    case "timing":
      return title("timing") + block.summary;
    case "tool": {
      const label = block.label ?? toolLabel(block.name ?? "", block.args ?? {});
      let out = title("tool call") + `- **call**: ${label}`;
      if (block.args) out += `\n- **arguments:**\n\n\`\`\`json\n${JSON.stringify(block.args, null, 2)}\n\`\`\``;
      return out + storedResult(tui, block.id);
    }
    case "result": {
      const status = block.ok ? "ok" : "failed";
      const timing = block.durationMs == null ? "" : ` · ${formatDuration(block.durationMs)}`;
      let out = title("tool result") + `- **${status}**: ${block.summary}${timing}`;
      if (block.detail) out += `\n\n### Preview\n\n${block.detail}`;
      return out + storedResult(tui, block.id);
    }
    default:
      return title(block.kind) + JSON.stringify(block, null, 2);
  }
}

/** The full stored tool message a block links to, when one was recorded. */
function storedResult(tui, id) {
  if (!id) return "";
  const message = tui.history.find((m) => m.role === "tool" && m.tool_call_id === id);
  if (!message) return "";
  return `\n\n### Stored result (from the session record)\n\n\`\`\`json\n${message.content}\n\`\`\``;
}

/** Name/args/description metadata for the suggestion popup and /help. */
export const SLASH_COMMANDS = COMMANDS.map(({ name, args, description }) => ({ name, args, description }));

export const COMMAND_HELP = `## Local commands

${SLASH_COMMANDS.map((c) => `- ${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`).join("\n")}`;

export const HELP_TEXT = `${COMMAND_HELP}\n\n${KEY_HELP}`;
