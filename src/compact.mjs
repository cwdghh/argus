/**
 * Context compaction.
 *
 * Long sessions grow the message history without bound, which eventually
 * overflows the model's context window. Before sending a turn, we estimate the
 * serialized size and, if it exceeds a budget, drop the oldest turns and
 * replace them with a compact summary (the final assistant text of each old
 * turn, truncated).
 *
 * This is deliberately lossy for what is *sent to the model* — that's the
 * point. The full messages stay in the session JSONL on disk, so the original
 * requests remain reconstructable.
 *
 * Tuning (env vars):
 *   ARGUS_COMPACT_AT   chars threshold before compacting (default 300000)
 *   ARGUS_COMPACT_KEEP how many recent turns to keep (default 8)
 */
// Getters are intentional: the standalone `argus` executable loads `.env`
// after module imports have begun, so environment-backed defaults must be lazy.
export const COMPACT_DEFAULTS = {
  get compactAtChars() {
    return Number(process.env.ARGUS_COMPACT_AT) || 300_000;
  },
  get keepTurns() {
    return Number(process.env.ARGUS_COMPACT_KEEP) || 8;
  },
};

export function estimateChars(messages) {
  return JSON.stringify(messages).length;
}

/** Split a flat message list into turns (each starts at a user message). */
export function splitTurns(messages) {
  const turns = [];
  let cur = [];
  for (const m of messages) {
    if (m.role === "user" && cur.length > 0) {
      turns.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) turns.push(cur);
  return turns;
}

/** A terse digest of a turn: preserve both the user's intent and the outcome. */
export function summarizeTurn(turn) {
  const users = turn.filter((m) => m.role === "user" && m.content);
  const assistants = turn.filter((m) => m.role === "assistant" && m.content);
  const user = users[0];
  const last = assistants[assistants.length - 1];
  if (!user && !last) return null;
  const usedTools = turn.some((m) => m.role === "tool");
  const brief = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) + "…" : text;
  };
  const parts = [];
  if (user) parts.push(`User: ${brief(user.content, 160)}`);
  if (last) parts.push(`Assistant${usedTools ? " (used tools)" : ""}: ${brief(last.content, 200)}`);
  return parts.join(" | ");
}

/**
 * Compact `messages` if they exceed the budget.
 * @returns {{ history: Array, compacted: boolean, dropped: number }}
 */
export function maybeCompact(messages, opts = {}) {
  const compactAtChars = opts.compactAtChars ?? COMPACT_DEFAULTS.compactAtChars;
  const keepTurns = opts.keepTurns ?? COMPACT_DEFAULTS.keepTurns;

  if (estimateChars(messages) <= compactAtChars) {
    return { history: messages, compacted: false, dropped: 0 };
  }

  const turns = splitTurns(messages);
  if (turns.length <= keepTurns) {
    return { history: messages, compacted: false, dropped: 0 };
  }

  const keep = turns.slice(-keepTurns);
  const dropped = turns.slice(0, -keepTurns);
  const lines = dropped.map(summarizeTurn).filter(Boolean);
  const summaryMsg = {
    role: "system",
    content: `Summary of earlier conversation (older than the last ${keepTurns} turns):\n${lines
      .map((l) => `- ${l}`)
      .join("\n")}`,
  };

  return { history: [summaryMsg, ...keep.flat()], compacted: true, dropped: dropped.length };
}
