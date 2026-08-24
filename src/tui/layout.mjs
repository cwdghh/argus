/**
 * Full-frame assembly for the TUI.
 *
 * `buildFrame` turns a snapshot of the controller state (a `MinimalTui`
 * instance or any object with the same methods/fields) into the complete set
 * of terminal rows for one render pass: header, transcript, empty-state hint,
 * editor with live suggestions / confirm row, and footer.
 *
 * It is the layout pass only — it calls the pure renderers (headerText,
 * footerText, transcriptLines, Editor.view, suggestionLines) and returns the
 * rows plus the geometry the controller needs to place the caret. It mutates
 * only the scroll clamp on the passed-in state, mirroring how the on-screen
 * layout is responsible for keeping the scroll offset in range.
 */
import { styleText, truncateMiddle, truncateEnd, dispWidth } from "./renderers.mjs";
import { suggestionLines } from "./suggestions.mjs";
import { theme } from "../theme.mjs";

/**
 * Assemble one frame.
 *
 * @param {object} state - controller snapshot: width/height/header()/footer()/
 *   transcriptLines()/inputView()/suggestion, scrollOffset, blocks, mode,
 *   pendingConfirm, cwd
 * @returns {{ rows: string[], editorHeight: number, inputCol: number, inputRow: number }}
 */
export function buildFrame(state) {
  const width = state.width;
  const height = state.height;
  const rows = new Array(height).fill("");

  rows[0] = state.header();

  const view = state.inputView();
  const editorHeight = view.height;

  const lines = state.transcriptLines();
  const transcriptHeight = Math.max(1, height - 4 - (editorHeight - 1));
  const maxStart = Math.max(0, lines.length - transcriptHeight);
  // scrollOffset is an absolute first-visible-line index, or null while
  // following the latest output (the default, so generation stays in view).
  // Absolute positions never shift when the transcript grows; only clamping
  // can move the viewport, and reaching the bottom resumes following.
  if (state.scrollOffset != null) {
    if (state.scrollOffset >= maxStart) {
      state.scrollOffset = null;
    } else {
      state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxStart));
    }
  }
  const start = state.scrollOffset == null ? maxStart : state.scrollOffset;
  for (let r = 0; r < transcriptHeight; r++) {
    rows[1 + r] = lines[start + r] ?? "";
  }
  // Blank separator line between transcript and editor
  rows[1 + transcriptHeight] = "";

  if (state.blocks.length === 0) {
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
      rows[1 + startRow + i] = styleText(centered, { fg: theme.dim });
    });
  }

  let inputCol;
  let inputRow;
  if (state.pendingConfirm) {
    // Confirmation mode is deliberately visual and separate: a dedicated row
    // above the editor showing the tool + cwd + command, with an explicit
    // y / n · Esc affordance, and the editor placeholder switches to a
    // confirm-specific hint. This keeps high-risk-bash confirmations from
    // being mistaken for ordinary transcript content.
    const p = state.pendingConfirm;
    const where = p.cwd ? ` in ${truncateMiddle(p.cwd, Math.max(8, width - 44))}` : "";
    const label = p.tool ?? "command";
    const command = truncateMiddle(p.command ?? "", Math.max(12, width - 44));
    rows[height - 3] = styleText(
      `⚠ ${label}${where}: ${command}`,
      { fg: theme.bad, bold: true }
    );
    rows[height - 2] = styleText("   [y] approve  ·  [n] deny  ·  [Esc] cancel", { fg: theme.dim });
    // The editor row stays put (so the caret doesn't jump); it just shows a
    // confirm hint instead of a placeholder.
    inputCol = 0;
    inputRow = height - 2;
  } else {
    const placeholder =
      state.mode === "idle"
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
    const firstEditorRow = height - 1 - view.height;

    // Live suggestion popup sits directly above the editor, overlaying the
    // bottom of the transcript while it is open.
    const suggestionRows = state.suggestion
      ? suggestionLines(state.suggestion, { width, height, editorHeight, cwd: state.cwd })
      : [];
    if (suggestionRows.length) {
      const maxPopupRows = Math.max(1, firstEditorRow - 1);
      const visible = suggestionRows.slice(0, maxPopupRows);
      const popupStart = firstEditorRow - visible.length;
      visible.forEach((line, i) => {
        rows[popupStart + i] = line;
      });
    }

    view.rows.forEach((rowText, i) => {
      const row = firstEditorRow + i;
      const isCaretRow = i === view.caretRow;
      const marker = i === 0 ? "❯" : "│";
      const markerStyle = i === 0 ? { fg: theme.accent, bold: true } : { fg: theme.rail, dim: true };
      if (rowText) {
        rows[row] = `${styleText(marker, markerStyle)} ${rowText}`;
      } else if (isCaretRow) {
        rows[row] = `${styleText("❯", { fg: theme.accent, bold: true })} ${
          styleText(truncateEnd(placeholder, Math.max(1, width - 3)), { fg: theme.dim, italic: true })
        }`;
      } else {
        rows[row] = styleText("│", { fg: theme.rail, dim: true }) + " "; // empty continuation rail
      }
    });
    inputCol = view.col;
    inputRow = firstEditorRow + view.caretRow;
  }

  rows[height - 1] = state.footer();
  return { rows, editorHeight, inputCol, inputRow };
}
