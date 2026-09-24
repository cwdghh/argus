import { findTool } from "../tools.mjs";
import { validateToolArgs } from "../tools/validate.mjs";
import { boundToolResult } from "./tool-result.mjs";

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
export async function executeToolCall(call, { cwd, signal, confirm, authorize, maxToolResultChars, toolState, attemptId, onEvent = () => {} }) {
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

  onEvent({ type: "tool_call", name: toolName, args, raw: rawArguments, id: call?.id, attemptId });

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
        let approved = false;
        const reason = tool.approval?.(args) ?? null;
        if (reason) {
          const request = { tool: tool.name, args, cwd, risk: tool.risk, reason };
          const decide = authorize ?? (confirm ? ({ args: requestedArgs }) => confirm(requestedArgs.command ?? requestedArgs) : null);
          if (!decide) {
            result = { error: true, message: `blocked: ${tool.name} requires approval (${reason})` };
          } else {
            approved = await decide(request);
            onEvent({ type: "approval", ...request, approved });
            if (!approved) result = { error: true, message: `denied: ${tool.name} was not approved (${reason})` };
          }
        }
        if (!result) {
          result = await tool.execute(args, {
            signal,
            cwd,
            confirm,
            authorize,
            approved,
            maxResultChars: maxToolResultChars,
            toolState,
          });
        }
      } catch (err) {
        result = { error: true, message: `tool threw: ${err.message}` };
      }
    }
  }

  result = await boundToolResult(result, maxToolResultChars);
  onEvent({ type: "tool_result", name: toolName, ok: !result?.error, result, id: call?.id, attemptId });

  let nextCwd = cwd;
  if (result && typeof result.cwd === "string" && result.cwd !== cwd) {
    nextCwd = result.cwd;
    onEvent({ type: "cwd_change", cwd: nextCwd });
  }
  return { result, cwd: nextCwd };
}
