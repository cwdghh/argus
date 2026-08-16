#!/usr/bin/env node
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
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getConfig, validateConfig } from "./config.mjs";
import { MinimalTui } from "./tui.mjs";
import { runHeadless } from "./headless.mjs";
import {
  Session,
  loadSession,
  latestSessionName,
  newSessionName,
  pruneSessions,
  sanitizeName,
  sessionSummaries,
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

export function parseArgs(argv) {
  const out = { forceNew: false, name: null, prompt: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--new") out.forceNew = true;
    else if (argv[i] === "--session") {
      const value = argv[++i];
      if (!value) throw new Error("--session requires a name");
      out.name = sanitizeName(value);
      if (!out.name) throw new Error(`invalid session name: ${value}`);
    }
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else if (argv[i] === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    else if (argv[i].startsWith("-")) throw new Error(`unknown option: ${argv[i]}`);
    else positional.push(argv[i]);
  }
  if (out.forceNew && out.name) throw new Error("--new and --session cannot be used together");
  if (out.forceNew && positional.length) throw new Error("--new is only valid in interactive mode");
  if (positional.length) out.prompt = positional.join(" ");
  return out;
}

async function main() {
  const { forceNew, name, prompt, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const config = validateConfig(getConfig());

  // Headless one-shot mode.
  if (prompt != null) {
    const session = name ? new Session(name, config) : null;
    await runHeadless(config, prompt, { session });
    return;
  }

  // Interactive TUI mode.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive mode requires a terminal; pass a prompt, for example: argus "explain this repo"');
  }
  let sessionName;
  if (name) sessionName = name;
  else if (forceNew) sessionName = newSessionName();
  else sessionName = (await latestSessionName()) ?? newSessionName();

  // Optional housekeeping: keep only the newest ARGUS_SESSION_KEEP sessions,
  // always preserving the session we are about to open.
  if (config.sessionKeep > 0) {
    await pruneSessions(config.sessionKeep, { exclude: sessionName });
  }

  const initial = await sessionState(sessionName, config);

  const tui = new MinimalTui(initial.model ? { ...config, model: initial.model } : config, {
    defaultModel: config.model,
    sessionName,
    session: initial.session,
    initialBlocks: initial.blocks,
    initialHistory: initial.history,
    initialCwd: initial.cwd,
    newSession: () => {
      const nextName = newSessionName();
      return {
        sessionName: nextName,
        session: new Session(nextName, config),
        cwd: process.cwd(),
      };
    },
    listSessions: () => sessionSummaries(20),
    resumeSession: async (nextName) => {
      const safe = sanitizeName(nextName);
      if (!safe) throw new Error(`invalid session name: ${nextName}`);
      const loaded = await loadSession(safe);
      if (!loaded) throw new Error(`session not found: ${safe}`);
      return sessionState(safe, config, loaded);
    },
  });
  tui.start();
}

async function sessionState(name, config, loaded = null) {
  const data = loaded ?? (await loadSession(name));
  const cwd = data?.meta?.cwd ?? process.cwd();
  const blocks = [];
  const history = [];
  for (const turn of data?.turns ?? []) {
    if (Array.isArray(turn.blocks)) blocks.push(...turn.blocks);
    if (Array.isArray(turn.messages)) history.push(...turn.messages);
  }
  return {
    sessionName: name,
    session: new Session(name, config, { initialCwd: data?.meta?.cwd, initialModel: data?.meta?.model }),
    blocks,
    history,
    cwd,
    model: data?.meta?.model ?? null,
  };
}

/** Compare canonical paths so npm-link/bin symlinks still execute the CLI. */
export function isMainModule(moduleUrl, entryPath) {
  if (!entryPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return moduleUrl === pathToFileURL(entryPath).href;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
