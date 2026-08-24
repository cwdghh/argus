// Config sources: process env > project .env > ~/.argus/.env > defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, validateConfig, argusHome, loadHomeEnv } from "../src/config.mjs";

// Every test file runs in its own process under `node --test`, but keep the
// shared environment tidy anyway.
const SAVED = new Map();
for (const key of ["ARGUS_HOME", "ARGUS_MODEL", "ARGUS_API_KEY", "ARGUS_BASE_URL", "ARGUS_SYSTEM_PROMPT"]) {
  SAVED.set(key, process.env[key]);
}
function restoreEnv() {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "argus-config-test-"));
  process.env.ARGUS_HOME = dir;
  return dir;
}

test("argusHome defaults to ~/.argus and honors ARGUS_HOME", () => {
  const saved = process.env.ARGUS_HOME;
  try {
    delete process.env.ARGUS_HOME;
    assert.equal(argusHome(), join(homedir(), ".argus"));
    process.env.ARGUS_HOME = "/tmp/argus-custom";
    assert.equal(argusHome(), "/tmp/argus-custom");
  } finally {
    process.env.ARGUS_HOME = saved;
  }
});

test("loadHomeEnv() applies ~/.argus/.env values that nothing else set", () => {
  const dir = tempHome();
  try {
    delete process.env.ARGUS_MODEL;
    writeFileSync(join(dir, ".env"), "ARGUS_MODEL=from-home\n");
    loadHomeEnv();
    assert.equal(getConfig().model, "from-home");
  } finally {
    restoreEnv();
  }
});

test("loadHomeEnv() tolerates a missing home .env", () => {
  tempHome(); // no .env written
  try {
    assert.doesNotThrow(() => loadHomeEnv());
  } finally {
    restoreEnv();
  }
});

test("process env wins over the home .env", () => {
  const dir = tempHome();
  try {
    process.env.ARGUS_MODEL = "from-process";
    writeFileSync(join(dir, ".env"), "ARGUS_MODEL=from-home\n");
    loadHomeEnv();
    assert.equal(process.env.ARGUS_MODEL, "from-process");
    assert.equal(getConfig().model, "from-process");
  } finally {
    restoreEnv();
  }
});

test("a project .env (loaded first) beats the home .env", () => {
  const dir = tempHome();
  try {
    process.env.ARGUS_MODEL = "from-project"; // as if the project .env loaded earlier
    writeFileSync(join(dir, ".env"), "ARGUS_MODEL=from-home\n");
    loadHomeEnv();
    assert.equal(process.env.ARGUS_MODEL, "from-project");
  } finally {
    restoreEnv();
  }
});

test("default system prompt names the agent Argus", () => {
  delete process.env.ARGUS_SYSTEM_PROMPT;
  const prompt = getConfig().systemPrompt;
  assert.match(prompt, /Your name is Argus\./);
});

test("home .env supports double-quoted multiline values", () => {
  const dir = tempHome();
  try {
    delete process.env.ARGUS_SYSTEM_PROMPT;
    writeFileSync(join(dir, ".env"), 'ARGUS_SYSTEM_PROMPT="line one\nline two"\n');
    loadHomeEnv();
    assert.equal(process.env.ARGUS_SYSTEM_PROMPT, "line one\nline two");
  } finally {
    restoreEnv();
  }
});

test("home .env can supply the API key for a DashScope base URL", () => {
  const dir = tempHome();
  try {
    process.env.ARGUS_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    delete process.env.ARGUS_API_KEY;
    writeFileSync(join(dir, ".env"), "ARGUS_API_KEY=sk-home-key\n");
    loadHomeEnv();
    assert.equal(getConfig().apiKey, "sk-home-key");
    assert.doesNotThrow(() => validateConfig(getConfig()));
  } finally {
    restoreEnv();
  }
});
