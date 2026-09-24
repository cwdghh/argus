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
 *   Home/End         jump to top / follow the bottom of the transcript
 *   mouse wheel      scroll the transcript (SGR mouse tracking)
 *
 * Scrolling is anchored to an absolute line index (see `scrollOffset`): the
 * viewport only moves when the user scrolls. While the model is generating,
 * new output grows the transcript below the anchor, so scrolling back stays
 * stable instead of creeping toward the latest line. End (or reaching the
 * bottom) resumes "follow the latest output" mode.
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
import { appendBlock } from "./transcript.mjs";
import { theme, themeRevision } from "./theme.mjs";
import { Editor } from "./tui/editor.mjs";
import { COMMANDS } from "./tui/commands.mjs";
import { footerText, headerText } from "./tui/frames.mjs";
import { buildFrame } from "./tui/layout.mjs";
import { refreshGitStatus, startTui, stopTui } from "./tui/lifecycle.mjs";
import { acceptSuggestion, computeSuggestion } from "./tui/suggestions.mjs";
import {
  styleText,
  stripAnsi,
} from "./tui/renderers.mjs";
import { blockLinesCached } from "./tui/blocks.mjs";
import * as input from "./tui/input.mjs";
import { submitTurn } from "./tui/turn.mjs";

const ESC = "\x1b";
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
    this.deleteSession = opts.deleteSession ?? null;
    this.resumeSession = opts.resumeSession ?? null;
    this.renameSession = opts.renameSession ?? null;
    // Saved-session names for `/resume` and `/delete` completion. Refresh after
    // any session change via refreshSessionNames().
    this.sessionNames = opts.sessionNames ?? [];
    this.listSessionNames = opts.listSessionNames ?? (async () => []);
    this.cwd = opts.initialCwd ?? process.cwd();
    // The multiline prompt editor is a separate pure widget (src/tui/editor.mjs)
    // and is the single owner of all input state: buffer, caret, recall
    // history, and the history walk index. The TUI reads and writes
    // `this.editor.*` directly — there is no second API surface.
    this.editor = new Editor();
    this.editor.history = this.history
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content);
    this.mode = "idle"; // idle | working | thinking | aborting | confirm
    // Absolute index of the first visible transcript line, or null while
    // following the latest output (see the scrolling keys in this header).
    this.scrollOffset = null;
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
    // ... } where items is the filtered list and start/end are the token
    // bounds in the editor buffer that accepting a suggestion replaces.
    this.suggestion = null;
    this.now = opts.now ?? Date.now;
    this.activityStartedAt = null;
    this.lastTurnDurationMs = [...this.blocks].reverse().find((block) => block.kind === "timing")?.durationMs ?? null;
    this.lastTurnUsage = [...this.blocks].reverse().find((block) => block.kind === "timing")?.usage ?? null;
    this.lastClockTick = -1;
    // The tool currently running (undefined when none), for the footer's
    // active-tool line — separate from the turn-level spinner timer.
    this.activeTool = null;
    this.activeToolStartedAt = null;
    // Cumulative token usage for the active turn (real provider counts, not a
    // char estimate). Reset at the start of each turn in submit().
    this.turnUsage = null;
    // Editor row count from the last rendered frame, used by scrolling
    // helpers between frames (the layout pass computes the exact value).
    this.editorHeight = 1;
    // Render cache (W6.2): a per-block cache re-wraps only the mutated tail,
    // and the assembled lines are memoized until a block changes or the width
    // changes. All block mutations bump this._renderStamp.
    this._renderStamp = 0;
    this._lines = null;
    this._linesWidth = -1;
    this._linesStamp = -1;
    this._linesThemeRevision = -1;
  }

  transcriptLines() {
    if (this._lines && this._linesWidth === this.width && this._linesStamp === this._renderStamp && this._linesThemeRevision === themeRevision) {
      return this._lines;
    }
    const out = [];
    let lastKind = null;
    for (const block of this.blocks) {
      // A turn divider separates one user prompt from the previous turn.
      if (block.kind === "user" && lastKind !== null) {
        while (out.length > 0 && stripAnsi(out[out.length - 1]).trim() === "") out.pop();
        if (out.length > 0) {
          const railWidth = Math.min(20, Math.max(4, this.width - 4));
          out.push(styleText("│", { fg: theme.rail }) + "  " + styleText("─".repeat(railWidth), { fg: theme.rail }));
        }
      } else if (lastKind !== null && lastKind !== block.kind) {
        // Clean separation between different kinds of blocks: thinking, tool
        // calls, confirmations, and responses get breathing room. The one
        // deliberate exception is a tool call and its result, which belong
        // together and are never separated by a blank line (they keep their
        // own rail styling to stay distinguishable).
        if (!(lastKind === "tool" && block.kind === "result")) {
          while (out.length > 0 && stripAnsi(out[out.length - 1]).trim() === "") out.pop();
          if (out.length > 0) out.push("");
        }
      }
      lastKind = block.kind;
      out.push(...blockLinesCached(block, this.width));
    }
    this._lines = out;
    this._linesWidth = this.width;
    this._linesStamp = this._renderStamp;
    this._linesThemeRevision = themeRevision;
    return out;
  }

  maxScroll() {
    return Math.max(0, this.transcriptLines().length - this.transcriptHeight());
  }

  /** Rows available for the transcript after reserving header/separator/footer/editor. */
  transcriptHeight() {
    const editorRows = this.editorHeight ?? 1;
    return Math.max(1, this.height - 4 - (editorRows - 1));
  }

  // ---- prompt editor (pure widget in src/tui/editor.mjs) ------------------

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
    this._renderStamp++;
    this.dirtyRendered = true;
  }

  append(kind, delta) {
    appendBlock(this.blocks, kind, delta);
    this._renderStamp++;
    this.dirtyRendered = true;
  }

  submit() { return submitTurn(this); }

  async runCommand(text) {
    this.editor.historyIndex = -1;
    const [name, ...args] = text.trim().split(/\s+/);
    const command = COMMANDS.find((c) => c.name === name);
    if (!command) {
      this.pushBlock({ kind: "error", text: `unknown command: ${name} (try /help)` });
    } else {
      await command.run(this, args);
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
    this._renderStamp++;
    this.lastTurnDurationMs = [...(next.blocks ?? [])].reverse().find((block) => block.kind === "timing")?.durationMs ?? null;
    this.lastTurnUsage = [...(next.blocks ?? [])].reverse().find((block) => block.kind === "timing")?.usage ?? null;
    this.editor.history = this.history
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content);
    this.editor.historyIndex = -1;
    this.editor.draft = null;
    this.editor.lastPaste = null;
    this.scrollOffset = null;
    this.suggestion = null;
    this.refreshGitStatus();
  }

  // ---- suggestions (@path + /command completions) --------------------------
  // The logic lives in src/tui/suggestions.mjs as pure functions; this
  // section wires them to the TUI's state.

  /** Recompute the live popup from the current buffer and caret. */
  refreshSuggestions() {
    this.suggestion = computeSuggestion({
      buffer: this.editor.buffer,
      cursor: this.editor.cursor,
      mode: this.mode,
      cwd: this.cwd,
      sessions: this.sessionNames,
      prev: this.suggestion,
    });
  }

  /** Re-fetch the saved-session name list (used by session command completion). */
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
    const next = acceptSuggestion(s, this.editor.buffer, this.editor.cursor);
    this.editor.buffer = next.buffer;
    this.editor.cursor = next.cursor;
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

  // ---- frame building -----------------------------------------------------

  /** Pure footer/header fragments (see frames.mjs). */
  footer() { return footerText(this); }
  header() { return headerText(this); }

  /**
   * Assemble one full frame (see layout.mjs). Returns the terminal rows; the
   * layout pass also computes caret geometry for render().
   */
  buildFrame() {
    return buildFrame(this).rows;
  }

  // ---- raw input parsing --------------------------------------------------

  onData(chunk) { return input.onData(this, chunk); }

  consumeInput() { return input.consumeInput(this); }

  scheduleEscTimeout() { return input.scheduleEscTimeout(this); }

  clearEscTimeout() { return input.clearEscTimeout(this); }

  tryEscape() { return input.tryEscape(this); }

  insertText(text) { return input.insertText(this, text); }

  /** A potential y/n input while a confirmation is pending (Enter or a paste). */
  confirmKey(text) { return input.confirmKey(this, text); }

  /**
   * Insert a bracketed-paste payload literally, bypassing the per-character
   * keybinding interpreter. Control bytes (TAB, Ctrl-A/K/U, ESC, …) become
   * text, and embedded newlines must never fire submit() — the payload lands in
   * one editor.insert() call.
   */
  pasteLiteral(text) { return input.pasteLiteral(this, text); }

  /**
   * The text of the submitted `user` block. A large paste renders as a marker
   * (the full prompt still reaches the model and persists in the session) but
   * only when it is exactly what is submitted — edits after the paste keep the
   * real text visible.
   */
  userPromptText(text, pasteMeta) { return input.userPromptText(text, pasteMeta); }

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

  runAction(action) { return input.runAction(this, action); }

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
    // A local-command confirmation has no model turn or AbortController to
    // cancel. Treat Ctrl-C like "no" and leave the TUI usable; otherwise the
    // stale `aborting` flag would make the next Ctrl-C force-quit.
    if (this.pendingConfirm && !this.abortController) {
      this.resolveConfirm(false);
      return;
    }
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

  confirm(request) {
    return new Promise((resolve) => {
      const details = typeof request === "string"
        ? { command: request }
        : { ...request, command: request?.args?.command ?? request?.command ?? "approval required" };
      this.pendingConfirm = { ...details, resolve };
      this.mode = "confirm";
      // Keep the decision in the transcript: a distinct confirm block (see
      // blocks.mjs) so a high-risk action is auditable even when it came from a
      // local command (e.g. /delete) rather than the agent loop.
      const reason = details.reason ?? "approval required";
      const label = details.tool ?? (details.command ? "command" : "approval");
      const cwd = details.cwd ? ` in ${details.cwd}` : "";
      this.pushBlock({
        kind: "confirm",
        text: `${label}${cwd}: ${details.command ?? reason}`,
      });
      this.dirtyRendered = true;
    });
  }

  /**
   * Resolve an in-flight confirmation and return the mode that should resume.
   * While a confirm is pending the TUI is in `confirm` mode; the caller decides
   * whether to return to `working` (a model turn is mid-flight) or `idle` (a
   * local command like /delete).
   */
  resolveConfirm(ok) {
    if (!this.pendingConfirm) return;
    const { resolve } = this.pendingConfirm;
    this.pendingConfirm = null;
    this.mode = "working";
    this.dirtyRendered = true;
    resolve(ok);
  }

  // ---- startup / lifecycle (implementation in src/tui/lifecycle.mjs) -------

  start() {
    startTui(this);
  }

  stop() {
    stopTui(this);
  }

  refreshGitStatus() {
    return refreshGitStatus(this);
  }

  render() {
    if (!this.dirtyRendered) return;
    this.dirtyRendered = false;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    const { rows, editorHeight, inputCol, inputRow } = buildFrame(this);
    this.editorHeight = editorHeight;
    process.stdout.write(`${ESC}[?25l`);
    for (let r = 0; r < this.height; r++) {
      if (rows[r] !== this.lastFrame[r]) {
        process.stdout.cursorTo(0, r);
        process.stdout.write(`${ESC}[2K`);
        process.stdout.write(rows[r]);
        this.lastFrame[r] = rows[r];
      }
    }
    process.stdout.cursorTo(Math.min(inputCol, this.width - 1), inputRow ?? this.height - 2);
    process.stdout.write(`${ESC}[?25h`);
  }
}
