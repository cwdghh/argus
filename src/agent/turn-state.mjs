/** Pure turn bookkeeping: protocol pairing and bounded no-progress detection. */
/**
 * No editor buffers / session payloads may violate the tool-call pairing
 * invariant: every `assistant` message's tool_call must be followed by a
 * matching `tool` message. Mid-loop guards (repeat guard, max steps inside the
 * tool loop, the per-turn result budget) throw AFTER the assistant reply is
 * pushed but BEFORE its tool executed — without this, an exposed
 * `err.turnMessages` would carry a dangling tool_call. Synthesize an error
 * tool result for every call that never executed, so the trail stays
 * replayable; existing result objects are preserved.
 */
export function protocolSafeMessages(turnMessages) {
  const out = [];
  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];
    out.push(msg);
    const calls = msg.role === "assistant" ? msg.tool_calls : undefined;
    if (!calls || calls.length === 0) continue;
    const results = new Map();
    while (turnMessages[i + 1]?.role === "tool") {
      const result = turnMessages[++i];
      results.set(result.tool_call_id, result);
    }
    for (const call of calls) {
      // Only this reply's contiguous results can satisfy its calls. Later
      // replies may reuse an id, and must not hide a missing result here.
      const matched = results.get(call?.id);
      out.push(matched ?? {
          role: "tool",
          tool_call_id: call?.id,
          content: JSON.stringify({
            error: true,
            message: `tool call was never executed (${call?.function?.name ?? "(missing name)"})`,
          }),
      });
    }
  }
  return out;
}

// How many executed (call, result) pairs the no-progress guard keeps in view;
// bounds the alternation patterns it can recognise.
export const LOOP_WINDOW = 8;

/**
 * Decide whether the next tool call would extend a no-progress loop, from the
 * pairs already executed this turn:
 *   - period 1: the same call produced the same result twice in a row — this
 *     request would be the third identical one;
 *   - period 2: the last six executed pairs strictly alternate — this request
 *     would start a fourth identical A/B cycle (a plain repeat-streak
 *     resets on every key change and never trips on this).
 * A pair key is callKey joined to resultKey (NUL-separated), so results —
 * not just call shapes — must repeat for the guard to fire.
 */
export function detectCallLoop(repeatKey, window) {
  const n = window.length;
  if (n >= 2) {
    const last = window[n - 1];
    if (last.key === window[n - 2].key && last.callKey === repeatKey) {
      return { period: 1, name: last.name };
    }
  }
  if (n >= 6) {
    let alternating = true;
    for (let j = n - 1; j >= Math.max(n - 6, 2); j--) {
      if (window[j].key !== window[j - 2].key) {
        alternating = false;
        break;
      }
    }
    if (alternating && repeatKey === window[n - 2].callKey) {
      return { period: 2, names: `${window[n - 1].name} / ${window[n - 2].name}` };
    }
  }
  return null;
}


/** Stable identity for one tool request: name + canonical (parsed) arguments. */
export function canonicalToolCall(call) {
  const name = call?.function?.name ?? "";
  let args = call?.function?.arguments;
  try {
    args = stableStringify(JSON.parse(args ?? "{}"));
  } catch {
    args = String(args ?? "").trim();
  }
  return `${name}\u0000${args}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}
