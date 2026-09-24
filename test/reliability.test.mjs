import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

  const result = await runTurn(
    { baseUrl, apiKey: "", model: "m", systemPrompt: "s", streamIdleTimeoutMs: 60 },
    [],
    "hi",
    () => {},
    {},
  );
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /idle timeout/);
  assert.equal(result.partial.text, "a");
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

test("truncated responses mark the turn truncated and never execute partial tool calls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-truncated-tool-"));
  const target = join(dir, "should-not-exist");
  const srv = await createMockServer(() => [
    { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: `{"command":"touch ${target}"}` } }] },
    { finishReason: "length" },
  ]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv), [], "go");
  assert.equal(result.outcome, "truncated", "the truncation is reported, not thrown away");
  assert.equal(result.reason, "model_length");
  assert.equal(existsSync(target), false, "the un-executed tool call never ran");
  const erred = result.messages.filter((m) => m.role === "tool");
  assert.equal(erred.length, 1);
  assert.match(JSON.parse(erred[0].content).message, /never ran/);
  const assistant = result.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.truncated, true, "the persisted assistant message carries the flag");
});

test("agent stops a runaway tool loop at the configured step limit", async (t) => {
  const srv = await createMockServer((i) => [
    { tool_calls: [{ index: 0, id: `c${i}`, function: { name: "bash", arguments: '{"command":"true"}' } }] },
  ]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv, { maxSteps: 2 }), [], "loop");
  assert.equal(result.outcome, "limited");
  assert.match(result.message, /2 model steps/);
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
  const timedOut = await runTurn(config(slowSrv, { requestTimeoutMs: 20, maxRetries: 0 }), [], "timeout");
  assert.equal(timedOut.outcome, "failed");
  assert.match(timedOut.message, /timed out/);
});

test("a mid-stream idle timeout retries the step before any text is shown", async (t) => {
  // First attempt: the SSE body opens (a flush-only keepalive comment, so the
  // response headers arrive) and then goes quiet past the idle timeout — a
  // pristine failure (no visible text forwarded) that the loop-level retry may
  // re-run. The second attempt streams normally.
  let calls = 0;
  const finish = (res) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const srv = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls === 1) {
      res.write(": keepalive\n\n");
      setTimeout(() => finish(res), 1_000); // far past the 60ms idle timeout
    } else {
      finish(res);
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  const result = await runTurn(
    { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "", model: "m", systemPrompt: "s", streamIdleTimeoutMs: 60, maxRetries: 1 },
    [],
    "hi",
    () => {},
    {},
  );
  assert.equal(result.finalText, "ok");
  assert.equal(calls, 2, "the step was retried once after the idle timeout");
});

test("a step that already streamed text is never retried (no duplicated output)", async (t) => {
  // The first attempt shows "par", then the idle timeout hits. Re-running the
  // step would echo "par" into the transcript again, so it must fail instead.
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`);
    // never end -> the idle timeout fires after the partial text
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  const result = await runTurn(
    { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "", model: "m", systemPrompt: "s", streamIdleTimeoutMs: 60, maxRetries: 1 },
    [],
    "hi",
    () => {},
    {},
  );
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /idle timeout/);
  assert.equal(result.partial.text, "par");
  assert.equal(result.requestUsage.attempts[0].usage.total_tokens, 12);
  assert.equal(result.requestUsage.totals.complete, true);
  assert.equal(calls, 1, "a content-carrying attempt is not retried");
});

test("the payload cap stops a request larger than ARGUS_MAX_REQUEST_CHARS", async (t) => {
  const srv = await createMockServer(() => [{ content: "ok" }]);
  t.after(() => srv.close());
  const result = await runTurn(config(srv, { maxRequestChars: 10 }), [], "x".repeat(200));
  assert.equal(result.outcome, "limited");
  assert.equal(result.reason, "request_size_limit");
  assert.match(result.message, /exceeds the 10-character context safety limit/);
});

test("a request that exhausts its retry budget is not multiplied by the step retry", async (t) => {
  const srv = await createMockServer(() => ({ status: 500, body: { error: { message: "boom" } } }));
  t.after(() => srv.close());
  const result = await runTurn(config(srv, { maxRetries: 2 }), [], "boom");
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /LLM request failed \(500\)/);
  assert.equal(result.requestUsage.attempts.length, 3);
  assert.equal(result.requestUsage.totals.complete, false);
  assert.equal(srv.calls(), 3, "only the in-request budget is spent (1 + maxRetries); a step retry must not stack on top");
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

test("oversized tool results keep the tail and spill the full output", async (t) => {
  const originalHome = process.env.ARGUS_HOME;
  const spillHome = mkdtempSync(join(tmpdir(), "argus-spill-home-"));
  process.env.ARGUS_HOME = spillHome;
  let sentResult = null;
  const command = `node -e ${JSON.stringify("process.stdout.write('x'.repeat(1990) + 'TAIL-END')")}`;
  const srv = await createMockServer((i, body) => {
    if (i === 0) {
      return [{ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }];
    }
    sentResult = body.messages.at(-1).content;
    return [{ content: "ok" }];
  });
  t.after(async () => {
    await srv.close();
    rmSync(spillHome, { recursive: true, force: true });
    process.env.ARGUS_HOME = originalHome;
  });
  await runTurn(config(srv, { maxToolResultChars: 700 }), [], "large output");
  assert.ok(sentResult.length <= 700);
  const bounded = JSON.parse(sentResult);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.preview.includes("TAIL-END"), "the preview keeps the tail, where a failure shows up");
  assert.ok(bounded.fullPath && existsSync(bounded.fullPath), "the full output is spilled to a tmp file with a path");
  assert.ok(readFileSync(bounded.fullPath, "utf8").includes("TAIL-END"), "the spill holds the complete output");
});
