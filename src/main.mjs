/**
 * Entry point.
 *
 *   argus                          start the TUI (auto-resume latest session)
 *   argus --new                    start a fresh TUI session
 *   argus --session <name>         TUI: resume/create a named session
 *   argus "<prompt>"               headless: run one prompt to stdout
 *   argus "<prompt>" --session X   headless: append to a named session (resumes it)
 *   argus --help                   show usage
 */
import { getConfig } from "./config.mjs";
import { MinimalTui } from "./tui.mjs";
import { runHeadless } from "./headless.mjs";
import {
  Session,
  loadSession,
  latestSessionName,
  newSessionName,
  sanitizeName,
} from "./session.mjs";

const USAGE = `argus — minimal coding agent

Usage:
  argus                           start the TUI (resume latest session)
  argus --new                     start a fresh TUI session
  argus --session <name>          TUI: resume/create a named session
  argus "<prompt>"                headless: run one prompt to stdout
  argus "<prompt>" --session X    headless: append to a named session
  argus --help                    show this help

Headless streams assistant text to stdout; reasoning, tool calls and errors go
to stderr, so stdout stays clean for piping.
`;

function parseArgs(argv) {
  const out = { forceNew: false, name: null, prompt: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--new") out.forceNew = true;
    else if (argv[i] === "--session") out.name = sanitizeName(argv[i + 1]) ?? null;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else if (out.prompt == null && !argv[i].startsWith("-")) out.prompt = argv[i];
  }
  return out;
}

async function main() {
  const { forceNew, name, prompt, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(USAGE);
    return;
  }
  const config = getConfig();

  // Headless one-shot mode.
  if (prompt != null) {
    const session = name ? new Session(name, config) : null;
    await runHeadless(config, prompt, { session });
    return;
  }

  // Interactive TUI mode.
  let sessionName;
  if (name) sessionName = name;
  else if (forceNew) sessionName = newSessionName();
  else sessionName = (await latestSessionName()) ?? newSessionName();

  const loaded = await loadSession(sessionName);
  const turns = loaded?.turns ?? [];
  const initialCwd = loaded?.meta?.cwd ?? process.cwd();

  const initialBlocks = [];
  const initialHistory = [];
  for (const turn of turns) {
    if (Array.isArray(turn.blocks)) initialBlocks.push(...turn.blocks);
    if (Array.isArray(turn.messages)) initialHistory.push(...turn.messages);
  }

  const session = new Session(sessionName, config);
  const tui = new MinimalTui(config, { sessionName, session, initialBlocks, initialHistory, initialCwd });
  tui.start();
}

main();
