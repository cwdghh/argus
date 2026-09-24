import test from "node:test";
import assert from "node:assert/strict";
import { createMockServer } from "./helpers/mock-llm.mjs";
import { runTurn } from "../src/agent.mjs";
import { executeToolCall } from "../src/agent/tool-call.mjs";
import { accumulateUsage, reportedRequestUsage, totalReportedUsage } from "../src/agent/usage.mjs";
import { canonicalToolCall } from "../src/agent/turn-state.mjs";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = (srv) => ({ baseUrl: srv.url, apiKey: "", model: "mock", systemPrompt: "s" });

test("text-only turn returns the streamed content", async (t) => {
  const srv = await createMockServer(() => [{ content: "**ok**" }]);
  t.after(() => srv.close());
  const { finalText, outcome, messages } = await runTurn(config(srv), [], "hi", () => {});
  assert.equal(finalText, "**ok**");
  assert.equal(outcome, "completed");
  assert.equal(messages.length, 2); // user + assistant
});

test("tool call then final text feeds results back", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] }];
    }
    return [{ content: "done" }];
  });
  t.after(() => srv.close());
  const seen = [];
  const { finalText, messages } = await runTurn(config(srv), [], "go", (e) => seen.push(e.type));
  assert.equal(finalText, "done");
  assert.equal(srv.calls(), 2);
  assert.ok(seen.includes("tool_call") && seen.includes("tool_result"));
  assert.ok(messages.some((m) => m.role === "tool"), "tool result present in messages");
});

test("abort mid-stream preserves observed text without incomplete tool calls", async (t) => {
  const srv = await createMockServer(() => [{ content: "a" }, { delay: 500 }, { content: "b" }]);
  t.after(() => srv.close());
  const ac = new AbortController();
  const p = runTurn(config(srv), [], "hi", () => {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const res = await p;
  assert.equal(res.outcome, "interrupted");
  assert.equal(res.partial.text, "a");
  assert.equal(res.messages.at(-1).content, "a");
  assert.equal(res.messages.at(-1).partial, true);
});

test("a late stop keeps a completed reply but prevents pending tool dispatch", async (t) => {
  const finalServer = await createMockServer(() => [{ content: "done" }]);
  t.after(() => finalServer.close());
  const finalAbort = new AbortController();
  const completed = await runTurn(config(finalServer), [], "hi", (event) => {
    if (event.type === "assistant_stop") finalAbort.abort();
  }, { signal: finalAbort.signal });
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.finalText, "done");

  const dir = mkdtempSync(join(tmpdir(), "argus-late-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const toolServer = await createMockServer(() => [
    { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"touch should-not-run"}' } }] },
  ]);
  t.after(() => toolServer.close());
  const toolAbort = new AbortController();
  const stopped = await runTurn(config(toolServer), [], "hi", (event) => {
    if (event.type === "assistant_stop") toolAbort.abort();
  }, { signal: toolAbort.signal, cwd: dir });
  assert.equal(stopped.outcome, "interrupted");
  assert.equal(stopped.toolAttempts.length, 0);
  assert.match(stopped.messages.at(-1).content, /never executed/);
  assert.equal(existsSync(join(dir, "should-not-run")), false);
});

test("multi-step usage reports the largest context, never a per-step sum", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [
        { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
        { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } }] },
      ];
    }
    return [
      { usage: { prompt_tokens: 130, completion_tokens: 25, total_tokens: 155 } },
      { content: "done" },
    ];
  });
  t.after(() => srv.close());
  const seen = [];
  const { finalText, usage, requestUsage, toolAttempts, runId } = await runTurn(config(srv), [], "go", (e) => {
    if (e.type === "usage") seen.push(e.usage);
  });
  assert.equal(finalText, "done");
  // The second request's prompt (130) already includes the first request's
  // context, so 100 + 130 = 230 would count the shared history twice. The
  // accumulated prompt is the largest context sent; only completion sums.
  assert.equal(usage.prompt_tokens, 130);
  assert.equal(usage.completion_tokens, 35); // 10 + 25
  assert.equal(usage.total_tokens, 165); // 130 + 35
  assert.equal(requestUsage.attempts.length, 2);
  assert.notEqual(requestUsage.attempts[0].id, requestUsage.attempts[1].id);
  assert.deepEqual(requestUsage.attempts.map((attempt) => attempt.usage.prompt_tokens), [100, 130]);
  assert.equal(requestUsage.totals.prompt_tokens, 230, "reported request input sums all actual requests");
  assert.equal(requestUsage.totals.completion_tokens, 35);
  assert.equal(requestUsage.totals.complete, true);
  assert.equal(toolAttempts.length, 1);
  assert.match(toolAttempts[0].id, new RegExp(`^${runId}:tool:`));
  assert.deepEqual(seen[0], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, reasoning_tokens: 0, cached_tokens: 0, cache_creation_input_tokens: 0 });
  assert.deepEqual(seen[1], { prompt_tokens: 130, completion_tokens: 35, total_tokens: 165, reasoning_tokens: 0, cached_tokens: 0, cache_creation_input_tokens: 0 });
});

test("an interrupted turn records only the steps that reported usage", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [
        { usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } },
        { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } }] },
      ];
    }
    return [{ content: "a" }, { delay: 500 }, { content: "b" }];
  });
  t.after(() => srv.close());
  const ac = new AbortController();
  const p = runTurn(config(srv), [], "go", () => {}, { signal: ac.signal });
  // Let the first model step finish (and report usage) — wait until the client
  // has actually issued the second request — then abort mid-way through the
  // second stream, whose usage never arrives.
  const deadline = Date.now() + 2_000;
  while (srv.calls() < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(srv.calls() >= 2, "second model request never started");
  ac.abort();
  const res = await p;
  assert.equal(res.outcome, "interrupted");
  assert.deepEqual(res.usage, { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, reasoning_tokens: 0, cached_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(res.requestUsage.attempts.length, 2);
  assert.equal(res.requestUsage.attempts[0].usage.prompt_tokens, 100);
  assert.equal(res.requestUsage.attempts[1].usage, null);
  assert.equal(res.requestUsage.totals.complete, false);
});

test("real last-request tokens trigger compaction before the next turn", async (t) => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}`.repeat(40) });
  }
  let lastBody = null;
  const ev = [];
  const srv = await createMockServer((i, body) => {
    lastBody = body;
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  await runTurn(
    { baseUrl: srv.url, apiKey: "", model: "m", systemPrompt: "s" },
    history,
    "new",
    (e) => ev.push(e.type),
    { lastTokens: 200_000, keepTurns: 3 }
  );
  assert.ok(ev.includes("compacted"), "a real 200k-token context compacts before the next turn");
  assert.ok(
    lastBody.messages.some((m) => m.role === "system" && /Summary of earlier/.test(m.content)),
    "the compacted summary reaches the model",
  );
  const users = lastBody.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["q7", "q8", "q9", "new"], "only recent turns + the new prompt are sent");

  const ev2 = [];
  const srv2 = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv2.close());
  await runTurn(
    { baseUrl: srv2.url, apiKey: "", model: "m", systemPrompt: "s" },
    history,
    "again",
    (e) => ev2.push(e.type),
    { lastTokens: 1_000, keepTurns: 3 }
  );
  assert.ok(!ev2.includes("compacted"), "a small real context does not compact");
});

test("requests ask for exactly one tool call per step", async (t) => {
  let seenBody = null;
  const srv = await createMockServer((i, body) => {
    seenBody = body;
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  await runTurn(config(srv), [], "hi", () => {});
  assert.equal(seenBody.parallel_tool_calls, false, "one tool per step keeps the loop tight");
});

test("canonicalToolCall normalizes argument formatting", () => {
  const a = { function: { name: "bash", arguments: '{"command":"true"}' } };
  const b = { function: { name: "bash", arguments: '{ "command": "true" }' } };
  assert.equal(canonicalToolCall(a), canonicalToolCall(b), "whitespace in JSON does not defeat the guard");
  assert.notEqual(canonicalToolCall(a), canonicalToolCall({ function: { name: "read", arguments: "{}" } }));
  assert.equal(
    canonicalToolCall({ function: { name: "edit", arguments: '{"path":"x","edits":[{"new":"y","old":"x"}]}' } }),
    canonicalToolCall({ function: { name: "edit", arguments: '{"edits":[{"old":"x","new":"y"}],"path":"x"}' } }),
    "object key order does not evade semantic identity",
  );
});

test("an identical repeated tool call stops the turn instead of looping", async (t) => {
  // A model that keeps requesting the exact same call never "stops
  // generating"; refuse on the third identical request.
  const srv = await createMockServer(() => [
    { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"echo loop"}' } }] },
  ]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv), [], "go", () => {});
  assert.equal(result.outcome, "limited");
  assert.equal(result.reason, "repeated_tool_call");
  assert.match(result.message, /repeated the same no-progress tool call 3 times \(bash\)/);
  assert.equal(srv.calls(), 3, "stopped on the third identical request");
});

test("an alternating A/B/A/B loop of identical pairs also stops the turn", async (t) => {
  // A plain repeat-streak resets on every key change, so echo/true/echo/true
  // with identical results loops forever; the rolling (call, result) window
  // must catch the two-cycle on its third repetition.
  const srv = await createMockServer((i) => [
    {
      tool_calls: [{
        index: 0,
        id: `c${i}`,
        function: { name: "bash", arguments: JSON.stringify({ command: i % 2 ? "true" : "echo a" }) },
      }],
    },
  ]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv), [], "go", () => {});
  assert.equal(result.outcome, "limited");
  assert.equal(result.reason, "alternating_tool_calls");
  assert.match(result.message, /alternated two no-progress tool calls 3 times \(bash \/ bash\)/);
  assert.equal(srv.calls(), 7, "stopped once the alternation repeated its cycle");
});

test("no persisted turn violates tool-call pairing on a mid-loop guard", async (t) => {
  const srv = await createMockServer(() => [
    { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } }] },
  ]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv, { maxSteps: 2 }), [], "loop", () => {});
  assert.equal(result.outcome, "limited");
  assertProtocolSafe(result.messages);
  const synthesized = result.messages.filter(
    (m) => m.role === "tool" && (() => { try { return JSON.parse(m.content).error; } catch { return false; } })(),
  );
  assert.equal(synthesized.length, 1, "the never-executed tool_call got a synthetic error result");
  assert.match(synthesized[0].content, /never executed/);
});

function assertProtocolSafe(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const call of m.tool_calls) {
      const id = call.id;
      const followed = msgs
        .slice(i + 1)
        .some((x) => x.role === "tool" && x.tool_call_id === id);
      assert.ok(followed, `tool_call ${id} has a matching tool message after its assistant`);
    }
  }
}

test("identical reads separated by other work do not trigger the no-progress guard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-repeat-progress-"));
  writeFileSync(join(dir, "a.txt"), "a\n");
  const sequence = ["read", "bash", "read", "bash", "read"];
  const srv = await createMockServer((i) => {
    if (i >= sequence.length) return [{ content: "done" }];
    const name = sequence[i];
    const args = name === "read" ? { path: "a.txt" } : { command: "true" };
    return [{ tool_calls: [{ index: 0, id: `c${i}`, function: { name, arguments: JSON.stringify(args) } }] }];
  });
  t.after(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await runTurn(config(srv), [], "inspect", () => {}, { cwd: dir })).finalText, "done");
});

test("a provider response with multiple tool calls runs them in sequence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-multi-call-"));
  const multi = [
    { index: 0, id: "c1", function: { name: "write", arguments: '{"path":"a.txt","content":"a","ensureFinalNewline":false}' } },
    { index: 1, id: "c2", function: { name: "write", arguments: '{"path":"b.txt","content":"b","ensureFinalNewline":false}' } },
  ];
  const srv = await createMockServer((i) => (i === 0 ? [{ tool_calls: multi }] : [{ content: "done" }]));
  t.after(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await runTurn(config(srv), [], "write", () => {}, { cwd: dir });
  assert.equal(result.finalText, "done", "the turn continues after the batch");
  assert.equal(existsSync(join(dir, "a.txt")), true, "the first call of the batch ran");
  assert.equal(existsSync(join(dir, "b.txt")), true, "the second call of the batch ran too");
  const toolMessages = result.messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.equal(JSON.parse(toolMessages[0].content).path, join(dir, "a.txt"), "results stay in call order");
  assert.equal(JSON.parse(toolMessages[1].content).path, join(dir, "b.txt"));
});

test("the final allowed model step cannot perform an orphaned mutation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-final-step-"));
  const srv = await createMockServer(() => [{
    tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: '{"path":"a.txt","content":"a","ensureFinalNewline":false}' } }],
  }]);
  t.after(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await runTurn(config(srv), [], "write", () => {}, { cwd: dir, maxSteps: 1 });
  assert.equal(result.outcome, "limited");
  assert.equal(result.reason, "step_limit_before_tool");
  assert.equal(existsSync(join(dir, "a.txt")), false);
});

test("cumulative tool output is bounded inside an active turn", async (t) => {
  const srv = await createMockServer((i) => {
    if (i > 2) return [{ content: "unexpected" }];
    const command = `printf ${String(i).repeat(700)}`;
    return [{ tool_calls: [{ index: 0, id: `c${i}`, function: { name: "bash", arguments: JSON.stringify({ command }) } }] }];
  });
  t.after(() => srv.close());
  const result = await runTurn(config(srv), [], "large", () => {}, { maxToolResultChars: 500, maxTurnToolResultChars: 700 });
  assert.equal(result.outcome, "limited");
  assert.equal(result.reason, "tool_result_budget");
});

test("persistent cwd: cd then pwd", async (t) => {
  const srv = await createMockServer((i) => {
    if (i === 0) return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"cd src"}' } }] }];
    if (i === 1) return [{ tool_calls: [{ index: 0, id: "c2", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }];
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  const { cwd } = await runTurn(config(srv), [], "cd", () => {}, { cwd: process.cwd() });
  assert.equal(cwd, new URL("../src", import.meta.url).pathname, "cwd should be <repo>/src");
});

test("executeToolCall: unknown tool, unparseable args, and a clean run", async () => {
  const events = [];
  const emit = (e) => events.push(e);

  const unknown = await executeToolCall({ id: "1", function: { name: "nope", arguments: "{}" } }, { cwd: process.cwd(), maxToolResultChars: 50_000, onEvent: emit });
  assert.equal(unknown.result.error, true);
  assert.match(unknown.result.message, /unknown tool/);

  const badJson = await executeToolCall({ id: "2", function: { name: "bash", arguments: "not json" } }, { cwd: process.cwd(), maxToolResultChars: 50_000, onEvent: emit });
  assert.equal(badJson.result.error, true);
  assert.match(badJson.result.message, /not valid JSON/);

  const ok = await executeToolCall({ id: "3", function: { name: "bash", arguments: JSON.stringify({ command: "printf ok" }) } }, { cwd: process.cwd(), maxToolResultChars: 50_000, onEvent: emit });
  assert.equal(ok.result.error, undefined);
  assert.match(ok.result.stdout, /ok/);
  assert.equal(ok.cwd, process.cwd());

  assert.equal(events[0].type, "tool_call");
  assert.equal(events[1].type, "tool_result");
});

test("executeToolCall: a bash cd updates the returned cwd", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "argus-ctc-"));
  const { result, cwd } = await executeToolCall(
    { id: "c", function: { name: "bash", arguments: JSON.stringify({ command: `cd "${tmp}"` }) } },
    { cwd: process.cwd(), maxToolResultChars: 50_000 }
  );
  assert.equal(result.error, undefined);
  assert.equal(cwd, tmp);
  rmSync(tmp, { recursive: true, force: true });
});

test("accumulateUsage never counts shared context more than once", () => {
  assert.equal(accumulateUsage(null, null), null);
  assert.equal(accumulateUsage(null, { prompt_tokens: "nope" }), null);
  const a = accumulateUsage(null, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    completion_tokens_details: { reasoning_tokens: 2 },
    prompt_tokens_details: { cached_tokens: 3 },
  });
  assert.deepEqual(a, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 2, cached_tokens: 3, cache_creation_input_tokens: 0 });

  // The second request re-sends the same 10-token context plus 80 new tokens.
  // `prompt_tokens` stays at the largest context sent (never the sum, which
  // would count the shared history once per model step); only `completion`
  // accumulates, since each step's output tokens are distinct.
  const b = accumulateUsage(a, { prompt_tokens: 90, completion_tokens: 95, total_tokens: 185 });
  assert.deepEqual(b, { prompt_tokens: 90, completion_tokens: 100, total_tokens: 190, reasoning_tokens: 2, cached_tokens: 3, cache_creation_input_tokens: 0 });

  // Even a request whose prompt does not grow leaves the running context
  // untouched — the re-sent history is never counted repeatedly.
  const c = accumulateUsage(b, { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
  assert.deepEqual(c, { prompt_tokens: 90, completion_tokens: 110, total_tokens: 200, reasoning_tokens: 2, cached_tokens: 3, cache_creation_input_tokens: 0 });
  // A call with no reasoning/cached fields leaves those totals unchanged.
  assert.equal(c.reasoning_tokens + c.cached_tokens, 5);
});

test("request accounting keeps missing reports unknown", () => {
  const first = reportedRequestUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  assert.equal(reportedRequestUsage({ prompt_tokens: "missing" }), null);
  assert.deepEqual(totalReportedUsage([{ usage: first }, { usage: null }]), {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    reasoning_tokens: null,
    cached_tokens: null,
    cache_creation_input_tokens: null,
    complete: false,
  });
});

test("repeated usage chunks count once for one request", async (t) => {
  const srv = await createMockServer(() => [
    { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    { content: "ok" },
  ]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv), [], "hi");
  assert.equal(result.requestUsage.attempts.length, 1);
  assert.equal(result.requestUsage.totals.total_tokens, 12);
  assert.equal(result.requestUsage.totals.complete, true);
});

test("a frontend callback bug is not reported as a provider failure", async (t) => {
  const srv = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv.close());
  await assert.rejects(
    runTurn(config(srv), [], "hi", (event) => {
      if (event.type === "request_attempt") throw new Error("callback broke");
    }),
    /callback broke/,
  );
  assert.equal(srv.calls(), 0, "the callback error never triggered a network retry");
});
