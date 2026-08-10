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
import { findTool, tools } from "./tools.mjs";

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

  // Everything created during this turn (assistant replies + tool results).
  const turnMessages = [{ role: "user", content: userMessage }];
  onEvent({ type: "user", text: userMessage });

  while (true) {
    const reply = await streamAssistant(config, [...history, ...turnMessages], toolList, onEvent, signal);

    // If the turn was aborted mid-stream, the assistant reply may be incomplete
    // (or contain partial tool_calls), so don't push it into the conversation.
    if (signal?.aborted) {
      return { messages: turnMessages, finalText: "", aborted: true, cwd };
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
      const tool = findTool(call.function.name);
      let args = {};
      try {
        args = JSON.parse(call.function.arguments ?? "{}");
      } catch {
        // malformed args -> treat as an error result below
      }
      onEvent({ type: "tool_call", name: call.function.name, args, raw: call.function.arguments });

      let result;
      if (!tool) {
        result = { error: true, message: `unknown tool: ${call.function.name}` };
      } else {
        try {
          result = await tool.execute(args, { signal, cwd, confirm });
        } catch (err) {
          result = { error: true, message: `tool threw: ${err.message}` };
        }
      }

      onEvent({ type: "tool_result", name: call.function.name, ok: !result?.error, result });

      if (result && typeof result.cwd === "string") {
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
}

/**
 * Stream one assistant reply from the model, emitting text deltas as they
 * arrive and returning the fully-assembled assistant message.
 */
async function streamAssistant(config, messages, toolList, onEvent, signal) {
  onEvent({ type: "assistant_start" });
  const stream = streamChat({ ...config, messages, tools: toolList, signal });
  let message = null;
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      onEvent({ type: "text_delta", delta: ev.delta });
    } else if (ev.type === "thinking_delta") {
      onEvent({ type: "thinking_delta", delta: ev.delta });
    } else if (ev.type === "done") {
      message = ev.message;
    }
  }
  if (!message) throw new Error("model returned no message");
  onEvent({ type: "assistant_stop" });
  return message;
}
