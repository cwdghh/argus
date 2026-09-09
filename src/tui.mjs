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
import { runTurn } from "./agent.mjs";
import { nextContextTokens } from "./compact.mjs";
import { formatDuration } from "./format.mjs";
import { appendBlock, consumeAgentEvent } from "./transcript.mjs";
import { theme } from "./theme.mjs";
import { sessionConfig } from "./session/index.mjs";
import { Editor } from "./tui/editor.mjs";
import { COMMANDS } from "./tui/commands.mjs";
import { footerText, headerText } from "./tui/frames.mjs";
import { decodeEscape } from "./tui/keys.mjs";
import { buildFrame } from "./tui/layout.mjs";
import { refreshGitStatus, startTui, stopTui } from "./tui/lifecycle.mjs";
import { acceptSuggestion, computeSuggestion } from "./tui/suggestions.mjs";
import {
  styleText,
  stripAnsi,
  previousCharIndex,
  nextCharIndex,
  previousWordIndex,
} from "./tui/renderers.mjs";
import { blockLines } from "./tui/blocks.mjs";

const ESC = "\x1b";
// Pastes beyond either bound render the submitted user block as `[pasted N …]`
// instead of flooding the transcript; the full text still persists and is what
// actually reaches the model.
const PASTE_ABBREV_CHARS = 1000;
const PASTE_ABBREV_LINES = 20;

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
  }

  transcriptLines() {
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
      out.push(...blockLines(block, this.width));
    }
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
    this.dirtyRendered = true;
  }

  append(kind, delta) {
    appendBlock(this.blocks, kind, delta);
    this.dirtyRendered = true;
  }

  async submit() {
    if (this.mode !== "idle") return;
    if (this.pendingConfirm) return; // a confirmation is in flight; Enter submits y/n via insertText
    const text = this.editor.buffer.trim();
    if (!text) return;
    const pasteMeta = this.editor.lastPaste;
    this.editor.lastPaste = null;
    this.editor.draft = null;
    this.editor.buffer = "";
    this.editor.cursor = 0;
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

    if (this.editor.history[this.editor.history.length - 1] !== text) this.editor.history.push(text);
    this.editor.historyIndex = -1;
    const turnStart = this.blocks.length;
    this.pushBlock({ kind: "user", text: this.userPromptText(text, pasteMeta) });

    const ac = new AbortController();
    this.abortController = ac;
    let savedMessages = [{ role: "user", content: text }];
    let outcome = "completed";
    try {
      const { messages, aborted, cwd } = await runTurn(this.config, this.history, text, (ev) => {
        // Mode/live-state tracking is frontend-specific; the blocks both
        // frontends persist come from the shared consumeAgentEvent so the TUI
        // and headless can never drift (W6.6).
        if (ev.type === "tool_call") {
          this.activeToolStartedAt = this.now();
          this.activeTool = { name: ev.name, args: ev.args };
          if (this.mode !== "aborting") this.mode = "working";
        } else if (ev.type === "thinking_delta") {
          this.mode = "thinking";
        } else if (ev.type === "text_delta" || ev.type === "tool_result" || ev.type === "compacted" || ev.type === "retrying") {
          if (this.mode !== "aborting") this.mode = "working";
        } else if (ev.type === "cwd_change") {
          this.cwd = ev.cwd;
          if (this.session) this.session.setCwd(ev.cwd).catch(() => {});
        } else if (ev.type === "usage") {
          this.turnUsage = ev.usage;
        }
        if (ev.type === "tool_result") {
          // The one block field the projector can't derive: the tool's wall time.
          const durationMs = this.activeToolStartedAt == null ? null : this.now() - this.activeToolStartedAt;
          this.activeToolStartedAt = null;
          this.activeTool = null;
          consumeAgentEvent(this.blocks, ev, { durationMs });
        } else {
          consumeAgentEvent(this.blocks, ev);
        }
        this.dirtyRendered = true;
      }, {
        signal: ac.signal,
        cwd: this.cwd,
        authorize: (request) => this.confirm(request),
        // Real tokens of the context this turn will re-send (previous request's
        // prompt + its completion); feeds the 200K-token compaction trigger.
        lastTokens: nextContextTokens(this.lastTurnUsage),
      });
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
          // Static config (incl. systemPrompt) is persisted once per session,
          // not with every turn; appendTurn stores only the model delta.
          await this.session.setConfig(this.config);
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
      this.activeTool = null;
      this.activeToolStartedAt = null;
      this.activityStartedAt = null;
      this.mode = "idle";
      // Leave the scroll anchor alone: a user who scrolled back during
      // generation keeps reading the same spot instead of being yanked to
      // the bottom when the turn ends. The default (null) follows anyway.
      this.dirtyRendered = true;
    }
  }

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

  onData(chunk) {
    this.rawBuf += this.decoder.decode(chunk, { stream: true });
    this.consumeInput();
  }

  consumeInput() {
    if (this.pasting) {
      const end = this.rawBuf.indexOf("\x1b[201~");
      if (end === -1) return;
      // Normalize CRLF/CR to LF but keep every other byte — a paste is data,
      // not key presses, so control bytes must not be interpreted (W1).
      const pasted = this.rawBuf.slice(0, end).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      this.rawBuf = this.rawBuf.slice(end + 6);
      this.pasting = false;
      this.pasteLiteral(pasted);
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
    if (this.pendingConfirm) return this.confirmKey(text);
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 32 || cp === 127) {
        if (cp === 1) this.editor.cursor = 0; // Ctrl-A
        else if (cp === 9) this.completePath(); // Tab
        else if (cp === 3) this.handleCtrlC();
        else if (cp === 4) {
          // Ctrl-D quits only on an empty buffer *while idle* — mid-turn it must
          // not exit (the mode guard mirrors Esc / Ctrl-C).
          if (!this.editor.buffer && this.mode === "idle") this.stop();
          else if (this.editor.buffer) this.deleteAtCursor();
        } else if (cp === 5) this.editor.cursor = this.editor.buffer.length; // Ctrl-E
        else if (cp === 11) this.deleteToLineEnd(); // Ctrl-K
        else if (cp === 12) this.redraw(); // Ctrl-L
        else if (cp === 21) this.deleteToLineStart(); // Ctrl-U
        else if (cp === 23) { // Ctrl-W
          const previous = previousWordIndex(this.editor.buffer, this.editor.cursor);
          this.editor.buffer = this.editor.buffer.slice(0, previous) + this.editor.buffer.slice(this.editor.cursor);
          this.editor.cursor = previous;
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

  /** A potential y/n input while a confirmation is pending (Enter or a paste). */
  confirmKey(text) {
    const ch = String(text).trim().toLowerCase()[0];
    if (ch === "y") this.resolveConfirm(true);
    else if (ch === "n") this.resolveConfirm(false);
  }

  /**
   * Insert a bracketed-paste payload literally, bypassing the per-character
   * keybinding interpreter. Control bytes (TAB, Ctrl-A/K/U, ESC, …) become
   * text, and embedded newlines must never fire submit() — the payload lands in
   * one editor.insert() call.
   */
  pasteLiteral(text) {
    if (this.pendingConfirm) return this.confirmKey(text);
    this.editor.insert(text);
    // Large pastes abbreviate the rendered user block (W1): record the shape
    // so submit() knows when the prompt came straight from a paste.
    const lines = text.split("\n").length;
    if (text.length > PASTE_ABBREV_CHARS || lines > PASTE_ABBREV_LINES) {
      this.editor.lastPaste = { chars: text.length, lines, text: text.trim() };
    }
    this.dirtyRendered = true;
    this.refreshSuggestions();
  }

  /**
   * The text of the submitted `user` block. A large paste renders as a marker
   * (the full prompt still reaches the model and persists in the session) but
   * only when it is exactly what is submitted — edits after the paste keep the
   * real text visible.
   */
  userPromptText(text, pasteMeta) {
    if (!pasteMeta) return text;
    if (text !== pasteMeta.text) return text;
    if (pasteMeta.chars > PASTE_ABBREV_CHARS || pasteMeta.lines > PASTE_ABBREV_LINES) {
      return pasteMeta.lines > 1 ? `[pasted ${pasteMeta.lines} lines]` : `[pasted ${pasteMeta.chars} chars]`;
    }
    return text;
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
        this.editor.cursor = previousCharIndex(this.editor.buffer, this.editor.cursor);
        this.refreshSuggestions();
        break;
      case "right":
        this.editor.cursor = nextCharIndex(this.editor.buffer, this.editor.cursor);
        this.refreshSuggestions();
        break;
      case "up":
        if (this.suggestion) {
          this.suggestionMove(-1);
          break;
        }
        if (this.editor.buffer.includes("\n")) {
          if (this.moveCaretVertical(-1)) break;
        }
        this.historyUp();
        return;
      case "down":
        if (this.suggestion) {
          this.suggestionMove(1);
          break;
        }
        if (this.editor.buffer.includes("\n")) {
          if (this.moveCaretVertical(1)) break;
        }
        this.historyDown();
        return;
      case "pageup":
        // "Up" = toward older content: decrease the absolute first-line index.
        this.scrollOffset =
          this.scrollOffset == null
            ? Math.max(0, this.maxScroll() - this.transcriptHeight())
            : Math.max(0, this.scrollOffset - this.transcriptHeight());
        break;
      case "pagedown":
        if (this.scrollOffset != null) {
          const max = this.maxScroll();
          this.scrollOffset = Math.min(this.scrollOffset + this.transcriptHeight(), max);
          // Reaching the bottom resumes following the latest output.
          if (this.scrollOffset >= max) this.scrollOffset = null;
        }
        break;
      case "home":
        this.scrollOffset = 0;
        break;
      case "end":
        this.scrollOffset = null;
        break;
      case "escape":
        if (this.pendingConfirm) this.resolveConfirm(false);
        else if (this.mode !== "idle") this.abortTurn();
        else if (this.suggestion) {
          this.suggestion = null;
        }
        // else: a multiline draft is left untouched — never flatten silently
        // (the editor's history draft slot already protects it on Up/Down).
        break;
      case "wheel":
        if (action.dir > 0) {
          // Wheel up: toward older content.
          this.scrollOffset =
            this.scrollOffset == null
              ? Math.max(0, this.maxScroll() - 3)
              : Math.max(0, this.scrollOffset - 3);
        } else if (this.scrollOffset != null) {
          // Wheel down: toward the bottom; reaching it resumes following.
          const max = this.maxScroll();
          this.scrollOffset = Math.min(this.scrollOffset + 3, max);
          if (this.scrollOffset >= max) this.scrollOffset = null;
        }
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
