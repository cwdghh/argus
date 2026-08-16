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
 *   Up/Down          navigate past inputs; in multiline input, move the caret
 *   PgUp/PgDn        scroll the transcript by a page
 *   Home/End         jump to top / bottom of the transcript
 *   mouse wheel      scroll the transcript (SGR mouse tracking)
 *   Left/Right       move the editor caret
 *   Ctrl-A/E         move to start/end of input
 *   Ctrl-U/K/W       delete to start/end/previous word
 *   Ctrl-L           redraw the terminal
 *   Ctrl-C           abort a turn / quit when idle
 *   Ctrl-D           delete at cursor / quit on empty input
 *   Shift+Enter      insert a newline (Enter submits)
 *   /help             show local commands
 *   @ / slash        live suggestions; Up/Down + Tab to pick, Esc to dismiss
 */
import { exec } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { runTurn } from "./agent.mjs";
import { COMPACT_DEFAULTS, estimateChars } from "./compact.mjs";
import { theme, setTheme } from "./theme.mjs";

const execAsync = promisify(exec);
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const SUGGESTION_ROWS = 8;
/**
 * Local slash commands, in the order they are suggested. One source of truth:
 * the same table drives the in-editor suggestion popup and `/help`.
 */
const SLASH_COMMANDS = [
  { name: "/help", description: "show commands and keyboard shortcuts" },
  { name: "/keys", description: "show keyboard shortcuts" },
  { name: "/status", description: "show the active session, model, cwd, context, and limits" },
  { name: "/sessions", description: "list recent saved sessions" },
  { name: "/resume", description: "switch to a saved session" },
  { name: "/new", description: "start a fresh session without restarting Argus" },
  { name: "/exit", description: "quit Argus" },
  { name: "/quit", description: "quit Argus (same as /exit)" },
];
const COMMAND_HELP = `## Local commands

${SLASH_COMMANDS.map((c) => `- ${c.name}${c.name === "/resume" ? " <name>" : ""} — ${c.description}`).join("\n")}`;

const KEY_HELP = `## Keyboard shortcuts

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

const HELP_TEXT = `${COMMAND_HELP}\n\n${KEY_HELP}`;
const MODE_COLOR = () => ({ idle: theme.dim, working: theme.accent, thinking: theme.think, aborting: theme.bad, confirm: theme.bad });
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

import {
  styleText,
  stripAnsi,
  charWidth,
  dispWidth,
  truncateMiddle,
  truncateEnd,
  formatDuration,
  formatChars,
  formatTokens,
  summarize,
  markdownLines,
  blockLines,
  previousCharIndex,
  nextCharIndex,
  previousWordIndex,
  wrap,
} from "./tui/renderers.mjs";

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
    // Live suggestion state for @path and /command completions, recomputed by
    // refreshSuggestions() after every input mutation. Null when no popup is
    // shown. Otherwise: { kind: "path"|"slash", items, selected, start, end,
    // ... } where items is the filtered list and start/end are the token bounds
    // in inputBuffer that accepting a suggestion replaces.
    this.suggestion = null;
    this.now = opts.now ?? Date.now;
    this.activityStartedAt = null;
    this.lastTurnDurationMs = [...this.blocks].reverse().find((block) => block.kind === "timing")?.durationMs ?? null;
    this.lastTurnUsage = [...this.blocks].reverse().find((block) => block.kind === "timing")?.usage ?? null;
    this.lastClockTick = -1;
    this.activeToolStartedAt = null;
    // Cumulative token usage for the active turn (real provider counts, not a
    // char estimate). Reset at the start of each turn in submit().
    this.turnUsage = null;
  }

  transcriptLines() {
    const out = [];
    let seen = false;
    let lastKind = null;
    for (const block of this.blocks) {
      if (block.kind === "user" && seen) {
        const width = Math.min(20, Math.max(4, this.width - 4));
        out.push(
          styleText("│", { fg: theme.rail }) +
            "  " +
            styleText("─".repeat(width), { fg: theme.rail })
        );
      }
      // Before tool calls or thinking blocks, strip trailing blank lines
      // (the model's text output may end with natural newlines) and insert
      // exactly one blank separator line for visual clarity.
      if (seen && (block.kind === "tool" || block.kind === "thinking")) {
        while (out.length > 0 && stripAnsi(out[out.length - 1]).trim() === "") {
          out.pop();
        }
        if (out.length > 0) out.push("");
      }
      // After a thinking block, add a blank line before the assistant's response.
      if (lastKind === "thinking" && block.kind === "assistant") {
        while (out.length > 0 && stripAnsi(out[out.length - 1]).trim() === "") {
          out.pop();
        }
        if (out.length > 0) out.push("");
      }
      seen = true;
      lastKind = block.kind;
      out.push(...blockLines(block, this.width));
      // After a timing block (end of a turn), add a blank line to
      // separate the recorded time from the input editor below.
      if (block.kind === "timing") out.push("");
    }
    return out;
  }

  maxScroll() {
    return Math.max(0, this.transcriptLines().length - this.transcriptHeight());
  }

  /** Rows available for the transcript after reserving header/footer/editor. */
  transcriptHeight() {
    const editorRows = this._editorHeight ?? 1;
    return Math.max(1, this.height - 3 - (editorRows - 1));
  }

  // ---- input --------------------------------------------------------------

  /**
   * The editor is a multiline text area. It is rendered bottom-up from the
   * footer: the last logical line sits on the row just above the footer, and
   * earlier lines stack upward. Each logical line is wrapped to `width - 4`
   * columns and rendered as `❯ ` + content (first line) or `│ ` + content
   * (continuation lines). Long buffers scroll horizontally so the caret stays
   * visible. `{ rows, height, caretRow, col }` describes the view; `height` is
   * the number of editor rows the frame must reserve.
   */
  editorRows() {
    const inputWidth = Math.max(1, this.width - 4);
    const logical = this.inputBuffer.split("\n");
    const rows = [];
    for (const l of logical) rows.push(...(l === "" ? [""] : wrap(l, inputWidth)));
    return rows;
  }

  /** Absolute cursor -> { row (display-row index), col (char offset in row) }. */
  caretPos() {
    const inputWidth = Math.max(1, this.width - 4);
    const logicalLines = this.inputBuffer.split("\n");
    const rows = this.editorRows();
    let remaining = this.inputCursor;
    let displayRow = 0;

    for (let li = 0; li < logicalLines.length; li++) {
      const line = logicalLines[li];
      const wrapped = line === "" ? [""] : wrap(line, inputWidth);

      for (let wi = 0; wi < wrapped.length; wi++) {
        const segLen = wrapped[wi].length;
        const isLastSegOfLine = wi === wrapped.length - 1;
        // Place caret in this segment if it fits, or if it's exactly at the
        // end of the last segment of this logical line.
        if (remaining < segLen || (remaining === segLen && isLastSegOfLine)) {
          return { row: displayRow, col: remaining, rows };
        }
        remaining -= segLen;
        displayRow++;
      }

      // Account for the \n between logical lines.
      if (li < logicalLines.length - 1) {
        remaining -= 1;
      }
    }

    const last = Math.max(0, rows.length - 1);
    return { row: last, col: rows[last].length, rows };
  }

  inputView() {
    const maxEditor = Math.max(1, this.height - 4);
    const rows = this.editorRows();
    const pos = this.caretPos();
    let active = pos.row;
    let lineCursor = pos.col;
    if (active >= rows.length) active = rows.length - 1;

    // Horizontal window: center the caret column when a row overflows.
    let buff = rows[active];
    let cursor = dispWidth(buff.slice(0, lineCursor));
    const inputWidth = Math.max(1, this.width - 4);
    if (dispWidth(buff) > inputWidth) {
      const before = dispWidth(buff.slice(0, lineCursor));
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
      cursor = dispWidth(buff.slice(0, Math.max(0, lineCursor - start)));
    }

    // Vertical window: keep the caret row visible when the buffer overflows
    // the editor area (rows are laid out bottom-up).
    let startRow = 0;
    if (rows.length > maxEditor) {
      startRow = Math.max(0, active - (maxEditor - 1));
    }
    const viewRows = rows.slice(startRow, startRow + maxEditor);
    const activeInView = active - startRow;

    // Track the caret row relative to the editor's bottom so rendering and
    // cursor placement agree even when the vertical window scrolls.
    this._activeInputRow = activeInView;

    return {
      rows: viewRows,
      height: viewRows.length,
      caretRow: activeInView,
      col: 2 + cursor,
    };
  }

  insertNewline() {
    const s = "\n";
    this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + s + this.inputBuffer.slice(this.inputCursor);
    this.inputCursor += s.length;
    this.dirtyRendered = true;
    this.refreshSuggestions();
  }

  /** Move the caret one display row up/down in multiline input; false if no row. */
  moveCaretVertical(dir) {
    const pos = this.caretPos();
    const target = pos.row + dir;
    if (target < 0 || target >= pos.rows.length) return false;
    const wantCol = dispWidth(pos.rows[pos.row].slice(0, pos.col));
    const targetRow = pos.rows[target];
    let col = 0;
    let w = 0;
    for (const ch of targetRow) {
      const cw = charWidth(ch);
      if (w + cw > wantCol) break;
      w += cw;
      col += ch.length;
    }

    // Compute absolute cursor position for target row by walking logical lines
    const inputWidth = Math.max(1, this.width - 4);
    const logicalLines = this.inputBuffer.split("\n");
    let displayRow = 0;
    let absolutePos = 0;

    for (let li = 0; li < logicalLines.length; li++) {
      const line = logicalLines[li];
      const wrapped = line === "" ? [""] : wrap(line, inputWidth);

      for (let wi = 0; wi < wrapped.length; wi++) {
        if (displayRow === target) {
          this.inputCursor = absolutePos + col;
          this.dirtyRendered = true;
          this.refreshSuggestions();
          return true;
        }
        absolutePos += wrapped[wi].length;
        displayRow++;
      }

      // Account for the \n between logical lines.
      if (li < logicalLines.length - 1) {
        absolutePos += 1;
      }
    }

    this.inputCursor = absolutePos + col;
    this.dirtyRendered = true;
    this.refreshSuggestions();
    return true;
  }

  /** Ctrl-K: delete from the caret to the end of the current logical line. */
  deleteToLineEnd() {
    const nl = this.inputBuffer.indexOf("\n", this.inputCursor);
    const end = nl === -1 ? this.inputBuffer.length : nl;
    this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + this.inputBuffer.slice(end);
    this.refreshSuggestions();
  }

  /** Ctrl-U: delete from the caret back to the start of the current logical line. */
  deleteToLineStart() {
    let start = this.inputBuffer.lastIndexOf("\n", this.inputCursor - 1);
    start = start === -1 ? 0 : start + 1;
    this.inputBuffer = this.inputBuffer.slice(0, start) + this.inputBuffer.slice(this.inputCursor);
    this.inputCursor = start;
    this.refreshSuggestions();
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
    this.suggestion = null;
    if (text.startsWith("/")) {
      await this.runCommand(text);
      return;
    }
    this.mode = "working";
    this.activityStartedAt = this.now();
    this.lastClockTick = -1;
    this.turnUsage = null;
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
        } else if (ev.type === "usage") {
          this.turnUsage = ev.usage;
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
      this.lastTurnUsage = this.turnUsage;
      this.pushBlock({ kind: "timing", summary: `${outcome} in ${formatDuration(durationMs)}`, durationMs, usage: this.turnUsage });
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
      const ratio = Math.round((contextChars / compactAt) * 100);
      this.pushBlock({
        kind: "assistant",
        text:
          `## Status\n\n- Session: \`${this.sessionName ?? "none"}\`\n` +
          `- Model: \`${this.config.model}\`\n- Cwd: \`${this.cwd}\`\n` +
          `- Last turn: ${this.lastTurnDurationMs == null ? "none yet" : formatDuration(this.lastTurnDurationMs)}` +
          `${this.lastTurnUsage ? ` (${formatTokens(this.lastTurnUsage)})` : ""}\n` +
          `- Context window: ${ratio}% used (${contextChars.toLocaleString()} / ${compactAt.toLocaleString()} chars, compacts at threshold)\n` +
          `- Turns: ${turns}\n` +
          `- Limits: ${this.config.maxSteps ?? 100} model steps, ${this.config.maxRetries ?? 2} retries, ` +
          `${this.config.requestTimeoutMs ?? 300_000}ms/request, ` +
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
    this.lastTurnUsage = [...(next.blocks ?? [])].reverse().find((block) => block.kind === "timing")?.usage ?? null;
    this.inputHistory = this.history
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content);
    this.historyIndex = -1;
    this.scrollOffset = 0;
    this.suggestion = null;
    this.refreshGitStatus();
  }

  // ---- suggestions (@path + /command completions) --------------------------

  /**
   * Recompute the live suggestion popup from the current buffer and caret.
   * Shows slash commands while the input is a bare `/...` command, and @path
   * entries while the caret sits right after an `@token`. Hides (null) when
   * nothing matches, the caret leaves the token, or a turn is running.
   */
  refreshSuggestions() {
    if (this.mode !== "idle") {
      this.suggestion = null;
      return;
    }
    const buffer = this.inputBuffer;
    const before = buffer.slice(0, this.inputCursor);
    // Preserve the highlighted row across recomputes (each keystroke shrinks
    // the list): keep the same label when it still matches, otherwise clamp the
    // old index to the new size; reset only when the token kind changes or no
    // popup was open.
    const prev = this.suggestion;
    const selectedFor = (kind, items) => {
      if (!prev || prev.kind !== kind || prev.items.length === 0) return 0;
      const chosen = prev.items[Math.min(prev.selected, prev.items.length - 1)].label;
      const idx = items.findIndex((item) => item.label === chosen);
      return idx === -1 ? Math.min(prev.selected, items.length - 1) : idx;
    };

    // Slash commands: the whole input is still a bare command, e.g. "/sta".
    const slash = /^\/([^\s]*)$/.exec(buffer);
    if (slash) {
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith("/" + slash[1])).map((c) => ({
        label: c.name,
        description: c.description,
      }));
      this.suggestion = items.length
        ? { kind: "slash", items, start: 0, end: buffer.length, selected: selectedFor("slash", items) }
        : null;
      return;
    }

    // @path token ending exactly at the caret, e.g. "Review @src/ag".
    const token = /(?:^|\s)@(?:"([^"]*)|([^\s]*))$/.exec(before);
    if (token) {
      const quoted = token[1] !== undefined;
      const typed = token[1] ?? token[2];
      const lastSlash = typed.lastIndexOf("/");
      const dirPart = lastSlash === -1 ? "" : typed.slice(0, lastSlash + 1);
      const prefix = lastSlash === -1 ? typed : typed.slice(lastSlash + 1);
      let entries;
      try {
        entries = readdirSync(resolve(this.cwd, dirPart || "."), { withFileTypes: true })
          .filter(
            (entry) =>
              !entry.name.includes('"') &&
              (prefix.startsWith(".") || !entry.name.startsWith(".")) &&
              entry.name.startsWith(prefix)
          )
          .map((entry) => {
            // Resolve symlink targets at list time: a link to a directory
            // sorts and completes as a directory, so Tab can descend into it.
            let isDirectory = entry.isDirectory();
            let symlinkTarget = null;
            if (entry.isSymbolicLink()) {
              try {
                symlinkTarget = realpathSync(resolve(this.cwd, dirPart || ".", entry.name));
                if (statSync(symlinkTarget).isDirectory()) isDirectory = true;
              } catch {
                symlinkTarget = null; // broken link: show like a plain file
              }
            }
            return {
              label: entry.name + (isDirectory ? "/" : ""),
              isDirectory,
              symlinkTarget,
            };
          })
          .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.label.localeCompare(b.label));
      } catch {
        this.suggestion = null;
        return;
      }
      if (!entries.length) {
        this.suggestion = null;
        return;
      }
      const items = entries;
      this.suggestion = {
        kind: "path",
        items,
        start: before.length - typed.length - (quoted ? 2 : 1),
        end: this.inputCursor,
        dirPart,
        quoted,
        selected: selectedFor("path", items),
      };
      return;
    }

    this.suggestion = null;
  }

  /** Move the highlighted row; false when no popup is open. */
  suggestionMove(dir) {
    const s = this.suggestion;
    if (!s) return false;
    s.selected = Math.max(0, Math.min(s.items.length - 1, s.selected + dir));
    this.dirtyRendered = true;
    return true;
  }

  /** Compact resolved symlink target for the popup: relative to cwd when inside. */
  shortTarget(target) {
    const root = this.cwd.replace(/\/+$/, "");
    if (target.startsWith(root + "/")) return target.slice(root.length + 1);
    return basename(target);
  }

  /**
   * Accept the highlighted suggestion. Slash commands replace the whole input
   * with the command name; @path tokens are replaced in place (quoted when
   * needed, trailing slash for directories, trailing space for files).
   */
  acceptSuggestion(s = this.suggestion) {
    if (!s) return;
    if (s.kind === "slash") {
      const item = s.items[s.selected] ?? s.items[0];
      this.inputBuffer = item.label + " ";
      this.inputCursor = this.inputBuffer.length;
      return;
    }
    const item = s.items[s.selected] ?? s.items[0];
    const path = `${s.dirPart}${item.label}`;
    const needsQuotes = s.quoted || /\s/.test(path);
    const replacement = needsQuotes
      ? `@"${path}${item.isDirectory ? "" : '" '}`
      : `@${path}${item.isDirectory ? "" : " "}`;
    this.inputBuffer = this.inputBuffer.slice(0, s.start) + replacement + this.inputBuffer.slice(s.end);
    this.inputCursor = s.start + replacement.length;
  }

  /**
   * Tab / the old @path completer. Recomputes the popup first so it also works
   * when the buffer was set directly, then accepts the highlighted item.
   */
  completePath() {
    if (this.mode !== "idle") return;
    this.refreshSuggestions();
    this.acceptSuggestion();
    this.refreshSuggestions();
  }

  /** Styled rows for the suggestion popup, ready to paste into a frame. */
  suggestionLines() {
    const s = this.suggestion;
    if (!s || !s.items.length) return [];
    const width = Math.max(1, this.width - 4);
    // How many rows are visible above the editor (header included). buildFrame
    // reserves exactly this many for the popup, so the window must match it.
    const editorRows = this._editorHeight ?? 1;
    const budget = Math.max(1, this.height - 2 - editorRows);
    // Fixed layout: header + item window + one status row. The item window
    // scrolls with the highlight, and the status row is always present, so the
    // popup keeps a constant height instead of growing or shrinking as the
    // "… N more" / "↑ N more" hints appear and disappear.
    const itemCount = Math.min(SUGGESTION_ROWS, Math.max(1, budget - 2));
    const windowFor = (count) => {
      const start =
        s.items.length <= count ? 0 : Math.max(0, Math.min(s.selected - (count - 1), s.items.length - count));
      return { start, shown: s.items.slice(start, start + count), above: start, below: s.items.length - (start + count) };
    };
    const w = windowFor(itemCount);

    const header =
      s.kind === "slash"
        ? styleText("commands", { fg: theme.dim, italic: true })
        : styleText(`files in ${s.dirPart.replace(/\/$/, "") || "."}`, { fg: theme.dim, italic: true });
    const lines = [header];
    const maxLabel = Math.max(...w.shown.map((item) => dispWidth(item.label)));
    for (const [index, item] of w.shown.entries()) {
      const selected = w.start + index === s.selected;
      const marker = selected ? "▸" : " ";
      const base = selected ? { fg: theme.accent, bold: true } : { fg: theme.text, dim: true };
      let label;
      if (s.kind === "path") {
        // Dirs keep a muted trailing slash; symlinks get a muted arrow to their
        // resolved target. Neither becomes part of the completed @path label.
        const name = item.isDirectory ? item.label.slice(0, -1) : item.label;
        const suffix = item.isDirectory
          ? "/"
          : item.symlinkTarget
            ? ` → ${this.shortTarget(item.symlinkTarget)}`
            : "";
        const nameBudget = Math.max(1, width - 2 - dispWidth(suffix));
        label = styleText(truncateEnd(name, nameBudget), base) + styleText(suffix, { fg: theme.dim });
      } else {
        label = styleText(truncateEnd(item.label, Math.max(1, width - 2)), base);
      }
      let row = `${marker} ${label}`;
      if (item.description) {
        const pad = Math.max(1, maxLabel - dispWidth(item.label));
        const budget = Math.max(0, width - dispWidth(stripAnsi(row)) - pad - 2);
        if (budget > 0) row += " ".repeat(pad) + "  " + styleText(truncateEnd(item.description, budget), { fg: theme.dim });
      }
      lines.push(row);
    }
    // One always-present status row keeps the height fixed and reports what is
    // hidden, using one arrow per direction: `↑ N more` above, `↓ N more`
    // below (or the match count when all fit).
    const status =
      w.above > 0 && w.below > 0
        ? `↑ ${w.above} more · ↓ ${w.below} more`
        : w.above > 0
          ? `↑ ${w.above} more`
          : w.below > 0
            ? `↓ ${w.below} more`
            : `${s.items.length} ${s.items.length === 1 ? "match" : "matches"}`;
    lines.push(styleText(truncateEnd(status, width), { fg: theme.dim }));
    // Degenerate tiny terminals: the status row is the first to go, keeping
    // the header and the highlighted item on screen.
    if (lines.length > budget) lines.pop();
    return lines;
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
    const model = this.config.model;
    const git =
      this.git.branch != null
        ? `git ${this.git.branch}${this.git.dirty ? ` ~${this.git.dirtyCount}` : " ✓"}`
        : "git -";
    const contextChars = estimateChars(this.history);
    const compactAt = COMPACT_DEFAULTS.compactAtChars;
    const ratio = Math.round((contextChars / compactAt) * 100);
    const context = `${ratio}% ${formatChars(compactAt)}`;
    // Real provider token usage: live while working, the last turn's when idle.
    const tokUsage = this.mode === "idle" ? this.lastTurnUsage : this.turnUsage;
    const tokens = formatTokens(tokUsage);
    const sepText = " · ";
    const sep = styleText(sepText, { fg: theme.dim });
    const metaBudget = this.width - dispWidth(statusPlain) - 2;
    if (metaBudget < 6) return statusStr;

    // Build the candidate fields (some optional), then fit as many as the
    // width allows, dropping the least important (tokens, context, model)
    // first. Git status always comes first; the working directory fills
    // whatever space is left.
    const tokField = tokens ? [styleText(tokens, { fg: theme.dim })] : [];
    const ctxField = [styleText(context, { fg: theme.dim })];
    const gitField = [styleText(git, { fg: this.git.dirty ? theme.bad : theme.good })];
    const modelField = [styleText(model, { fg: theme.text })];

    const fields = [];
    // Exact display width of `fields`, including separators between them.
    let used = 0;
    const pushIfFits = (field) => {
      if (!field.length) return true; // optional field absent (e.g. no usage yet)
      const width = dispWidth(stripAnsi(field[0]));
      const extra = (fields.length ? sepText.length : 0) + width;
      if (used + extra > metaBudget) return false;
      if (fields.length) used += sepText.length;
      fields.push(field[0]);
      used += width;
      return true;
    };

    // Always try to keep at least the git status; if even that won't fit,
    // fall back to showing the working directory alone.
    if (!pushIfFits(gitField)) {
      fields.length = 0;
      const cwdOnly = styleText(truncateMiddle(this.cwd, metaBudget), { fg: theme.dim });
      fields.push(cwdOnly);
      used = dispWidth(stripAnsi(cwdOnly));
    } else {
      pushIfFits(modelField);
      pushIfFits(ctxField);
      pushIfFits(tokField);
      const remaining = metaBudget - used - (fields.length ? sepText.length : 0);
      if (remaining > 0) {
        const path = truncateMiddle(this.cwd, remaining);
        if (path) {
          if (fields.length) used += sepText.length;
          fields.push(styleText(path, { fg: theme.dim }));
          used += dispWidth(path);
        }
      }
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

    const view = this.inputView();
    this._editorHeight = view.height;

    const lines = this.transcriptLines();
    const transcriptHeight = this.transcriptHeight();
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
              "/help for commands  ·  Tab completes @paths & /commands  ·  Esc aborts",
            ]
          : width >= 40
            ? ["What would you like to build?", "Type a task or use @path.", "/help commands  ·  Tab @ or /  ·  Esc aborts"]
            : width >= 30
              ? ["What would you like to build?", "Type a task or use @path.", "/help  ·  Tab @ or /  ·  Esc aborts"]
              : ["What will you build?", "Type a task or @path.", "/help  ·  Tab  ·  Esc"];
      const startRow = Math.max(0, Math.floor((transcriptHeight - hint.length) / 2));
      hint.forEach((line, i) => {
        const l = truncateEnd(line, width);
        const centered = " ".repeat(Math.max(0, Math.floor((width - dispWidth(l)) / 2))) + l;
        frame[1 + startRow + i] = styleText(centered, { fg: theme.dim });
      });
    }

    if (this.pendingConfirm) {
      frame[this.height - 2] = styleText(
        `⚠ ${truncateMiddle(this.pendingConfirm.command, Math.max(12, this.width - 12))}  (y/n)`,
        { fg: theme.bad }
      );
      this.inputCol = 0;
      this._inputRow = this.height - 2;
    } else {
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
      // Editor grows upward: its rows occupy the rows directly above the footer.
      const firstEditorRow = this.height - 1 - view.height;

      // Live suggestion popup sits directly above the editor, overlaying the
      // bottom of the transcript while it is open.
      const suggestionRows = this.suggestion ? this.suggestionLines() : [];
      if (suggestionRows.length) {
        const maxPopupRows = Math.max(1, firstEditorRow - 1);
        const visible = suggestionRows.slice(0, maxPopupRows);
        const popupStart = firstEditorRow - visible.length;
        visible.forEach((line, i) => {
          frame[popupStart + i] = line;
        });
      }

      view.rows.forEach((rowText, i) => {
        const row = firstEditorRow + i;
        const isCaretRow = i === view.caretRow;
        const marker = i === 0 ? "❯" : "│";
        const markerStyle = i === 0 ? { fg: theme.accent, bold: true } : { fg: theme.rail, dim: true };
        if (rowText) {
          frame[row] = `${styleText(marker, markerStyle)} ${rowText}`;
        } else if (isCaretRow) {
          frame[row] = `${styleText("❯", { fg: theme.accent, bold: true })} ${
            styleText(truncateEnd(placeholder, Math.max(1, this.width - 3)), { fg: theme.dim, italic: true })
          }`;
        } else {
          frame[row] = styleText("│", { fg: theme.rail, dim: true }) + " "; // empty continuation rail
        }
      });
      this.inputCol = view.col;
      this._inputRow = firstEditorRow + view.caretRow;
    }

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
      [/^\x1b\[13;2u/, { type: "shiftenter" }],
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
        else if (cp === 11) this.deleteToLineEnd(); // Ctrl-K
        else if (cp === 12) this.redraw(); // Ctrl-L
        else if (cp === 21) this.deleteToLineStart(); // Ctrl-U
        else if (cp === 23) { // Ctrl-W
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
    this.refreshSuggestions();
  }

  backspace() {
    const previous = previousCharIndex(this.inputBuffer, this.inputCursor);
    this.inputBuffer = this.inputBuffer.slice(0, previous) + this.inputBuffer.slice(this.inputCursor);
    this.inputCursor = previous;
    this.refreshSuggestions();
  }

  deleteAtCursor() {
    this.inputBuffer =
      this.inputBuffer.slice(0, this.inputCursor) + this.inputBuffer.slice(nextCharIndex(this.inputBuffer, this.inputCursor));
    this.refreshSuggestions();
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
      case "shiftenter":
        this.insertNewline();
        break;
      case "backspace":
        this.backspace();
        break;
      case "delete":
        this.deleteAtCursor();
        break;
      case "left":
        this.inputCursor = previousCharIndex(this.inputBuffer, this.inputCursor);
        this.refreshSuggestions();
        break;
      case "right":
        this.inputCursor = nextCharIndex(this.inputBuffer, this.inputCursor);
        this.refreshSuggestions();
        break;
      case "up":
        if (this.suggestion) {
          this.suggestionMove(-1);
          break;
        }
        if (this.inputBuffer.includes("\n")) {
          if (this.moveCaretVertical(-1)) break;
        }
        this.historyUp();
        return;
      case "down":
        if (this.suggestion) {
          this.suggestionMove(1);
          break;
        }
        if (this.inputBuffer.includes("\n")) {
          if (this.moveCaretVertical(1)) break;
        }
        this.historyDown();
        return;
      case "pageup":
        this.scrollOffset = Math.min(this.scrollOffset + this.transcriptHeight(), this.maxScroll());
        break;
      case "pagedown":
        this.scrollOffset = Math.max(0, this.scrollOffset - this.transcriptHeight());
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
        else if (this.suggestion) {
          this.suggestion = null;
        } else if (this.inputBuffer.includes("\n")) {
          // Esc closes a multiline buffer back to a single line.
          this.inputBuffer = this.inputBuffer.replace(/\n/g, " ");
          this.inputCursor = this.inputBuffer.length;
          this.refreshSuggestions();
        }
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
    this.refreshSuggestions();
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
    this.refreshSuggestions();
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
    process.stdout.cursorTo(Math.min(this.inputCol, this.width - 1), this._inputRow ?? this.height - 2);
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
