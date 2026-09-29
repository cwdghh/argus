/**
 * Render one transcript display block ({ kind, text, ... }) into styled
 * terminal lines. Block shapes come from the agent frontends: user prompts,
 * streaming thinking/assistant text, tool calls and results, turn timing, and
 * errors. Pure functions: given a block and a width, return lines.
 */
import { formatDuration, formatTokens, toolLabel } from "../format.mjs";
import { styleText } from "./renderers.mjs";
import { markdownLines, renderSimple } from "./markdown.mjs";
import { theme, themeRevision } from "../theme.mjs";


// Only text-carrying blocks (user/thinking/assistant) mutate after creation,
// and they mutate *text* in place — so a per-block cache keyed by object
// identity, width, and the text snapshot re-renders exactly the blocks that
// changed and reuses the rest. Long transcripts stop re-wrapping every block
// on every frame; only the mutated tail re-renders.
const blockLinesCache = new WeakMap();

/**
 * `blockLines` with a per-block cache. The snapshot check is exact: if the
 * block's text is unchanged for this width, its wrapped lines are reused.
 */
export function blockLinesCached(block, width) {
  const entry = blockLinesCache.get(block);
  if (entry && entry.width === width && entry.text === block.text && entry.themeRevision === themeRevision) return entry.lines;
  const lines = blockLines(block, width);
  blockLinesCache.set(block, { width, text: block.text, themeRevision, lines });
  return lines;
}

export function blockLines(block, width) {
  switch (block.kind) {
    case "user": {
      const out = [];
      block.text.split("\n").forEach((l, idx) => {
        out.push(...renderSimple(`${idx === 0 ? "❯ " : "  "}${l}`, { fg: theme.user, bold: true }, width));
      });
      return out;
    }
    case "thinking": {
      const out = [];
      const contentWidth = Math.max(1, width - 2);
      for (const l of block.text.split("\n")) {
        const t = l.trim();
        if (!t) continue;
        const pieces = renderSimple(t, { fg: theme.think, italic: true }, contentWidth);
        pieces.forEach((ln, idx) => {
          out.push(styleText("│", { fg: theme.think }) + " " + ln);
        });
      }
      return out;
    }
    case "assistant":
      return markdownLines(block.text, width);
    case "tool": {
      const contentWidth = Math.max(1, width - 4);
      // `label` is what new blocks persist (built from the shared toolLabel
      // resolver); blocks written by older sessions still carry raw `args`.
      const label = block.label ?? toolLabel(block.name ?? "", block.args ?? {});
      const pieces = renderSimple(`⚙ ${label}`, { fg: theme.tool, bold: true }, contentWidth);
      return pieces.map((ln, idx) => styleText("│", { fg: theme.tool, bold: true }) + " " + ln);
    }
    case "result": {
      const timing = block.durationMs == null ? "" : `${formatDuration(block.durationMs)} · `;
      // Both the bare "interrupted" and the TUI's "⏹ interrupted" summary must
      // suppress the ✗ so an interrupt never renders "✗ ⏹ interrupted".
      const prefix = block.summary?.includes("interrupted") ? "" : `${block.ok ? "✓" : "✗"} `;
      const contentWidth = Math.max(1, width - 4);
      const accent = block.ok ? theme.good : theme.bad;
      const out = renderSimple(`${prefix}${timing}${block.summary}`, {
        fg: accent,
        bold: true,
      }, contentWidth).map((ln, idx) => styleText("│", { fg: accent, bold: true }) + " " + ln);
      // A dimmed, multi-line preview of a large result (read snapshots, build
      // output) rides under the summary inside the same rail.
      if (block.detail) {
        for (const raw of block.detail.split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          out.push(...renderSimple(line, { fg: theme.dim }, contentWidth)
            .map((ln) => styleText("│", { fg: theme.dim, bold: true }) + " " + ln));
        }
      }
      return out;
    }
    case "confirm": {
      // A structured, distinct confirmation block for high-risk actions (e.g. a
      // dangerous bash command). Rendered as a warning box in the transcript so
      // decisions stay auditable, without repeating the live y/n hint (which
      // the layout's confirm row shows while the decision is pending).
      const contentWidth = Math.max(1, width - 4);
      const box = renderSimple(block.text, { fg: theme.bad, bold: true }, contentWidth);
      return box.map((ln) => styleText("⚠", { fg: theme.bad, bold: true }) + " " + ln);
    }
    case "timing": {
      const usage = formatTokens(block.usage);
      return renderSimple(`  ◷ ${block.summary}${usage ? ` · ${usage}` : ''}`, { fg: theme.dim, dim: true }, width);
    }
    case "error":
      return renderSimple(`error: ${block.text}`, { fg: theme.bad }, width);
    default:
      return [];
  }
}
