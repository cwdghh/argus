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
import { promisify } from "node:util";
import { runTurn } from "./agent.mjs";
import { Editor } from "./tui/editor.mjs";
import { footerText, headerText, statusText } from "./tui/frames.mjs";
import { HELP_TEXT, KEY_HELP } from "./tui/help.mjs";
import { decodeEscape } from "./tui/keys.mjs";
import { acceptSuggestion, computeSuggestion, suggestionLines } from "./tui/suggestions.mjs";
import { sessionConfig } from "./session.mjs";
import { theme, setTheme } from "./theme.mjs";

const execAsync = promisify(exec);
const ESC = "\x1b";
import {
  styleText,
  stripAnsi,
  dispWidth,
  truncateMiddle,
  truncateEnd,
  formatDuration,
  formatChars,
  formatTokens,
  summarize,
  blockLines,
  previousCharIndex,
  nextCharIndex,
  previousWordIndex,
} from "./tui/renderers.mjs";

export class MinimalTui {
  constructor(config, opts = {}) {
    this.config = config;
    this.defaultModel = opts.defaultModel ?? config.model;
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
    this.renameSession = opts.renameSession ?? null;
    // Saved-session names for `/resume` completion. Refresh after any session
    // change (rename, new, resume) via refreshSessionNames().
    this.sessionNames = opts.sessionNames ?? [];
    this.listSessionNames = opts.listSessionNames ?? (async () => []);
    this.cwd = opts.initialCwd ?? process.cwd();
    // The multiline prompt editor is a separate pure widget (src/tui/editor.mjs);
    // the accessors below expose its state as plain inputBuffer/inputCursor/
    // inputHistory/historyIndex fields for the rest of the class and the tests.
    this.editor = new Editor();
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
    }
    return out;
  }

  maxScroll() {
    return Math.max(0, this.transcriptLines().length - this.transcriptHeight());
  }

  /** Rows available for the transcript after reserving header/separator/footer/editor. */
  transcriptHeight() {
    const editorRows = this._editorHeight ?? 1;
    return Math.max(1, this.height - 4 - (editorRows - 1));
  }

  // ---- prompt editor (pure widget in src/tui/editor.mjs) ------------------

  // The editor's state lives in `this.editor`; the accessors below expose it as
  // plain fields so the rest of the class (and the tests) can keep talking in
  // terms of inputBuffer/inputCursor/inputHistory/historyIndex.
  get inputBuffer() { return this.editor.buffer; }
  set inputBuffer(value) { this.editor.buffer = value; }
  get inputCursor() { return this.editor.cursor; }
  set inputCursor(value) { this.editor.cursor = value; }
  get inputHistory() { return this.editor.history; }
  set inputHistory(value) { this.editor.history = value; }
  get historyIndex() { return this.editor.historyIndex; }
  set historyIndex(value) { this.editor.historyIndex = value; }

  /** Wrapped logical editor lines (see Editor.rows). */
  editorRows() {
    return this.editor.rows(this.width);
  }

  /** Absolute cursor -> { row, col } (see Editor.caretPos). */
  caretPos() {
    return this.editor.caretPos(this.width);
  }

  /** Visible editor view; also pins the caret row for cursor placement. */
  inputView() {
    return this.editor.view(this.width, this.height);
  }

  /** Shift+Enter: insert a newline, then refresh rendering + suggestions. */
  insertNewline() {
    this.editor.insertNewline();
    this.dirtyRendered = true;
    this.refreshSuggestions();
  }

  /** Move the caret one display row up/down in multiline input; false if none. */
  moveCaretVertical(dir) {
    const moved = this.editor.moveCaretVertical(dir, this.width);
    if (moved) {
      this.dirtyRendered = true;
      this.refreshSuggestions();
    }
    return moved;
  }

  /** Ctrl-K: delete from the caret to the end of the current logical line. */
  deleteToLineEnd() {
    this.editor.deleteToLineEnd();
    this.refreshSuggestions();
  }

  /** Ctrl-U: delete from the caret back to the start of the current logical line. */
  deleteToLineStart() {
    this.editor.deleteToLineStart();
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
            config: sessionConfig(this.config),
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
      const contextTokens = this.lastTurnUsage?.total_tokens ?? 0;
      this.pushBlock({
        kind: "assistant",
        text:
          `## Status\n\n- Session: \`${this.sessionName ?? "none"}\`\n` +
          `- Model: \`${this.config.model}\`\n- Cwd: \`${this.cwd}\`\n` +
          `- Last turn: ${this.lastTurnDurationMs == null ? "none yet" : formatDuration(this.lastTurnDurationMs)}` +
          `${this.lastTurnUsage ? ` (${formatTokens(this.lastTurnUsage)})` : ""}\n` +
          `- Context tokens: ${contextTokens.toLocaleString()}\n` +
          `- Turns: ${turns}\n` +
          `- Limits: ${this.config.maxSteps ?? 100} model steps, ${this.config.maxRetries ?? 2} retries, ` +
          `${this.config.requestTimeoutMs ?? 300_000}ms/request, ` +
          `${(this.config.maxToolResultChars ?? 50_000).toLocaleString()} chars/tool result`,
      });
    } else if (command === "/model") {
      if (args.length === 0) {
        this.pushBlock({
          kind: "assistant",
          text:
            `## Model\n\nCurrent model: \`${this.config.model}\`\n` +
            `Use \`/model <name>\` to switch. The override is saved with this session ` +
            `and restored on resume; \`/new\` resets to \`${this.defaultModel}\`.`,
        });
      } else if (args.length > 1) {
        this.pushBlock({ kind: "error", text: "usage: /model <name>" });
      } else {
        const model = args[0].trim();
        if (!model) {
          this.pushBlock({ kind: "error", text: "usage: /model <name>" });
        } else if (model === this.config.model) {
          this.pushBlock({ kind: "result", ok: true, summary: `model is already ${model}` });
        } else {
          this.config.model = model;
          if (this.session) {
            await this.session.setModel(model).catch((err) => {
              this.pushBlock({ kind: "error", text: `could not save the model to this session: ${err.message}` });
            });
          }
          this.pushBlock({ kind: "result", ok: true, summary: `model switched to ${model}` });
        }
      }
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
            const size = item.size != null ? ` · ${formatChars(item.size)}B` : "";
            const prompt = item.lastPrompt
              ? ` — ${item.lastPrompt.replace(/`/g, "'").slice(0, 80)}${item.lastPrompt.length > 80 ? "…" : ""}`
              : "";
            return `${active} \`${item.name}\` — ${item.turns} turn${item.turns === 1 ? "" : "s"}, ${date}${size}${prompt}`;
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
          this.refreshSessionNames();
        });
      }
    } else if (command === "/name") {
      if (args.length !== 1) {
        this.pushBlock({ kind: "error", text: "usage: /name <name> — rename the current session" });
      } else if (!this.renameSession) {
        this.pushBlock({ kind: "error", text: "session renaming is unavailable in this frontend" });
      } else if (args[0] === this.sessionName) {
        this.pushBlock({ kind: "result", ok: true, summary: `already named ${this.sessionName}` });
      } else {
        await this.withLocalTask(async () => {
          const safe = await this.renameSession(this.sessionName, args[0]);
          if (this.session && typeof this.session.renameTo === "function") this.session.renameTo(safe);
          this.sessionName = safe;
          this.pushBlock({ kind: "result", ok: true, summary: `session renamed to ${safe}` });
          this.refreshSessionNames();
        });
      }
    } else if (command === "/new") {
      if (!this.newSession) {
        this.pushBlock({ kind: "error", text: "starting a new session is unavailable in this frontend" });
      } else {
        const name = args.length ? args.join(" ") : undefined;
        try {
          const next = await this.newSession(name);
          this.applySession({ ...next, blocks: [], history: [] }, `started session ${next.sessionName}`);
          this.refreshSessionNames();
        } catch (err) {
          this.pushBlock({ kind: "error", text: err.message });
        }
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
    this.config = { ...this.config, model: next.model ?? this.defaultModel };
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
  // The logic lives in src/tui/suggestions.mjs as pure functions; this
  // section wires them to the TUI's state.

  /** Recompute the live popup from the current buffer and caret. */
  refreshSuggestions() {
    this.suggestion = computeSuggestion({
      buffer: this.inputBuffer,
      cursor: this.inputCursor,
      mode: this.mode,
      cwd: this.cwd,
      sessions: this.sessionNames,
      prev: this.suggestion,
    });
  }

  /** Re-fetch the saved-session name list (used by `/resume` completion). */
  async refreshSessionNames() {
    try {
      this.sessionNames = await this.listSessionNames();
      this.dirtyRendered = true;
    } catch {
      // keep the last known list; completion degrades gracefully
    }
  }

  /** Move the highlighted row; false when no popup is open. */
  suggestionMove(dir) {
    const s = this.suggestion;
    if (!s) return false;
    s.selected = Math.max(0, Math.min(s.items.length - 1, s.selected + dir));
    this.dirtyRendered = true;
    return true;
  }

  /** Accept the highlighted suggestion into the editor. */
  acceptSuggestion(s = this.suggestion) {
    if (!s) return;
    const next = acceptSuggestion(s, this.inputBuffer, this.inputCursor);
    this.inputBuffer = next.buffer;
    this.inputCursor = next.cursor;
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
    return suggestionLines(this.suggestion, {
      width: this.width,
      height: this.height,
      editorHeight: this._editorHeight,
      cwd: this.cwd,
    });
  }

  // ---- frame building -----------------------------------------------------

  statusText() { return statusText(this); }
  footer() { return footerText(this); }
  header() { return headerText(this); }
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
    // Blank separator line between transcript and editor
    frame[1 + transcriptHeight] = "";

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
    const decoded = decodeEscape(this.rawBuf);
    if (!decoded) return false;
    this.rawBuf = this.rawBuf.slice(decoded.consumed);
    if (decoded.pasting) this.pasting = true;
    else if (decoded.action) this.runAction(decoded.action);
    return true;
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
      this.editor.insert(String.fromCodePoint(cp));
      this.dirtyRendered = true;
    }
    this.refreshSuggestions();
  }

  backspace() {
    this.editor.backspace();
    this.refreshSuggestions();
  }

  deleteAtCursor() {
    this.editor.deleteAtCursor();
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
    this.editor.historyUp();
    this.dirtyRendered = true;
    this.refreshSuggestions();
  }

  historyDown() {
    this.editor.historyDown();
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
