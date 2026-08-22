import test from "node:test";
import assert from "node:assert/strict";
import { COMPACT_DEFAULTS, compactBudgetTokens, maybeCompact, nextContextTokens, splitTurns, summarizeTurn } from "../src/compact.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";
import { runTurn } from "../src/agent.mjs";

function turn(n) {
  return [
    { role: "user", content: `user ${n}` },
    { role: "assistant", content: `answer ${n} `.repeat(50) },
  ];
}

test("below threshold: no compaction", () => {
  const history = [].concat(turn(1));
  const r = maybeCompact(history, { compactAtChars: 1_000_000, keepTurns: 8 });
  assert.equal(r.compacted, false);
  assert.equal(r.history, history);
});

test("above threshold: drops oldest turns, keeps recent + summary", () => {
  const history = [].concat(...Array.from({ length: 10 }, (_, i) => turn(i)));
  const r = maybeCompact(history, { compactAtChars: 100, keepTurns: 3 });
  assert.equal(r.compacted, true);
  assert.equal(r.dropped, 7);
  assert.equal(r.history[0].role, "system");
  assert.match(r.history[0].content, /Summary of earlier/);
  assert.match(r.history[0].content, /answer 0/);
  assert.match(r.history[0].content, /user 0/, "summary should preserve the user's intent");
  const users = r.history.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["user 7", "user 8", "user 9"]);
});

test("splitTurns + summarizeTurn", () => {
  const turns = splitTurns([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(summarizeTurn([{ role: "user", content: "a" }]), "User: a");
  assert.match(summarizeTurn([{ role: "user", content: "a" }, { role: "assistant", content: "hello" }]), /hello/);
});

test("agent emits compacted event and sends summary", async (t) => {
  const history = [].concat(...Array.from({ length: 10 }, (_, i) => turn(i)));
  let lastBody = null;
  const srv = await createMockServer((i, body) => {
    lastBody = body;
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  const ev = [];
  await runTurn(
    { baseUrl: srv.url, apiKey: "", model: "m", systemPrompt: "s" },
    history,
    "new",
    (e) => ev.push(e.type),
    { compactAtChars: 100, keepTurns: 3 }
  );
  assert.ok(ev.includes("compacted"), "compacted event missing");
  assert.ok(lastBody.messages.some((m) => m.role === "system" && /Summary/.test(m.content)), "summary not sent");
  const users = lastBody.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["user 7", "user 8", "user 9", "new"]);
});

test("compaction defaults resolve environment values lazily and default to 200k real tokens", () => {
  const origTokens = process.env.ARGUS_COMPACT_TOKENS;
  const origChars = process.env.ARGUS_COMPACT_AT;
  delete process.env.ARGUS_COMPACT_TOKENS;
  delete process.env.ARGUS_COMPACT_AT;
  try {
    assert.equal(COMPACT_DEFAULTS.compactAtTokens, 200_000, "default budget is 200k real tokens");
    assert.equal(
      COMPACT_DEFAULTS.compactAtChars,
      200_000 * 4,
      "the char safety net derives from the token limit (200k tokens ≈ 800k chars)",
    );
    process.env.ARGUS_COMPACT_TOKENS = "12345";
    assert.equal(COMPACT_DEFAULTS.compactAtTokens, 12345);
    assert.equal(COMPACT_DEFAULTS.compactAtChars, 12345 * 4);
  } finally {
    if (origTokens === undefined) delete process.env.ARGUS_COMPACT_TOKENS;
    else process.env.ARGUS_COMPACT_TOKENS = origTokens;
    if (origChars === undefined) delete process.env.ARGUS_COMPACT_AT;
    else process.env.ARGUS_COMPACT_AT = origChars;
  }
});

test("a continued interrupt history keeps the partial assistant text once", () => {
  // Mirrors docs/interrupt-resume.md §6.2: a partial assistant message is
  // persisted, then continued over (assistant(request_input) -> tool ->
  // assistant). Whatever the callback stack reconstructs, the partial text
  // must appear in the message history exactly once — never twice (which
  // would inflate the provider's real prompt count on the next request), never
  // zero (which would blind the model to what the user refers to).
  const partial = "part of an answer[INTERRUPTED]";
  const history = [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: partial },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "req_1", type: "function", function: { name: "request_input", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "req_1", content: "finish it" },
    { role: "assistant", content: "and the rest of the answer" },
  ];
  const sent = JSON.stringify(history);
  assert.equal(sent.split(partial).length - 1, 1, "partial text appears exactly once in the messages");
});

test("compactBudgetTokens returns the real-token limit", () => {
  const original = process.env.ARGUS_COMPACT_TOKENS;
  process.env.ARGUS_COMPACT_TOKENS = "400";
  try {
    assert.equal(compactBudgetTokens(), 400);
  } finally {
    if (original === undefined) delete process.env.ARGUS_COMPACT_TOKENS;
    else process.env.ARGUS_COMPACT_TOKENS = original;
  }
});

test("nextContextTokens: real prompt + completion of the last turn, null without usage", () => {
  assert.equal(nextContextTokens(null), null);
  assert.equal(nextContextTokens({ prompt_tokens: "nope" }), null);
  assert.equal(
    nextContextTokens({ prompt_tokens: 1000, completion_tokens: 250 }),
    1250,
    "the next request re-sends the prompt plus the previous reply",
  );
  assert.equal(nextContextTokens({ prompt_tokens: 1000 }), 1000, "completion may be absent (0)");
});

test("the char safety net compacts at or over the measured budget", () => {
  // The char path is an exact, measured size of the actual serialized messages
  // (ARGUS_COMPACT_AT chars), used only before the first real usage report.
  const history = [
    { role: "user", content: "one" },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "two" },
    { role: "assistant", content: "answer two" },
  ];
  const len = JSON.stringify(history).length;
  const under = maybeCompact(history, { compactAtChars: len + 1, keepTurns: 1 });
  assert.equal(under.compacted, false, "under the budget: no compaction");
  const at = maybeCompact(history, { compactAtChars: len, keepTurns: 1 });
  assert.equal(at.compacted, true, "at exactly the budget: compact");
  const over = maybeCompact(history, { compactAtChars: len - 1, keepTurns: 1 });
  assert.equal(over.compacted, true, "one char over the budget compacts");
  assert.equal(over.dropped, 1, "the oldest turn is dropped");
});

test("real tokens drive compaction: at/over the 200k limit compacts", () => {
  const history = [].concat(...Array.from({ length: 10 }, (_, i) => turn(i)));
  const under = maybeCompact(history, { lastTokens: 199_999, keepTurns: 3 });
  assert.equal(under.compacted, false, "below the 200k limit: no compaction");
  const at = maybeCompact(history, { lastTokens: 200_000, keepTurns: 3 });
  assert.equal(at.compacted, true, "at the limit: compact");
  assert.equal(at.dropped, 7);
});

test("the real report beats the char path when both are known", () => {
  const history = [].concat(...Array.from({ length: 10 }, (_, i) => turn(i)));
  const big = maybeCompact(history, { lastTokens: 200_000, compactAtChars: 1_000_000, keepTurns: 3 });
  assert.equal(big.compacted, true, "a tiny payload must not block a real 200k-token context");
  const small = maybeCompact(history, { lastTokens: 1_000, compactAtChars: 1, keepTurns: 3 });
  assert.equal(small.compacted, false, "a real small context wins even when the payload looks big");
});

test("repeated compaction carries the previous summary forward", () => {
  // Regression: a second compaction used to drop the first summary, silently
  // forgetting every older turn it compressed.
  const history = [].concat(...Array.from({ length: 12 }, (_, i) => turn(i))); // turns 0..11
  const r1 = maybeCompact(history, { compactAtChars: 100, keepTurns: 3 });
  assert.match(r1.history[0].content, /user 0/, "first summary covers the oldest turns");

  const r2 = maybeCompact([...r1.history, ...turn(12), ...turn(13)], { compactAtChars: 100, keepTurns: 3 });
  assert.match(r2.history[0].content, /user 3/, "the earlier summary survives re-compaction");
  assert.match(r2.history[0].content, /user 9/, "newly dropped turns are folded in");
  const users = r2.history.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["user 11", "user 12", "user 13"]);
});
