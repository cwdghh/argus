/** One owner for /steer in both idle and active TUI modes. */
import { randomUUID } from "node:crypto";

function clearActiveDraft(tui, active) {
  if (!active) return;
  tui.editor.buffer = "";
  tui.editor.cursor = 0;
}

export async function handleSteeringInput(tui, rawText, active) {
  const instruction = rawText.trim();
  if (instruction === "list") {
    tui.pushBlock({ kind: "assistant", text: tui.steeringQueue.length
      ? tui.steeringQueue.map((item) => `${item.id.slice(0, 8)} — ${item.text}`).join("\n")
      : "No queued steering." });
    clearActiveDraft(tui, active);
    return;
  }

  if (instruction.startsWith("cancel ")) {
    const prefix = instruction.slice(7).trim();
    const item = prefix && tui.steeringQueue.find((queued) => queued.id.startsWith(prefix));
    if (!item) {
      tui.pushBlock({ kind: "error", text: "no queued steering matches that ID" });
      return;
    }
    try {
      await tui.session.settleSteering(item.runId, item.id, "cancelled");
      tui.steeringQueue = tui.steeringQueue.filter((queued) => queued.id !== item.id);
      clearActiveDraft(tui, active);
      tui.pushBlock({ kind: "result", ok: true, summary: `steering cancelled (${item.id.slice(0, 8)})` });
    } catch (error) {
      tui.pushBlock({ kind: "error", text: `could not cancel steering: ${error.message}` });
    }
    return;
  }

  if (!active) {
    tui.pushBlock({ kind: "error", text: "use /steer <text> while Argus is working" });
    return;
  }
  if (!instruction || instruction.length > 4_096 || tui.steeringQueue.length >= 8 ||
      !tui.activeRunId || !tui.session?.queueSteering) {
    tui.pushBlock({ kind: "error", text: "steering needs an active saved run, 1–4096 characters, and fewer than 8 queued instructions" });
    return;
  }
  const item = { id: randomUUID(), runId: tui.activeRunId, text: instruction };
  try {
    await tui.session.queueSteering(item.runId, item.id, item.text);
    tui.steeringQueue.push(item);
    clearActiveDraft(tui, active);
    tui.pushBlock({ kind: "result", ok: true, summary: `steering queued (${item.id.slice(0, 8)})` });
    if (tui.pendingConfirm) tui.resolveConfirm(false);
  } catch (error) {
    tui.pushBlock({ kind: "error", text: `could not save steering: ${error.message}` });
  }
}
