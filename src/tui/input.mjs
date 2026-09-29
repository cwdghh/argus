/** Terminal input decoding and actions, operating on the explicit TUI state. */
import { decodeEscape } from "./keys.mjs";
import { previousCharIndex, nextCharIndex, previousWordIndex } from "./renderers.mjs";

// Pastes beyond either bound render the submitted user block as `[pasted N …]`
// instead of flooding the transcript; the full text still persists and is what
// actually reaches the model.
const PASTE_ABBREV_CHARS = 1000;
const PASTE_ABBREV_LINES = 20;
export function onData(tui, chunk) {
  tui.rawBuf += tui.decoder.decode(chunk, { stream: true });
  tui.consumeInput();
}

export function consumeInput(tui) {
  if (tui.pasting) {
    const end = tui.rawBuf.indexOf("\x1b[201~");
    if (end === -1) return;
    // Normalize CRLF/CR to LF but keep every other byte — a paste is data,
    // not key presses, so control bytes must not be interpreted.
    const pasted = tui.rawBuf.slice(0, end).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    tui.rawBuf = tui.rawBuf.slice(end + 6);
    tui.pasting = false;
    tui.pasteLiteral(pasted);
    tui.consumeInput();
    return;
  }
  const esc = tui.rawBuf.indexOf("\x1b");
  if (esc === -1) {
    if (tui.rawBuf) {
      tui.insertText(tui.rawBuf);
      tui.rawBuf = "";
    }
    tui.clearEscTimeout();
    return;
  }
  if (esc > 0) {
    tui.insertText(tui.rawBuf.slice(0, esc));
    tui.rawBuf = tui.rawBuf.slice(esc);
  }
  if (tui.tryEscape()) {
    tui.clearEscTimeout();
    tui.consumeInput();
  } else if (tui.rawBuf === "\x1b") {
    tui.scheduleEscTimeout();
  }
}

export function scheduleEscTimeout(tui) {
  if (tui.escTimer) return;
  tui.escTimer = setTimeout(() => {
    tui.escTimer = null;
    if (tui.stopped) return;
    if (tui.rawBuf === "\x1b") {
      tui.rawBuf = "";
      tui.runAction({ type: "escape" });
    }
  }, 60);
}

export function clearEscTimeout(tui) {
  if (tui.escTimer) {
    clearTimeout(tui.escTimer);
    tui.escTimer = null;
  }
}

export function tryEscape(tui) {
  const decoded = decodeEscape(tui.rawBuf);
  if (!decoded) return false;
  tui.rawBuf = tui.rawBuf.slice(decoded.consumed);
  if (decoded.pasting) tui.pasting = true;
  else if (decoded.action) tui.runAction(decoded.action);
  return true;
}

export function insertText(tui, text) {
  if (tui.pendingConfirm) {
    if (text.startsWith("/") || tui.editor.buffer.startsWith("/")) {
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") tui.submit();
        else tui.editor.insert(ch);
      }
      tui.dirtyRendered = true;
      return;
    }
    return tui.confirmKey(text);
  }
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || cp === 127) {
      if (cp === 1) tui.editor.cursor = 0; // Ctrl-A
      else if (cp === 9) tui.completePath(); // Tab
      else if (cp === 3) tui.handleCtrlC();
      else if (cp === 4) {
        // Ctrl-D quits only on an empty buffer *while idle* — mid-turn it must
        // not exit (the mode guard mirrors Esc / Ctrl-C).
        if (!tui.editor.buffer && tui.mode === "idle") tui.stop();
        else if (tui.editor.buffer) tui.deleteAtCursor();
      } else if (cp === 5) tui.editor.cursor = tui.editor.buffer.length; // Ctrl-E
      else if (cp === 11) tui.deleteToLineEnd(); // Ctrl-K
      else if (cp === 12) tui.redraw(); // Ctrl-L
      else if (cp === 21) tui.deleteToLineStart(); // Ctrl-U
      else if (cp === 23) { // Ctrl-W
        const previous = previousWordIndex(tui.editor.buffer, tui.editor.cursor);
        tui.editor.buffer = tui.editor.buffer.slice(0, previous) + tui.editor.buffer.slice(tui.editor.cursor);
        tui.editor.cursor = previous;
      } else if (cp === 13 || cp === 10) {
        tui.submit();
      } else if (cp === 127 || cp === 8) {
        tui.backspace();
      }
      tui.dirtyRendered = true;
      continue;
    }
    tui.editor.insert(String.fromCodePoint(cp));
    tui.dirtyRendered = true;
  }
  tui.refreshSuggestions();
}

export function confirmKey(tui, text) {
  const ch = String(text).trim().toLowerCase()[0];
  if (ch === "y") tui.resolveConfirm(true);
  else if (ch === "n") tui.resolveConfirm(false);
}

export function pasteLiteral(tui, text) {
  if (tui.pendingConfirm) {
    if (text.startsWith("/steer ")) {
      tui.editor.insert(text);
      tui.dirtyRendered = true;
      return;
    }
    return tui.confirmKey(text);
  }
  tui.editor.insert(text);
  // Large pastes abbreviate the rendered user block: record the shape
  // so submit() knows when the prompt came straight from a paste.
  const lines = text.split("\n").length;
  if (text.length > PASTE_ABBREV_CHARS || lines > PASTE_ABBREV_LINES) {
    tui.editor.lastPaste = { chars: text.length, lines, text: text.trim() };
  }
  tui.dirtyRendered = true;
  tui.refreshSuggestions();
}

export function userPromptText(text, pasteMeta) {
  if (!pasteMeta) return text;
  if (text !== pasteMeta.text) return text;
  if (pasteMeta.chars > PASTE_ABBREV_CHARS || pasteMeta.lines > PASTE_ABBREV_LINES) {
    return pasteMeta.lines > 1 ? `[pasted ${pasteMeta.lines} lines]` : `[pasted ${pasteMeta.chars} chars]`;
  }
  return text;
}

export function runAction(tui, action) {
  if (tui.stopped) return;
  switch (action.type) {
    case "exit":
      return tui.stop();
    case "enter":
      return tui.submit();
    case "shiftenter":
      tui.insertNewline();
      break;
    case "backspace":
      tui.backspace();
      break;
    case "delete":
      tui.deleteAtCursor();
      break;
    case "left":
      tui.editor.cursor = previousCharIndex(tui.editor.buffer, tui.editor.cursor);
      tui.refreshSuggestions();
      break;
    case "right":
      tui.editor.cursor = nextCharIndex(tui.editor.buffer, tui.editor.cursor);
      tui.refreshSuggestions();
      break;
    case "up":
      if (tui.suggestion) {
        tui.suggestionMove(-1);
        break;
      }
      if (tui.editor.buffer.includes("\n")) {
        if (tui.moveCaretVertical(-1)) break;
      }
      tui.historyUp();
      return;
    case "down":
      if (tui.suggestion) {
        tui.suggestionMove(1);
        break;
      }
      if (tui.editor.buffer.includes("\n")) {
        if (tui.moveCaretVertical(1)) break;
      }
      tui.historyDown();
      return;
    case "pageup":
      // "Up" = toward older content: decrease the absolute first-line index.
      tui.scrollOffset =
        tui.scrollOffset == null
          ? Math.max(0, tui.maxScroll() - tui.transcriptHeight())
          : Math.max(0, tui.scrollOffset - tui.transcriptHeight());
      break;
    case "pagedown":
      if (tui.scrollOffset != null) {
        const max = tui.maxScroll();
        tui.scrollOffset = Math.min(tui.scrollOffset + tui.transcriptHeight(), max);
        // Reaching the bottom resumes following the latest output.
        if (tui.scrollOffset >= max) tui.scrollOffset = null;
      }
      break;
    case "home":
      tui.scrollOffset = 0;
      break;
    case "end":
      tui.scrollOffset = null;
      break;
    case "escape":
      if (tui.pendingConfirm) tui.resolveConfirm(false);
      else if (tui.mode !== "idle") tui.abortTurn();
      else if (tui.suggestion) {
        tui.suggestion = null;
      }
      // else: a multiline draft is left untouched — never flatten silently
      // (the editor's history draft slot already protects it on Up/Down).
      break;
    case "wheel":
      if (action.dir > 0) {
        // Wheel up: toward older content.
        tui.scrollOffset =
          tui.scrollOffset == null
            ? Math.max(0, tui.maxScroll() - 3)
            : Math.max(0, tui.scrollOffset - 3);
      } else if (tui.scrollOffset != null) {
        // Wheel down: toward the bottom; reaching it resumes following.
        const max = tui.maxScroll();
        tui.scrollOffset = Math.min(tui.scrollOffset + 3, max);
        if (tui.scrollOffset >= max) tui.scrollOffset = null;
      }
      break;
    default:
      return;
  }
  tui.dirtyRendered = true;
}
