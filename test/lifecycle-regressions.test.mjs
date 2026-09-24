import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { abortableDelay } from "../src/llm.mjs";
import { MinimalTui } from "../src/tui.mjs";
import { setTheme } from "../src/theme.mjs";

test("completed retry delays release their abort listeners", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 12; i++) await abortableDelay(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = abortableDelay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("theme detection refreshes both transcript and per-block render caches", (t) => {
  setTheme("light");
  t.after(() => setTheme("light"));
  const tui = new MinimalTui({ model: "mock" });
  tui.pushBlock({ kind: "user", text: "existing transcript" });
  const light = tui.transcriptLines();
  setTheme("dark");
  const dark = tui.transcriptLines();
  assert.notEqual(dark, light);
  assert.notDeepEqual(dark, light, "ANSI colors must change even though block text and width did not");
  assert.equal(tui.transcriptLines(), dark, "unchanged frames still reuse the cache");
});
