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
 * its history first) and the working directory is persisted there.
 */
import { runTurn } from "./agent.mjs";
import { loadSession } from "./session.mjs";

function summarize(result) {
  if (!result) return "";
  if (result.error) return result.message ?? "error";
  if (result.stdout != null) {
    const first = String(result.stdout).trim().split("\n")[0];
    return first ? `stdout: ${first.slice(0, 80)}${first.length > 80 ? "…" : ""}` : "ok (no output)";
  }
  return JSON.stringify(result).slice(0, 80);
}

export async function runHeadless(config, prompt, { session, cwd } = {}) {
  const writeOut = (s) => process.stdout.write(s);
  const writeErr = (s) => process.stderr.write(s);

  // Resume session history if one is given.
  let history = [];
  if (session) {
    const loaded = await loadSession(session.name);
    for (const turn of loaded?.turns ?? []) history.push(...(turn.messages ?? []));
  }

  // Build display blocks alongside events (mirrors the TUI) so a turn saved to
  // a session reconstructs the transcript.
  const blocks = [];
  const append = (kind, delta) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.text += delta;
    else blocks.push({ kind, text: delta });
  };
  const push = (b) => blocks.push(b);

  let sawText = false;
  let result;
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
        }
      },
      { cwd: cwd ?? process.cwd() }
    );
  } catch (err) {
    push({ kind: "error", text: err.message });
    writeErr(`\nerror: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (sawText || result.aborted) writeOut("\n");

  if (session) {
    try {
      await session.setCwd(result.cwd);
    } catch {
      /* non-fatal */
    }
    await session.appendTurn({
      config: { baseUrl: config.baseUrl, model: config.model, systemPrompt: config.systemPrompt },
      messages: result.messages,
      blocks,
    });
  }

  process.exitCode = result.aborted ? 130 : 0;
}
