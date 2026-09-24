/**
 * Turn/session data shapes shared by every frontend.
 *
 * `sessionData` rebuilds the on-screen transcript and exact model history
 * from a session's raw turns; `sessionConfig` picks the safe, credential-
 * free config subset to persist with each turn. Pure functions with one
 * home each, so the TUI and headless mode can never drift apart. Recovery
 * warnings from damaged JSONL records travel with the reconstructed data.
 */
export function sessionData(data) {
  const blocks = [];
  const history = [];
  for (const turn of data?.turns ?? []) {
    if (Array.isArray(turn.blocks)) blocks.push(...turn.blocks);
    if (Array.isArray(turn.messages)) history.push(...turn.messages);
  }
  return {
    blocks,
    history,
    cwd: data?.meta?.cwd ?? null,
    model: data?.meta?.model ?? null,
    warnings: Array.isArray(data?.meta?.warnings) ? data.meta.warnings : [],
  };
}

/**
 * The config payload of a `{type:"config"}` session record, written once per
 * distinct value (never per turn). systemPrompt is the heavy field — 10KB ×
 * hundreds of turns re-parsed on every load — so it lives here, not inside
 * every turn. The API key and stream-only knobs are intentionally excluded so
 * sessions never leak credentials; the model is deliberately absent too (it
 * has its own deduped `{type:"model"}` record and changes mid-session).
 */
export function configRecord(config = {}) {
  return {
    baseUrl: config.baseUrl ?? null,
    systemPrompt: config.systemPrompt ?? null,
    requestTimeoutMs: config.requestTimeoutMs ?? null,
    maxRetries: config.maxRetries ?? null,
    maxSteps: config.maxSteps ?? null,
    maxToolResultChars: config.maxToolResultChars ?? null,
    maxTurnToolResultChars: config.maxTurnToolResultChars ?? null,
  };
}

/**
 * The config subset persisted alongside a turn: only the model, the one knob
 * that actually differs between turns and is needed to reconstruct what the
 * model saw. Everything else is session-static and lives once in the session's
 * `{type:"config"}` record (written by `Session#setConfig`).
 */
export function sessionConfig(config) {
  return { model: config.model };
}
