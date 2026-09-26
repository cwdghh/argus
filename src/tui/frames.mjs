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
import { compactBudgetTokens } from "../compact.mjs";
import { formatChars, formatDuration, formatTokens, toolLabel } from "../format.mjs";
import { styleText, stripAnsi, dispWidth, truncateMiddle, truncateEnd } from "./renderers.mjs";
import { theme } from "../theme.mjs";

const MODE_COLOR = () => ({
  idle: theme.dim,
  working: theme.accent,
  thinking: theme.think,
  aborting: theme.bad,
  confirm: theme.bad,
});
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// A tool names itself in the footer only once it has run this long — a
// sub-second call would flicker a label without the user being able to read it.
const ACTIVE_TOOL_DELAY_MS = 1_000;

/** Left-hand status text: live phase + elapsed time + real token usage. */
export function statusText(s) {
  if (s.mode === "confirm") {
    // A pending high-risk confirmation is its own phase: no spinner (nothing is
    // computing), just a clear call to decide.
    return "confirm — y/n · Esc";
  }
  if (s.mode !== "idle") {
    if (s.activityStartedAt == null) return s.mode;
    const now = s.now();
    const elapsed = Math.max(0, now - s.activityStartedAt);
    const spinner = SPINNER[Math.floor(elapsed / 100) % SPINNER.length];
    const tokens = formatTokens(s.turnUsage);
    // A long-running tool reports itself in place of the generic phase:
    // `⠋ write → src/a.mjs (content 4.1K chars) 12.3s`.
    const toolElapsed =
      s.activeTool && s.activeToolStartedAt != null ? Math.max(0, now - s.activeToolStartedAt) : null;
    if (s.activeTool && toolElapsed != null && toolElapsed >= ACTIVE_TOOL_DELAY_MS && s.activeTool.name) {
      return `${spinner} ${toolLabel(s.activeTool.name, s.activeTool.args)} ${formatDuration(toolElapsed)}` +
        `${s.activeTool.outputPreview ? ` · ${s.activeTool.outputPreview}` : ""}${tokens ? ` · ${tokens}` : ""}`;
    }
    return `${spinner} ${s.mode} ${formatDuration(elapsed)}${tokens ? ` · ${tokens}` : ""}`;
  }
  if (s.lastTurnDurationMs == null) return "idle";
  const tokens = formatTokens(s.lastTurnUsage);
  return `last ${formatDuration(s.lastTurnDurationMs)}${tokens ? ` · ${tokens}` : ""}`;
}

/**
 * Real, provider-reported prompt tokens of the most recent model request —
 * the actual context the model saw, never an estimate. Shows the live turn's
 * usage once the first request of the turn reports it; before that — and while
 * idle — it keeps showing the last completed turn's usage, which is persisted
 * with the turn and therefore survives a resume. The provider only reports
 * usage at the end of a streamed response, so without this fallback the meter
 * would flicker to an em dash for the whole time the model is responding.
 * Returns null only when no request has ever reported usage (a fresh session),
 * so the meter can show "— / budget" instead of a made-up number.
 */
export function contextTokens(s) {
  const usage = s.turnUsage != null ? s.turnUsage : s.lastTurnUsage;
  if (!usage || !Number.isFinite(usage.prompt_tokens)) return null;
  return usage.prompt_tokens;
}

/**
 * The context meter shared by the footer and `/status` — `X / Y (Z%)`:
 *
 *   - tokens = the real, provider-reported prompt tokens of the most recent
 *              request (null only until any request in the session has
 *              reported usage — the meter then shows "— / budget");
 *   - budget = the real-token compaction budget — the upper limit argus
 *              actually enforces (`ARGUS_COMPACT_TOKENS`, default 200k);
 *   - ratio  = tokens / budget as a clamped percentage.
 */
export function contextUsage(s) {
  const tokens = contextTokens(s);
  const budget = compactBudgetTokens();
  const ratio = Math.min(100, Math.max(0, Math.round(((tokens ?? 0) / budget) * 100)));
  return { tokens, budget, ratio };
}

/**
 * The full footer line: status + token usage on the left, then a right-aligned
 * meta area (git status, model, context-window usage, working directory).
 * The context meter is `X / Y (Z%)` — X is the real, provider-reported
 * prompt-token count of the most recent request (the last-known one while a
 * new response is streaming), Y is the compaction budget — the upper limit
 * argus enforces — and Z% is their ratio.
 * Lower-priority details (context, model) are dropped first on narrow
 * terminals; if even git won't fit, the working directory is shown alone.
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
  const { tokens: ctxTokens, budget: ctxBudget, ratio: ctxRatio } = contextUsage(s);
  const sepText = " · ";
  const sep = styleText(sepText, { fg: theme.dim });
  const metaBudget = s.width - dispWidth(statusPlain) - 2;
  if (metaBudget < 6) return statusStr;

  const ctxField = [
    styleText(`${ctxTokens == null ? "—" : formatChars(ctxTokens)} / ${formatChars(ctxBudget)} (${ctxRatio}%)`, {
      fg: theme.dim,
    }),
  ];
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
  // scrollOffset is the absolute first-visible transcript line, or null while
  // following the latest output; the hint shows how far from the end we are.
  if (s.scrollOffset == null) {
    if (dispWidth(left) > s.width) {
      return styleText(truncateMiddle(left, s.width), { fg: theme.accent, bold: true });
    }
    return (
      styleText("argus", { fg: theme.accent, bold: true }) +
      styleText(`  ·  ${s.sessionName ?? "session"}`, { fg: theme.dim })
    );
  }
  const fromLatest =
    typeof s.transcriptLines === "function" && typeof s.transcriptHeight === "function"
      ? Math.max(0, Math.max(0, s.transcriptLines().length - s.transcriptHeight()) - s.scrollOffset)
      : s.scrollOffset;
  const longRight = `↑ ${fromLatest} from latest · End`;
  const shortRight = `↑${fromLatest} · End`;
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
