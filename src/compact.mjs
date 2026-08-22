/**
 * Context compaction.
 *
 * Long sessions grow the message history without bound, which eventually
 * overflows the model's context window. Before sending a turn we check the
 * context size and, if it is at or past the budget, drop the oldest turns and
 * replace them with a compact summary (the final assistant text of each old
 * turn, truncated).
 *
 * The budget is in **real tokens**: once a request has gone out, the provider
 * reports exactly what the context cost (`usage.prompt_tokens`), and that is
 * the signal we trust. `lastTokens` (see `maybeCompact`) comes from that real
 * usage via `nextContextTokens` — the largest prompt sent plus that turn's
 * completions. That is a slight, deliberate over-count of what the next
 * request re-sends (tool-call arguments live inside the prompt too), which is
 * the safe direction: compaction fires a touch early, never late. Before any
 * request has reported usage (a brand-new session, a provider that omits
 * usage), we fall back to the measured serialized payload size so a session
 * can never grow unbounded.
 *
 * This is deliberately lossy for what is *sent to the model* — that's the
 * point. The full messages stay in the session JSONL on disk, so the original
 * requests remain reconstructable, and earlier summaries are carried forward
 * across repeated compactions (never silently dropped).
 *
 * Tuning (env vars):
 *   ARGUS_COMPACT_TOKENS real-token budget (default 200000)
 *   ARGUS_COMPACT_AT     char-based safety net used only before the first
 *                        usage report (default = ARGUS_COMPACT_TOKENS * 4)
 *   ARGUS_COMPACT_KEEP   how many recent turns to keep (default 8)
 */
// Getters are intentional: the standalone `argus` executable loads `.env`
// after module imports have begun, so environment-backed defaults must be lazy.
export const COMPACT_DEFAULTS = {
  // The primary compaction limit: real, provider-reported tokens. Defaults to
  // 200k tokens, leaving plenty of headroom under large-window models.
  get compactAtTokens() {
    return Number(process.env.ARGUS_COMPACT_TOKENS) || 200_000;
  },
  // Safety net in measured chars, used only when no real usage has been
  // reported yet. Defaults to the token limit via the documented ~4 chars per
  // token convention (200k tokens ≈ 800k chars) so it can never be looser
  // than the primary trigger unless the user explicitly tunes it.
  get compactAtChars() {
    return Number(process.env.ARGUS_COMPACT_AT) || this.compactAtTokens * 4;
  },
  get keepTurns() {
    return Number(process.env.ARGUS_COMPACT_KEEP) || 8;
  },
};

export function estimateChars(messages) {
  return JSON.stringify(messages).length;
}

/**
 * The real-token compaction budget (`ARGUS_COMPACT_TOKENS`) — the upper limit
 * (Y in the footer's `X / Y (Z%)` meter). This is a real number: the same
 * budget the compaction trigger enforces, not a heuristic.
 */
export function compactBudgetTokens() {
  return COMPACT_DEFAULTS.compactAtTokens;
}

/**
 * The compaction signal, from the last turn's provider-reported usage: the
 * largest prompt sent plus that turn's summed completions. For a single-step
 * turn this is exactly what the next request re-sends (prompt + the one
 * reply). For a multi-call turn the tool-call arguments are counted twice
 * (they are inside the prompt as well as the completions), a small, safe
 * over-count — compaction fires early, never late. Returns null when no
 * request has reported usage yet.
 */
export function nextContextTokens(usage) {
  if (!usage || !Number.isFinite(usage.prompt_tokens)) return null;
  const completion = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  return usage.prompt_tokens + completion;
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
const SUMMARY_HEADER = "Summary of earlier conversation";

/**
 * Compact `messages` when the context is at or past the budget.
 *
 * The primary trigger is `opts.lastTokens` — real provider-reported tokens of
 * the context the next request will carry (see `nextContextTokens`). When no
 * real usage is known yet, it falls back to the measured serialized payload
 * size (`ARGUS_COMPACT_AT` chars). Either way, compaction only drops turns when
 * more than `keepTurns` turns are present; a single oversized turn is bounded
 * separately (tool-result cap, read caps).
 *
 * Earlier summaries are carried forward instead of being re-summarized away,
 * so repeated compactions never forget context they already compressed.
 *
 * @returns {{ history: Array, compacted: boolean, dropped: number }}
 */
export function maybeCompact(messages, opts = {}) {
  const compactAtTokens = opts.compactAtTokens ?? COMPACT_DEFAULTS.compactAtTokens;
  const compactAtChars = opts.compactAtChars ?? COMPACT_DEFAULTS.compactAtChars;
  const keepTurns = opts.keepTurns ?? COMPACT_DEFAULTS.keepTurns;

  const atOrOver =
    opts.lastTokens != null
      ? opts.lastTokens >= compactAtTokens
      : estimateChars(messages) >= compactAtChars;
  if (!atOrOver) {
    return { history: messages, compacted: false, dropped: 0 };
  }

  const turns = splitTurns(messages);
  if (turns.length <= keepTurns) {
    return { history: messages, compacted: false, dropped: 0 };
  }

  const keep = turns.slice(-keepTurns);
  const dropped = turns.slice(0, -keepTurns);

  // Carry forward any existing summary instead of dropping it: it is the gist
  // of already-compacted turns.
  const lines = [];
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string" && m.content.startsWith(SUMMARY_HEADER)) {
      const nl = m.content.indexOf("\n");
      const body = nl === -1 ? "" : m.content.slice(nl + 1);
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) lines.push(trimmed);
      }
    }
  }
  for (const line of dropped.map(summarizeTurn).filter(Boolean)) {
    lines.push(`- ${line}`);
  }

  const summaryMsg = {
    role: "system",
    content: `${SUMMARY_HEADER} (older than the last ${keepTurns} turns):\n${lines.join("\n")}`,
  };

  return { history: [summaryMsg, ...keep.flat()], compacted: true, dropped: dropped.length };
}
