/**
 * Shared block folding for pretty transcript rendering.
 *
 * Both frontends (the TUI and headless mode) render a running turn as a list
 * of display blocks. Streaming text arrives as many tiny deltas; `appendBlock`
 * folds consecutive deltas of the same kind into one growing block so the
 * transcript stays readable and the session JSONL stays compact. `consumeAgentEvent`
 * turns the agent's event stream into the blocks both frontends persist, so
 * the TUI and headless can never drift apart on tool calls, results,
 * approvals, retries, or compaction.
 */
import { formatDuration, previewResult, summarize, toolLabel } from "./format.mjs";

/**
 * Append a text delta to `blocks`, folding it into the previous block when it
 * has the same kind (so streamed tokens accumulate into one block). Blocks are
 * `{ kind, text, ... }` objects; mutating the array in place keeps the simple
 * "append-only" model every frontend already uses.
 */
export function appendBlock(blocks, kind, delta) {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) last.text += delta;
  else blocks.push({ kind, text: delta });
  return blocks;
}

/**
 * Apply one agent event to a display-block list. Every frontend calls this for
 * the same events and persists the same blocks; frontend-only state — tool
 * durations, paste markers, live mode flags, token usage — stays with each
 * frontend, but the *blocks* are identical everywhere.
 *
 * Events without a block projection (user, cwd_change, usage, assistant_*)
 * are no-ops here.
 */
export function consumeAgentEvent(blocks, ev, { durationMs } = {}) {
  switch (ev.type) {
    case "thinking_delta":
      appendBlock(blocks, "thinking", ev.delta);
      break;
    case "text_delta":
      appendBlock(blocks, "assistant", ev.delta);
      break;
    case "steering":
      blocks.push({ kind: "user", text: ev.text });
      break;
    case "tool_call":
      blocks.push({
        kind: "tool",
        name: ev.name,
        // The resolved label, not the raw args: the payload already lives in
        // the turn's tool message, so re-storing it is pure JSONL amplification.
        label: toolLabel(ev.name, ev.args),
        ...(ev.id ? { id: ev.id } : {}),
        ...(ev.attemptId ? { attemptId: ev.attemptId } : {}),
      });
      break;
    case "tool_result": {
      const summary = summarize(ev.result);
      const detail = previewResult(ev.result);
      blocks.push({
        kind: "result",
        ok: ev.ok,
        summary,
        ...(durationMs != null ? { durationMs } : {}),
        ...(ev.id ? { id: ev.id } : {}),
        ...(ev.attemptId ? { attemptId: ev.attemptId } : {}),
        // A preview that adds nothing beyond the one-line summary is noise.
        ...(detail && detail !== summary ? { detail } : {}),
      });
      break;
    }
    case "approval":
      // Only approvals get their own row — a denial is already reported by the
      // tool_result error block that follows (one "denied …" row, never two).
      if (ev.approved) {
        blocks.push({ kind: "result", ok: true, summary: `approved ${ev.tool} in ${ev.cwd}: ${ev.reason}` });
      }
      break;
    case "compacted":
      blocks.push({ kind: "result", ok: true, summary: "… earlier context compacted" });
      break;
    case "retrying": {
      const why = ev.reason === "quota" ? "LLM quota exhausted" : "LLM request failed";
      blocks.push({
        kind: "result",
        ok: true,
        summary: `${why}; retrying (${ev.attempt}/${ev.budget}) in ${formatDuration(ev.delayMs)}`,
      });
      break;
    }
  }
  return blocks;
}
