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
 * @returns {Promise<{ messages: Array, finalText: string, aborted: boolean, cwd: string }>}
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
      const { message: reply, finishReason } = await streamAssistant(
        config,
        [...sendHistory, ...turnMessages],
        toolList,
        onEvent,
        signal
      );

      // If the turn was aborted mid-stream, the assistant reply may be incomplete
      // (or contain partial tool_calls), so don't push it into the conversation.
      if (signal?.aborted) {
        return { messages: turnMessages, finalText: "", aborted: true, cwd };
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
        return { messages: turnMessages, finalText: reply.content ?? "", aborted: false, cwd };
      }

      // Execute each requested tool call and feed the result back as a
      // `tool` message. The model does not actually run anything itself.
      for (const call of toolCalls) {
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

        if (result && typeof result.cwd === "string" && result.cwd !== cwd) {
          cwd = result.cwd;
          onEvent({ type: "cwd_change", cwd });
        }

        turnMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });

        // Stop early if aborted (e.g. while a tool was running).
        if (signal?.aborted) {
          return { messages: turnMessages, finalText: "", aborted: true, cwd };
        }
      }
      // Loop again: the model now sees the tool results and can continue.
    }
  } catch (err) {
    // A later request may fail after tools already changed the world. Preserve
    // that completed audit trail so sessions and subsequent turns stay honest.
    err.turnMessages = turnMessages;
    err.cwd = cwd;
    throw err;
  }
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
  const stream = streamChat({ ...config, messages, tools: toolList, signal });
  let message = null;
  let finishReason = null;
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      onEvent({ type: "text_delta", delta: ev.delta });
    } else if (ev.type === "thinking_delta") {
      onEvent({ type: "thinking_delta", delta: ev.delta });
    } else if (ev.type === "done") {
      message = ev.message;
      finishReason = ev.finishReason;
    }
  }
  if (!message) throw new Error("model returned no message");
  if (!message.content && !(message.tool_calls?.length > 0) && !signal?.aborted) {
    throw new Error("model returned an empty response");
  }
  onEvent({ type: "assistant_stop" });
  return { message, finishReason };
}
