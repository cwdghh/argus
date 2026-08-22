/**
 * Headless one-shot mode: run a single prompt without the TUI.
 *
 *   node src/main.mjs "your prompt" [--session name]
 *
 * Separation of streams:
 *   - assistant text        -> stdout (clean, pipable)
 *   - reasoning / errors    -> stderr (so stdout stays useful when piped)
 *   - tool calls + results  -> stderr
 *
 * If a --session name is given, the turn is appended to that session (resuming
 * its history first) and the working directory is persisted there — even when
 * the turn errors, so the error block is preserved.
 */
import { runTurn } from "./agent.mjs";
import { nextContextTokens } from "./compact.mjs";
import { loadSession, sessionConfig, sessionData } from "./session/index.mjs";
import { formatDuration, summarize } from "./format.mjs";
import { appendBlock } from "./transcript.mjs";

export async function runHeadless(config, prompt, { session, cwd, stdout, stderr } = {}) {
  // Streams are injectable so tests can capture output without monkeypatching.
  const writeOut = stdout || ((s) => process.stdout.write(s));
  const writeErr = stderr || ((s) => process.stderr.write(s));

  // Resume session history if one is given.
  let history = [];
  let activeCwd = cwd ?? process.cwd();
  // Real tokens of the context this turn will re-send, from the last
  // persisted turn's usage (null -> the char safety net applies).
  let lastUsage = null;
  if (session) {
    const loaded = await loadSession(session.name);
    const { history: saved, cwd: savedCwd, model, blocks: savedBlocks } = sessionData(loaded);
    history = saved;
    activeCwd = cwd ?? savedCwd ?? process.cwd();
    if (savedCwd) session.lastCwd = savedCwd;
    // Honor a persisted per-session model override (e.g. set by /model).
    if (model) config = { ...config, model };
    lastUsage = [...savedBlocks].reverse().find((block) => block.kind === "timing")?.usage ?? null;
  }

  // Build display blocks alongside events (mirrors the TUI) so a turn saved to
  // a session reconstructs the transcript.
  const blocks = [];
  const append = (kind, delta) => appendBlock(blocks, kind, delta);
  const push = (b) => blocks.push(b);

  let sawText = false;
  let result = null;
  let error = null;
  const startedAt = Date.now();
  try {
    result = await runTurn(
      config,
      history,
      prompt,
      (ev) => {
        if (ev.type === "user") {
          push({ kind: "user", text: ev.text });
          writeErr(`❯ ${ev.text}\n`);
        } else if (ev.type === "thinking_delta") {
          append("thinking", ev.delta);
          writeErr(`… ${ev.delta}`);
        } else if (ev.type === "text_delta") {
          append("assistant", ev.delta);
          writeOut(ev.delta);
          sawText = true;
        } else if (ev.type === "tool_call") {
          push({ kind: "tool", name: ev.name, args: ev.args });
          writeErr(`⚙ ${ev.name}(${JSON.stringify(ev.args ?? {})})\n`);
        } else if (ev.type === "tool_result") {
          push({ kind: "result", ok: ev.ok, summary: summarize(ev.result) });
          writeErr(`   ${ev.ok ? "✓" : "✗"} ${summarize(ev.result)}\n`);
        } else if (ev.type === "compacted") {
          writeErr("… earlier context compacted\n");
        }
      },
      { cwd: activeCwd, lastTokens: nextContextTokens(lastUsage) }
    );
  } catch (err) {
    error = err;
    push({ kind: "error", text: err.message });
    writeErr(`\nerror: ${err.message}\n`);
  }

  // Persist the turn (including error blocks) regardless of outcome. A timing
  // block carries the real provider usage so later headless/TUI runs on this
  // session can drive compaction from real tokens.
  if (session) {
    const finalCwd = result?.cwd ?? error?.cwd;
    if (finalCwd) {
      try {
        await session.setCwd(finalCwd);
      } catch {
        /* non-fatal */
      }
    }
    const outcome = error ? "failed" : result?.aborted ? "interrupted" : "completed";
    blocks.push({
      kind: "timing",
      summary: `${outcome} in ${formatDuration(Date.now() - startedAt)}`,
      durationMs: Date.now() - startedAt,
      usage: result?.usage ?? error?.usage ?? null,
    });
    await session.appendTurn({
      config: sessionConfig(config),
      messages: result?.messages ?? error?.turnMessages ?? [{ role: "user", content: prompt }],
      blocks,
    });
  }

  if (error) {
    process.exitCode = 1;
    return;
  }
  if (sawText || result.aborted) writeOut("\n");
  process.exitCode = result.aborted ? 130 : 0;
}
