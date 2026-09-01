import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
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

test("headless CLI runs end to end against an OpenAI-compatible stream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-cli-smoke-"));
  const srv = await createMockServer(() => [{ content: "cli smoke ok" }]);
  t.after(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const entry = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, "say hello"], {
    cwd: dir,
    env: {
      ...process.env,
      ARGUS_HOME: join(dir, "home"),
      ARGUS_BASE_URL: srv.url,
      ARGUS_API_KEY: "",
      ARGUS_MODEL: "mock",
      ARGUS_MAX_RETRIES: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
  assert.equal(stdout, "cli smoke ok\n");
  assert.match(stderr, /❯ say hello/);
});

test("an idle timeout tears down the underlying stream connection", async (t) => {
  // A server that starts streaming then goes silent forever. The client's idle
  // timeout must cancel its pending reader; otherwise the connection (and the
  // server-side event handler) stays open for as long as the server keeps the
  // stream alive — a leaked body reader.
  let clientClosed = false;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`);
    req.on("close", () => {
      clientClosed = true;
    });
    // never end the response
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;

  await assert.rejects(
    runTurn(
      { baseUrl, apiKey: "", model: "m", systemPrompt: "s", streamIdleTimeoutMs: 60 },
      [],
      "hi",
      () => {},
      {},
    ),
    /idle timeout/,
  );
  const deadline = Date.now() + 3000;
  while (!clientClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(clientClosed, "reader.cancel() tore the body down so the server saw the connection close");
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

test("default timeouts are generous for reasoning models", () => {
  const savedRequest = process.env.ARGUS_REQUEST_TIMEOUT_MS;
  const savedIdle = process.env.ARGUS_STREAM_IDLE_TIMEOUT_MS;
  try {
    delete process.env.ARGUS_REQUEST_TIMEOUT_MS;
    delete process.env.ARGUS_STREAM_IDLE_TIMEOUT_MS;
    assert.equal(getConfig().requestTimeoutMs, 600_000, "10 min before first byte");
    assert.equal(getConfig().streamIdleTimeoutMs, 300_000, "5 min idle between chunks");
    process.env.ARGUS_REQUEST_TIMEOUT_MS = "120000";
    process.env.ARGUS_STREAM_IDLE_TIMEOUT_MS = "45000";
    assert.equal(getConfig().requestTimeoutMs, 120_000);
    assert.equal(getConfig().streamIdleTimeoutMs, 45_000);
  } finally {
    for (const [key, saved] of [["ARGUS_REQUEST_TIMEOUT_MS", savedRequest], ["ARGUS_STREAM_IDLE_TIMEOUT_MS", savedIdle]]) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
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
  await write.execute({ path: "a.txt", content: "x x", ensureFinalNewline: false }, { cwd: dir });
  const ambiguous = await edit.execute({ path: "a.txt", edits: [{ old: "x", new: "y" }] }, { cwd: dir });
  assert.equal(ambiguous.error, true);
  assert.match(ambiguous.message, /occurs 2 times/);
  await edit.execute({ path: "a.txt", edits: [{ old: "x", new: "y" }], all: true }, { cwd: dir });
  assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).numberedText, "1 │ y y");
});

test("write requires an explicit opt-in to overwrite an existing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-write-"));
  const write = findTool("write");
  const read = findTool("read");
  await write.execute({ path: "a.txt", content: "original", ensureFinalNewline: false }, { cwd: dir });
  const protectedWrite = await write.execute({ path: "a.txt", content: "replacement", ensureFinalNewline: false }, { cwd: dir });
  assert.equal(protectedWrite.error, true);
  assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).numberedText, "1 │ original");
  await write.execute({ path: "a.txt", content: "replacement", ensureFinalNewline: false, overwrite: true }, { cwd: dir });
  assert.equal((await read.execute({ path: "a.txt" }, { cwd: dir })).numberedText, "1 │ replacement");
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
