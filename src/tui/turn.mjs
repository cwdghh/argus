/** TUI turn lifecycle: agent events, visible timing, and session persistence. */
import { runTurn } from "../agent.mjs";
import { nextContextTokens } from "../compact.mjs";
import { formatDuration } from "../format.mjs";
import { summarizeEvidence } from "../agent/evidence.mjs";
import { consumeAgentEvent } from "../transcript.mjs";
import { sessionConfig } from "../session/index.mjs";
import { handleSteeringInput } from "./steering.mjs";

// Agent events whose block projection changes the transcript; only these
// invalidate the rendered-line cache (usage/cwd_change/assistant_* do not).
const BLOCK_PROJECTING_EVENTS = new Set([
  "thinking_delta",
  "text_delta",
  "tool_call",
  "tool_result",
  "approval",
  "compacted",
  "retrying",
  "steering",
]);

export async function submitTurn(tui) {
  if (tui.mode !== "idle") {
    const draft = tui.editor.buffer.trim();
    if (!draft.startsWith("/steer ")) return;
    await handleSteeringInput(tui, draft.slice(7), true);
    return;
  }
  if (tui.pendingConfirm) return; // a confirmation is in flight; Enter submits y/n via insertText
  let text = tui.editor.buffer.trim();
  if (!text) return;
  if (tui.recoveryRequired && !text.startsWith("/")) {
    tui.pushBlock({ kind: "error", text: `the last run could not be finalized; use /resume ${tui.sessionName ?? "<session>"} to inspect its saved prefix before continuing` });
    return;
  }
  const uncertain = tui.unfinishedRuns.find((run) => run.uncertainCalls?.length && !run.resolution);
  if (uncertain && !text.startsWith("/")) {
    tui.pushBlock({ kind: "error", text: `run ${uncertain.runId} has uncertain tool effects; inspect them, then use /resolve retry or /resolve abandon` });
    return;
  }
  const parentRunId = tui.nextContinuationParent;
  tui.nextContinuationParent = null;
  const followUpSteering = text.startsWith("/") ? [] : [...tui.steeringQueue];
  if (followUpSteering.length) {
    const queuedText = followUpSteering.map((item) => item.text).join("\n");
    if (text !== queuedText) text = `${queuedText}\n${text}`;
  }
  const pasteMeta = tui.editor.lastPaste;
  tui.editor.lastPaste = null;
  tui.editor.draft = null;
  tui.editor.buffer = "";
  tui.editor.cursor = 0;
  tui.suggestion = null;
  if (text.startsWith("/")) {
    await tui.runCommand(text);
    return;
  }
  const designatedChecks = [...tui.checkCommands];
  tui.checkCommands = [];
  tui.mode = "working";
  tui.activityStartedAt = tui.now();
  tui.lastClockTick = -1;
  tui.turnUsage = null;
  tui.dirtyRendered = true;

  if (tui.editor.history[tui.editor.history.length - 1] !== text) tui.editor.history.push(text);
  tui.editor.historyIndex = -1;
  const turnStart = tui.blocks.length;
  tui.pushBlock({ kind: "user", text: tui.userPromptText(text, pasteMeta) });

  const ac = new AbortController();
  tui.abortController = ac;
  let savedMessages = [{ role: "user", content: text }];
  let outcome = "completed";
  let result = null;
  let journalRunId = null;
  let runFailedBeforeResult = false;
  try {
    result = await runTurn(tui.config, tui.history, text, (ev) => {
      // Mode/live-state tracking is frontend-specific; the blocks both
      // frontends persist come from the shared consumeAgentEvent so the TUI
      // and headless use the same saved block projection.
      if (ev.type === "tool_call") {
        tui.activeToolStartedAt = tui.now();
        tui.activeTool = { name: ev.name, args: ev.args };
        if (tui.mode !== "aborting") tui.mode = "working";
      } else if (ev.type === "tool_output") {
        if (tui.activeTool) tui.activeTool.outputPreview = ev.text.replace(/\s+/g, " ").trim().slice(-100);
      } else if (ev.type === "thinking_delta") {
        tui.mode = "thinking";
      } else if (ev.type === "text_delta" || ev.type === "tool_result" || ev.type === "compacted" || ev.type === "retrying") {
        if (tui.mode !== "aborting") tui.mode = "working";
      } else if (ev.type === "cwd_change") {
        tui.cwd = ev.cwd;
        if (tui.session) tui.session.setCwd(ev.cwd).catch(() => {});
      } else if (ev.type === "usage") {
        tui.turnUsage = ev.usage;
      }
      if (ev.type === "tool_result") {
        // The one block field the projector can't derive: the tool's wall time.
        const durationMs = tui.activeToolStartedAt == null ? null : tui.now() - tui.activeToolStartedAt;
        tui.activeToolStartedAt = null;
        tui.activeTool = null;
        consumeAgentEvent(tui.blocks, ev, { durationMs });
      } else {
        consumeAgentEvent(tui.blocks, ev);
      }
      // The projector mutates tui.blocks directly (bypassing pushBlock), so
      // bump the render stamp for exactly the events that produced blocks.
      if (BLOCK_PROJECTING_EVENTS.has(ev.type)) tui._renderStamp++;
      tui.dirtyRendered = true;
    }, {
      signal: ac.signal,
      cwd: tui.cwd,
      artifactDir: tui.session?.artifactDir?.(),
      authorize: (request) => tui.confirm(request),
      // Real tokens of the context this turn will re-send (previous request's
      // prompt + its completion); feeds the 200K-token compaction trigger.
      lastTokens: nextContextTokens(tui.lastTurnUsage),
      historyTurnSizes: tui.historyTurnSizes,
      contextRevision: tui.contextRevision,
      ...(tui.session?.saveContextRevision ? {
        onContextRevision: (revision, source) => tui.session.saveContextRevision(revision, source),
      } : {}),
      checkCommands: designatedChecks,
      ...(parentRunId ? { parentRunId } : {}),
      ...(tui.session?.beginRun ? {
        onRunStart: async (data) => {
          await tui.session.beginRun(data);
          journalRunId = data.runId;
          tui.activeRunId = data.runId;
          for (const item of followUpSteering) {
            await tui.session.settleSteering(item.runId, item.id, "applied");
            tui.steeringQueue = tui.steeringQueue.filter((queued) => queued.id !== item.id);
          }
          if (parentRunId) {
            const parent = tui.unfinishedRuns.find((run) => run.runId === parentRunId);
            if (parent) parent.resolution = "continued";
          }
        },
        onCheckpoint: ({ runId, kind, ...payload }) => tui.session.checkpoint(runId, kind, payload),
        takeSteering: async () => [...tui.steeringQueue],
        markSteeringApplied: async (item) => {
          await tui.session.settleSteering(item.runId, item.id, "applied");
          tui.steeringQueue = tui.steeringQueue.filter((queued) => queued.id !== item.id);
        },
      } : {}),
    });
    savedMessages = result.messages;
    tui.history.push(...result.messages);
    tui.historyTurnSizes.push(result.messages.length);
    if (result.contextRevision) tui.contextRevision = result.contextRevision;
    if (typeof result.cwd === "string") tui.cwd = result.cwd;
    outcome = result.outcome;
    if (outcome !== "completed") {
      const detail = result.message ?? (outcome === "truncated" ? "model output reached its limit" : outcome);
      if (outcome === "failed") tui.pushBlock({ kind: "error", text: detail });
      else tui.pushBlock({ kind: "result", ok: false, summary: outcome === "interrupted" ? "⏹ interrupted" : `${outcome}: ${detail}` });
    }
    const evidenceSummary = summarizeEvidence(result.evidence);
    if (evidenceSummary) tui.pushBlock({ kind: "result", ok: result.evidence.checks.every((check) => check.state === "passed" && check.freshness === "fresh"),
      summary: `checks: ${evidenceSummary}` });
  } catch (err) {
    runFailedBeforeResult = true;
    if (journalRunId) tui.recoveryRequired = true;
    if (!journalRunId) tui.checkCommands.unshift(...designatedChecks);
    savedMessages = err.turnMessages ?? savedMessages;
    tui.history.push(...savedMessages);
    tui.historyTurnSizes.push(savedMessages.length);
    if (ac.signal.aborted) {
      outcome = "interrupted";
      tui.pushBlock({ kind: "result", ok: false, summary: "⏹ interrupted" });
    } else {
      outcome = "failed";
      tui.pushBlock({ kind: "error", text: err.message });
    }
  } finally {
    const durationMs = tui.activityStartedAt == null ? 0 : tui.now() - tui.activityStartedAt;
    tui.lastTurnDurationMs = durationMs;
    tui.lastTurnUsage = result?.usage ?? tui.turnUsage;
    tui.pushBlock({
      kind: "timing",
      summary: `${outcome} in ${formatDuration(durationMs)}`,
      durationMs,
      usage: tui.lastTurnUsage,
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
    if (tui.session) {
      try {
        if (journalRunId && runFailedBeforeResult) await tui.session.leaveRunUnfinished();
        await tui.session.setCwd(tui.cwd);
        // Static config (incl. systemPrompt) is persisted once per session,
        // not with every turn; appendTurn stores only the model delta.
        await tui.session.setConfig(tui.config);
        const turn = {
          config: sessionConfig(tui.config),
          messages: savedMessages,
          blocks: tui.blocks.slice(turnStart),
        };
        // A thrown checkpoint error may have followed a real tool effect.
        // Preserve the last synced prefix as unfinished for crash recovery.
        if (journalRunId && !runFailedBeforeResult) await tui.session.endRun(journalRunId, turn);
        else if (!journalRunId && !runFailedBeforeResult) await tui.session.appendTurn(turn);
      } catch (err) {
        tui.pushBlock({ kind: "error", text: `could not save session: ${err.message}` });
      }
    }
    tui.abortController = null;
    tui.activeRunId = null;
    tui.aborting = false;
    tui.activeTool = null;
    tui.activeToolStartedAt = null;
    tui.activityStartedAt = null;
    tui.mode = "idle";
    if (tui.steeringQueue.length) {
      const queuedText = tui.steeringQueue.map((item) => item.text).join("\n");
      if (!tui.editor.buffer.trim()) {
        tui.editor.buffer = queuedText;
        tui.editor.cursor = queuedText.length;
      }
      tui.pushBlock({ kind: "result", ok: true, summary: "steering arrived after the run boundary; it is queued for the next prompt" });
    }
    // Leave the scroll anchor alone: a user who scrolled back during
    // generation keeps reading the same spot instead of being yanked to
    // the bottom when the turn ends. The default (null) follows anyway.
    tui.dirtyRendered = true;
  }
}
