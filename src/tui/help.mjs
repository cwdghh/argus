/**
 * Local slash commands and the `/help` / `/keys` reference text.
 *
 * The command table is the single source of truth: the same list drives the
 * in-editor suggestion popup (see `suggestions.mjs`) and the `/help` command,
 * so a new command only has to be added in one place.
 */
export const SLASH_COMMANDS = [
  { name: "/help", description: "show commands and keyboard shortcuts" },
  { name: "/keys", description: "show keyboard shortcuts" },
  { name: "/status", description: "show the active session, model, cwd, context, and limits" },
  { name: "/model", description: "show or switch the model (e.g. /model gpt-4o-mini)" },
  { name: "/sessions", description: "list recent saved sessions" },
  { name: "/resume", description: "switch to a saved session" },
  { name: "/new", description: "start a fresh session without restarting Argus" },
  { name: "/exit", description: "quit Argus" },
  { name: "/quit", description: "quit Argus (same as /exit)" },
];

export const COMMAND_HELP = `## Local commands

${SLASH_COMMANDS.map((c) => `- ${c.name}${c.name === "/resume" ? " <name>" : ""} — ${c.description}`).join("\n")}`;

export const KEY_HELP = `## Keyboard shortcuts

### Edit the prompt

- Left / Right — move the cursor
- Ctrl-A / Ctrl-E — move to the start / end
- Backspace / Delete — delete before / under the cursor
- Ctrl-U / Ctrl-K — delete to the start / end
- Ctrl-W — delete the previous word
- Up / Down — move through the suggestion popup; recall earlier prompts otherwise
- Tab — accept the suggested @path or /command
- Shift+Enter — insert a newline
- Enter — submit

### Control Argus

- Esc — abort the active turn
- Ctrl-C — abort; press again to force quit (or quit immediately when idle)
- Ctrl-D — delete under the cursor, or quit when the prompt is empty
- Ctrl-L — clear and redraw the screen

### Browse the transcript

- PgUp / PgDn or mouse wheel — scroll the transcript by a page
- Home / End — jump to the top / bottom`;

export const HELP_TEXT = `${COMMAND_HELP}\n\n${KEY_HELP}`;
