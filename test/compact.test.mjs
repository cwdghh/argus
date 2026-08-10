import test from "node:test";
import assert from "node:assert/strict";
import { maybeCompact, splitTurns, summarizeTurn } from "../src/compact.mjs";
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
  assert.equal(null, summarizeTurn([{ role: "user", content: "a" }]));
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
