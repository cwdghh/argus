/**
 * Minimal, dependency-free terminal UI.
 *
 * Built only on Node built-ins: raw-mode input parsing + ANSI escapes. It's a
 * thin front-end over src/agent.mjs (which emits events: text_delta,
 * thinking_delta, tool_call, tool_result, ...).
 *
 * Layout (top to bottom), all rows fixed:
 *   row 0            header (brand)
 *   rows 1..H-4      transcript (scrollable history)
 *   row H-2          editor (always at the bottom, caret follows the cursor)
 *   row H-1          footer (live phase/time · model · path · git)
 *
 * Controls:
 *   Up/Down          navigate past inputs (input history)
 *   PgUp/PgDn        scroll the transcript by a page
 *   Home/End         jump to top / bottom of the transcript
 *   mouse wheel      scroll the transcript (SGR mouse tracking)
 *   Left/Right       move the editor caret
 *   Ctrl-A/E         move to start/end of input
 *   Ctrl-U/K/W       delete to start/end/previous word
 *   Ctrl-L           redraw the terminal
 *   Ctrl-C           abort a turn / quit when idle
 *   Ctrl-D           delete at cursor / quit on empty input
 *   /help             show local commands
 */
import { exec } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runTurn } from "./agent.mjs";
import { COMPACT_DEFAULTS, estimateChars } from "./compact.mjs";
import { theme, setTheme } from "./theme.mjs";

const execAsync = promisify(exec);
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const COMMAND_HELP = `## Local commands

- /help — show commands and keyboard shortcuts
- /keys — show keyboard shortcuts
- /status — show the active session, model, cwd, context, and limits
- /sessions — list recent saved sessions
- /resume <name> — switch to a saved session
- /new — start a fresh session without restarting Argus
- /exit or /quit — quit Argus`;

const KEY_HELP = `## Keyboard shortcuts

### Edit the prompt

- Left / Right — move the cursor
- Ctrl-A / Ctrl-E — move to the start / end
- Backspace / Delete — delete before / under the cursor
- Ctrl-U / Ctrl-K — delete to the start / end
- Ctrl-W — delete the previous word
- Up / Down — recall earlier prompts
- Tab — complete an @path file reference
- Enter — submit

### Control Argus

- Esc — abort the active turn
- Ctrl-C — abort; press again to force quit (or quit immediately when idle)
- Ctrl-D — delete under the cursor, or quit when the prompt is empty
- Ctrl-L — clear and redraw the screen

### Browse the transcript

- PgUp / PgDn or mouse wheel — scroll
- Home / End — jump to the top / bottom`;

const HELP_TEXT = `${COMMAND_HELP}\n\n${KEY_HELP}`;

// ---------------------------------------------------------------------------
// ANSI + text helpers
// ---------------------------------------------------------------------------

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function styleText(text, { fg, bold, dim, italic, underline, strike } = {}) {
  // Never let model/tool/file content inject terminal control sequences.
  text = String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const codes = [];
  if (fg) codes.push(`38;2;${rgb(fg).join(";")}`);
  if (bold) codes.push("1");
  if (dim) codes.push("2");
  if (italic) codes.push("3");
  if (underline) codes.push("4");
  if (strike) codes.push("9");
  if (!codes.length) return text;
  return `${ESC}[${codes.join(";")}m${text}${RESET}`;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrap(text, width) {
  width = Math.max(1, width);
  const out = [];
  let line = "";
  let columns = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (line && columns + cw > width) {
      out.push(line);
      line = "";
      columns = 0;
    }
    line += ch;
    columns += cw;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function previousCharIndex(text, index) {
  if (index <= 0) return 0;
  const cp = text.codePointAt(index - 1);
  return index - (cp >= 0xdc00 && cp <= 0xdfff ? 2 : 1);
}

function nextCharIndex(text, index) {
  if (index >= text.length) return text.length;
  const cp = text.codePointAt(index);
  return index + (cp > 0xffff ? 2 : 1);
}

function previousWordIndex(text, index) {
  let i = index;
  while (i > 0 && /\s/.test(text.slice(previousCharIndex(text, i), i))) i = previousCharIndex(text, i);
  while (i > 0 && !/\s/.test(text.slice(previousCharIndex(text, i), i))) i = previousCharIndex(text, i);
  return i;
}

function truncateMiddle(text, max) {
  if (max <= 0) return "";
  if (dispWidth(text) <= max) return text;
  if (max === 1) return "…";

  const chars = [...text];
  const leftBudget = Math.ceil((max - 1) / 2);
  const rightBudget = Math.floor((max - 1) / 2);
  let left = "";
  let leftWidth = 0;
  for (const ch of chars) {
    const width = charWidth(ch);
    if (leftWidth + width > leftBudget) break;
    left += ch;
    leftWidth += width;
  }
  let right = "";
  let rightWidth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const width = charWidth(chars[i]);
    if (rightWidth + width > rightBudget) break;
    right = chars[i] + right;
    rightWidth += width;
  }
  return `${left}…${right}`;
}

function truncateEnd(text, max) {
  if (max <= 0) return "";
  if (dispWidth(text) <= max) return text;
  if (max === 1) return "…";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const charColumns = charWidth(ch);
    if (width + charColumns > max - 1) break;
    out += ch;
    width += charColumns;
  }
  return `${out}…`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  if (seconds > 0 && seconds < 0.1) return "<0.1s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
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
// Markdown: inline tokenisation (streaming-tolerant, nested)
// ---------------------------------------------------------------------------

/**
 * Parse inline markdown into a token tree. Unclosed markers are treated as
 * literal text so streaming output doesn't flicker between styled/plain.
 * Supports: backtick code, **bold**, *italic*, ~~strikethrough~~, [text](url),
 * and backslash escapes — with nesting (e.g. bold containing code).
 */
function parseInlineTokens(text) {
  const tokens = [];
  let plain = "";
  let i = 0;
  const flushPlain = () => {
    if (plain) {
      tokens.push({ type: "text", text: plain });
      plain = "";
    }
  };

  const findCloser = (marker) => text.indexOf(marker, i + marker.length);

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const closer = findCloser("`");
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "code", text: text.slice(i + 1, closer) });
        i = closer + 1;
      } else {
        plain += ch;
        i++;
      }
      continue;
    }
    if (text.startsWith("**", i)) {
      const closer = text.indexOf("**", i + 2);
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "strong", children: parseInlineTokens(text.slice(i + 2, closer)) });
        i = closer + 2;
      } else {
        plain += text.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (text.startsWith("~~", i)) {
      const closer = text.indexOf("~~", i + 2);
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "del", children: parseInlineTokens(text.slice(i + 2, closer)) });
        i = closer + 2;
      } else {
        plain += text.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        if (end !== -1) {
          flushPlain();
          tokens.push({
            type: "link",
            children: parseInlineTokens(text.slice(i + 1, close)),
            href: text.slice(close + 2, end),
          });
          i = end + 1;
          continue;
        }
      }
      plain += ch;
      i++;
      continue;
    }
    if (ch === "*" || ch === "_") {
      const closer = text.indexOf(ch, i + 1);
      if (closer !== -1) {
        flushPlain();
        tokens.push({ type: "em", children: parseInlineTokens(text.slice(i + 1, closer)) });
        i = closer + 1;
      } else {
        plain += ch;
        i++;
      }
      continue;
    }
    plain += ch;
    i++;
  }
  flushPlain();
  return tokens;
}

function plainOf(tokens) {
  let s = "";
  for (const t of tokens) {
    if (t.type === "text") s += t.text;
    else if (t.type === "code") s += t.text;
    else if (t.children) s += plainOf(t.children);
  }
  return s;
}

/** Flatten an inline token tree into styled text segments. */
function segsFromInline(text, base) {
  const out = [];
  const render = (tok, style) => {
    if (tok.type === "text") {
      out.push({ text: tok.text, style });
      return;
    }
    if (tok.type === "code") {
      out.push({ text: tok.text, style: { ...base, fg: theme.code } });
      return;
    }
    if (tok.type === "link") {
      for (const c of tok.children) render(c, { ...style, underline: true });
      const textPlain = plainOf(tok.children);
      if (tok.href && tok.href !== textPlain) {
        out.push({ text: ` (${tok.href})`, style: { ...base, fg: theme.dim } });
      }
      return;
    }
    const childStyle =
      tok.type === "strong"
        ? { ...style, bold: true }
        : tok.type === "em"
          ? { ...style, italic: true }
          : { ...style, strike: true };
    for (const c of tok.children) render(c, childStyle);
  };
  for (const t of parseInlineTokens(text)) render(t, base);
  return out;
}

/** Approximate terminal column width of one char (East Asian wide = 2). */
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo init. consonants
      cp === 0x2329 || cp === 0x232a || // angle brackets
      (0x2e80 <= cp && cp <= 0xa4cf && cp !== 0x303f) || // CJK ... Yi
      (0xac00 <= cp && cp <= 0xd7a3) || // Hangul Syllables
      (0xf900 <= cp && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (0xfe10 <= cp && cp <= 0xfe19) || // Vertical forms
      (0xfe30 <= cp && cp <= 0xfe6f) || // CJK Compatibility Forms
      (0xff00 <= cp && cp <= 0xff60) || // Fullwidth Forms
      (0xffe0 <= cp && cp <= 0xffe6) || // Fullwidth Signs
      (0x1f300 <= cp && cp <= 0x1f64f) || // Emoji
      (0x1f900 <= cp && cp <= 0x1f9ff) || // Supplemental Emoji
      (0x20000 <= cp && cp <= 0x2fffd) || // CJK Ext B
      (0x30000 <= cp && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

/** Approximate terminal display width of a string. */
function dispWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Wrap styled segments into lines of `width` visible columns. */
function wrapSegments(segs, width) {
  const max = Math.max(1, width);
  const lines = [];
  let cur = [];
  let len = 0;
  for (const seg of segs) {
    let rest = seg.text;
    while (rest.length > 0) {
      if (len >= max) {
        lines.push(cur);
        cur = [];
        len = 0;
      }
      let take = 0;
      let tw = 0;
      for (const ch of rest) {
        const cw = charWidth(ch);
        if (len + tw + cw > max) break;
        tw += cw;
        take += ch.length;
      }
      if (take === 0) {
        take = rest[0].length;
        tw = charWidth(rest.slice(0, take));
      }
      cur.push({ text: rest.slice(0, take), style: seg.style });
      len += tw;
      rest = rest.slice(take);
    }
  }
  if (cur.length || lines.length === 0) lines.push(cur);
  return lines.map((ls) => ls.map((s) => styleText(s.text, s.style)).join(""));
}

/** Render a single run of plain text with a base style, wrapped to width. */
function renderSimple(text, base, width) {
  return wrapSegments(segsFromInline(text, base), width);
}

/** Render markdown (block-level) to wrapped, styled lines. */
function markdownLines(text, width) {
  const lines = [];
  const src = text.split("\n");
  let i = 0;
  let fence = false;
  let fenceLang = "";
  while (i < src.length) {
    const raw = src[i];
    const trimmed = raw.trim();

    if (!fence && /^```/.test(trimmed)) {
      fence = true;
      fenceLang = trimmed.slice(3).trim();
      lines.push(styleText(`  ${"```"}${fenceLang}`, { fg: theme.dim }));
      i++;
      continue;
    }
    if (fence) {
      if (/^```/.test(trimmed)) {
        fence = false;
        lines.push(styleText("  ```", { fg: theme.dim }));
        i++;
        continue;
      }
      for (const piece of wrap(raw, Math.max(1, width - 2))) lines.push(styleText(`  ${piece}`, { fg: theme.code }));
      i++;
      continue;
    }
    if (trimmed === "") {
      lines.push("");
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      lines.push(...renderSimple(heading[2], { fg: theme.heading, bold: true }, width));
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      lines.push(styleText("─".repeat(Math.min(28, width)), { fg: theme.dim }));
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      lines.push(...renderSimple(trimmed.replace(/^>\s?/, ""), { fg: theme.dim, italic: true }, width));
      i++;
      continue;
    }

    const list = trimmed.match(/^([-*+]|\d+\.)\s+(.*)/);
    if (list) {
      const prefix = `${list[1]} `;
      const contentWidth = Math.max(1, width - prefix.length);
      const wrapped = wrapSegments(segsFromInline(list[2], { fg: theme.text }), contentWidth);
      wrapped.forEach((ln, idx) => {
        lines.push((idx === 0 ? prefix : " ".repeat(prefix.length)) + ln);
      });
      i++;
      continue;
    }

        // Preserve the model's newlines as hard line breaks (chat rendering),
    // so single newlines in output stay as separate lines.
    lines.push(...renderSimple(raw.trim(), { fg: theme.text }, width));
    i++;
  }
  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------
// Block -> display lines
// ---------------------------------------------------------------------------

function blockLines(block, width) {
  switch (block.kind) {
    case "user": {
      const out = [];
      block.text.split("\n").forEach((l, idx) => {
        out.push(...renderSimple(`${idx === 0 ? "❯ " : "  "}${l}`, { fg: theme.user, bold: true }, width));
      });
      return out;
    }
    case "thinking": {
      const out = [];
      for (const l of block.text.split("\n")) {
        const t = l.trim();
        if (!t) continue;
        out.push(...renderSimple(`… ${t}`, { fg: theme.think, italic: true }, width));
      }
      return out;
    }
    case "assistant":
      return markdownLines(block.text, width);
    case "tool":
      return renderSimple(`  ⚙ ${block.name}(${formatArgs(block.args)})`, { fg: theme.tool, dim: true }, width);
    case "result": {
      const timing = block.durationMs == null ? "" : `${formatDuration(block.durationMs)} · `;
      return renderSimple(`  ${block.ok ? "✓" : "✗"} ${timing}${block.summary}`, { fg: block.ok ? theme.good : theme.bad, dim: true }, width);
    }
    case "timing":
      return renderSimple(`  ◷ ${block.summary}`, { fg: theme.dim, dim: true }, width);
    case "error":
      return renderSimple(`error: ${block.text}`, { fg: theme.bad }, width);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// The TUI
// ---------------------------------------------------------------------------

const MODE_COLOR = () => ({ idle: theme.dim, working: theme.accent, thinking: theme.think, aborting: theme.bad, confirm: theme.bad });
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class MinimalTui {
  constructor(config, opts = {}) {
    this.config = config;
    this.blocks = opts.initialBlocks ?? [];
    if (this.blocks.length > 0) {
      this.blocks.unshift({ kind: "result", ok: true, summary: `resumed session${opts.sessionName ? ` ${opts.sessionName}` : ""}` });
    }
    this.history = opts.initialHistory ?? [];
    this.sessionName = opts.sessionName ?? null;
    this.session = opts.session ?? null;
    this.newSession = opts.newSession ?? null;
    this.listSessions = opts.listSessions ?? null;
    this.resumeSession = opts.resumeSession ?? null;
    this.cwd = opts.initialCwd ?? process.cwd();
    this.inputBuffer = "";
    this.inputCursor = 0;
    this.inputHistory = this.history
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content);
    this.historyIndex = -1;
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
    this.rawBuf = "";
    this.decoder = new TextDecoder();
    this.abortController = null;
    this.aborting = false;
    this.escTimer = null;
    this.pendingConfirm = null;
    this.pasting = false;
    this.now = opts.now ?? Date.now;
    this.activityStartedAt = null;
    this.lastTurnDurationMs = [...this.blocks].reverse().find((block) => block.kind === "timing")?.durationMs ?? null;
    this.lastClockTick = -1;
    this.activeToolStartedAt = null;
  }

  transcriptLines() {
    const out = [];
    let seen = false;
    for (const block of this.blocks) {
      if (block.kind === "user" && seen) {
        out.push(styleText(`  ${"─".repeat(Math.min(20, Math.max(4, this.width - 4)))}`, { fg: theme.dim }));
      }
      seen = true;
      out.push(...blockLines(block, this.width));
    }
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
    if (dispWidth(buff) > inputWidth) {
      // Window centered-ish on the caret, measured in display columns.
      const before = dispWidth(buff.slice(0, cursor));
      const minBefore = Math.max(0, before - Math.floor(inputWidth / 2));
      let start = 0;
      let startW = 0;
      for (const ch of buff) {
        const cw = charWidth(ch);
        if (startW + cw > minBefore) break;
        startW += cw;
        start += ch.length;
      }
      let end = start;
      let endW = 0;
      for (const ch of buff.slice(start)) {
        const cw = charWidth(ch);
        if (endW + cw > inputWidth) break;
        endW += cw;
        end += ch.length;
      }
      buff = buff.slice(start, end);
      cursor = dispWidth(buff.slice(0, Math.max(0, cursor - start)));
    } else {
      cursor = dispWidth(buff.slice(0, cursor));
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
    if (this.mode !== "idle") return;
    const text = this.inputBuffer.trim();
    if (!text) return;
    this.inputBuffer = "";
    this.inputCursor = 0;
    if (text.startsWith("/")) {
      await this.runCommand(text);
      return;
    }
    this.mode = "working";
    this.activityStartedAt = this.now();
    this.lastClockTick = -1;
    this.dirtyRendered = true;

    if (this.inputHistory[this.inputHistory.length - 1] !== text) this.inputHistory.push(text);
    this.historyIndex = -1;
    const turnStart = this.blocks.length;
    this.pushBlock({ kind: "user", text });

    const ac = new AbortController();
    this.abortController = ac;
    let savedMessages = [{ role: "user", content: text }];
    let outcome = "completed";
    try {
      const { messages, aborted, cwd } = await runTurn(this.config, this.history, text, (ev) => {
        if (ev.type === "thinking_delta") {
          this.append("thinking", ev.delta);
          this.mode = "thinking";
        } else if (ev.type === "text_delta") {
          this.append("assistant", ev.delta);
          if (this.mode !== "aborting") this.mode = "working";
        } else if (ev.type === "tool_call") {
          this.activeToolStartedAt = this.now();
          this.pushBlock({ kind: "tool", name: ev.name, args: ev.args });
          if (this.mode !== "aborting") this.mode = "working";
        } else if (ev.type === "tool_result") {
          const durationMs = this.activeToolStartedAt == null ? null : this.now() - this.activeToolStartedAt;
          this.activeToolStartedAt = null;
          this.pushBlock({ kind: "result", ok: ev.ok, summary: summarize(ev.result), durationMs });
          if (this.mode !== "aborting") this.mode = "working";
        } else if (ev.type === "cwd_change") {
          this.cwd = ev.cwd;
          if (this.session) this.session.setCwd(ev.cwd).catch(() => {});
        } else if (ev.type === "compacted") {
          this.pushBlock({ kind: "result", ok: true, summary: "… earlier context compacted" });
          if (this.mode !== "aborting") this.mode = "working";
        }
        this.dirtyRendered = true;
      }, { signal: ac.signal, cwd: this.cwd, confirm: (cmd) => this.confirm(cmd) });
      savedMessages = messages;
      this.history.push(...messages);
      if (typeof cwd === "string") this.cwd = cwd;
      if (aborted || ac.signal.aborted) {
        outcome = "interrupted";
        this.pushBlock({ kind: "result", ok: false, summary: "⏹ interrupted" });
      }
    } catch (err) {
      savedMessages = err.turnMessages ?? savedMessages;
      this.history.push(...savedMessages);
      if (ac.signal.aborted) {
        outcome = "interrupted";
        this.pushBlock({ kind: "result", ok: false, summary: "⏹ interrupted" });
      } else {
        outcome = "failed";
        this.pushBlock({ kind: "error", text: err.message });
      }
    } finally {
      const durationMs = this.activityStartedAt == null ? 0 : this.now() - this.activityStartedAt;
      this.lastTurnDurationMs = durationMs;
      this.pushBlock({ kind: "timing", summary: `${outcome} in ${formatDuration(durationMs)}`, durationMs });
      if (this.session) {
        try {
          await this.session.setCwd(this.cwd);
          await this.session.appendTurn({
            config: {
              baseUrl: this.config.baseUrl,
              model: this.config.model,
              systemPrompt: this.config.systemPrompt,
              requestTimeoutMs: this.config.requestTimeoutMs,
              maxRetries: this.config.maxRetries,
              maxSteps: this.config.maxSteps,
              maxToolResultChars: this.config.maxToolResultChars,
            },
            messages: savedMessages,
            blocks: this.blocks.slice(turnStart),
          });
        } catch (err) {
          this.pushBlock({ kind: "error", text: `could not save session: ${err.message}` });
        }
      }
      this.abortController = null;
      this.aborting = false;
      this.activeToolStartedAt = null;
      this.activityStartedAt = null;
      this.mode = "idle";
      this.scrollOffset = 0;
      this.dirtyRendered = true;
    }
  }

  async runCommand(text) {
    const [command, ...args] = text.split(/\s+/);
    this.historyIndex = -1;
    if (command === "/help") {
      this.pushBlock({ kind: "assistant", text: HELP_TEXT });
    } else if (command === "/keys") {
      this.pushBlock({ kind: "assistant", text: KEY_HELP });
    } else if (command === "/status") {
      const turns = this.history.filter((message) => message.role === "user").length;
      const contextChars = estimateChars(this.history);
      const compactAt = COMPACT_DEFAULTS.compactAtChars;
      this.pushBlock({
        kind: "assistant",
        text:
          `## Status\n\n- Session: \`${this.sessionName ?? "none"}\`\n` +
          `- Model: \`${this.config.model}\`\n- Cwd: \`${this.cwd}\`\n` +
          `- Last turn: ${this.lastTurnDurationMs == null ? "none yet" : formatDuration(this.lastTurnDurationMs)}\n` +
          `- Context: ${turns} turns, ${contextChars.toLocaleString()} / ${compactAt.toLocaleString()} estimated chars\n` +
          `- Limits: ${this.config.maxSteps ?? 25} model steps, ${this.config.maxRetries ?? 2} retries, ` +
          `${this.config.requestTimeoutMs ?? 120_000}ms/request, ` +
          `${(this.config.maxToolResultChars ?? 50_000).toLocaleString()} chars/tool result`,
      });
    } else if (command === "/sessions") {
      if (args.length) {
        this.pushBlock({ kind: "error", text: "/sessions does not take arguments" });
      } else if (!this.listSessions) {
        this.pushBlock({ kind: "error", text: "session listing is unavailable in this frontend" });
      } else {
        await this.withLocalTask(async () => {
          const sessions = await this.listSessions();
          const lines = sessions.map((item) => {
            const active = item.name === this.sessionName ? "→" : "-";
            const date = new Date(item.mtime).toLocaleString();
            const prompt = item.lastPrompt
              ? ` — ${item.lastPrompt.replace(/`/g, "'").slice(0, 80)}${item.lastPrompt.length > 80 ? "…" : ""}`
              : "";
            return `${active} \`${item.name}\` — ${item.turns} turn${item.turns === 1 ? "" : "s"}, ${date}${prompt}`;
          });
          this.pushBlock({
            kind: "assistant",
            text: `## Recent sessions\n\n${lines.length ? lines.join("\n") : "No saved sessions yet."}\n\nUse \`/resume <name>\` to switch.`,
          });
        });
      }
    } else if (command === "/resume") {
      if (args.length !== 1) {
        this.pushBlock({ kind: "error", text: "usage: /resume <name>" });
      } else if (!this.resumeSession) {
        this.pushBlock({ kind: "error", text: "session switching is unavailable in this frontend" });
      } else if (args[0] === this.sessionName) {
        this.pushBlock({ kind: "result", ok: true, summary: `already in session ${this.sessionName}` });
      } else {
        await this.withLocalTask(async () => {
          const next = await this.resumeSession(args[0]);
          this.applySession(next, `resumed session ${next.sessionName}`);
        });
      }
    } else if (command === "/new") {
      if (args.length) {
        this.pushBlock({ kind: "error", text: "/new does not take arguments" });
      } else if (!this.newSession) {
        this.pushBlock({ kind: "error", text: "starting a new session is unavailable in this frontend" });
      } else {
        const next = await this.newSession();
        this.applySession({ ...next, blocks: [], history: [] }, `started session ${next.sessionName}`);
      }
    } else if (command === "/exit" || command === "/quit") {
      this.stop();
      return;
    } else {
      this.pushBlock({ kind: "error", text: `unknown command: ${command} (try /help)` });
    }
    this.dirtyRendered = true;
  }

  async withLocalTask(task) {
    this.mode = "working";
    this.activityStartedAt = this.now();
    this.lastClockTick = -1;
    this.dirtyRendered = true;
    try {
      await task();
    } catch (err) {
      this.pushBlock({ kind: "error", text: err.message });
    } finally {
      this.activityStartedAt = null;
      this.mode = "idle";
      this.dirtyRendered = true;
    }
  }

  applySession(next, summary) {
    this.sessionName = next.sessionName;
    this.session = next.session;
    this.cwd = next.cwd ?? process.cwd();
    this.history = next.history ?? [];
    this.blocks = [...(next.blocks ?? []), { kind: "result", ok: true, summary }];
    this.lastTurnDurationMs = [...(next.blocks ?? [])].reverse().find((block) => block.kind === "timing")?.durationMs ?? null;
    this.inputHistory = this.history
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content);
    this.historyIndex = -1;
    this.scrollOffset = 0;
    this.refreshGitStatus();
  }

  completePath() {
    if (this.mode !== "idle") return;
    const before = this.inputBuffer.slice(0, this.inputCursor);
    const token = /(?:^|\s)@(?:"([^"]*)|([^\s]*))$/.exec(before);
    if (!token) return;

    const quoted = token[1] !== undefined;
    const typed = token[1] ?? token[2];
    const slash = typed.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : typed.slice(0, slash + 1);
    const prefix = slash === -1 ? typed : typed.slice(slash + 1);
    let entries;
    try {
      entries = readdirSync(resolve(this.cwd, dirPart || "."), { withFileTypes: true })
        .filter(
          (entry) =>
            !entry.name.includes('"') &&
            (prefix.startsWith(".") || !entry.name.startsWith(".")) &&
            entry.name.startsWith(prefix)
        )
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch {
      return;
    }
    if (!entries.length) return;

    let completion = entries[0].name;
    for (const entry of entries.slice(1)) {
      let i = 0;
      while (i < completion.length && completion[i] === entry.name[i]) i++;
      completion = completion.slice(0, i);
    }

    if (entries.length === 1 || completion.length > prefix.length) {
      const chosen = entries.length === 1 ? entries[0].name : completion;
      const completeEntry = entries.length === 1 ? entries[0] : null;
      const path = `${dirPart}${chosen}${completeEntry?.isDirectory() ? "/" : ""}`;
      const needsQuotes = quoted || /\s/.test(path);
      const replacement = needsQuotes
        ? `@"${path}${completeEntry && !completeEntry.isDirectory() ? '" ' : ""}`
        : `@${path}${completeEntry && !completeEntry.isDirectory() ? " " : ""}`;
      const start = before.length - typed.length - (quoted ? 2 : 1);
      this.inputBuffer = this.inputBuffer.slice(0, start) + replacement + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor = start + replacement.length;
      this.dirtyRendered = true;
      return;
    }

    const shown = entries.slice(0, 12).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    const extra = entries.length > shown.length ? ` … +${entries.length - shown.length} more` : "";
    this.pushBlock({ kind: "result", ok: true, summary: `@path matches: ${shown.join("  ")}${extra}` });
  }

  // ---- frame building -----------------------------------------------------

  statusText() {
    if (this.mode !== "idle") {
      if (this.activityStartedAt == null) return this.mode;
      const elapsed = Math.max(0, this.now() - this.activityStartedAt);
      const spinner = SPINNER[Math.floor(elapsed / 100) % SPINNER.length];
      return `${spinner} ${this.mode} ${formatDuration(elapsed)}`;
    }
    return this.lastTurnDurationMs == null ? "idle" : `idle · last ${formatDuration(this.lastTurnDurationMs)}`;
  }

  footer() {
    const status = this.statusText();
    const statusBudget = Math.max(1, Math.min(dispWidth(status), this.width));
    const statusPlain = truncateMiddle(status, statusBudget);
    const statusStr = styleText(statusPlain, {
      fg: MODE_COLOR()[this.mode] ?? theme.dim,
      bold: this.mode !== "idle",
    });
    const model = `model ${this.config.model}`;
    const git =
      this.git.branch != null
        ? `git ${this.git.branch}${this.git.dirty ? ` ~${this.git.dirtyCount}` : " ✓"}`
        : "git -";
    const sepText = "  ·  ";
    const sep = styleText(sepText, { fg: theme.dim });
    const metaBudget = this.width - dispWidth(statusPlain) - 2;
    if (metaBudget < 6) return statusStr;

    let fields;
    const fullFixed = dispWidth(model) + dispWidth(git) + sepText.length * 2;
    if (metaBudget >= fullFixed + 8) {
      const path = truncateMiddle(this.cwd, metaBudget - fullFixed);
      fields = [
        styleText(model, { fg: theme.text }),
        styleText(path, { fg: theme.dim }),
        styleText(git, { fg: this.git.dirty ? theme.bad : theme.good }),
      ];
    } else if (metaBudget >= dispWidth(git) + sepText.length + 8) {
      const path = truncateMiddle(this.cwd, metaBudget - dispWidth(git) - sepText.length);
      fields = [styleText(path, { fg: theme.dim }), styleText(git, { fg: this.git.dirty ? theme.bad : theme.good })];
    } else {
      fields = [styleText(truncateMiddle(this.cwd, metaBudget), { fg: theme.dim })];
    }
    const meta = fields.join(sep);
    const pad = Math.max(2, this.width - dispWidth(statusPlain) - dispWidth(stripAnsi(meta)));
    return `${statusStr}${" ".repeat(pad)}${meta}`;
  }

  header() {
    const left = `argus  ·  ${this.sessionName ?? "session"}`;
    if (this.scrollOffset === 0) {
      if (dispWidth(left) > this.width) {
        return styleText(truncateMiddle(left, this.width), { fg: theme.accent, bold: true });
      }
      return (
        styleText("argus", { fg: theme.accent, bold: true }) +
        styleText(`  ·  ${this.sessionName ?? "session"}`, { fg: theme.dim })
      );
    }
    const longRight = `↑ ${this.scrollOffset} from latest · End`;
    const shortRight = `↑${this.scrollOffset} · End`;
    const right = dispWidth(longRight) + 10 <= this.width ? longRight : shortRight;
    const leftBudget = this.width - dispWidth(right) - 2;
    if (leftBudget < 5) return styleText(truncateEnd(right, this.width), { fg: theme.accent, bold: true });
    const fittedLeft = truncateMiddle(left, leftBudget);
    const pad = this.width - dispWidth(fittedLeft) - dispWidth(right);
    return (
      styleText(fittedLeft, { fg: theme.accent, bold: true }) +
      " ".repeat(pad) +
      styleText(right, { fg: theme.accent })
    );
  }

  buildFrame() {
    const frame = new Array(this.height).fill("");
    const width = this.width;

    frame[0] = this.header();

    const lines = this.transcriptLines();
    const transcriptHeight = Math.max(1, this.height - 3);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());
    const start = Math.max(0, lines.length - transcriptHeight - this.scrollOffset);
    for (let r = 0; r < transcriptHeight; r++) {
      frame[1 + r] = lines[start + r] ?? "";
    }

    if (this.blocks.length === 0) {
      const hint =
        width >= 55
          ? [
              "What would you like to build?",
              "Type a task, or reference a file with @path.",
              "/help for commands  ·  Tab completes paths  ·  Esc aborts",
            ]
          : width >= 40
            ? ["What would you like to build?", "Type a task or use @path.", "/help commands  ·  Tab paths  ·  Esc aborts"]
            : width >= 30
              ? ["What would you like to build?", "Type a task or use @path.", "/help  ·  Tab  ·  Esc aborts"]
              : ["What will you build?", "Type a task or @path.", "/help  ·  Tab  ·  Esc"];
      const startRow = Math.max(0, Math.floor((transcriptHeight - hint.length) / 2));
      hint.forEach((line, i) => {
        const l = truncateEnd(line, width);
        const centered = " ".repeat(Math.max(0, Math.floor((width - dispWidth(l)) / 2))) + l;
        frame[1 + startRow + i] = styleText(centered, { fg: theme.dim });
      });
    }

    const { text, col } = this.inputView();
    const placeholder =
      this.mode === "idle"
        ? width >= 45
          ? "Describe a task…  (/help for commands)"
          : width >= 25
            ? "Describe a task…  (/help)"
            : "Describe a task…"
        : width >= 45
          ? "Argus is working…  (Esc to interrupt)"
          : width >= 25
            ? "Working…  (Esc to stop)"
            : "Working… Esc stops";
    frame[this.height - 2] = this.pendingConfirm
      ? styleText(`⚠ ${truncateMiddle(this.pendingConfirm.command, Math.max(12, this.width - 12))}  (y/n)`, { fg: theme.bad })
      : `${styleText("❯", { fg: theme.accent, bold: true })} ${
          text || styleText(truncateEnd(placeholder, Math.max(1, this.width - 3)), { fg: theme.dim, italic: true })
        }`;
    this.inputCol = this.pendingConfirm ? 0 : col;

    frame[this.height - 1] = this.footer();
    return frame;
  }

  // ---- raw input parsing --------------------------------------------------

  onData(chunk) {
    this.rawBuf += this.decoder.decode(chunk, { stream: true });
    this.consumeInput();
  }

  consumeInput() {
    if (this.pasting) {
      const end = this.rawBuf.indexOf("\x1b[201~");
      if (end === -1) return;
      const pasted = this.rawBuf.slice(0, end).replace(/\r?\n/g, " ").replace(/\r/g, " ");
      this.rawBuf = this.rawBuf.slice(end + 6);
      this.pasting = false;
      this.insertText(pasted);
      this.consumeInput();
      return;
    }
    const esc = this.rawBuf.indexOf("\x1b");
    if (esc === -1) {
      if (this.rawBuf) {
        this.insertText(this.rawBuf);
        this.rawBuf = "";
      }
      this.clearEscTimeout();
      return;
    }
    if (esc > 0) {
      this.insertText(this.rawBuf.slice(0, esc));
      this.rawBuf = this.rawBuf.slice(esc);
    }
    if (this.tryEscape()) {
      this.clearEscTimeout();
      this.consumeInput();
    } else if (this.rawBuf === "\x1b") {
      this.scheduleEscTimeout();
    }
  }

  scheduleEscTimeout() {
    if (this.escTimer) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.stopped) return;
      if (this.rawBuf === "\x1b") {
        this.rawBuf = "";
        this.runAction({ type: "escape" });
      }
    }, 60);
  }

  clearEscTimeout() {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  tryEscape() {
    // Bracketed paste: collect the entire payload so embedded newlines cannot
    // accidentally submit several prompts. The one-line editor folds them.
    if (this.rawBuf.startsWith("\x1b[200~")) {
      this.rawBuf = this.rawBuf.slice(6);
      this.pasting = true;
      return true;
    }

    // OSC sequence -> ignore (theme response is handled earlier, before input).
    if (this.rawBuf.startsWith("\x1b]")) {
      const st = this.rawBuf.indexOf("\x1b\\", 2);
      const bel = this.rawBuf.indexOf("\x07", 2);
      let end = -1;
      if (st !== -1 && (bel === -1 || st < bel)) end = st + 2;
      else if (bel !== -1) end = bel + 1;
      if (end === -1) return false;
      this.rawBuf = this.rawBuf.slice(end);
      return true;
    }

    // SGR mouse events (wheel = buttons 64/65).
    if (this.rawBuf.startsWith("\x1b[<")) {
      const m = this.rawBuf.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (!m) return false;
      const btn = Number(m[1]);
      this.rawBuf = this.rawBuf.slice(m[0].length);
      if (btn === 64) this.runAction({ type: "wheel", dir: 1 });
      else if (btn === 65) this.runAction({ type: "wheel", dir: -1 });
      return true;
    }

    const CSI = [
      [/^\x1b\[A/, { type: "up" }],
      [/^\x1b\[B/, { type: "down" }],
      [/^\x1b\[C/, { type: "right" }],
      [/^\x1b\[D/, { type: "left" }],
      [/^\x1b\[H/, { type: "home" }],
      [/^\x1b\[F/, { type: "end" }],
      [/^\x1b\[1~/, { type: "home" }],
      [/^\x1b\[4~/, { type: "end" }],
      [/^\x1b\[5~/, { type: "pageup" }],
      [/^\x1b\[6~/, { type: "pagedown" }],
      [/^\x1b\[3~/, { type: "delete" }],
    ];
    for (const [re, act] of CSI) {
      const m = re.exec(this.rawBuf);
      if (m) {
        this.rawBuf = this.rawBuf.slice(m[0].length);
        this.runAction(act);
        return true;
      }
    }

    // Unknown CSI sequence: consume up to and including the final byte
    // (in range 0x40-0x7E), so no trailing bytes leak into text.
    if (this.rawBuf.startsWith("\x1b[")) {
      let j = 2;
      while (j < this.rawBuf.length && this.rawBuf.charCodeAt(j) < 0x40) j++;
      if (j >= this.rawBuf.length) return false; // incomplete sequence
      this.rawBuf = this.rawBuf.slice(j + 1);
      return true;
    }
    // Alt+key escape: consume ESC + next byte, ignore.
    if (this.rawBuf.length >= 2) {
      this.rawBuf = this.rawBuf.slice(2);
      return true;
    }
    return false;
  }

  insertText(text) {
    if (this.pendingConfirm) {
      const ch = String(text).trim().toLowerCase()[0];
      if (ch === "y") this.resolveConfirm(true);
      else if (ch === "n") this.resolveConfirm(false);
      return;
    }
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 32 || cp === 127) {
        if (cp === 1) this.inputCursor = 0; // Ctrl-A
        else if (cp === 9) this.completePath(); // Tab
        else if (cp === 3) this.handleCtrlC();
        else if (cp === 4) {
          if (!this.inputBuffer) this.stop();
          else this.deleteAtCursor();
        } else if (cp === 5) this.inputCursor = this.inputBuffer.length; // Ctrl-E
        else if (cp === 11) this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor); // Ctrl-K
        else if (cp === 12) this.redraw(); // Ctrl-L
        else if (cp === 21) { // Ctrl-U
          this.inputBuffer = this.inputBuffer.slice(this.inputCursor);
          this.inputCursor = 0;
        } else if (cp === 23) { // Ctrl-W
          const previous = previousWordIndex(this.inputBuffer, this.inputCursor);
          this.inputBuffer = this.inputBuffer.slice(0, previous) + this.inputBuffer.slice(this.inputCursor);
          this.inputCursor = previous;
        } else if (cp === 13 || cp === 10) {
          this.submit();
        } else if (cp === 127 || cp === 8) {
          this.backspace();
        }
        this.dirtyRendered = true;
        continue;
      }
      const s = String.fromCodePoint(cp);
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + s + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor += s.length;
      this.dirtyRendered = true;
    }
  }

  backspace() {
    const previous = previousCharIndex(this.inputBuffer, this.inputCursor);
    this.inputBuffer = this.inputBuffer.slice(0, previous) + this.inputBuffer.slice(this.inputCursor);
    this.inputCursor = previous;
  }

  deleteAtCursor() {
    this.inputBuffer =
      this.inputBuffer.slice(0, this.inputCursor) + this.inputBuffer.slice(nextCharIndex(this.inputBuffer, this.inputCursor));
  }

  redraw() {
    this.lastFrame = [];
    this.dirtyRendered = true;
    process.stdout.write(`${ESC}[2J${ESC}[H`);
  }

  runAction(action) {
    if (this.stopped) return;
    switch (action.type) {
      case "exit":
        return this.stop();
      case "enter":
        return this.submit();
      case "backspace":
        this.backspace();
        break;
      case "delete":
        this.deleteAtCursor();
        break;
      case "left":
        this.inputCursor = previousCharIndex(this.inputBuffer, this.inputCursor);
        break;
      case "right":
        this.inputCursor = nextCharIndex(this.inputBuffer, this.inputCursor);
        break;
      case "up":
        this.historyUp();
        return;
      case "down":
        this.historyDown();
        return;
      case "pageup":
        this.scrollOffset = Math.min(this.scrollOffset + (this.height - 3), this.maxScroll());
        break;
      case "pagedown":
        this.scrollOffset = Math.max(0, this.scrollOffset - (this.height - 3));
        break;
      case "home":
        this.scrollOffset = this.maxScroll();
        break;
      case "end":
        this.scrollOffset = 0;
        break;
      case "escape":
        if (this.pendingConfirm) this.resolveConfirm(false);
        else if (this.mode !== "idle") this.abortTurn();
        break;
      case "wheel":
        this.scrollOffset = Math.min(Math.max(0, this.scrollOffset + action.dir * 3), this.maxScroll());
        break;
      default:
        return;
    }
    this.dirtyRendered = true;
  }

  historyUp() {
    if (!this.inputHistory.length) return;
    if (this.historyIndex === -1) this.historyIndex = this.inputHistory.length - 1;
    else this.historyIndex = Math.max(0, this.historyIndex - 1);
    this.inputBuffer = this.inputHistory[this.historyIndex];
    this.inputCursor = this.inputBuffer.length;
    this.dirtyRendered = true;
  }

  historyDown() {
    if (this.historyIndex === -1) return;
    this.historyIndex++;
    if (this.historyIndex >= this.inputHistory.length) {
      this.historyIndex = -1;
      this.inputBuffer = "";
    } else {
      this.inputBuffer = this.inputHistory[this.historyIndex];
    }
    this.inputCursor = this.inputBuffer.length;
    this.dirtyRendered = true;
  }

  handleCtrlC() {
    if (this.mode === "idle") return this.stop();
    if (this.aborting) return this.stop(); // second press: force quit
    this.abortTurn();
  }

  abortTurn() {
    this.resolveConfirm(false);
    this.aborting = true;
    if (this.abortController) this.abortController.abort();
    this.mode = "aborting";
    this.dirtyRendered = true;
  }

  confirm(command) {
    return new Promise((resolve) => {
      this.pendingConfirm = { command, resolve };
      this.mode = "confirm";
      this.dirtyRendered = true;
    });
  }

  resolveConfirm(ok) {
    if (!this.pendingConfirm) return;
    const { resolve } = this.pendingConfirm;
    this.pendingConfirm = null;
    this.mode = "working";
    this.dirtyRendered = true;
    resolve(ok);
  }

  // ---- startup / lifecycle ------------------------------------------------

  async refreshGitStatus() {
    const cwd = this.cwd;
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

  /** Query terminal background via OSC 11; resolve { light } or { light: null }. */
  queryBackground() {
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

  start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Clear the whole screen up front so we start from a clean slate rather
    // than relying on per-row clearing of whatever was on screen before.
    process.stdout.write(`${ESC}[2J${ESC}[H`);
    process.stdout.on("resize", () => {
      this.width = process.stdout.columns || 80;
      this.height = process.stdout.rows || 24;
      this.dirtyRendered = true;
    });

    this.timer = setInterval(() => {
      if (this.activityStartedAt != null) {
        const tick = Math.floor((this.now() - this.activityStartedAt) / 100);
        if (tick !== this.lastClockTick) {
          this.lastClockTick = tick;
          this.dirtyRendered = true;
        }
      }
      this.render();
    }, 40);
    this.gitTimer = setInterval(() => this.refreshGitStatus(), 3000);
    this.refreshGitStatus();
    this.dirtyRendered = true;
    this.render();

    // Attach input immediately so keystrokes typed during theme detection are
    // not lost. The parser already ignores OSC responses.
    this.attachInput();
    this.queryBackground().then((bg) => {
      if (bg.light != null) setTheme(bg.light ? "light" : "dark");
      this.dirtyRendered = true;
      this.render();
    });
  }

  attachInput() {
    process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?2004h"); // mouse + bracketed paste
    process.stdin.on("data", (chunk) => this.onData(chunk));
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
    process.stdout.cursorTo(Math.min(this.inputCol, this.width - 1), this.height - 2);
    process.stdout.write(`${ESC}[?25h`);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.gitTimer);
    this.clearEscTimeout();
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l"); // restore terminal modes
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.decoder.decode();
    process.stdout.write(`${ESC}[?25h\n`);
    process.exit(0);
  }
}
