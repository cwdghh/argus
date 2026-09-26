/** Fold versioned run records without treating uncertain effects as success. */
import { summarize, toolLabel } from "../format.mjs";

function localToolResult(call, uncertain) {
  return {
    role: "tool", tool_call_id: call.id,
    content: JSON.stringify({
      error: true,
      code: uncertain ? "execution_uncertain" : "not_executed",
      message: uncertain
        ? "Argus recorded tool intent but no result; inspect effects before retrying"
        : "Argus did not record execution of this call",
    }),
  };
}

function recoverPrefix(state) {
  const messages = [{ role: "user", content: state.start.prompt }];
  const blocks = [{ kind: "user", text: state.start.prompt }];
  const calls = [];
  const intents = new Set();
  const results = new Set();
  let partialText = null;
  let partialReasoning = null;
  for (const checkpoint of state.checkpoints) {
    if (checkpoint.kind === "assistant" && checkpoint.message?.role === "assistant") {
      const message = checkpoint.message;
      messages.push(message);
      if (message.content) blocks.push({ kind: "assistant", text: message.content });
      for (const call of message.tool_calls ?? []) {
        calls.push(call);
        blocks.push({ kind: "tool", name: call.function?.name, label: toolLabel(call.function?.name, {}) });
      }
      partialText = null;
      partialReasoning = null;
    } else if (checkpoint.kind === "tool_intent") {
      intents.add(checkpoint.ordinal);
    } else if (checkpoint.kind === "tool_result" && checkpoint.message?.role === "tool") {
      if (results.has(checkpoint.ordinal)) continue;
      results.add(checkpoint.ordinal);
      messages.push(checkpoint.message);
      let value;
      try { value = JSON.parse(checkpoint.message.content); }
      catch { value = { error: true, message: "unparseable recorded tool result" }; }
      blocks.push({ kind: "result", ok: value.error !== true, summary: summarize(value) });
    } else if (checkpoint.kind === "partial_delta") {
      partialText = (partialText ?? "") + (checkpoint.text ?? "");
      partialReasoning = (partialReasoning ?? "") + (checkpoint.reasoning ?? "");
    } else if (checkpoint.kind === "steering" && typeof checkpoint.text === "string") {
      messages.push({ role: "user", content: checkpoint.text });
      blocks.push({ kind: "user", text: checkpoint.text });
    }
  }
  const uncertainCalls = [];
  for (let ordinal = 1; ordinal <= calls.length; ordinal++) {
    if (results.has(ordinal)) continue;
    const uncertain = intents.has(ordinal);
    messages.push(localToolResult(calls[ordinal - 1], uncertain));
    blocks.push({ kind: "result", ok: false,
      summary: uncertain ? "tool execution uncertain; inspect effects" : "tool call was not executed" });
    if (uncertain) uncertainCalls.push(ordinal);
  }
  if (partialReasoning) blocks.push({ kind: "thinking", text: partialReasoning });
  if (partialText) {
    messages.push({ role: "assistant", content: partialText, partial: true });
    blocks.push({ kind: "assistant", text: partialText });
  }
  blocks.push({ kind: "result", ok: false, summary: "unfinished run recovered; explicit continuation required" });
  return {
    type: "turn", runId: state.start.runId, recovered: true, unfinished: true,
    uncertainCalls, config: { model: state.start.model }, messages, blocks,
  };
}

export class JournalReader {
  constructor() {
    this.active = new Map();
    this.warnings = [];
  }

  damageActive(lineNumber) {
    for (const state of this.active.values()) state.damaged = true;
    if (this.active.size) this.warnings.push(`session journal damaged at line ${lineNumber}; later records in the active run were ignored`);
  }

  /** Return a completed or recovered turn at run_end, if any. */
  accept(record) {
    if (record.type === "run_start") {
      if (record.version !== 2 || record.seq !== 0 || typeof record.runId !== "string" || typeof record.prompt !== "string") {
        this.warnings.push("ignored invalid run_start record");
        return null;
      }
      if (this.active.has(record.runId)) {
        this.warnings.push(`duplicate run_start for ${record.runId}`);
        this.active.get(record.runId).damaged = true;
        return null;
      }
      this.active.set(record.runId, { start: record, expected: 1, checkpoints: [], damaged: false });
      return null;
    }
    if (record.type !== "checkpoint" && record.type !== "run_end") return null;
    const state = this.active.get(record.runId);
    if (!state) {
      this.warnings.push(`ignored ${record.type} without run_start`);
      return null;
    }
    if (state.damaged || record.seq !== state.expected) {
      if (!state.damaged) this.warnings.push(`run ${record.runId} has a sequence gap at ${record.seq}`);
      state.damaged = true;
    } else {
      state.expected++;
      if (record.type === "checkpoint") state.checkpoints.push(record);
    }
    if (record.type !== "run_end") return null;
    this.active.delete(record.runId);
    if (!state.damaged && record.turn && Array.isArray(record.turn.messages) && Array.isArray(record.turn.blocks)) {
      return { type: "turn", ...record.turn, runId: record.runId };
    }
    this.warnings.push(`run ${record.runId} ended without a trustworthy final turn; recovered its valid prefix`);
    return recoverPrefix(state);
  }

  unfinished() {
    return [...this.active.values()].map((state) => recoverPrefix(state));
  }
}
