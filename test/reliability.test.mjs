import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/main.mjs";
import { runTurn } from "../src/agent.mjs";
import { getConfig, validateConfig } from "../src/config.mjs";
import { findTool } from "../src/tools.mjs";
import { createMockServer } from "./helpers/mock-llm.mjs";

const config = (srv, extra = {}) => ({
  baseUrl: `${srv.url}/`,
  apiKey: "",
  model: "mock",
  systemPrompt: "s",
  ...extra,
});

test("CLI consumes session names, joins prompt words, and rejects bad options", () => {
  assert.deepEqual(parseArgs(["--session", "work"]), {
    forceNew: false,
    name: "work",
    prompt: null,
    help: false,
  });
  assert.equal(parseArgs(["explain", "this", "repo"]).prompt, "explain this repo");
  assert.equal(parseArgs(["--new"]).forceNew, true);
  assert.throws(() => parseArgs(["--session"]), /requires a name/);
  assert.throws(() => parseArgs(["--session", "../bad"]), /invalid session/);
  assert.throws(() => parseArgs(["--wat"]), /unknown option/);
});

test("CLI executes through an npm-link-style symlink", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-linked-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const linked = join(dir, "argus");
  symlinkSync(fileURLToPath(new URL("../src/main.mjs", import.meta.url)), linked);
  const output = execFileSync(linked, ["--help"], { encoding: "utf8" });
  assert.match(output, /argus --new\s+start a fresh TUI session/);
});

test("ARGUS_SESSION_KEEP defaults to 0 and parses a non-negative limit", () => {
  const saved = process.env.ARGUS_SESSION_KEEP;
  try {
    delete process.env.ARGUS_SESSION_KEEP;
    assert.equal(getConfig().sessionKeep, 0, "0 means keep everything");
    process.env.ARGUS_SESSION_KEEP = "5";
    assert.equal(getConfig().sessionKeep, 5);
    process.env.ARGUS_SESSION_KEEP = "-1";
    assert.equal(getConfig().sessionKeep, 0, "negative values fall back to keep-all");
  } finally {
    if (saved === undefined) delete process.env.ARGUS_SESSION_KEEP;
    else process.env.ARGUS_SESSION_KEEP = saved;
  }
});

test("config rejects missing DashScope credentials and invalid URLs", () => {
  assert.throws(
    () => validateConfig({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "m", apiKey: "" }),
    /ARGUS_API_KEY/
  );
  assert.throws(() => validateConfig({ baseUrl: "not a URL", model: "m", apiKey: "x" }), /valid URL/);
  assert.doesNotThrow(() => validateConfig({ baseUrl: "http://localhost:11434/v1", model: "m", apiKey: "" }));
});

test("OPENAI_API_KEY is never forwarded to a non-OpenAI host", () => {
  const saved = {
    argusKey: process.env.ARGUS_API_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.ARGUS_BASE_URL,
  };
  try {
    delete process.env.ARGUS_API_KEY;
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.ARGUS_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    assert.equal(getConfig().apiKey, "");
    process.env.ARGUS_BASE_URL = "https://api.openai.com/v1";
    assert.equal(getConfig().apiKey, "openai-secret");
  } finally {
    for (const [name, value] of [
      ["ARGUS_API_KEY", saved.argusKey],
      ["OPENAI_API_KEY", saved.openaiKey],
      ["ARGUS_BASE_URL", saved.baseUrl],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("malformed tool arguments are returned as an error and never executed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-invalid-tool-"));
  const target = join(dir, "should-not-exist");
  let toolResult;
  const srv = await createMockServer((i, body) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: `{"command":"touch ${target}"` } }] }];
    }
    toolResult = JSON.parse(body.messages.at(-1).content);
    return [{ content: "recovered" }];
  });
  t.after(() => srv.close());
  const result = await runTurn(config(srv), [], "go");
  assert.equal(result.finalText, "recovered");
  assert.match(toolResult.message, /valid JSON/);
  assert.equal(existsSync(target), false);
});

test("truncated responses never execute partial tool calls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-truncated-tool-"));
  const target = join(dir, "should-not-exist");
  const srv = await createMockServer(() => [
    { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: `{"command":"touch ${target}"}` } }] },
    { finishReason: "length" },
  ]);
  t.after(() => srv.close());
  await assert.rejects(() => runTurn(config(srv), [], "go"), /truncated/);
  assert.equal(existsSync(target), false);
});

test("agent stops a runaway tool loop at the configured step limit", async (t) => {
  const srv = await createMockServer((i) => [
    { tool_calls: [{ index: 0, id: `c${i}`, function: { name: "bash", arguments: '{"command":"true"}' } }] },
  ]);
  t.after(() => srv.close());
  await assert.rejects(() => runTurn(config(srv, { maxSteps: 2 }), [], "loop"), /2 model steps/);
  assert.equal(srv.calls(), 2);
});

test("transient API failures retry, while request timeouts stay bounded", async (t) => {
  const retrySrv = await createMockServer((i) => {
    if (i === 0) throw new Error("temporary");
    return [{ content: "ok" }];
  });
  t.after(() => retrySrv.close());
  assert.equal((await runTurn(config(retrySrv, { maxRetries: 1 }), [], "retry")).finalText, "ok");
  assert.equal(retrySrv.calls(), 2);

  const slowSrv = await createMockServer(() => [{ delay: 200 }, { content: "late" }]);
  t.after(() => slowSrv.close());
  await assert.rejects(
    () => runTurn(config(slowSrv, { requestTimeoutMs: 20, maxRetries: 0 }), [], "timeout"),
    /timed out/
  );
});

test("edit refuses ambiguous replacements unless all=true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-edit-"));
  const write = findTool("write");
  const edit = findTool("edit");
  const read = findTool("read");
  await write.execute({ path: "a.txt", content: "x x" }, { cwd: dir });
  const ambiguous = await edit.execute({ path: "a.txt", old: "x", new: "y" }, { cwd: dir });
  assert.equal(ambiguous.error, true);
  assert.match(ambiguous.message, /occurs 2 times/);
  await edit.execute({ path: "a.txt", old: "x", new: "y", all: true }, { cwd: dir });
  assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).content, "y y");
});

test("write requires an explicit opt-in to overwrite an existing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-write-"));
  const write = findTool("write");
  const read = findTool("read");
  await write.execute({ path: "a.txt", content: "original" }, { cwd: dir });
  const protectedWrite = await write.execute({ path: "a.txt", content: "replacement" }, { cwd: dir });
  assert.equal(protectedWrite.error, true);
  assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).content, "original");
  await write.execute({ path: "a.txt", content: "replacement", overwrite: true }, { cwd: dir });
  assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).content, "replacement");
});

test("bash persists the shell's real cwd for quoted and compound cd commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-cwd-"));
  const child = join(dir, "dir with spaces");
  await findTool("bash").execute({ command: 'mkdir "dir with spaces"' }, { cwd: dir });
  const result = await findTool("bash").execute({ command: 'cd "dir with spaces" && pwd' }, { cwd: dir });
  assert.equal(result.cwd, result.stdout.trim());
  assert.ok(result.cwd.endsWith("/dir with spaces"));
});

test("oversized tool results are bounded before the next model request", async (t) => {
  let sentResult = null;
  const command = `node -e ${JSON.stringify("process.stdout.write('x'.repeat(2000))")}`;
  const srv = await createMockServer((i, body) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }];
    }
    sentResult = body.messages.at(-1).content;
    return [{ content: "ok" }];
  });
  t.after(() => srv.close());
  await runTurn(config(srv, { maxToolResultChars: 500 }), [], "large output");
  assert.ok(sentResult.length <= 500);
  assert.equal(JSON.parse(sentResult).truncated, true);
});
