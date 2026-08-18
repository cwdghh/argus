import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalTui } from "../src/tui.mjs";
import { COMPACT_DEFAULTS, estimateChars } from "../src/compact.mjs";
import { formatChars } from "../src/format.mjs";
import { SLASH_COMMANDS } from "../src/tui/commands.mjs";
import { suggestionLines } from "../src/tui/suggestions.mjs";

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

test("footer shows context-window usage as its share of the compaction budget", () => {
  const t = new MinimalTui({ model: "mock-model" });
  t.width = 100;
  t.height = 12;
  t.git = { branch: "main", dirty: false, dirtyCount: 0 };
  t.cwd = "/workspace/argus";
  t.history = [{ role: "user", content: "a".repeat(10_000) }];
  const original = process.env.ARGUS_COMPACT_AT;
  process.env.ARGUS_COMPACT_AT = "20000";
  try {
    const used = estimateChars(t.history);
    const budget = COMPACT_DEFAULTS.compactAtChars;
    const ratio = Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
    const f = strip(t.footer());
    assert.ok(
      f.includes(`${formatChars(used)} / ${formatChars(budget)} (${ratio}%)`),
      `context field shows chars / budget (percent): ${f}`,
    );
    assert.ok(f.includes("git main"), "git stays in the right-hand meta area");
  } finally {
    if (original === undefined) delete process.env.ARGUS_COMPACT_AT;
    else process.env.ARGUS_COMPACT_AT = original;
  }
});

test("header makes transcript scroll state visible", () => {
  const t = new MinimalTui({ model: "m" }, { sessionName: "work" });
  t.width = 60;
  t.scrollOffset = 12;
  const header = strip(t.header());
  assert.ok(header.includes("work"));
  assert.ok(header.includes("12 from latest") && header.includes("End"));
  assert.ok(header.length <= 60);
  t.width = 22;
  const narrow = strip(t.header());
  assert.ok(narrow.includes("↑12") && narrow.includes("End"), "narrow headers should still expose scroll state");
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
  t.runAction({ type: "wheel", dir: 1 });
  assert.ok(t.scrollOffset > 0);
  t.runAction({ type: "wheel", dir: -1 });
  t.runAction({ type: "wheel", dir: -1 });
  assert.equal(t.scrollOffset, 0);
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
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["/resume"]);

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
  assert.deepEqual(t.suggestion.items.map((i) => i.label), ["/status", "/sessions"]);
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
});

test("Tab never completes plain text without an @ or / token", () => {
  const t = new MinimalTui({ model: "m" });
  t.editor.buffer = "Review src/ag";
  t.editor.cursor = t.editor.buffer.length;
  t.insertText("\t");
  assert.equal(t.editor.buffer, "Review src/ag");
  assert.equal(t.suggestion, null);
});

test("bracketed multiline paste becomes one editor input", () => {
  const t = new MinimalTui({ model: "m" });
  let submits = 0;
  t.submit = () => submits++;
  t.onData(Buffer.from("\x1b[200~first\nsecond\r\nthird\x1b[201~"));
  assert.equal(t.editor.buffer, "first second third");
  assert.equal(submits, 0);
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
