/**
 * The multiline prompt editor.
 *
 * A pure state machine over the input buffer, the caret position, and the
 * promote-recall history. It knows nothing about the terminal, rendering, or
 * the agent loop: all methods are plain mutations / computations, and the TUI
 * (or a test) decides what to render afterwards. Its visual geometry helpers
 * (`rows`, `caretPos`, `view`) share the same UTF-8-aware width math as the
 * transcript via `renderers.mjs`.
 */
import { wrap, charWidth, dispWidth, previousCharIndex, nextCharIndex } from "./renderers.mjs";

export class Editor {
  constructor() {
    this.buffer = "";
    this.cursor = 0;
    this.history = [];
    this.historyIndex = -1;
    // In-progress input stashed when history recall starts, so walking back
    // off the end of the history restores the draft instead of dropping it.
    this.draft = null;
    // Meta about the last bracketed paste (set only for large pastes) so the
    // TUI can render the submitted user block as `[pasted N lines]`.
    this.lastPaste = null;
  }

  /**
   * The editor is a multiline text area. It is rendered bottom-up from the
   * footer: the last logical line sits on the row just above the footer, and
   * earlier lines stack upward. Each logical line is wrapped to `width - 4`
   * columns and rendered as `❯ ` + content (first line) or `│ ` + content
   * (continuation lines). Long buffers scroll horizontally so the caret stays
   * visible.
   */
  rows(width) {
    const inputWidth = Math.max(1, width - 4);
    const logical = this.buffer.split("\n");
    const rows = [];
    for (const l of logical) rows.push(...(l === "" ? [""] : wrap(l, inputWidth)));
    return rows;
  }

  /** Absolute cursor -> { row (display-row index), col (char offset in row) }. */
  caretPos(width) {
    const inputWidth = Math.max(1, width - 4);
    const logicalLines = this.buffer.split("\n");
    const rows = this.rows(width);
    let remaining = this.cursor;
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

  /**
   * The visible editor: which wrapped rows fit on screen (with horizontal and
   * vertical windows), where the caret row lands, and the rendered caret
   * column. `{ rows, height, caretRow, col }` describes the view;
   * `height` is the number of editor rows the frame must reserve.
   */
  view(width, height) {
    const maxEditor = Math.max(1, height - 4);
    const rows = this.rows(width);
    const pos = this.caretPos(width);
    let active = pos.row;
    let lineCursor = pos.col;
    if (active >= rows.length) active = rows.length - 1;

    // Horizontal window: center the caret column when a row overflows.
    let buff = rows[active];
    let cursor = dispWidth(buff.slice(0, lineCursor));
    const inputWidth = Math.max(1, width - 4);
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

    return {
      rows: viewRows,
      height: viewRows.length,
      caretRow: activeInView,
      col: 2 + cursor,

    };
  }

  /** Insert `text` at the caret. */
  insert(text) {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  insertNewline() {
    const s = "\n";
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
  }

  /** Move the caret one display row up/down in multiline input; false if no row. */
  moveCaretVertical(dir, width) {
    const pos = this.caretPos(width);
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
    const inputWidth = Math.max(1, width - 4);
    const logicalLines = this.buffer.split("\n");
    let displayRow = 0;
    let absolutePos = 0;

    for (let li = 0; li < logicalLines.length; li++) {
      const line = logicalLines[li];
      const wrapped = line === "" ? [""] : wrap(line, inputWidth);

      for (let wi = 0; wi < wrapped.length; wi++) {
        if (displayRow === target) {
          this.cursor = absolutePos + col;
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

    this.cursor = absolutePos + col;
    return true;
  }

  /** Ctrl-K: delete from the caret to the end of the current logical line. */
  deleteToLineEnd() {
    const nl = this.buffer.indexOf("\n", this.cursor);
    const end = nl === -1 ? this.buffer.length : nl;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(end);
  }

  /** Ctrl-U: delete from the caret back to the start of the current logical line. */
  deleteToLineStart() {
    let start = this.buffer.lastIndexOf("\n", this.cursor - 1);
    start = start === -1 ? 0 : start + 1;
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
    this.cursor = start;
  }

  backspace() {
    const previous = previousCharIndex(this.buffer, this.cursor);
    this.buffer = this.buffer.slice(0, previous) + this.buffer.slice(this.cursor);
    this.cursor = previous;
  }

  deleteAtCursor() {
    this.buffer =
      this.buffer.slice(0, this.cursor) + this.buffer.slice(nextCharIndex(this.buffer, this.cursor));
  }

  historyUp() {
    if (!this.history.length) return;
    if (this.historyIndex === -1) {
      // First Up from a live buffer: stash the draft so a later walk off the
      // history end restores it. An empty buffer has no draft to lose.
      if (this.buffer) this.draft = { buffer: this.buffer, cursor: this.cursor };
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }
    this.buffer = this.history[this.historyIndex];
    this.cursor = this.buffer.length;
  }

  historyDown() {
    if (this.historyIndex === -1) return;
    this.historyIndex++;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1;
      if (this.draft) {
        this.buffer = this.draft.buffer;
        this.cursor = this.draft.cursor;
        this.draft = null;
      } else {
        this.buffer = "";
        this.cursor = 0;
      }
    } else {
      this.buffer = this.history[this.historyIndex];
      this.cursor = this.buffer.length;
    }
  }
}
