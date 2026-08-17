/**
 * Live suggestions for the prompt editor: slash commands while the input is a
 * bare `/...`, saved-session names after `/resume `, and `@path` entries while
 * the caret sits right after an `@token`.
 *
 * Pure functions over plain input state: the TUI recomputes its `suggestion`
 * field with `computeSuggestion` after every edit, applies accepted
 * replacements with `acceptSuggestion`, and renders the popup with
 * `suggestionLines`. File-system reads happen here (listing `@path` entries),
 * but there is no terminal or controller state.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { styleText, stripAnsi, dispWidth, truncateEnd } from "./renderers.mjs";
import { theme } from "../theme.mjs";
import { SLASH_COMMANDS } from "./commands.mjs";

export const SUGGESTION_ROWS = 8;

/**
 * Recompute the live popup from an input snapshot. Returns the next suggestion
 * (or `null` when nothing applies). The previous suggestion is used only to
 * preserve the highlighted row across recomputes (each keystroke shrinks the
 * list): the same label is kept when it still matches, otherwise the old index
 * is clamped; it resets only when the token kind changes or no popup was open.
 */
export function computeSuggestion({ buffer, cursor, mode, cwd, sessions, prev }) {
  if (mode !== "idle") return null;
  const before = buffer.slice(0, cursor);
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
    return items.length
      ? { kind: "slash", items, start: 0, end: buffer.length, selected: selectedFor("slash", items) }
      : null;
  }

  // Session names after "/resume ", e.g. "/resume work-". The token is the
  // text between the space and the caret; an empty token lists every session.
  const resume = /^\/resume\s+([^\s]*)$/.exec(before);
  if (resume && Array.isArray(sessions)) {
    const typed = resume[1];
    const items = sessions.filter((name) => name.startsWith(typed)).map((name) => ({ label: name }));
    if (!items.length) return null;
    return {
      kind: "session",
      items,
      start: before.length - typed.length,
      end: cursor,
      selected: selectedFor("session", items),
    };
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
      entries = readdirSync(resolve(cwd, dirPart || "."), { withFileTypes: true })
        .filter(
          (entry) =>
            !entry.name.includes('"') &&
            (prefix.startsWith(".") || !entry.name.startsWith(".")) &&
            entry.name.startsWith(prefix)
        )
        .map((entry) => {
          // Resolve symlink targets at list time: a link to a directory sorts
          // and completes as a directory, so Tab can descend into it.
          let isDirectory = entry.isDirectory();
          let symlinkTarget = null;
          if (entry.isSymbolicLink()) {
            try {
              symlinkTarget = realpathSync(resolve(cwd, dirPart || ".", entry.name));
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
      return null;
    }
    if (!entries.length) return null;
    return {
      kind: "path",
      items: entries,
      start: before.length - typed.length - (quoted ? 2 : 1),
      end: cursor,
      dirPart,
      quoted,
      selected: selectedFor("path", entries),
    };
  }

  return null;
}

/**
 * Accept the highlighted suggestion: slash commands replace the whole input
 * with the command name; `@path` tokens are replaced in place (quoted when
 * needed, trailing slash for directories, trailing space for files).
 * Returns the new `{ buffer, cursor }`.
 */
export function acceptSuggestion(s, buffer, cursor) {
  if (!s) return { buffer, cursor };
  if (s.kind === "slash") {
    const item = s.items[s.selected] ?? s.items[0];
    buffer = item.label + " ";
    return { buffer, cursor: buffer.length };
  }
  if (s.kind === "session") {
    const item = s.items[s.selected] ?? s.items[0];
    const replacement = item.label + " ";
    buffer = buffer.slice(0, s.start) + replacement + buffer.slice(s.end);
    return { buffer, cursor: s.start + replacement.length };
  }
  const item = s.items[s.selected] ?? s.items[0];
  const path = `${s.dirPart}${item.label}`;
  const needsQuotes = s.quoted || /\s/.test(path);
  const replacement = needsQuotes
    ? `@"${path}${item.isDirectory ? "" : '" '}`
    : `@${path}${item.isDirectory ? "" : " "}`;
  buffer = buffer.slice(0, s.start) + replacement + buffer.slice(s.end);
  return { buffer, cursor: s.start + replacement.length };
}

/** Compact a resolved symlink target for the popup: relative to cwd when inside. */
function shortTarget(target, cwd) {
  const root = cwd.replace(/\/+$/, "");
  if (target.startsWith(root + "/")) return target.slice(root.length + 1);
  return basename(target);
}

/**
 * Styled rows for the suggestion popup, ready to paste into a frame. The item
 * window scrolls with the highlight and one always-present status row keeps a
 * constant height instead of growing or shrinking as the "↑ / ↓ N more" hints
 * appear and disappear.
 */
export function suggestionLines(s, { width, height, editorHeight, cwd }) {
  if (!s || !s.items.length) return [];
  width = Math.max(1, width - 4);
  // How many rows are visible above the editor (header included). buildFrame
  // reserves exactly this many for the popup, so the window must match it.
  const budget = Math.max(1, height - 2 - (editorHeight ?? 1));
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
      : s.kind === "session"
        ? styleText("sessions", { fg: theme.dim, italic: true })
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
          ? ` → ${shortTarget(item.symlinkTarget, cwd)}`
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
  // One always-present status row reports what is hidden, using one arrow per
  // direction: `↑ N more` above, `↓ N more` below (or the match count).
  const status =
    w.above > 0 && w.below > 0
      ? `↑ ${w.above} more · ↓ ${w.below} more`
      : w.above > 0
        ? `↑ ${w.above} more`
        : w.below > 0
          ? `↓ ${w.below} more`
          : `${s.items.length} ${s.items.length === 1 ? "match" : "matches"}`;
  lines.push(styleText(truncateEnd(status, width), { fg: theme.dim }));
  // Degenerate tiny terminals: the status row is the first to go, keeping the
  // header and the highlighted item on screen.
  if (lines.length > budget) lines.pop();
  return lines;
}
