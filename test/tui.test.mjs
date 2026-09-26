import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalTui } from "../src/tui.mjs";
import { stopOnSignal } from "../src/tui/lifecycle.mjs";
import { formatChars } from "../src/format.mjs";
import { SLASH_COMMANDS } from "../src/tui/commands.mjs";
import { suggestionLines } from "../src/tui/suggestions.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("markdown: nested inline, strikethrough, links, code fence", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 20;
  t.append("assistant", "## T\n\n**b `c`** and ~~gone~~ [l](https://x).\n\n```js\nconst a = 1;\n```");
  const out = strip(t.transcriptLines().join("\n"));
  assert.ok(out.includes("T"), "heading");
  assert.ok(out.includes("b c"), "nested bold+code");
  assert.ok(out.includes("gone"), "strikethrough");
  assert.ok(out.includes("(https://x)"), "link url fallback");
  assert.ok(out.includes("```js") && out.includes("const a = 1;"), "code fence");
});

test("newlines are hard breaks (model convention)", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.height = 20;
  t.append("assistant", "a\nb");
  const lines = t.transcriptLines();
  assert.equal(strip(lines[0]), "a");
  assert.equal(strip(lines[1]), "b");
});

test("footer: mode on the left, no 'mode' prefix, meta right-aligned", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 100;
  t.height = 12;
  t.git = { branch: "main", dirty: false, dirtyCount: 0 };
  t.mode = "working";
  t.cwd = "/workspace/argus";
  const f = strip(t.footer());
  assert.ok(f.startsWith("working"), "mode should be first");
  assert.ok(!f.includes("mode working"), "no 'mode ' prefix");
  assert.ok(f.includes("mock-model"), "model present");
  assert.ok(f.includes("git main"), "git present");
  assert.ok(f.includes("/workspace/argus"), "ANSI bytes must not crowd out the working directory");
  assert.ok(f.length <= 100, "footer should fit the terminal width");
});

test("footer shows a live phase timer, remembers the last turn, and adapts to narrow terminals", () => {
  let now = 12_500;
  const t = new MinimalTui({ model: "mock-model" }, { now: () => now });
  t.width = 100;
  t.git = { branch: "main", dirty: true, dirtyCount: 2 };
  t.cwd = "/workspace/a-very-long-project-name/argus";
  t.mode = "thinking";
  t.activityStartedAt = 10_000;

  const active = strip(t.footer());
  assert.match(active, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking 2\.5s/);
  assert.ok(active.includes("git main ~2"));

  t.mode = "idle";
  t.activityStartedAt = null;
  t.lastTurnDurationMs = 65_000;
  t.width = 36;
  const narrow = strip(t.footer());
  assert.ok(narrow.startsWith("last 1m 05s"));
  assert.ok(narrow.length <= 36, `narrow footer overflowed: ${narrow}`);
});

test("footer puts token usage on the left of the status", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 100;
  t.height = 12;
  t.git = { branch: "main", dirty: false, dirtyCount: 0 };
  t.cwd = "/workspace/argus";
  t.lastTurnDurationMs = 2700;
  t.lastTurnUsage = { prompt_tokens: 1100, completion_tokens: 140, total_tokens: 1240, reasoning_tokens: 77, cached_tokens: 384 };
  const f = strip(t.footer());
  assert.ok(f.startsWith("last 2.7s · ↑1.1K ↓140 ✶77 ≡384"), "token usage follows the status on the left");
  assert.ok(f.includes("git main"), "git stays in the right-hand meta area");
  assert.ok(f.includes("/workspace/argus"), "working directory stays in the right-hand meta area");
});

test("footer shows the real provider-reported request tokens as context", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 100;
  t.height = 12;
  t.git = { branch: "main", dirty: false, dirtyCount: 0 };
  t.cwd = "/workspace/argus";
  t.lastTurnUsage = { prompt_tokens: 1600, completion_tokens: 412, total_tokens: 2012, reasoning_tokens: 0, cached_tokens: 0 };
  const f = strip(t.footer());
  assert.ok(
    f.includes(`${formatChars(1600)} / ${formatChars(200000)} (1%)`),
    `context meter reports the last request's real prompt tokens against the 200k token budget: ${f}`,
  );
  assert.ok(f.includes("git main"), "git stays in the right-hand meta area");
});

test("before any request, the footer shows no made-up context but keeps the upper limit", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 100;
  t.height = 12;
  t.git = { branch: "main", dirty: false, dirtyCount: 0 };
  t.cwd = "/workspace/argus";
  const f = strip(t.footer());
  assert.ok(f.includes("— / 200.0K (0%)"), `no made-up context before a real request, limit shown: ${f}`);
  assert.ok(!f.includes("2 / "), "and no empty-array artifact either");
});

test("header makes transcript scroll state visible", () => {
  const t = new MinimalTui({ model: "m" }, { sessionName: "work" });
  t.width = 60;
  t.height = 10;
  for (let i = 0; i < 20; i++) t.pushBlock({ kind: "assistant", text: `line ${i}` });
  t.scrollOffset = 12; // absolute first-visible transcript line
  const header = strip(t.header());
  assert.ok(header.includes("work"));
  // 20 lines, viewport 6 → line 12 is 20 - 6 - 12 = 2 lines from the latest.
  assert.ok(header.includes("2 from latest") && header.includes("End"));
  assert.ok(header.length <= 60);
  t.width = 22;
  const narrow = strip(t.header());
  assert.ok(narrow.includes("↑2") && narrow.includes("End"), "narrow headers should still expose scroll state");
  assert.ok(narrow.length <= 22);
});

test("input history navigation", () => {
  const t = new MinimalTui({ model: "m" });
  t.editor.history = ["first", "second"];
  t.historyUp();
  assert.equal(t.editor.buffer, "second");
  t.historyUp();
  assert.equal(t.editor.buffer, "first");
  t.historyDown();
  t.historyDown();
  assert.equal(t.editor.buffer, "");
});

test("abortTurn aborts controller and sets aborting mode", () => {
  const t = new MinimalTui({ model: "m" });
  t.mode = "working";
  let aborted = false;
  t.abortController = { abort: () => (aborted = true) };
  t.abortTurn();
  assert.equal(t.mode, "aborting");
  assert.equal(aborted, true);
});

test("scrolling: wheel up/down + clamp", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.height = 10;
  for (let i = 0; i < 30; i++) t.pushBlock({ kind: "assistant", text: `line ${i}` });
  assert.equal(t.scrollOffset, null, "starts following the latest output");
  t.runAction({ type: "wheel", dir: 1 });
  assert.ok(t.scrollOffset > 0, "wheel up anchors an absolute line index");
  t.runAction({ type: "wheel", dir: -1 });
  t.runAction({ type: "wheel", dir: -1 });
  assert.equal(t.scrollOffset, null, "reaching the bottom resumes following");
});

test("scrolling: the viewport anchor is absolute, so new output doesn't move it", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.height = 10;
  for (let i = 0; i < 10; i++) t.pushBlock({ kind: "assistant", text: `line ${i}` });
  t.runAction({ type: "home" }); // absolute top: first visible line is 0
  assert.equal(t.scrollOffset, 0);
  const first = (rows) => rows.slice(1, 1 + t.transcriptHeight()).find((r) => r.length > 0);
  const before = first(t.buildFrame());
  // Simulate generation appending output below the anchor.
  for (let i = 10; i < 22; i++) t.pushBlock({ kind: "assistant", text: `line ${i}` });
  const after = first(t.buildFrame());
  assert.equal(after, before, "the top visible line stays put while output grows below");
  // Reaching the end again follows the latest line.
  t.runAction({ type: "end" });
  assert.equal(t.scrollOffset, null);
});

test("local slash commands do not enter model history", async () => {
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "old",
      initialHistory: [{ role: "user", content: "earlier" }],
      newSession: () => ({ sessionName: "fresh", session: {}, cwd: "/fresh" }),
      listSessions: () => [{ name: "saved", mtime: 1, size: 2048, turns: 2, lastPrompt: "last task" }],
      resumeSession: (name) => ({
        sessionName: name,
        session: { name },
        cwd: "/saved",
        history: [{ role: "user", content: "saved prompt" }],
        blocks: [
          { kind: "user", text: "saved prompt" },
          { kind: "timing", summary: "completed in 1.2s", durationMs: 1_200 },
        ],
      }),
    }
  );
  await t.runCommand("/help");
  assert.ok(t.blocks.some((b) => b.kind === "assistant" && b.text.includes("/status") && b.text.includes("Ctrl-W")));
  assert.equal(t.history.length, 1);
  await t.runCommand("/keys");
  assert.ok(t.blocks.at(-1).text.includes("Keyboard shortcuts"));
  assert.ok(!t.blocks.at(-1).text.includes("Local commands"));
  await t.runCommand("/status");
  assert.ok(t.blocks.at(-1).text.includes("Session: `old`"));
  assert.ok(t.blocks.at(-1).text.includes("Last turn: none yet"));
  assert.ok(t.blocks.at(-1).text.includes("chars/tool result"));
  await t.runCommand("/sessions");
  assert.ok(t.blocks.at(-1).text.includes("`saved`") && t.blocks.at(-1).text.includes("last task"));
  assert.ok(t.blocks.at(-1).text.includes("2.0KB"), "session listing reports file size");
  await t.runCommand("/resume saved");
  assert.equal(t.sessionName, "saved");
  assert.equal(t.cwd, "/saved");
  assert.equal(t.lastTurnDurationMs, 1_200);
  assert.deepEqual(t.editor.history, ["saved prompt"]);
  await t.runCommand("/new");
  assert.equal(t.sessionName, "fresh");
  assert.equal(t.cwd, "/fresh");
  assert.equal(t.lastTurnDurationMs, null);
  assert.deepEqual(t.history, []);
});

test("/model switches the runtime model and persists the override per session", async () => {
  let savedModel = null;
  const t = new MinimalTui({ model: "mock" }, { session: { setModel: async (m) => (savedModel = m) } });
  await t.runCommand("/model");
  assert.ok(t.blocks.at(-1).text.includes("Current model: `mock`"));
  assert.ok(t.blocks.at(-1).text.includes("/model <name>"));

  await t.runCommand("/model gpt-4o-mini");
  assert.equal(t.config.model, "gpt-4o-mini");
  assert.equal(savedModel, "gpt-4o-mini");
  assert.ok(t.blocks.at(-1).summary.includes("gpt-4o-mini"));

  await t.runCommand("/model already gpt-4o-mini");
  assert.equal(t.blocks.at(-1).kind, "error", "more than one name is a usage error");
});

test("/help lists /model as a runtime-switchable command", async () => {
  const t = new MinimalTui({ model: "m" });
  await t.runCommand("/help");
  assert.ok(t.blocks.at(-1).text.includes("/model"));
});

test("resuming a session applies its stored model; /new resets to the default", async () => {
  const t = new MinimalTui(
    { model: "env-default" },
    {
      defaultModel: "env-default",
      newSession: () => ({ sessionName: "fresh", session: {}, cwd: "/fresh" }),
      resumeSession: async () => ({
        sessionName: "saved",
        session: {},
        cwd: "/saved",
        model: "deepseek-chat",
        history: [],
        blocks: [],
      }),
    }
  );
  await t.runCommand("/resume saved");
  assert.equal(t.config.model, "deepseek-chat", "the session's stored override wins");
  await t.runCommand("/new");
  assert.equal(t.config.model, "env-default", "fresh sessions go back to the env default");
});

test("Tab completes only @path tokens and preserves surrounding input", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-complete-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "space dir"));
  writeFileSync(join(dir, "src", "agent.mjs"), "");
  writeFileSync(join(dir, "src", "another.mjs"), "");
  writeFileSync(join(dir, "space dir", "file name.txt"), "");
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });

  t.editor.buffer = "Review @src/ag";
  t.editor.cursor = t.editor.buffer.length;
  t.completePath();
  assert.equal(t.editor.buffer, "Review @src/agent.mjs ");

  t.editor.buffer = "Review src/ag";
  t.editor.cursor = t.editor.buffer.length;
  t.completePath();
  assert.equal(t.editor.buffer, "Review src/ag", "plain paths are not implicitly completed");

  t.editor.buffer = "Review @sr";
  t.editor.cursor = t.editor.buffer.length;
  t.completePath();
  assert.equal(t.editor.buffer, "Review @src/");

  t.editor.buffer = "Review @sp";
  t.editor.cursor = t.editor.buffer.length;
  t.completePath();
  assert.equal(t.editor.buffer, 'Review @"space dir/');
  t.editor.buffer += "fi";
  t.editor.cursor = t.editor.buffer.length;
  t.completePath();
  assert.equal(t.editor.buffer, 'Review @"space dir/file name.txt" ');
});

test("live suggestions: /commands filter, navigate, Tab accepts, Esc dismisses", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 80;

  t.insertText("/re");
  assert.equal(t.suggestion?.kind, "slash");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["/resolve", "/resume"]);

  t.runAction({ type: "down" });

  t.insertText("\t"); // Tab accepts the highlighted command
  assert.equal(t.editor.buffer, "/resume ");
  assert.equal(t.suggestion, null, "a completed command leaves no popup");

  t.editor.buffer = "/";
  t.editor.cursor = 1;
  t.refreshSuggestions();
  assert.equal(t.suggestion.items.length, SLASH_COMMANDS.length, "one entry per SLASH_COMMANDS command");
  t.runAction({ type: "down" });
  t.runAction({ type: "down" });
  assert.equal(t.suggestion.selected, 2, "arrow keys move the highlight");
  t.insertText("\t");
  assert.equal(t.editor.buffer, "/status ", "Tab accepts the moved highlight");

  // Typing more shrinks the list but keeps the highlighted command.
  t.editor.buffer = "/";
  t.editor.cursor = 1;
  t.refreshSuggestions();
  t.runAction({ type: "down" });
  t.runAction({ type: "down" });
  t.insertText("s");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["/status", "/steer", "/show", "/sessions"]);
  assert.equal(t.suggestion.selected, 0, "highlight follows the previously selected command");
  t.insertText("e");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["/sessions"]);

  // A space ends the bare-command token, so the popup hides.
  t.editor.buffer = "/re";
  t.editor.cursor = 3;
  t.insertText(" ");
  assert.equal(t.suggestion, null);
  assert.equal(t.editor.buffer, "/re ");

  // Esc dismisses the popup without touching the input.
  t.editor.buffer = "/";
  t.editor.cursor = 1;
  t.refreshSuggestions();
  t.runAction({ type: "escape" });
  assert.equal(t.suggestion, null);
  assert.equal(t.editor.buffer, "/");
});

test("live suggestions: @path list follows the caret and Tab accepts entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-suggest-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "src", "agent.mjs"), "");
  writeFileSync(join(dir, "src", "cli.mjs"), "");
  writeFileSync(join(dir, "lib", "reader.mjs"), "");
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });
  t.width = 80;

  t.insertText("read ");
  assert.equal(t.suggestion, null);
  t.insertText("@sr");
  assert.equal(t.suggestion?.kind, "path");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["src/"], "dirs sort first and filter by prefix");

  t.insertText("\t"); // accept src/ so the token points into the real dir
  assert.equal(t.editor.buffer, "read @src/", "Tab fills the directory");
  t.insertText("ag");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["agent.mjs"]);
  t.insertText("\t");
  assert.equal(t.editor.buffer, "read @src/agent.mjs ", "Tab fills the file and closes the token");

  t.editor.buffer = "read @li";
  t.editor.cursor = t.editor.buffer.length;
  t.refreshSuggestions();
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["lib/"]);
  t.insertText("\t"); // accept the directory, opening it for descent
  t.insertText("r");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["reader.mjs"]);
  t.runAction({ type: "escape" });
  assert.equal(t.suggestion, null);

  // No popup for a plain slash or an @token that is not at the caret end.
  t.editor.buffer = "read @src/agent.mjs and keep typing";
  t.editor.cursor = t.editor.buffer.length;
  t.refreshSuggestions();
  assert.equal(t.suggestion, null);
});

test("suggestion popup renders above the editor and hides while working", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 60;
  t.height = 24;
  t.editor.buffer = "/";
  t.editor.cursor = 1;
  t.refreshSuggestions();

  const frame = t.buildFrame();
  const plain = frame.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(plain.includes("commands"), "popup header labels slash suggestions");
  assert.ok(plain.some((line) => line.includes("▸ /help")), "selected suggestion is marked");
  assert.ok(plain[22] === "❯ /", "editor stays in its own row");
  assert.ok(plain[23].startsWith("idle"), "footer stays at the bottom");

  t.mode = "working";
  t.refreshSuggestions();
  assert.equal(t.suggestion, null, "no popup while a turn is running");
});

test("suggestion popup scrolls when Up/Down move past the visible limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-scroll-"));
  for (const name of ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "b0"]) {
    writeFileSync(join(dir, name), "");
  }
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });
  t.width = 60;
  t.height = 24;
  t.editor.buffer = "@";
  t.editor.cursor = 1;
  t.refreshSuggestions();
  const plain = () => t.buildFrame().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));

  let frame = plain();
  assert.equal(t.suggestion.items.length, 11);
  assert.ok(frame.some((line) => line.includes("▸ a0")), "the first match is highlighted");
  assert.ok(frame.some((line) => line.includes("↓ 3 more")), "the status row says how many are hidden below");
  assert.ok(!frame.some((line) => line.includes("a8")), "a8 is past the first window");

  for (let i = 0; i < 8; i++) t.runAction({ type: "down" });
  frame = plain();
  assert.equal(t.suggestion.selected, 8);
  assert.ok(frame.some((line) => line.includes("▸ a8")), "the highlight follows the selection past the limit");
  assert.ok(!frame.some((line) => line.includes("▸ a0")), "scrolled rows leave the window");

  for (let i = 0; i < 2; i++) t.runAction({ type: "down" });
  frame = plain();
  assert.equal(t.suggestion.selected, 10);
  assert.ok(frame.some((line) => line.includes("▸ b0")), "the last match is shown at the bottom");
  assert.ok(frame.some((line) => line.includes("↑ 3 more")), "scrolling down reveals how many are above");
  assert.ok(!frame.some((line) => line.includes("↓")), "no down arrow when the window ends at the list end");

  for (let i = 0; i < 5; i++) t.runAction({ type: "up" });
  frame = plain();
  assert.equal(t.suggestion.selected, 5);
  assert.ok(frame.some((line) => line.includes("▸ a5")), "highlight stays visible arrowing back up");
});

test("suggestion popup keeps a constant height while scrolling", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-const-"));
  for (const name of ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "b0", "b1", "b2"]) {
    writeFileSync(join(dir, name), "");
  }
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });
  t.width = 60;
  t.height = 24;
  t.editor.buffer = "@";
  t.editor.cursor = 1;
  t.refreshSuggestions();

  const heights = [];
  for (let i = 0; i < t.suggestion.items.length; i++) {
    heights.push(
    suggestionLines(t.suggestion, { width: t.width, height: t.height, editorHeight: t.editorHeight, cwd: t.cwd }).length
  );
    t.runAction({ type: "down" });
  }
  assert.ok(heights.length > 1, "the list is long enough to scroll");
  assert.equal(new Set(heights).size, 1, "the popup height never changes while arrowing");

  const frame = t.buildFrame().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(frame.some((l) => l.includes("↑")), "hidden-above count lives in the fixed status row");
});

test("suggestion popup keeps the highlight visible on short terminals", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-short-"));
  for (let i = 0; i < 15; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}`), "");
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });
  t.width = 60;
  t.height = 8;
  t.editor.buffer = "@";
  t.editor.cursor = 1;
  t.refreshSuggestions();

  for (let i = 0; i < 14; i++) t.runAction({ type: "down" });
  const frame = t.buildFrame().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(t.suggestion.selected, 14);
  assert.ok(frame.some((line) => line.includes("▸ f14")), "the highlighted row is never clipped");
  assert.ok(frame.some((line) => line.includes("↑")), "the popup says items are hidden above");
});

test("suggestion popup marks directories and symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-link-"));
  mkdirSync(join(dir, "subdir"));
  writeFileSync(join(dir, "file.txt"), "");
  symlinkSync(join(dir, "subdir"), join(dir, "link-to-dir"));
  symlinkSync(join(dir, "file.txt"), join(dir, "link-to-file"));
  const t = new MinimalTui({ model: "m" }, { initialCwd: dir });
  t.width = 80;
  t.editor.buffer = "@";
  t.editor.cursor = 1;
  t.refreshSuggestions();
  const plain = suggestionLines(t.suggestion, { width: t.width, height: t.height, editorHeight: t.editorHeight, cwd: t.cwd }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

  // Directories (real and via symlink) sort first and keep a trailing slash.
  assert.deepEqual(t.suggestion.items.map((i) => i.label), [
    "link-to-dir/",
    "subdir/",
    "file.txt",
    "link-to-file",
  ]);
  assert.ok(plain.some((l) => l.includes("link-to-dir/")), "symlinked dir shows a trailing slash");
  assert.ok(plain.some((l) => l.includes("subdir/")), "real dir shows a trailing slash");
  assert.ok(plain.some((l) => l.includes("→ file.txt")), "file symlink shows its resolved target");
  assert.ok(!plain.some((l) => l.includes("link-to-file.txt")), "symlink marker is never folded into the path");
});

test("/status and timing rows show real token usage", async () => {
  const usage = { prompt_tokens: 1600, completion_tokens: 412, total_tokens: 2012, reasoning_tokens: 0, cached_tokens: 0 };
  const t = new MinimalTui({ model: "m" });
  t.lastTurnUsage = usage;
  t.pushBlock({ kind: "timing", summary: "completed in 2.5s", durationMs: 2500, usage });
  const lines = t.transcriptLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("2.5s") && l.includes("↑1.6K ↓412")), "timing row shows usage");

  await t.runCommand("/status");
  assert.ok(t.blocks.at(-1).text.includes("↑1.6K ↓412"), "/status shows last-turn usage");
  assert.ok(t.blocks.at(-1).text.includes("Context: 1.6K / 200.0K tokens (1%)"), "/status reports real context against the 200k token budget");
});

test("Tab never completes plain text without an @ or / token", () => {
  const t = new MinimalTui({ model: "m" });
  t.editor.buffer = "Review src/ag";
  t.editor.cursor = t.editor.buffer.length;
  t.insertText("\t");
  assert.equal(t.editor.buffer, "Review src/ag");
  assert.equal(t.suggestion, null);
});

test("bracketed multiline paste becomes one editor input, newlines preserved", () => {
  const t = new MinimalTui({ model: "m" });
  let submits = 0;
  t.submit = () => submits++;
  t.onData(Buffer.from("\x1b[200~first\nsecond\r\nthird\x1b[201~"));
  assert.equal(t.editor.buffer, "first\nsecond\nthird");
  assert.equal(submits, 0);
});

test("paste inserts TAB, ESC, and control bytes literally (no keybindings fire)", () => {
  const t = new MinimalTui({ model: "m" });
  // \t must not path-complete; \x1b, Ctrl-A (\x01), Ctrl-K (\x0b) must land in
  // the buffer as data rather than move the caret / delete / move-to-line-end.
  t.onData(Buffer.from("\x1b[200~a\tb\x1bc\x01d\x0be\x1b[201~"));
  assert.equal(t.editor.buffer, "a\tb\x1bc\x01d\x0be");
  assert.equal(t.suggestion, null, "no completion popup from pasted TAB");
});

test("a pasted Ctrl-D cannot quit from a non-empty buffer mid-paste", () => {
  const t = new MinimalTui({ model: "m" });
  let stopped = false;
  t.stop = () => (stopped = true);
  t.onData(Buffer.from("\x1b[200~abc\x04def\x1b[201~"));
  assert.equal(t.editor.buffer, "abc\x04def");
  assert.equal(stopped, false);
});

test("a large paste renders [pasted N lines] but submits the full text", async (t) => {
  const srv = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv.close());
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
  const payload = lines.join("\n");
  const tui = new MinimalTui({ model: "m", baseUrl: srv.url, apiKey: "", systemPrompt: "s" });
  tui.onData(Buffer.from(`\x1b[200~${payload}\x1b[201~`));
  await tui.submit();
  const user = tui.blocks.find((b) => b.kind === "user");
  assert.equal(user.text, "[pasted 25 lines]");
  assert.equal(tui.history.find((m) => m.role === "user")?.content, payload, "the full paste reached the model");
});

test("editing a large paste keeps the real text in the user block", async (t) => {
  const srv = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv.close());
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
  const payload = lines.join("\n");
  const tui = new MinimalTui({ model: "m", baseUrl: srv.url, apiKey: "", systemPrompt: "s" });
  tui.onData(Buffer.from(`\x1b[200~${payload}\x1b[201~`));
  tui.editor.buffer += "\nplease review";
  tui.editor.cursor = tui.editor.buffer.length;
  await tui.submit();
  const user = tui.blocks.find((b) => b.kind === "user");
  assert.equal(user.text.split("\n").length, 26, "the block shows the real (edited) prompt");
  assert.match(user.text, /please review/);
});

test("Esc on a multiline draft keeps it instead of flattening", () => {
  const t = new MinimalTui({ model: "m" });
  t.editor.buffer = "alpha\nbeta";
  t.editor.cursor = 5;
  t.runAction({ type: "escape" });
  assert.equal(t.editor.buffer, "alpha\nbeta");
  assert.equal(t.editor.cursor, 5);
});

test("history navigation does not destroy an in-progress draft", () => {
  const t = new MinimalTui({ model: "m" });
  t.editor.history = ["first", "second"];
  t.editor.buffer = "my draft";
  t.editor.cursor = 4;
  t.historyUp();
  assert.equal(t.editor.buffer, "second");
  t.historyDown();
  t.historyDown();
  assert.equal(t.editor.buffer, "my draft", "walking off the history restores the draft");
  assert.equal(t.editor.cursor, 4);
  assert.equal(t.editor.draft, null, "the draft is consumed once restored");
});

test("Ctrl-D on an empty buffer quits only while idle", () => {
  const t = new MinimalTui({ model: "m" });
  let stopped = 0;
  t.stop = () => (stopped++);
  t.mode = "working";
  t.insertText("\x04");
  assert.equal(stopped, 0, "mid-turn Ctrl-D must not exit");
  t.mode = "idle";
  t.insertText("\x04");
  assert.equal(stopped, 1, "idle Ctrl-D still quits");
});

test("a denied approval renders one result row, not two", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-deny-"));
  const srv = await createMockServer((i) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: JSON.stringify({ command: `rm -rf "${dir}"` }) } }] }];
    }
    return [{ content: "ok" }];
  });
  t.after(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const tui = new MinimalTui({ model: "m", baseUrl: srv.url, apiKey: "", systemPrompt: "s" });
  tui.editor.buffer = "dangerous";
  tui.confirm = () => Promise.resolve(false);
  await tui.submit();
  const denied = tui.blocks.filter((b) => b.kind === "result" && b.summary.includes("denied"));
  assert.equal(denied.length, 1);
  assert.match(denied[0].summary, /not approved/);
});

test("an interrupted turn renders without a redundant ✗ before ⏹", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.pushBlock({ kind: "result", ok: false, summary: "⏹ interrupted" });
  const lines = t.transcriptLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("⏹ interrupted")));
  assert.ok(!lines.some((l) => l.includes("✗")), "no ✗ marker on the interrupt row");
});

test("terminal editing hotkeys manipulate input predictably", () => {
  const t = new MinimalTui({ model: "m" });
  t.editor.buffer = "one two";
  t.editor.cursor = t.editor.buffer.length;
  t.insertText("\x17"); // Ctrl-W
  assert.equal(t.editor.buffer, "one ");
  t.insertText("two");
  t.insertText("\x01"); // Ctrl-A
  t.insertText("X");
  assert.equal(t.editor.buffer, "Xone two");
  t.insertText("\x05"); // Ctrl-E
  t.insertText("\x15"); // Ctrl-U
  assert.equal(t.editor.buffer, "");
  t.editor.buffer = "abc";
  t.editor.cursor = 1;
  t.insertText("\x04"); // Ctrl-D
  assert.equal(t.editor.buffer, "ac");
});

test("multiline cursor positioning: caret stays aligned across logical lines", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 80;
  
  // Test case 1: Two short lines (no wrapping)
  // "line1\nline2" = 5+1+5 = 11 chars total
  t.editor.buffer = "line1\nline2";
  t.editor.cursor = 11; // at end of "line2"
  let pos = t.caretPos();
  assert.equal(pos.row, 1, "cursor should be on row 1");
  assert.equal(pos.col, 5, "cursor should be at column 5 in line2");
  
  // Test case 2: Three lines with cursor at start of third line
  // "line1\nline2\nline3" = 5+1+5+1+5 = 17 chars total
  t.editor.buffer = "line1\nline2\nline3";
  t.editor.cursor = 12; // at start of "line3" (after "line1\nline2\n")
  pos = t.caretPos();
  assert.equal(pos.row, 2, "cursor should be on row 2");
  assert.equal(pos.col, 0, "cursor should be at column 0 in line3");
  
  // Test case 3: Cursor at end of first line
  t.editor.cursor = 5; // after "line1", before \n
  pos = t.caretPos();
  assert.equal(pos.row, 0, "cursor should be on row 0");
  assert.equal(pos.col, 5, "cursor should be at column 5 in line1");
  
  // Test case 4: Cursor just after \n (start of second line)
  t.editor.cursor = 6; // after \n, at start of "line2"
  pos = t.caretPos();
  assert.equal(pos.row, 1, "cursor should be on row 1");
  assert.equal(pos.col, 0, "cursor should be at column 0 in line2");
  
  // Test case 5: Cursor in middle of second line
  t.editor.cursor = 8; // at 'n' in "line2" (6+2=8)
  pos = t.caretPos();
  assert.equal(pos.row, 1, "cursor should be on row 1");
  assert.equal(pos.col, 2, "cursor should be at column 2 in line2");
});

test("multiline vertical cursor movement preserves column position", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 80;
  
  // Set up three lines
  t.editor.buffer = "abcdef\nghijk\nlmnop";
  t.editor.cursor = 4; // at 'e' in first line (col 4)
  
  // Move down to second line
  let moved = t.moveCaretVertical(1);
  assert.ok(moved, "should move down");
  assert.equal(t.editor.cursor, 11, "cursor should be at col 4 in second line (7+4=11)");
  
  // Move down to third line
  moved = t.moveCaretVertical(1);
  assert.ok(moved, "should move down");
  assert.equal(t.editor.cursor, 17, "cursor should be at col 4 in third line (13+4=17)");
  
  // Move back up to second line
  moved = t.moveCaretVertical(-1);
  assert.ok(moved, "should move up");
  assert.equal(t.editor.cursor, 11, "cursor should be back at col 4 in second line");
  
  // Move back up to first line
  moved = t.moveCaretVertical(-1);
  assert.ok(moved, "should move up");
  assert.equal(t.editor.cursor, 4, "cursor should be back at col 4 in first line");
});

test("/name renames the current session and repoints the handle", async () => {
  const handle = {
    name: "old",
    renamedTo: null,
    renameTo(name) {
      this.renamedTo = name;
      this.name = name;
    },
  };
  let moved = null;
  let sawHandle = null;
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "old",
      session: handle,
      renameSession: async (from, to, sessionHandle) => {
        moved = `${from}->${to}`;
        sawHandle = sessionHandle;
        return to;
      },
      listSessionNames: async () => ["new", "old"],
    }
  );
  await t.runCommand("/name new");
  assert.equal(moved, "old->new");
  assert.equal(sawHandle, handle, "the live session handle is passed to renameSession");
  assert.equal(t.sessionName, "new");
  assert.equal(handle.renamedTo, "new");
  assert.equal(t.blocks.at(-1).summary, "session renamed to new");
  await t.refreshSessionNames();
  assert.deepEqual(t.sessionNames, ["new", "old"], "the completion cache refreshes after a rename");
});

test("/delete confirms, protects the active session, and refreshes completion", async () => {
  const deleted = [];
  const confirmations = [];
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "active",
      sessionNames: ["active", "old"],
      deleteSession: async (name, active) => {
        deleted.push([name, active]);
        return name;
      },
      listSessionNames: async () => ["active"],
    },
  );
  t.confirm = async (request) => {
    confirmations.push(request);
    return true;
  };

  await t.runCommand("/delete active");
  assert.match(t.blocks.at(-1).text, /cannot delete the active session/);
  assert.deepEqual(deleted, []);

  await t.runCommand("/delete old");
  assert.deepEqual(deleted, [["old", "active"]]);
  assert.match(confirmations[0].reason, /cannot be undone/);
  assert.equal(t.blocks.at(-1).summary, "deleted session old; it cannot be recovered");
  assert.deepEqual(t.sessionNames, ["active"]);

  t.confirm = async () => false;
  await t.runCommand("/delete another");
  assert.deepEqual(deleted, [["old", "active"]]);
  assert.equal(t.blocks.at(-1).summary, "session deletion cancelled: another");
});

test("Ctrl-C cancels a local confirmation without arming force-quit", async () => {
  const t = new MinimalTui({ model: "m" });
  const decision = t.confirm({ tool: "session delete", args: { command: "old" } });
  t.handleCtrlC();
  assert.equal(await decision, false);
  assert.equal(t.pendingConfirm, null);
  assert.equal(t.aborting, false);
  assert.equal(t.mode, "working");
});

test("/name tolerates trailing whitespace and joins multi-word input", async () => {
  let called = [];
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "old",
      // Mirrors the store contract: single joined name in, validated out.
      renameSession: async (from, to) => {
        called.push([from, to]);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(to)) throw new Error(`invalid session name: ${to}`);
        return to;
      },
    }
  );
  // A trailing space must not fake an empty second argument (regression).
  await t.runCommand("/name new ");
  assert.deepEqual(called, [["old", "new"]]);
  assert.equal(t.sessionName, "new");

  // Multi-word input reaches the store as one name, so the error the user sees
  // is the truthful "invalid session name" (from sanitizeName), not "usage".
  await t.runCommand("/name fix the bug");
  assert.deepEqual(called.at(-1), ["new", "fix the bug"]);
  assert.equal(t.blocks.at(-1).kind, "error");
  assert.match(t.blocks.at(-1).text, /invalid session name/);
});

test("/name validates usage, collisions, and same-name no-ops", async () => {
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "old",
      renameSession: async () => {
        throw new Error("session already exists: taken");
      },
    }
  );
  await t.runCommand("/name");
  assert.equal(t.blocks.at(-1).kind, "error");
  assert.match(t.blocks.at(-1).text, /usage: \/name/);
  await t.runCommand("/name one two");
  assert.equal(t.blocks.at(-1).kind, "error");
  await t.runCommand("/name taken");
  assert.equal(t.blocks.at(-1).kind, "error");
  assert.match(t.blocks.at(-1).text, /session already exists/);

  const noop = new MinimalTui({ model: "m" }, { sessionName: "same", renameSession: async () => { throw new Error("should not be called"); } });
  await noop.runCommand("/name same");
  assert.equal(noop.blocks.at(-1).kind, "result");
  assert.equal(noop.blocks.at(-1).summary, "already named same");
});

test("/new <name> starts a named fresh session; invalid names error", async () => {
  let received = "unset";
  const t = new MinimalTui(
    { model: "m" },
    {
      sessionName: "old",
      newSession: (name) => {
        received = name;
        return { sessionName: name, session: {}, cwd: "/fresh" };
      },
      listSessionNames: async () => ["my-work"],
    }
  );
  await t.runCommand("/new my-work");
  assert.equal(received, "my-work");
  assert.equal(t.sessionName, "my-work");
  assert.equal(t.cwd, "/fresh");
  assert.deepEqual(t.history, []);
  await t.refreshSessionNames();
  assert.deepEqual(t.sessionNames, ["my-work"]);

  const bad = new MinimalTui({ model: "m" }, {
    newSession: (name) => {
      throw new Error(`invalid session name: ${name}`);
    },
  });
  await bad.runCommand("/new bad name!");
  assert.equal(bad.blocks.at(-1).kind, "error");
  assert.match(bad.blocks.at(-1).text, /invalid session name/);
});

test("live suggestions: saved-session names complete /resume tokens", () => {
  const t = new MinimalTui({ model: "m" }, { sessionNames: ["work-1", "work-2", "ai-lab"] });
  t.width = 80;

  t.editor.buffer = "/resume wo";
  t.editor.cursor = "/resume wo".length;
  t.refreshSuggestions();
  assert.equal(t.suggestion?.kind, "session");
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["work-1", "work-2"]);

  t.insertText("\t"); // Tab accepts the highlighted name
  assert.equal(t.editor.buffer, "/resume work-1 ");
  assert.equal(t.suggestion, null, "a completed name leaves no popup");

  // An empty token after /resume lists everything.
  t.editor.buffer = "/resume ";
  t.editor.cursor = 8;
  t.refreshSuggestions();
  assert.equal(t.suggestion.items.length, 3);
});

test("/help documents /name and /new <name>", async () => {
  const t = new MinimalTui({ model: "m" });
  await t.runCommand("/help");
  assert.ok(t.blocks.at(-1).text.includes("/name <name>"));
  assert.ok(t.blocks.at(-1).text.includes("/new [<name>]"));
});

test("separator: blank between distinct kinds, but tool call and its result stay paired", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.height = 20;
  t.pushBlock({ kind: "user", text: "first" });
  t.pushBlock({ kind: "thinking", text: "plan" });
  t.pushBlock({ kind: "tool", name: "read", args: { path: "a.txt" } });
  t.pushBlock({ kind: "result", ok: true, summary: "1 lines" });
  t.append("assistant", "done");
  const lines = t.transcriptLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  // tool -> result are a pair and are NOT separated; other kind changes get a
  // blank line: user->thinking->tool have blanks, tool->result none,
  // result->assistant blank.
  assert.deepEqual(lines, [
    "❯ first",
    "",
    "│ plan",
    "",
    "│ ⚙ read → a.txt",
    "│ ✓ 1 lines",
    "",
    "done",
  ]);
});

test("separator: two consecutive tool/result pairs each keep their own result", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.height = 20;
  t.pushBlock({ kind: "tool", name: "bash", args: { command: "ls" } });
  t.pushBlock({ kind: "result", ok: true, summary: "src" });
  t.pushBlock({ kind: "tool", name: "read", args: { path: "a" } });
  t.pushBlock({ kind: "result", ok: false, summary: "no such file" });
  const lines = t.transcriptLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.deepEqual(lines, [
    "│ ⚙ bash → ls",
    "│ ✓ src",
    "",
    "│ ⚙ read → a",
    "│ ✗ no such file",
  ]);
});

test("result preview renders dimmed under the summary inside the same rail", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.height = 20;
  t.pushBlock({ kind: "result", ok: true, summary: "stdout: npm ok", detail: "build step 1\nbuild step 2\n… 4 more lines" });
  const lines = t.transcriptLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.deepEqual(lines, ["│ ✓ stdout: npm ok", "│ build step 1", "│ build step 2", "│ … 4 more lines"]);
});

test("render cache: the line assembly is reused until a block changes or the width does", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 30;
  t.append("assistant", "a".repeat(60));
  const first = t.transcriptLines();
  assert.equal(t.transcriptLines(), first, "an unchanged transcript returns the same cached array");

  t.width = 60;
  const widened = t.transcriptLines();
  assert.notEqual(widened, first, "a width change invalidates the cache");
  const plain = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain(widened[0]).length > plain(first[0]).length, "a wider terminal wraps less");

  t.pushBlock({ kind: "user", text: "hi" });
  const grew = t.transcriptLines();
  assert.notEqual(grew, widened, "a new block invalidates the assembly");
  assert.ok(grew.length > widened.length);
});

test("render cache: a folded text append re-wraps the tail, never stale lines", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 40;
  t.append("assistant", "alpha");
  const before = t.transcriptLines();
  t.append("assistant", " beta");
  const after = t.transcriptLines();
  assert.notEqual(after, before, "appending to the live block invalidates the assembly");
  assert.ok(after.some((l) => l.replace(/\x1b\[[0-9;]*m/g, "").includes("alpha beta")));
});

test("/show prints a block in full, including the stored tool result", async () => {
  const t = new MinimalTui({ model: "m" });
  t.history = [
    { role: "user", content: "read the file" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ numberedText: "1 │ one\n2 │ two" }) },
  ];
  t.pushBlock({ kind: "tool", name: "read", label: "read → a.txt", id: "call_1" });
  t.pushBlock({ kind: "result", ok: true, summary: "1 │ one", detail: "1 │ one\n2 │ two", id: "call_1" });
  await t.runCommand("/show 1");
  const tool = t.blocks.at(-1).text;
  assert.ok(tool.includes("## Block 1 — tool call"), "tool block header");
  assert.ok(tool.includes("read → a.txt"), "label line");
  assert.ok(tool.includes('"numberedText"'), "the stored result is linked back via the call id");
  await t.runCommand("/show 2");
  const result = t.blocks.at(-1).text;
  assert.ok(result.includes("## Block 2 — tool result"), "result block header");
  assert.ok(result.includes('"numberedText"'), "full stored result from the session record");
  assert.ok(result.includes("1 │ one\n2 │ two"), "preview body");
});

test("/show validates its argument and range", async () => {
  const missing = new MinimalTui({ model: "m" });
  await missing.runCommand("/show");
  assert.match(missing.blocks.at(-1).text, /usage/);
  const notNumber = new MinimalTui({ model: "m" });
  await notNumber.runCommand("/show abc");
  assert.match(notNumber.blocks.at(-1).text, /whole number/);
  const zero = new MinimalTui({ model: "m" });
  await zero.runCommand("/show 0");
  assert.match(zero.blocks.at(-1).text, /whole number/);
  const outOfRange = new MinimalTui({ model: "m" });
  await outOfRange.runCommand("/show 2");
  assert.match(outOfRange.blocks.at(-1).text, /no block 2/);
});

test("confirm mode: distinct row + affordance, button resolves, block recorded", async () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 50;
  t.height = 16;
  const p = t.confirm({ tool: "bash", cwd: "/x", command: "rm -rf /x", reason: "recursive remove" });
  assert.equal(t.mode, "confirm");
  assert.ok(t.pendingConfirm);
  const frame = t.buildFrame().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  // height 16: confirm row at height-3 = 13, affordance at height-2 = 14,
  // footer at height-1 = 15 (all 0-indexed).
  assert.ok(frame[13]?.includes("⚠ bash in /x: rm -rf /x"), "confirm row shows tool + cwd + command");
  assert.ok(frame[14]?.includes("[y] approve"), "confirm row shows y/n affordance");
  assert.ok(t.blocks.some((b) => b.kind === "confirm" && /bash in \/x: rm -rf \/x/.test(b.text)), "confirm block recorded");
  t.insertText("y");
  assert.equal(await p, true);
  assert.equal(t.pendingConfirm, null);
});

test("Enter during a pending confirm stays in confirm mode", async () => {
  const t = new MinimalTui({ model: "m" });
  t.confirm("rm -rf /x");
  const before = t.blocks.length;
  t.editor.buffer = "oops";
  await t.submit();
  assert.ok(t.pendingConfirm, "a pending confirm stays pending");
  assert.equal(t.mode, "confirm");
  assert.equal(t.blocks.length, before, "no user/submit block added while confirming");
});

test("footer shows confirm phase distinctly", () => {
  const t = new MinimalTui({ model: "m" });
  t.width = 60;
  t.mode = "confirm";
  const f = t.footer().replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(f.startsWith("confirm"), "footer names the confirm phase");
});

test("SIGTERM requests cancellation and bounded terminal cleanup", async () => {
  const tui = {
    stopped: false, mode: "working", abortController: {}, aborted: false,
    abortTurn() { this.aborted = true; this.abortController = null; },
  };
  let stopped;
  await stopOnSignal(tui, async (_tui, exitCode, flushMs) => {
    stopped = { exitCode, flushMs };
  });
  assert.equal(tui.aborted, true);
  assert.deepEqual(stopped, { exitCode: 143, flushMs: 500 });
});
