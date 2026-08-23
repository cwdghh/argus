import test from "node:test";
import assert from "node:assert/strict";
import { statusText, footerText, headerText } from "../src/tui/frames.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const base = {
  width: 100,
  height: 12,
  mode: "idle",
  now: () => 5000,
  activityStartedAt: null,
  turnUsage: null,
  lastTurnDurationMs: null,
  lastTurnUsage: null,
  config: { model: "mock-model" },
  git: { branch: "main", dirty: false, dirtyCount: 0 },
  cwd: "/workspace/argus",
  history: [],
  sessionName: "work",
  scrollOffset: 0,
};

test("frames: statusText shows idle then the last turn's usage", () => {
  assert.equal(statusText({ ...base }), "idle");
  const s = statusText({
    ...base,
    lastTurnDurationMs: 2700,
    lastTurnUsage: { prompt_tokens: 1100, completion_tokens: 140, total_tokens: 1240 },
  });
  assert.equal(s, "last 2.7s · ↑1.1K ↓140");
});

test("frames: statusText shows a live spinner while working", () => {
  const s = statusText({ ...base, mode: "working", activityStartedAt: 300 });
  assert.match(s, /^. working 4\.7s$/);
});

test("frames: footer shows tokens on the left and real context on the right", () => {
  const f = strip(
    footerText({
      ...base,
      lastTurnDurationMs: 2700,
      lastTurnUsage: { prompt_tokens: 1100, completion_tokens: 140, total_tokens: 1240 },
    })
  );
  assert.ok(f.startsWith("last 2.7s · ↑1.1K ↓140"), "token usage travels with the status");
  assert.ok(f.includes("git main ✓"));
  assert.ok(f.includes("mock-model"));
  assert.ok(f.includes("1.1K / 200.0K (1%)"), "context meter: real prompt tokens vs. the 200k token budget");
  assert.ok(f.includes("/workspace/argus"));
  assert.ok(f.length <= 100, "fits the width");
});

test("frames: before any request, the context meter shows an em dash against the budget", () => {
  const f = strip(footerText({ ...base, lastTurnDurationMs: 2700, lastTurnUsage: null }));
  assert.ok(f.includes("— / 200.0K (0%)"), "no made-up context, but the upper limit stays visible");
});

test("frames: while working the meter keeps the last-known real context", () => {
  // The provider reports usage only at the end of a streamed response, so a
  // working turn's `turnUsage` is null until then. The meter must not flicker
  // to an em dash for the whole response — it keeps the last request's real
  // context until the live number arrives.
  const f = strip(
    footerText({
      ...base,
      mode: "working",
      activityStartedAt: 3000,
      lastTurnUsage: { prompt_tokens: 1100, completion_tokens: 140, total_tokens: 1240 },
    })
  );
  assert.ok(f.includes("1.1K / 200.0K"), "last-known context stays visible while responding");
  assert.ok(!f.includes("— /"), "no em-dash flicker mid-turn");
});

test("frames: footer collapses cleanly on a narrow terminal", () => {
  const f = strip(footerText({ ...base, width: 30, cwd: "/a/very/long/path" }));
  assert.ok(f.length <= 30, `footer within 30 cols: ${f}`);
  assert.ok(f.includes("git main"), "git status survives the squeeze");
});

test("frames: header shows the session and a scroll-away hint", () => {
  assert.ok(strip(headerText({ ...base })).includes("argus"));
  assert.ok(strip(headerText({ ...base })).includes("work"));
  const scrolled = strip(headerText({ ...base, scrollOffset: 5 }));
  assert.ok(scrolled.includes("↑ 5 from latest · End"));
});
