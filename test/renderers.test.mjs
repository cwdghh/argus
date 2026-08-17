import test from "node:test";
import assert from "node:assert/strict";
import { markdownLines } from "../src/tui/markdown.mjs";
import { stripAnsi, dispWidth, charWidth } from "../src/tui/renderers.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (md, width = 80) => markdownLines(md, width).map(strip);

test("markdown table renders as an aligned box-drawing table", () => {
  const md =
    "| Tool | Purpose |\n" +
    "|------|---------|\n" +
    "| `read` | Read a file |\n" +
    "| edit | One more |";
  const out = render(md);
  assert.ok(out[0].startsWith("┌─"), "top border");
  assert.ok(out.at(-1).startsWith("└─"), "bottom border");
  assert.ok(out.some((l) => l.includes("│ Tool")), "header row");
  assert.ok(out.some((l) => l.includes("│ read")), "body row with inline code");
  for (const line of out) assert.ok(stripAnsi(line).length <= 80, "line respects width");
});

test("table without leading pipes honours delimiter alignment", () => {
  const md = "Tool | Purpose\n:---:|---:\nread | Read";
  const out = render(md, 40);
  assert.ok(out.some((l) => l.includes("│ Tool")), "header row");
  assert.ok(out.some((l) => l.includes("│ read")), "body row");
});

test("a table that cannot fit falls back to plain text instead of corrupting", () => {
  const md = "| Tool | Purpose |\n|------|---------|\n| read | a b c |";
  const out = render(md, 12);
  assert.ok(out.some((l) => l.includes("| Tool |") || l.includes("│")), "raw or boxed output");
});

test("a table is followed by normal markdown again", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |\n\n## After";
  const out = render(md);
  assert.ok(out[out.length - 1].includes("After"), "heading after the table");
});

test("pipes in prose are not mistaken for a table", () => {
  const out = render("Use `a | b` inline.", 40);
  assert.ok(out[0].includes("a | b"), "inline code keeps its pipe");
});

test("charWidth: CJK and fullwidth characters are two columns", () => {
  assert.equal(charWidth("中"), 2);
  assert.equal(charWidth("A"), 1);
  assert.equal(dispWidth("中文"), 4);
  assert.equal(dispWidth("a中文b"), 6);
  assert.equal(dispWidth("ＡＢ"), 4);
  assert.equal(dispWidth("ab"), 2);
});

test("charWidth: emoji are two columns and joiners are zero width", () => {
  assert.equal(dispWidth("🚀"), 2); // transport emoji block (1F680)
  assert.equal(dispWidth("👋"), 2);
  assert.equal(dispWidth("👍🏽"), 2); // skin tone modifier counts 0
  assert.equal(dispWidth("👨\u200D👩\u200D👧"), 6); // ZWJ joins three emoji
  assert.equal(dispWidth("🇨🇳"), 2); // flag = two regional indicators
  assert.equal(dispWidth("⌚"), 2); // BMP emoji
  assert.equal(dispWidth("❤️"), 1); // heart + VS16 (0)
});

test("tables keep borders aligned with CJK and emoji cells", () => {
  const md = [
    "| Name | Value |",
    "|------|-------|",
    "| 中文 | 🚀 快 |",
    "| ab   | ✅ ok  |",
    "| 👨\u200D👩\u200D👧 | 3人   |",
  ].join("\n");
  const out = render(md, 40);
  const widths = out.map((l) => dispWidth(l));
  assert.ok(widths.length > 0);
  assert.ok(widths.every((w) => w === widths[0]), `every line is ${widths[0]} display columns`);
});
