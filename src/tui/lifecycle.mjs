/**
 * Terminal lifecycle for the TUI: raw-mode startup, the render clock, git
 * status polling, background/theme detection, input attachment, and shutdown.
 *
 * These functions operate on a `MinimalTui` instance (or any object with the
 * same fields) so the controller stays thin and the terminal plumbing is
 * separable — the controller only keeps one-line facade methods.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { setTheme } from "../theme.mjs";

const execAsync = promisify(exec);
const ESC = "\x1b";

/** Refresh the git branch/dirty badge for the controller's cwd. */
export async function refreshGitStatus(tui) {
  const cwd = tui.cwd;
  try {
    const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd });
    const { stdout: porcelain } = await execAsync("git status --porcelain", { cwd });
    const count = porcelain.split("\n").filter((l) => l.trim()).length;
    tui.git = { branch: branch.trim() || "?", dirty: count > 0, dirtyCount: count };
  } catch {
    tui.git = { branch: null, dirty: false, dirtyCount: 0 };
  }
  tui.dirtyRendered = true;
}

/**
 * Query terminal background via OSC 11; resolves `{ light }` or
 * `{ light: null }` when the terminal doesn't answer within 400ms.
 */
export function queryBackground() {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (light) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      resolve({ light });
    };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const st = buf.indexOf("\x1b\\");
      const bel = buf.indexOf("\x07");
      let end = -1;
      if (st !== -1) end = st;
      else if (bel !== -1) end = bel;
      if (end === -1) return;
      const m = /rgb:([0-9a-fA-F]{4})\/([0-9a-fA-F]{4})\/([0-9a-fA-F]{4})/.exec(buf.slice(0, end));
      if (!m) return finish(null);
      const r = parseInt(m[1].slice(0, 2), 16);
      const g = parseInt(m[2].slice(0, 2), 16);
      const b = parseInt(m[3].slice(0, 2), 16);
      finish((r * 299 + g * 587 + b * 114) / 1000 > 127);
    };
    const timer = setTimeout(() => finish(null), 400);
    process.stdin.on("data", onData);
    process.stdout.write("\x1b]11;?\x1b\\");
  });
}

/** Enable mouse + bracketed-paste reporting and route stdin to the controller. */
export function attachInput(tui) {
  process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?2004h"); // mouse + bracketed paste
  process.stdin.on("data", (chunk) => tui.onData(chunk));
}

/**
 * Put the terminal into TUI mode: raw input, a clean screen, the render
 * clock, git polling, input attachment, and background-adaptive theme.
 */
export function startTui(tui) {
  process.once("SIGTERM", () => { void stopOnSignal(tui); });
  process.stdin.setRawMode(true);
  process.stdin.resume();
  // Clear the whole screen up front so we start from a clean slate rather than
  // relying on per-row clearing of whatever was on screen before.
  process.stdout.write(`${ESC}[2J${ESC}[H`);
  process.stdout.on("resize", () => {
    tui.width = process.stdout.columns || 80;
    tui.height = process.stdout.rows || 24;
    tui.dirtyRendered = true;
  });

  tui.timer = setInterval(() => {
    if (tui.activityStartedAt != null) {
      const tick = Math.floor((tui.now() - tui.activityStartedAt) / 100);
      if (tick !== tui.lastClockTick) {
        tui.lastClockTick = tick;
        tui.dirtyRendered = true;
      }
    }
    tui.render();
  }, 40);
  tui.gitTimer = setInterval(() => refreshGitStatus(tui), 3000);
  refreshGitStatus(tui);
  tui.dirtyRendered = true;
  tui.render();

  // Attach input immediately so keystrokes typed during theme detection are
  // not lost. The parser already ignores OSC responses.
  attachInput(tui);
  queryBackground().then((bg) => {
    if (bg.light != null) setTheme(bg.light ? "light" : "dark");
    tui.dirtyRendered = true;
    tui.render();
  });
}

/** Request a cooperative stop, then restore the terminal within a fixed bound. */
export async function stopOnSignal(tui, stop = stopTui) {
  if (tui.stopped) return;
  if (tui.mode !== "idle") tui.abortTurn();
  const deadline = Date.now() + 3_000;
  while (tui.abortController && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stop(tui, 143, 500);
}

/**
 * Tear down the TUI and exit: stop clocks, flush pending session writes, restore
 * terminal modes, exit 0.
 */
export async function stopTui(tui, exitCode = 0, flushMs = null) {
  if (tui.stopped) return;
  tui.stopped = true;
  clearInterval(tui.timer);
  clearInterval(tui.gitTimer);
  tui.clearEscTimeout();
  // Flush the queued session writes (e.g. a just-finished turn) before exit so
  // a Ctrl-D right after Enter doesn't drop the last persisted record.
  try {
    const pending = tui.session?.writeQueue?.catch?.(() => {});
    if (flushMs == null) await pending;
    else await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, flushMs))]);
  } catch {
    // the queue has no catch surface; non-fatal
  }
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l"); // restore terminal modes
  process.stdin.setRawMode(false);
  process.stdin.pause();
  tui.decoder.decode();
  process.stdout.write(`${ESC}[?25h\n`);
  process.exit(exitCode);
}
