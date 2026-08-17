/**
 * The heart of the agent: the tool-calling loop.
 *
 * This is the same loop pi implements in packages/agent/src/agent-loop.ts,
 * stripped to its essentials:
 *
 *   1. Send the whole history + tool schemas to the LLM.
 *   2. If the reply contains tool calls, execute each one and append the
 *      results to the conversation as `tool` messages.
 *   3. Go back to step 1. The model now sees the tool outputs.
 *   4. When the model replies with plain text and no tool calls, we're done.
 *
 * The crucial idea: the model never runs the tools. It only *requests* them by
 * name and arguments. Your code decides what actually runs.
 *
 * The loop is UI-agnostic: it emits events (text_delta, tool_call, tool_result,
 * ...) so any front-end can render it live. See src/tui.mjs for the TUI.
 *
 * An optional `opts.signal` (AbortSignal) lets a turn be cancelled: the streamed
 * reply stops, in-flight tools get the signal, and the loop returns early with
 * `{ aborted: true }`.
 */
import { streamChat } from "./llm.mjs";
import { findTool, tools, validateToolArgs } from "./tools.mjs";
import { maybeCompact } from "./compact.mjs";

/**
 * Run one user prompt through the tool-calling loop.
 *
 * @param {object}  config     resolved config from config.mjs
 * @param {Array}   history    full conversation so far (outside this turn)
 * @param {string}  userMessage the new user prompt
 * @param {(event: object) => void} [onEvent] called with {type, ...} as things happen
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ messages: Array, finalText: string, aborted: boolean, cwd: string, usage: object|null }>}
 */
export async function runTurn(config, history, userMessage, onEvent = () => {}, opts = {}) {
  const { signal } = opts;
  let cwd = opts.cwd || process.cwd();
  const confirm = opts.confirm || null;
  const toolList = tools;
  const maxSteps = opts.maxSteps ?? config.maxSteps ?? 25;
  const maxToolResultChars = opts.maxToolResultChars ?? config.maxToolResultChars ?? 50_000;
  let steps = 0;

  // Everything created during this turn (assistant replies + tool results).
  const turnMessages = [{ role: "user", content: userMessage }];
  onEvent({ type: "user", text: userMessage });

  // Cumulative token usage across all model calls in this turn. Providers
  // return per-request usage (prompt + completion tokens); accumulateUsage
  // sums them so the UI can show what the whole turn actually cost.
  // `null` until the first model call reports usage.
  let usage = null;

  // Keep the model context within the window: drop the oldest turns and replace
  // them with a compact summary when the history grows too large.
  const { history: sendHistory, compacted } = maybeCompact(history, {
    compactAtChars: opts.compactAtChars,
    keepTurns: opts.keepTurns,
  });
  if (compacted) onEvent({ type: "compacted" });

  try {
    while (true) {
      if (steps >= maxSteps) {
        throw new Error(`agent stopped after ${maxSteps} model steps (ARGUS_MAX_STEPS)`);
      }
      steps++;
      const { message: reply, finishReason, usage: stepUsage } = await streamAssistant(
        config,
        [...sendHistory, ...turnMessages],
        toolList,
        onEvent,
        signal
      );
      usage = accumulateUsage(usage, stepUsage);
      onEvent({ type: "usage", usage });

      // If the turn was aborted mid-stream, the assistant reply may be incomplete
      // (or contain partial tool_calls), so don't push it into the conversation.
      if (signal?.aborted) {
        return { messages: turnMessages, finalText: "", aborted: true, cwd, usage };
      }

      if (finishReason === "length") {
        throw new Error("model response was truncated by its context/output limit; no partial tool calls were executed");
      }

      // The assistant message becomes part of the conversation.
      turnMessages.push(reply);

      const toolCalls = reply.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // No tools requested -> the model gave its final answer.
        onEvent({ type: "assistant_end", text: reply.content ?? "" });
        return { messages: turnMessages, finalText: reply.content ?? "", aborted: false, cwd, usage };
      }

      // Execute each requested tool call and feed the result back as a
      // `tool` message. The model does not actually run anything itself.
      for (const call of toolCalls) {
        const { result, cwd: nextCwd } = await executeToolCall(call, {
          cwd,
          signal,
          confirm,
          maxToolResultChars,
          onEvent,
        });
        cwd = nextCwd;
        turnMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });

        // Stop early if aborted (e.g. while a tool was running).
        if (signal?.aborted) {
          return { messages: turnMessages, finalText: "", aborted: true, cwd, usage };
        }
      }
      // Loop again: the model now sees the tool results and can continue.
    }
  } catch (err) {
    // A later request may fail after tools already changed the world. Preserve
    // that completed audit trail so sessions and subsequent turns stay honest.
    err.turnMessages = turnMessages;
    err.cwd = cwd;
    err.usage = usage;
    throw err;
  }
}


/**
 * Sum one model call's usage into the running turn total. Providers return
 * per-request usage (prompt + completion tokens); members that don't apply to
 * a given call (reasoning/cached) are simply added as zero, and a missing or
 * malformed report is ignored.
 *
 * @returns {object|null} the accumulated usage object (null until a real one
 *   has been seen)
 */
export function accumulateUsage(usage, stepUsage) {
  if (!stepUsage || typeof stepUsage !== "object") return usage;
  // A report with no numeric counts isn't a usage report; keep the running
  // total untouched rather than recording a bogus zero-cost call.
  if (
    !Number.isFinite(stepUsage.prompt_tokens) &&
    !Number.isFinite(stepUsage.completion_tokens) &&
    !Number.isFinite(stepUsage.total_tokens)
  ) {
    return usage;
  }
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const add = (base, value) => (base ?? 0) + n(value);
  const step = {
    prompt: n(stepUsage.prompt_tokens),
    completion: n(stepUsage.completion_tokens),
    total: n(stepUsage.total_tokens),
    reasoning: n(stepUsage.completion_tokens_details?.reasoning_tokens),
    cached: n(stepUsage.prompt_tokens_details?.cached_tokens),
  };
  if (!usage) {
    return {
      prompt_tokens: step.prompt,
      completion_tokens: step.completion,
      total_tokens: step.total,
      reasoning_tokens: step.reasoning,
      cached_tokens: step.cached,
    };
  }
  return {
    ...usage,
    prompt_tokens: add(usage.prompt_tokens, stepUsage.prompt_tokens),
    completion_tokens: add(usage.completion_tokens, stepUsage.completion_tokens),
    total_tokens: add(usage.total_tokens, stepUsage.total_tokens),
    reasoning_tokens: add(usage.reasoning_tokens, stepUsage.completion_tokens_details?.reasoning_tokens),
    cached_tokens: add(usage.cached_tokens, stepUsage.prompt_tokens_details?.cached_tokens),
  };
}

/**
 * Execute one model-requested tool call: parse its arguments, find and
 * validate the tool, run it (or produce a clean error), bound the result so a
 * rogue tool can't flood the context window, emit the tool_call / tool_result
 * / cwd_change events, and track the tool's new working directory.
 *
 * Errors — unknown tool, invalid JSON arguments, failed validation, a thrown
 * tool — are returned as `{ error: true, message }` results rather than
 * thrown, so the loop can feed them back to the model and continue.
 *
 * @returns {Promise<{ result: object, cwd: string }>}
 */
export async function executeToolCall(call, { cwd, signal, confirm, maxToolResultChars, onEvent = () => {} }) {
  const toolName = call?.function?.name ?? "";
  const rawArguments = call?.function?.arguments;
  const tool = findTool(toolName);

  let args = {};
  let argumentError = null;
  try {
    args = JSON.parse(rawArguments ?? "{}");
  } catch {
    argumentError = "tool arguments were not valid JSON";
  }

  onEvent({ type: "tool_call", name: toolName, args, raw: rawArguments });

  let result;
  if (!tool) {
    result = { error: true, message: `unknown tool: ${toolName || "(missing name)"}` };
  } else if (argumentError) {
    result = { error: true, message: argumentError };
  } else {
    const validationError = validateToolArgs(tool, args);
    if (validationError) {
      result = { error: true, message: validationError };
    } else {
      try {
        result = await tool.execute(args, { signal, cwd, confirm });
      } catch (err) {
        result = { error: true, message: `tool threw: ${err.message}` };
      }
    }
  }

  result = boundToolResult(result, maxToolResultChars);
  onEvent({ type: "tool_result", name: toolName, ok: !result?.error, result });

  let nextCwd = cwd;
  if (result && typeof result.cwd === "string" && result.cwd !== cwd) {
    nextCwd = result.cwd;
    onEvent({ type: "cwd_change", cwd: nextCwd });
  }
  return { result, cwd: nextCwd };
}

/** Keep any tool—present or future—from flooding the next model request. */
function boundToolResult(result, maxChars) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (err) {
    return { error: true, message: `tool result was not JSON-serializable: ${err.message}` };
  }
  if (serialized === undefined) return { error: true, message: "tool returned undefined" };
  if (serialized.length <= maxChars) return result;

  let preview = serialized.slice(0, Math.max(0, maxChars - 300));
  let bounded;
  do {
    bounded = {
      ...(result?.error ? { error: true } : {}),
      ...(typeof result?.cwd === "string" ? { cwd: result.cwd } : {}),
      truncated: true,
      originalChars: serialized.length,
      message: `tool result exceeded ${maxChars} characters; use a narrower read or command`,
      preview,
    };
    if (JSON.stringify(bounded).length > maxChars) preview = preview.slice(0, Math.floor(preview.length * 0.8));
  } while (JSON.stringify(bounded).length > maxChars && preview.length > 0);
  return bounded;
}

/**
 * Stream one assistant reply from the model, emitting text deltas as they
 * arrive and returning the fully-assembled assistant message.
 */
async function streamAssistant(config, messages, toolList, onEvent, signal) {
  onEvent({ type: "assistant_start" });
  const stream = streamChat({
    ...config,
    messages,
    tools: toolList,
    signal,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  });
  let message = null;
  let finishReason = null;
  let usage = null;
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      onEvent({ type: "text_delta", delta: ev.delta });
    } else if (ev.type === "thinking_delta") {
      onEvent({ type: "thinking_delta", delta: ev.delta });
    } else if (ev.type === "done") {
      message = ev.message;
      finishReason = ev.finishReason;
      usage = ev.usage ?? null;
    }
  }
  if (!message) throw new Error("model returned no message");
  if (!message.content && !(message.tool_calls?.length > 0) && !signal?.aborted) {
    throw new Error("model returned an empty response");
  }
  onEvent({ type: "assistant_stop" });
  return { message, finishReason, usage };
}
