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
import { formatDuration, summarize, toolLabel } from "./format.mjs";
import { consumeAgentEvent } from "./transcript.mjs";
import { summarizeEvidence } from "./agent/evidence.mjs";

export async function runHeadless(config, prompt, { session, cwd, stdout, stderr, continueRun = false, resolution = null, checkCommands = [] } = {}) {
  const controller = new AbortController();
  const termination = { signal: controller.signal, requested: false };
  let forceTimer = null;
  const onSigterm = () => {
    termination.requested = true;
    controller.abort();
    forceTimer = setTimeout(() => process.exit(143), 4_000);
  };
  process.once("SIGTERM", onSigterm);
  try {
    return await runHeadlessOnce(config, prompt, { session, cwd, stdout, stderr, continueRun, resolution,
      checkCommands, termination });
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    clearTimeout(forceTimer);
  }
}

async function runHeadlessOnce(config, prompt, { session, cwd, stdout, stderr, continueRun, resolution, checkCommands, termination }) {
  // Streams are injectable so tests can capture output without monkeypatching.
  const writeOut = stdout || ((s) => process.stdout.write(s));
  const writeErr = stderr || ((s) => process.stderr.write(s));

  // Resume session history if one is given.
  let history = [];
  let historyTurnSizes = [];
  let contextRevision = null;
  let activeCwd = cwd ?? process.cwd();
  // Real tokens of the context this turn will re-send, from the last
  // persisted turn's usage (null -> the char safety net applies).
  let lastUsage = null;
  let parentRunId = null;
  if (session) {
    const loaded = await loadSession(session.name);
    const { history: saved, turnSizes, contextRevision: savedRevision, cwd: savedCwd, model, blocks: savedBlocks, warnings } = sessionData(loaded);
    history = saved;
    historyTurnSizes = turnSizes;
    contextRevision = savedRevision;
    activeCwd = cwd ?? savedCwd ?? process.cwd();
    if (savedCwd) session.lastCwd = savedCwd;
    if (loaded?.meta?.toolSurfaceHash) session.lastToolSurfaceHash = loaded.meta.toolSurfaceHash;
    if (loaded?.meta?.sessionId) {
      session.sessionId = loaded.meta.sessionId;
      session.sessionIdWritten = true;
    }
    // Honor a persisted per-session model override (e.g. set by /model).
    if (model) config = { ...config, model };
    lastUsage = [...savedBlocks].reverse().find((block) => block.kind === "timing")?.usage ?? null;
    for (const warning of warnings) writeErr(`warning: ${warning}\n`);
    const recovered = [...(loaded?.meta?.unfinishedRuns ?? [])].reverse().find((run) => run.resolution !== "continued");
    const timing = [...savedBlocks].reverse().find((block) => block.kind === "timing");
    const target = recovered ?? (timing?.outcome && timing.outcome !== "completed" ? { runId: timing.runId } : null);
    if (continueRun) {
      if (!target?.runId) throw new Error("no unfinished run to continue in this session");
      if (target.uncertainCalls?.length && !target.resolution && !resolution) {
        throw new Error(`run ${target.runId} has uncertain tool effects; inspect them, then pass --resolve retry or abandon`);
      }
      if (resolution) {
        if (!target.uncertainCalls?.length) throw new Error("--resolve applies only to an uncertain tool attempt");
        await session.resolveRun(target.runId, resolution);
      }
      parentRunId = target.runId;
      const decision = resolution ?? target.resolution;
      const note = decision === "retry" ? " The user chose retry; inspect existing effects before repeating anything."
        : decision === "abandon" ? " The user chose abandon; do not repeat the uncertain attempt." : "";
      prompt = `Continue the previous task from recorded progress. Inspect the current workspace and do not repeat completed tool actions.${note}${prompt ? ` ${prompt}` : ""}`;
    } else if (recovered?.uncertainCalls?.length && !recovered.resolution) {
      throw new Error(`run ${recovered.runId} has uncertain tool effects; inspect them before starting another task`);
    }
  } else if (continueRun) {
    throw new Error("continuation requires a named session");
  }

  // Build display blocks alongside events (mirrors the TUI) so a turn saved to
  // a session reconstructs the transcript.
  const blocks = [];
  const push = (b) => blocks.push(b);

  let sawText = false;
  let result = null;
  let error = null;
  let journalRunId = null;
  const startedAt = Date.now();
  try {
    result = await runTurn(
      config,
      history,
      prompt,
      (ev) => {
        // Blocks are projected by the same consumeAgentEvent the TUI uses, so
        // a session's transcript never depends on which frontend wrote it
        // The stdout/stderr lines are this frontend's stream split.
        consumeAgentEvent(blocks, ev);
        if (ev.type === "user") {
          push({ kind: "user", text: ev.text });
          writeErr(`❯ ${ev.text}\n`);
        } else if (ev.type === "thinking_delta") {
          writeErr(`… ${ev.delta}`);
        } else if (ev.type === "text_delta") {
          writeOut(ev.delta);
          sawText = true;
        } else if (ev.type === "tool_call") {
          writeErr(`⚙ ${toolLabel(ev.name, ev.args)}\n`);
        } else if (ev.type === "tool_result") {
          writeErr(`   ${ev.ok ? "✓" : "✗"} ${summarize(ev.result)}\n`);
        } else if (ev.type === "approval") {
          if (ev.approved) writeErr(`   ✓ approved ${ev.tool} in ${ev.cwd}: ${ev.reason}\n`);
        } else if (ev.type === "compacted") {
          writeErr("… earlier context compacted\n");
        } else if (ev.type === "retrying") {
          const why = ev.reason === "quota" ? "insufficient quota" : "transient failure";
          writeErr(`retrying (${why}, attempt ${ev.attempt}/${ev.budget}) in ${formatDuration(ev.delayMs)}\n`);
        }
      },
      {
        signal: termination.signal,
        cwd: activeCwd,
        artifactDir: session?.artifactDir?.(),
        ...(parentRunId ? { parentRunId } : {}),
        lastTokens: nextContextTokens(lastUsage),
        historyTurnSizes,
        contextRevision,
        ...(session?.saveContextRevision ? {
          onContextRevision: (revision, source) => session.saveContextRevision(revision, source),
        } : {}),
        checkCommands,
        ...(session?.beginRun ? {
          onRunStart: async (data) => {
            await session.beginRun(data);
            journalRunId = data.runId;
          },
          onCheckpoint: ({ runId, kind, ...payload }) => session.checkpoint(runId, kind, payload),
        } : {}),
      }
    );
  } catch (err) {
    error = err;
    push({ kind: "error", text: err.message });
    writeErr(`\nerror: ${err.message}\n`);
  }

  if (result && result.outcome !== "completed") {
    const detail = result.message ?? (result.outcome === "truncated" ? "model output reached its limit" : result.outcome);
    if (result.outcome === "failed") blocks.push({ kind: "error", text: detail });
    else blocks.push({ kind: "result", ok: false, summary: `${result.outcome}: ${detail}` });
    writeErr(`\n${result.outcome === "failed" ? "error" : result.outcome}: ${detail}\n`);
  }
  const evidenceSummary = summarizeEvidence(result?.evidence);
  if (evidenceSummary) {
    blocks.push({ kind: "result", ok: result.evidence.checks.every((check) => check.state === "passed" && check.freshness === "fresh"),
      summary: `checks: ${evidenceSummary}` });
    writeErr(`checks: ${evidenceSummary}\n`);
  }

  // Persist the turn (including error blocks) regardless of outcome. A timing
  // block carries the real provider usage so later headless/TUI runs on this
  // session can drive compaction from real tokens.
  if (session) {
    if (journalRunId && error) await session.leaveRunUnfinished();
    const finalCwd = result?.cwd ?? error?.cwd;
    if (finalCwd) {
      try {
        await session.setCwd(finalCwd);
      } catch {
        /* non-fatal */
      }
    }
    const outcome = error ? "failed" : result?.outcome ?? "failed";
    blocks.push({
      kind: "timing",
      summary: `${outcome} in ${formatDuration(Date.now() - startedAt)}`,
      durationMs: Date.now() - startedAt,
      usage: result?.usage ?? error?.usage ?? null,
      ...(result ? {
        runId: result.runId,
        outcome: result.outcome,
        reason: result.reason,
        partial: result.partial,
        requestUsage: result.requestUsage,
        toolAttempts: result.toolAttempts,
        evidence: result.evidence,
      } : {}),
    });
    // The static config (incl. the often-large systemPrompt) is persisted once
    // per session; the turn itself stores only the model delta.
    await session.setConfig(config);
    const turn = {
      config: sessionConfig(config),
      messages: result?.messages ?? error?.turnMessages ?? [{ role: "user", content: prompt }],
      blocks,
    };
    // A thrown checkpoint error can occur after an effect. Keep the synced
    // prefix unfinished so recovery can flag uncertainty instead of sealing
    // an error snapshot as a complete run.
    if (journalRunId && !error) await session.endRun(journalRunId, turn);
    else if (!journalRunId && !error) await session.appendTurn(turn);
  }

  if (error) {
    process.exitCode = termination.requested ? 143 : 1;
    return;
  }
  if (sawText || result.outcome === "interrupted") writeOut("\n");
  process.exitCode = termination.requested ? 143
    : result.outcome === "completed" ? 0 : result.outcome === "interrupted" ? 130 : 1;
}
