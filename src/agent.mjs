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
 * ...) so any front-end can render it live. See src/tui.mjs for the Ink UI.
 */
import { streamChat } from "./llm.mjs";
import { findTool, tools } from "./tools.mjs";

/**
 * Run one user prompt through the tool-calling loop.
 *
 * @param {object} config  resolved config from config.mjs
 * @param {Array}  history full conversation so far (outside this turn)
 * @param {string} userMessage the new user prompt
 * @param {(event: object) => void} [onEvent] called with {type, ...} as things happen
 * @returns {Promise<{ messages: Array, finalText: string }>}
 */
export async function runTurn(config, history, userMessage, onEvent = () => {}) {
  const toolList = tools;

  // Everything created during this turn (assistant replies + tool results).
  const turnMessages = [{ role: "user", content: userMessage }];
  onEvent({ type: "user", text: userMessage });

  while (true) {
    const reply = await streamAssistant(config, [...history, ...turnMessages], toolList, onEvent);

    // The assistant message becomes part of the conversation.
    turnMessages.push(reply);

    const toolCalls = reply.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tools requested -> the model gave its final answer.
      onEvent({ type: "assistant_end", text: reply.content ?? "" });
      return { messages: turnMessages, finalText: reply.content ?? "" };
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
          result = await tool.execute(args);
        } catch (err) {
          result = { error: true, message: `tool threw: ${err.message}` };
        }
      }

      onEvent({ type: "tool_result", name: call.function.name, ok: !result?.error, result });

      turnMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
    // Loop again: the model now sees the tool results and can continue.
  }
}

/**
 * Stream one assistant reply from the model, emitting text deltas as they
 * arrive and returning the fully-assembled assistant message.
 */
async function streamAssistant(config, messages, toolList, onEvent) {
  onEvent({ type: "assistant_start" });
  const stream = streamChat({ ...config, messages, tools: toolList });
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
