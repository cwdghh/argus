/**
 * Entry point: resolve the session, then start the TUI.
 *
 * Usage:
 *   npm start                 auto-resume the most recent session (or start fresh)
 *   npm start -- --new        start a brand-new session
 *   npm start -- --session X  resume/create a session named X
 */
import { getConfig } from "./config.mjs";
import { MinimalTui } from "./tui.mjs";
import {
  Session,
  loadSession,
  latestSessionName,
  newSessionName,
  sanitizeName,
} from "./session.mjs";

function parseArgs(argv) {
  const out = { forceNew: false, name: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--new") out.forceNew = true;
    else if (argv[i] === "--session") out.name = sanitizeName(argv[i + 1]) ?? null;
  }
  return out;
}

async function main() {
  const { forceNew, name } = parseArgs(process.argv.slice(2));
  const config = getConfig();

  let sessionName;
  if (name) {
    sessionName = name;
  } else if (forceNew) {
    sessionName = newSessionName();
  } else {
    sessionName = (await latestSessionName()) ?? newSessionName();
  }

  const loaded = await loadSession(sessionName);
  const turns = loaded?.turns ?? [];

  const initialBlocks = [];
  const initialHistory = [];
  for (const turn of turns) {
    if (Array.isArray(turn.blocks)) initialBlocks.push(...turn.blocks);
    if (Array.isArray(turn.messages)) initialHistory.push(...turn.messages);
  }

  const session = new Session(sessionName, config);
  const tui = new MinimalTui(config, { sessionName, session, initialBlocks, initialHistory });
  tui.start();
}

main();
