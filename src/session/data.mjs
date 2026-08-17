/**
 * Turn/session data shapes shared by every frontend.
 *
 * `sessionData` rebuilds the on-screen transcript and exact model history
 * from a session's raw turns; `sessionConfig` picks the safe, credential-
 * free config subset to persist with each turn. Pure functions with one
 * home each, so the TUI and headless mode can never drift apart.
 */
export function sessionData(data) {
  const blocks = [];
  const history = [];
  for (const turn of data?.turns ?? []) {
    if (Array.isArray(turn.blocks)) blocks.push(...turn.blocks);
    if (Array.isArray(turn.messages)) history.push(...turn.messages);
  }
  return { blocks, history, cwd: data?.meta?.cwd ?? null, model: data?.meta?.model ?? null };
}

/**
 * The config subset persisted alongside a turn. The API key and stream-only
 * knobs are intentionally excluded so sessions never leak credentials, and one
 * copy of the shape keeps the TUI and headless persistence consistent.
 */
export function sessionConfig(config) {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    systemPrompt: config.systemPrompt,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    maxSteps: config.maxSteps,
    maxToolResultChars: config.maxToolResultChars,
  };
}

