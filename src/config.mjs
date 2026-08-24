/**
 * Runtime configuration, read from environment variables (and `.env`).
 *
 * Defaults target Alibaba Cloud DashScope (the model server for our default
 * model), but anything that speaks the OpenAI "chat completions" protocol
 * works (e.g. Ollama, LM Studio, vLLM, LiteLLM).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root directory for argus state (sessions, the home config file). Resolved
 * lazily so an `ARGUS_HOME` set by an earlier-loaded `.env` is honored.
 */
export function argusHome() {
  return process.env.ARGUS_HOME || join(homedir(), ".argus");
}

/**
 * Load global defaults from $ARGUS_HOME/.env (or ~/.argus/.env) if present —
 * the same variables and format as the project `.env`. Node's env-file loader
 * never overrides a variable that is already set, so calling this AFTER the
 * project `.env` yields the precedence: process env > project `.env` >
 * home `.env` > built-in defaults.
 */
export function loadHomeEnv() {
  try {
    process.loadEnvFile(join(argusHome(), ".env"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function positiveInt(value, fallback, minimum = 1) {
  const n = Number(value);
  return Number.isInteger(n) && n >= minimum ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function getConfig() {
  const baseUrl = (process.env.ARGUS_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // validateConfig reports the useful error after the config is assembled.
  }
  return {
    // Base URL of the chat completions endpoint, without the trailing path.
    baseUrl,
    // Never send an OpenAI credential to a custom provider by accident.
    // Local servers can leave this empty; other providers use ARGUS_API_KEY.
    apiKey:
      process.env.ARGUS_API_KEY ??
      (hostname === "api.openai.com" ? process.env.OPENAI_API_KEY : "") ??
      "",
    // Model identifier understood by the endpoint.
    model: process.env.ARGUS_MODEL ?? "deepseek-v4-flash-0731",
    // Bound network stalls and runaway tool-call loops. Reasoning models can
    // think for a long time before the first byte arrives and between chunks,
    // so both defaults are deliberately generous; tune down for local models.
    requestTimeoutMs: positiveInt(process.env.ARGUS_REQUEST_TIMEOUT_MS, 600_000, 100),
    // For streaming, the idle timeout resets on each chunk received.
    streamIdleTimeoutMs: positiveInt(process.env.ARGUS_STREAM_IDLE_TIMEOUT_MS, 300_000, 100),
    maxRetries: nonNegativeInt(process.env.ARGUS_MAX_RETRIES, 2),
    maxSteps: positiveInt(process.env.ARGUS_MAX_STEPS, 100),
    maxToolResultChars: positiveInt(process.env.ARGUS_MAX_TOOL_RESULT_CHARS, 50_000, 500),
    // Bound cumulative tool output inside one active turn; next-turn
    // compaction cannot help until that turn finishes.
    maxTurnToolResultChars: positiveInt(process.env.ARGUS_MAX_TURN_TOOL_RESULT_CHARS, 400_000, 1_000),
    // Keep only the N most recent saved sessions (the active one is never
    // pruned); 0 keeps everything. Pruning runs on TUI startup.
    sessionKeep: nonNegativeInt(process.env.ARGUS_SESSION_KEEP, 0),
    // Optional system prompt that shapes the agent's behaviour.
    systemPrompt:
      process.env.ARGUS_SYSTEM_PROMPT ??
      "Your name is Argus. You are a careful coding agent. Before changing a " +
        "repository, read and follow its instruction files (for example AGENTS.md). " +
        "Inspect relevant files before editing; treat @path mentions as file " +
        "references: read them before relying on their contents. Make small focused " +
        "changes, preserve unrelated user work, run relevant checks, and report " +
        "results honestly. Prefer tools over guessing. Keep answers concise.",
  };
}

/** Fail early with a useful message instead of deep inside fetch. */
export function validateConfig(config) {
  if (!String(config.model ?? "").trim()) throw new Error("ARGUS_MODEL must not be empty");
  let url;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error(`ARGUS_BASE_URL is not a valid URL: ${config.baseUrl}`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`ARGUS_BASE_URL must use http or https: ${config.baseUrl}`);
  }
  if (url.hostname.endsWith("aliyuncs.com") && (!config.apiKey || config.apiKey === "sk-your-key-here")) {
    throw new Error("ARGUS_API_KEY is required for the configured Alibaba Cloud endpoint; set it in .env or your environment");
  }
  return config;
}
