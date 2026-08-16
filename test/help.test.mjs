import test from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, COMMAND_HELP, KEY_HELP, HELP_TEXT } from "../src/tui/help.mjs";

test("help: every slash command appears in the /help text", () => {
  assert.ok(SLASH_COMMANDS.length >= 9, "command table is populated");
  for (const c of SLASH_COMMANDS) {
    assert.ok(COMMAND_HELP.includes(c.name), `${c.name} listed in /help`);
  }
  assert.ok(COMMAND_HELP.includes("/resume <name>"), "resume shows its argument");
});

test("help: HELP_TEXT combines commands, keys, and transcript browsing", () => {
  assert.ok(HELP_TEXT.startsWith("## Local commands"));
  assert.ok(HELP_TEXT.includes("## Keyboard shortcuts"));
  assert.ok(HELP_TEXT.includes("Shift+Enter"));
  assert.ok(HELP_TEXT.includes("PgUp / PgDn or mouse wheel"));
});
