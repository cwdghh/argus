/** TUI turn lifecycle: agent events, visible timing, and session persistence. */
import { runTurn } from "../agent.mjs";
import { nextContextTokens } from "../compact.mjs";
import { formatDuration } from "../format.mjs";
import { consumeAgentEvent } from "../transcript.mjs";
import { sessionConfig } from "../session/index.mjs";

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
]);

export async function submitTurn(tui) {
  if (tui.mode !== "idle") return;
  if (tui.pendingConfirm) return; // a confirmation is in flight; Enter submits y/n via insertText
  const text = tui.editor.buffer.trim();
  if (!text) return;
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
  try {
    const { messages, aborted, cwd } = await runTurn(tui.config, tui.history, text, (ev) => {
      // Mode/live-state tracking is frontend-specific; the blocks both
      // frontends persist come from the shared consumeAgentEvent so the TUI
      // and headless can never drift (W6.6).
      if (ev.type === "tool_call") {
        tui.activeToolStartedAt = tui.now();
        tui.activeTool = { name: ev.name, args: ev.args };
        if (tui.mode !== "aborting") tui.mode = "working";
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
      authorize: (request) => tui.confirm(request),
      // Real tokens of the context this turn will re-send (previous request's
      // prompt + its completion); feeds the 200K-token compaction trigger.
      lastTokens: nextContextTokens(tui.lastTurnUsage),
    });
    savedMessages = messages;
    tui.history.push(...messages);
    if (typeof cwd === "string") tui.cwd = cwd;
    if (aborted || ac.signal.aborted) {
      outcome = "interrupted";
      tui.pushBlock({ kind: "result", ok: false, summary: "⏹ interrupted" });
    }
  } catch (err) {
    savedMessages = err.turnMessages ?? savedMessages;
    tui.history.push(...savedMessages);
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
    tui.lastTurnUsage = tui.turnUsage;
    tui.pushBlock({ kind: "timing", summary: `${outcome} in ${formatDuration(durationMs)}`, durationMs, usage: tui.turnUsage });
    if (tui.session) {
      try {
        await tui.session.setCwd(tui.cwd);
        // Static config (incl. systemPrompt) is persisted once per session,
        // not with every turn; appendTurn stores only the model delta.
        await tui.session.setConfig(tui.config);
        await tui.session.appendTurn({
          config: sessionConfig(tui.config),
          messages: savedMessages,
          blocks: tui.blocks.slice(turnStart),
        });
      } catch (err) {
        tui.pushBlock({ kind: "error", text: `could not save session: ${err.message}` });
      }
    }
    tui.abortController = null;
    tui.aborting = false;
    tui.activeTool = null;
    tui.activeToolStartedAt = null;
    tui.activityStartedAt = null;
    tui.mode = "idle";
    // Leave the scroll anchor alone: a user who scrolled back during
    // generation keeps reading the same spot instead of being yanked to
    // the bottom when the turn ends. The default (null) follows anyway.
    tui.dirtyRendered = true;
  }
}
