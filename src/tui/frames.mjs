/**
 * Pure footer/header/status renderers for the TUI.
 *
 * Each function takes a read-only snapshot of the controller state (a
 * `MinimalTui` instance or any object with the same fields) and returns styled
 * text. They never mutate anything, so they can be unit-tested with plain
 * objects and the controller just delegates:
 *
 *   footer() { return footerText(this); }
 */
import { estimateChars, COMPACT_DEFAULTS } from "../compact.mjs";
import { styleText, stripAnsi, dispWidth, truncateMiddle, truncateEnd, formatDuration, formatChars, formatTokens } from "./renderers.mjs";
import { theme } from "../theme.mjs";

const MODE_COLOR = () => ({
  idle: theme.dim,
  working: theme.accent,
  thinking: theme.think,
  aborting: theme.bad,
  confirm: theme.bad,
});
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Left-hand status text: live phase + elapsed time + real token usage. */
export function statusText(s) {
  if (s.mode !== "idle") {
    if (s.activityStartedAt == null) return s.mode;
    const elapsed = Math.max(0, s.now() - s.activityStartedAt);
    const spinner = SPINNER[Math.floor(elapsed / 100) % SPINNER.length];
    const tokens = formatTokens(s.turnUsage);
    return `${spinner} ${s.mode} ${formatDuration(elapsed)}${tokens ? ` · ${tokens}` : ""}`;
  }
  if (s.lastTurnDurationMs == null) return "idle";
  const tokens = formatTokens(s.lastTurnUsage);
  return `last ${formatDuration(s.lastTurnDurationMs)}${tokens ? ` · ${tokens}` : ""}`;
}

/**
 * The full footer line: status + token usage on the left, then a right-aligned
 * meta area (git status, model, context-window usage vs. the compaction
 * budget, working directory). Lower-priority details (context, model) are
 * dropped first on narrow terminals; if even git won't fit, the working
 * directory is shown alone.
 */
export function footerText(s) {
  const status = statusText(s);
  const statusBudget = Math.max(1, Math.min(dispWidth(status), s.width));
  const statusPlain = truncateMiddle(status, statusBudget);
  const statusStr = styleText(statusPlain, {
    fg: MODE_COLOR()[s.mode] ?? theme.dim,
    bold: s.mode !== "idle",
  });
  const model = s.config.model;
  const git =
    s.git.branch != null
      ? `git ${s.git.branch}${s.git.dirty ? ` ~${s.git.dirtyCount}` : " ✓"}`
      : "git -";
  const contextChars = estimateChars(s.history);
  const compactAt = COMPACT_DEFAULTS.compactAtChars;
  const usedRatio = Math.min(100, Math.max(0, Math.round((contextChars / compactAt) * 100)));
  const context = `${formatChars(contextChars)} / ${formatChars(compactAt)} (${usedRatio}%)`;
  const sepText = " · ";
  const sep = styleText(sepText, { fg: theme.dim });
  const metaBudget = s.width - dispWidth(statusPlain) - 2;
  if (metaBudget < 6) return statusStr;

  const ctxField = [styleText(context, { fg: theme.dim })];
  const gitField = [styleText(git, { fg: s.git.dirty ? theme.bad : theme.good })];
  const modelField = [styleText(model, { fg: theme.text })];

  const fields = [];
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

  // Always try to keep at least the git status; if even that won't fit, fall
  // back to showing the working directory alone.
  if (!pushIfFits(gitField)) {
    fields.length = 0;
    const cwdOnly = styleText(truncateMiddle(s.cwd, metaBudget), { fg: theme.dim });
    fields.push(cwdOnly);
    used = dispWidth(stripAnsi(cwdOnly));
  } else {
    pushIfFits(modelField);
    pushIfFits(ctxField);
    const remaining = metaBudget - used - (fields.length ? sepText.length : 0);
    if (remaining > 0) {
      const path = truncateMiddle(s.cwd, remaining);
      if (path) {
        if (fields.length) used += sepText.length;
        fields.push(styleText(path, { fg: theme.dim }));
        used += dispWidth(path);
      }
    }
  }

  const meta = fields.join(sep);
  const pad = Math.max(2, s.width - dispWidth(statusPlain) - dispWidth(stripAnsi(meta)));
  return `${statusStr}${" ".repeat(pad)}${meta}`;
}

/** The one-row header: brand + session name, plus a scroll-away hint. */
export function headerText(s) {
  const left = `argus  ·  ${s.sessionName ?? "session"}`;
  if (s.scrollOffset === 0) {
    if (dispWidth(left) > s.width) {
      return styleText(truncateMiddle(left, s.width), { fg: theme.accent, bold: true });
    }
    return (
      styleText("argus", { fg: theme.accent, bold: true }) +
      styleText(`  ·  ${s.sessionName ?? "session"}`, { fg: theme.dim })
    );
  }
  const longRight = `↑ ${s.scrollOffset} from latest · End`;
  const shortRight = `↑${s.scrollOffset} · End`;
  const right = dispWidth(longRight) + 10 <= s.width ? longRight : shortRight;
  const leftBudget = s.width - dispWidth(right) - 2;
  if (leftBudget < 5) return styleText(truncateEnd(right, s.width), { fg: theme.accent, bold: true });
  const fittedLeft = truncateMiddle(left, leftBudget);
  const pad = s.width - dispWidth(fittedLeft) - dispWidth(right);
  return (
    styleText(fittedLeft, { fg: theme.accent, bold: true }) +
    " ".repeat(pad) +
    styleText(right, { fg: theme.accent })
  );
}
