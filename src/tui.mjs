/**
 * Minimal, dependency-free terminal UI.
 *
 * Built only on Node built-ins: readline raw-mode key events + ANSI escapes.
 * It's a thin front-end over src/agent.mjs (which emits events: text_delta,
 * thinking_delta, tool_call, tool_result, ...).
 *
 * Layout (top to bottom), all rows fixed:
 *   row 0            header (brand)
 *   rows 1..H-4      transcript (scrollable history)
 *   row H-2          editor (always at the bottom, cursor follows the caret)
 *   row H-1          footer (model · path · git · mode)
 *
 * Mode is shown in the footer only — never in the history, so "working" /
 * "thinking" never pollute the transcript.
 */
import { emitKeypressEvents } from "node:readline";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runTurn } from "./agent.mjs";
import { theme } from "./theme.mjs";

const execAsync = promisify(exec);
const ESC = "\x1b";
const RESET = `${ESC}[0m`;

// ---------------------------------------------------------------------------
// ANSI + text helpers
// ---------------------------------------------------------------------------

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function styleText(text, { fg, bold, dim, italic } = {}) {
  const codes = [];
  if (fg) codes.push(`38;2;${rgb(fg).join(";")}`);
  if (bold) codes.push("1");
  if (dim) codes.push("2");
  if (italic) codes.push("3");
  if (!codes.length) return text;
  return `${ESC}[${codes.join(";")}m${text}${RESET}`;
}

function wrap(text, width) {
  if (width <= 1) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out.length ? out : [""];
}

function truncateMiddle(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 5) return text.slice(0, max);
  const lead = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${text.slice(0, lead)}…${text.slice(-tail)}`;
}

function summarize(result) {
  if (!result) return "";
  if (result.error) return result.message ?? "error";
  if (result.stdout != null) {
    const first = String(result.stdout).trim().split("\n")[0];
    return first ? `stdout: ${first.slice(0, 80)}${first.length > 80 ? "…" : ""}` : "ok (no output)";
  }
  if (result.content != null) {
    const c = String(result.content).trim();
    return c ? `${c.split("\n")[0].slice(0, 80)}${c.length > 80 ? "…" : ""}` : "ok";
  }
  if (result.ok) {
    const extra = Object.entries(result)
      .filter(([k]) => k !== "ok")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return extra ? `${extra} — ok` : "ok";
  }
  return JSON.stringify(result).slice(0, 80);
}

function formatArgs(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// ---------------------------------------------------------------------------
// Markdown rendering (minimal but functional)
// ---------------------------------------------------------------------------

function inlineTokens(text) {
  const segs = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ t: "plain", s: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) segs.push({ t: "bold", s: tok.slice(2, -2) });
    else if (tok.startsWith("*")) segs.push({ t: "italic", s: tok.slice(1, -1) });
    else segs.push({ t: "code", s: tok.slice(1, -1) });
    last = m.index + tok.length;
  }
  if (last < text.length) segs.push({ t: "plain", s: text.slice(last) });
  return segs;
}

function styleLine(plain, base = {}) {
  return inlineTokens(plain)
    .map((seg) => {
      const o = { ...base };
      if (seg.t === "bold") o.bold = true;
      else if (seg.t === "italic") o.italic = true;
      else if (seg.t === "code") {
        o.fg = theme.code;
        delete o.bold;
        delete o.italic;
      }
      return styleText(seg.s, o);
    })
    .join("");
}

function pushWrapped(out, text, base, width) {
  for (const piece of wrap(text, width)) out.push(styleLine(piece, base));
}

function renderMarkdown(text, width) {
  const out = [];
  const src = text.split("\n");
  let i = 0;
  let fence = false;
  while (i < src.length) {
    const raw = src[i];
    const trimmed = raw.trim();

    if (!fence && trimmed.startsWith("```")) {
      fence = true;
      i++;
      continue;
    }
    if (fence) {
      if (/^```/.test(trimmed)) {
        fence = false;
        i++;
        continue;
      }
      pushWrapped(out, raw, { fg: theme.code }, width);
      i++;
      continue;
    }
    if (trimmed === "") {
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      pushWrapped(out, heading[2], { fg: theme.heading, bold: true }, width);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(styleText("─".repeat(Math.min(width, 28)), { fg: theme.dim }));
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      pushWrapped(out, trimmed.replace(/^>\s?/, ""), { fg: theme.dim, italic: true }, width);
      i++;
      continue;
    }

    const list = trimmed.match(/^([-*+]|\d+\.)\s+(.*)/);
    if (list) {
      const prefix = `${list[1]} `;
      const indent = " ".repeat(prefix.length);
      wrap(list[2], Math.max(1, width - prefix.length)).forEach((ln, idx) => {
        pushWrapped(out, idx === 0 ? `${prefix}${ln}` : `${indent}${ln}`, { fg: theme.text }, width);
      });
      i++;
      continue;
    }

    // Paragraph: gather lines until a blank line or block marker.
    const parts = [raw.trim()];
    while (i + 1 < src.length) {
      const nt = src[i + 1].trim();
      if (
        nt === "" ||
        /^```/.test(nt) ||
        /^#{1,6}\s/.test(nt) ||
        /^\d+\.\s/.test(nt) ||
        /^[-*+]\s/.test(nt) ||
        /^>/.test(nt)
      )
        break;
      i++;
      parts.push(nt);
    }
    pushWrapped(out, parts.join(" "), { fg: theme.text }, width);
    i++;
  }
  return out.length ? out : [""];
}

// ---------------------------------------------------------------------------
// Block -> display lines
// ---------------------------------------------------------------------------

function blockLines(block, width) {
  switch (block.kind) {
    case "user": {
      const out = [];
      block.text.split("\n").forEach((l, idx) => {
        pushWrapped(out, `${idx === 0 ? "❯ " : "  "}${l}`, { fg: theme.user, bold: true }, width);
      });
      return out;
    }
    case "thinking": {
      const out = [];
      for (const srcLine of block.text.split("\n")) {
        const t = srcLine.trim();
        if (!t) continue;
        pushWrapped(out, `… ${t}`, { fg: theme.think, italic: true }, width);
      }
      return out;
    }
    case "assistant":
      return renderMarkdown(block.text, width);
    case "tool": {
      const out = [];
      pushWrapped(out, `  ⚙ ${block.name}(${formatArgs(block.args)})`, { fg: theme.tool, dim: true }, width);
      return out;
    }
    case "result": {
      const out = [];
      pushWrapped(out, `  ${block.ok ? "✓" : "✗"} ${block.summary}`, { fg: block.ok ? theme.good : theme.bad, dim: true }, width);
      return out;
    }
    case "error": {
      const out = [];
      pushWrapped(out, `error: ${block.text}`, { fg: theme.bad }, width);
      return out;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// The TUI
// ---------------------------------------------------------------------------

const MODE_COLOR = { idle: theme.dim, working: theme.accent, thinking: theme.think };

export class MinimalTui {
  constructor(config) {
    this.config = config;
    this.blocks = [];
    this.history = [];
    this.inputBuffer = "";
    this.inputCursor = 0;
    this.mode = "idle"; // idle | working | thinking
    this.scrollOffset = 0;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.lastFrame = [];
    this.dirtyRendered = true;
    this.git = { branch: null, dirty: false, dirtyCount: 0 };
    this.timer = null;
    this.gitTimer = null;
    this.stopped = false;
  }

  transcriptLines() {
    const out = [];
    for (const block of this.blocks) out.push(...blockLines(block, this.width));
    return out;
  }

  maxScroll() {
    return Math.max(0, this.transcriptLines().length - (this.height - 3));
  }

  // ---- input --------------------------------------------------------------

  inputView() {
    const inputWidth = Math.max(1, this.width - 3);
    let buff = this.inputBuffer;
    let cursor = this.inputCursor;
    if (buff.length > inputWidth) {
      let start = cursor - Math.floor(inputWidth / 2);
      start = Math.max(0, Math.min(start, buff.length - inputWidth));
      buff = buff.slice(start, start + inputWidth);
      cursor -= start;
    }
    return { text: buff, col: 2 + cursor };
  }

  // ---- events from the agent ----------------------------------------------

  pushBlock(block) {
    this.blocks.push(block);
    this.dirtyRendered = true;
  }

  append(kind, delta) {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === kind) last.text += delta;
    else this.blocks.push({ kind, text: delta });
    this.dirtyRendered = true;
  }

  async submit() {
    if (this.mode !== "idle") {
      this.inputBuffer = "";
      this.inputCursor = 0;
      this.dirtyRendered = true;
      return;
    }
    const text = this.inputBuffer.trim();
    this.inputBuffer = "";
    this.inputCursor = 0;
    this.mode = "working";
    this.dirtyRendered = true;
    if (!text) return;

    this.pushBlock({ kind: "user", text });
    try {
      const { messages } = await runTurn(this.config, this.history, text, (ev) => {
        if (ev.type === "thinking_delta") {
          this.append("thinking", ev.delta);
          this.mode = "thinking";
        } else if (ev.type === "text_delta") {
          this.append("assistant", ev.delta);
          this.mode = "working";
        } else if (ev.type === "tool_call") {
          this.pushBlock({ kind: "tool", name: ev.name, args: ev.args });
          this.mode = "working";
        } else if (ev.type === "tool_result") {
          this.pushBlock({ kind: "result", ok: ev.ok, summary: summarize(ev.result) });
          this.mode = "working";
        }
        this.dirtyRendered = true;
      });
      this.history.push(...messages);
    } catch (err) {
      this.pushBlock({ kind: "error", text: err.message });
    } finally {
      this.mode = "idle";
      this.scrollOffset = 0; // jump to the newest content
      this.dirtyRendered = true;
    }
  }

  // ---- frame building -----------------------------------------------------

  footer() {
    const model = `model ${this.config.model}`;
    const git =
      this.git.branch != null
        ? `git ${this.git.branch}${this.git.dirty ? ` ~${this.git.dirtyCount}` : " ✓"}`
        : "git -";
    const mode = `mode ${this.mode}`;
    const sep = styleText("  ·  ", { fg: theme.dim });
    const cwdLen = Math.max(8, this.width - model.length - git.length - mode.length - sep.length * 3 - 4);
    const path = truncateMiddle(process.cwd(), cwdLen);

    const meta = [
      styleText(model, { fg: theme.text }),
      styleText(path, { fg: theme.dim }),
      styleText(git, { fg: this.git.dirty ? theme.bad : theme.good }),
    ].join(sep);

    const modeStyled = styleText(mode, { fg: MODE_COLOR[this.mode] ?? theme.dim, bold: this.mode !== "idle" });
    return `${meta}${sep}${modeStyled}`;
  }

  buildFrame() {
    const frame = new Array(this.height).fill("");
    const width = this.width;

    // header
    frame[0] =
      styleText("argus", { fg: theme.accent, bold: true }) +
      styleText("  ·  minimal coding agent", { fg: theme.dim });

    // scrollable transcript
    const lines = this.transcriptLines();
    const transcriptHeight = Math.max(1, this.height - 3);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());
    const start = Math.max(0, lines.length - transcriptHeight - this.scrollOffset);
    for (let r = 0; r < transcriptHeight; r++) {
      frame[1 + r] = lines[start + r] ?? "";
    }

    // editor (always at the bottom)
    const { text, col } = this.inputView();
    frame[this.height - 2] = `${styleText("❯", { fg: theme.accent, bold: true })} ${text}`;
    this.inputCol = col;

    // footer
    frame[this.height - 1] = this.footer();

    return frame;
  }

  // ---- key handling -------------------------------------------------------

  onKey(str, key) {
    if (this.stopped) return;
    if (key.ctrl && (key.name === "c" || key.name === "d")) return this.stop();
    const k = key.name;

    if (k === "return" || k === "enter") return this.submit();
    if (k === "backspace") {
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - 1) + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor = Math.max(0, this.inputCursor - 1);
    } else if (k === "delete") {
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + this.inputBuffer.slice(this.inputCursor + 1);
    } else if (k === "left") {
      this.inputCursor = Math.max(0, this.inputCursor - 1);
    } else if (k === "right") {
      this.inputCursor = Math.min(this.inputBuffer.length, this.inputCursor + 1);
    } else if (k === "up") {
      this.scrollOffset = Math.min(this.scrollOffset + 1, this.maxScroll());
    } else if (k === "down") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (k === "pageup") {
      this.scrollOffset = Math.min(this.scrollOffset + (this.height - 3), this.maxScroll());
    } else if (k === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - (this.height - 3));
    } else if (k === "home") {
      this.scrollOffset = this.maxScroll();
    } else if (k === "end") {
      this.scrollOffset = 0;
    } else if (str && !key.ctrl && !key.meta && k !== "escape" && k !== "undefined") {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursor) + str + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor += str.length;
    } else {
      return;
    }
    this.dirtyRendered = true;
  }

  // ---- startup / lifecycle ------------------------------------------------

  async refreshGitStatus() {
    const cwd = process.cwd();
    try {
      const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd });
      const { stdout: porcelain } = await execAsync("git status --porcelain", { cwd });
      const count = porcelain.split("\n").filter((l) => l.trim()).length;
      this.git = { branch: branch.trim() || "?", dirty: count > 0, dirtyCount: count };
    } catch {
      this.git = { branch: null, dirty: false, dirtyCount: 0 };
    }
    this.dirtyRendered = true;
  }

  start() {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", (str, key) => this.onKey(str, key));

    process.stdout.on("resize", () => {
      this.width = process.stdout.columns || 80;
      this.height = process.stdout.rows || 24;
      this.dirtyRendered = true;
    });

    this.timer = setInterval(() => this.render(), 40);
    this.gitTimer = setInterval(() => this.refreshGitStatus(), 3000);
    this.refreshGitStatus();
    this.dirtyRendered = true;
    this.render();
  }

  render() {
    if (!this.dirtyRendered) return;
    this.dirtyRendered = false;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    const frame = this.buildFrame();
    process.stdout.write(`${ESC}[?25l`);
    for (let r = 0; r < this.height; r++) {
      if (frame[r] !== this.lastFrame[r]) {
        process.stdout.cursorTo(0, r);
        process.stdout.write(`${ESC}[2K`);
        process.stdout.write(frame[r]);
        this.lastFrame[r] = frame[r];
      }
    }
    // put the caret exactly at the editing position in the bottom editor
    process.stdout.cursorTo(Math.min(this.inputCol, this.width - 1), this.height - 2);
    process.stdout.write(`${ESC}[?25h`);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.gitTimer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ESC}[?25h\n`);
    process.exit(0);
  }
}
