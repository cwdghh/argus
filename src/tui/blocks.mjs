/**
 * Render one transcript display block ({ kind, text, ... }) into styled
 * terminal lines. Block shapes come from the agent frontends: user prompts,
 * streaming thinking/assistant text, tool calls and results, turn timing, and
 * errors. Pure functions: given a block and a width, return lines.
 */
import { formatDuration, formatTokens } from "../format.mjs";
import { styleText } from "./renderers.mjs";
import { markdownLines, renderSimple } from "./markdown.mjs";
import { theme } from "../theme.mjs";
function formatArgs(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
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
      const pieces = renderSimple(`⚙ ${block.name}(${formatArgs(block.args)})`, { fg: theme.tool, bold: true }, contentWidth);
      return pieces.map((ln, idx) => styleText("│", { fg: theme.tool, bold: true }) + " " + ln);
    }
    case "result": {
      const timing = block.durationMs == null ? "" : `${formatDuration(block.durationMs)} · `;
      const prefix = block.summary === "interrupted" ? "" : `${block.ok ? "✓" : "✗"} `;
      const contentWidth = Math.max(1, width - 4);
      const pieces = renderSimple(`${prefix}${timing}${block.summary}`, {
        fg: block.ok ? theme.good : theme.bad,
        bold: true,
      }, contentWidth);
      return pieces.map((ln, idx) => styleText("│", { fg: block.ok ? theme.good : theme.bad, bold: true }) + " " + ln);
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
