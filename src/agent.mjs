/**
 * The heart of the agent: the tool-calling loop.
 *
 * This is the same loop pi implements in packages/agent/src/agent-loop.ts,
 * stripped to its essentials:
 *
 *   1. Send the whole history + tool schemas to the LLM.
 *   2. If the reply contains one tool call, validate/authorize/execute it and
 *      append its bounded result as a `tool` message.
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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { abortableDelay, buildBody, streamChat } from "./llm.mjs";
import { findTool, tools, validateToolArgs } from "./tools.mjs";
import { COMPACT_DEFAULTS, maybeCompact } from "./compact.mjs";
import { argusHome } from "./config.mjs";
import { createToolState } from "./tool-state.mjs";

/**
 * Run one user prompt through the tool-calling loop.
 *
 * @param {object}  config     resolved config from config.mjs
 * @param {Array}   history    full conversation so far (outside this turn)
 * @param {string}  userMessage the new user prompt
 * @param {(event: object) => void} [onEvent] called with {type, ...} as things happen
 * @param {{
 *   signal?: AbortSignal,
 *   cwd?: string,
 *   confirm?: (cmd: string) => Promise<boolean>,
 *   authorize?: (request: object) => Promise<boolean>,
 *   maxSteps?: number,
 *   maxToolResultChars?: number,
 *   maxTurnToolResultChars?: number,
 *   maxRequestChars?: number,
 *   compactAtTokens?: number,
 *   compactAtChars?: number,
 *   keepTurns?: number,
 *   lastTokens?: number|null,
 * }} [opts]
 * @returns {Promise<{ messages: Array, finalText: string, aborted: boolean, cwd: string, usage: object|null }>}
 */
export async function runTurn(config, history, userMessage, onEvent = () => {}, opts = {}) {
  const { signal } = opts;
  let cwd = opts.cwd || process.cwd();
  const confirm = opts.confirm || null;
  const authorize = opts.authorize || null;
  const toolList = tools;
  const maxSteps = opts.maxSteps ?? config.maxSteps ?? 100;
  const maxToolResultChars = opts.maxToolResultChars ?? config.maxToolResultChars ?? 50_000;
  const maxTurnToolResultChars = opts.maxTurnToolResultChars ?? config.maxTurnToolResultChars ?? 400_000;
  const maxRequestChars = opts.maxRequestChars ?? config.maxRequestChars ?? COMPACT_DEFAULTS.compactAtChars;
  // Loop-level retries for a model step that died before any visible text
  // streamed (the in-request `request()` retries already cover the initial
  // POST); reuses the same budget the request layer uses.
  const stepRetries = config.maxRetries ?? 2;
  const toolState = createToolState();
  let steps = 0;
  let turnToolResultChars = 0;

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
    compactAtTokens: opts.compactAtTokens,
    compactAtChars: opts.compactAtChars,
    keepTurns: opts.keepTurns,
    // Real provider-reported tokens of the context the next request will
    // carry (see compact.mjs `nextContextTokens`); falls back to the char
    // safety net before the first usage report.
    lastTokens: opts.lastTokens,
  });
  if (compacted) onEvent({ type: "compacted" });

  // Rolling window of executed (call, result) pairs for the no-progress guard.
  // Keying whole pairs — not just consecutive ones — lets the guard catch an
  // A/B/A/B alternation that a plain repeat-streak would reset on every change.
  const loopWindow = [];

  try {
    while (true) {
      if (steps >= maxSteps) {
        throw new Error(`agent stopped after ${maxSteps} model steps (ARGUS_MAX_STEPS)`);
      }
      steps++;
      const outgoingMessages = [...sendHistory, ...turnMessages];
      // Build the request body once per step: the same serialized payload is
      // both measured against the char cap and sent, so the measurement can
      // never drift from what actually goes over the wire.
      const body = buildRequestBody(config, outgoingMessages, toolList);
      const outgoingChars = JSON.stringify(body).length;
      if (outgoingChars > maxRequestChars) {
        throw new Error(
          `agent stopped before sending ${outgoingChars} characters; the active request exceeds the ` +
            `${maxRequestChars}-character context safety limit`
        );
      }
      const { message: reply, finishReason, usage: stepUsage } = await runModelStep(
        config,
        outgoingMessages,
        toolList,
        { body, onEvent, signal, stepRetries }
      );
      usage = accumulateUsage(usage, stepUsage);
      onEvent({ type: "usage", usage });

      // If the turn was aborted mid-stream, the assistant reply may be incomplete
      // (or contain partial tool_calls), so don't push it into the conversation.
      if (signal?.aborted) {
        return { messages: turnMessages, finalText: "", aborted: true, cwd, usage };
      }

      const toolCalls = reply.tool_calls ?? [];
      if (finishReason === "length") {
        // The model hit its output/context limit. Keep what it said (marked
        // truncated) instead of discarding the reply, and turn any un-executed
        // tool_calls into explicit "never ran" error results so the persisted
        // turn still satisfies tool-call pairing.
        reply.truncated = true;
        turnMessages.push(reply);
        for (const call of toolCalls) {
          turnMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              error: true,
              truncated: true,
              message: 'model output was truncated (finish_reason "length"); this tool call never ran',
            }),
          });
        }
        return { messages: turnMessages, finalText: reply.content ?? "", aborted: false, truncated: true, cwd, usage };
      }

      // The assistant message becomes part of the conversation only after its
      // tool-call shape is known to be protocol-safe.
      turnMessages.push(reply);
      if (toolCalls.length === 0) {
        // No tools requested -> the model gave its final answer.
        onEvent({ type: "assistant_end", text: reply.content ?? "" });
        return { messages: turnMessages, finalText: reply.content ?? "", aborted: false, cwd, usage };
      }

      // Execute each requested tool call in sequence and feed the results back as
      // `tool` messages. Some endpoints ignore `parallel_tool_calls:false` and
      // return several at once; they still never run in parallel, and each is
      // executed exactly once. The model does not actually run anything itself.
      for (const call of toolCalls) {
        const repeatKey = canonicalToolCall(call);
        const loop = detectCallLoop(repeatKey, loopWindow);
        if (loop) {
          throw new Error(
            loop.period === 1
              ? `agent stopped: the model repeated the same no-progress tool call 3 times ` +
                `(${loop.name ?? "(missing name)"}); this looks like a loop — refusing to keep generating`
              : `agent stopped: the model alternated two no-progress tool calls 3 times ` +
                `(${loop.names}); this looks like a loop — refusing to keep generating`
          );
        }
        if (steps >= maxSteps) {
          throw new Error(
            `agent stopped after ${maxSteps} model steps (ARGUS_MAX_STEPS) before executing another tool; ` +
              "no follow-up model step remains to report its result"
          );
        }
        const remainingToolChars = maxTurnToolResultChars - turnToolResultChars;
        if (remainingToolChars < 500) {
          throw new Error(
            `agent stopped before another tool call: this turn reached its ${maxTurnToolResultChars}-character tool-result budget`
          );
        }
        const { result, cwd: nextCwd } = await executeToolCall(call, {
          cwd,
          signal,
          confirm,
          authorize,
          maxToolResultChars: Math.min(maxToolResultChars, remainingToolChars),
          toolState,
          onEvent,
        });
        cwd = nextCwd;
        const serializedResult = JSON.stringify(result);
        turnToolResultChars += serializedResult.length;
        turnMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializedResult,
        });
        const resultKey = stableStringify(result);
        loopWindow.push({
          key: `${repeatKey}\u0000${resultKey}`,
          callKey: repeatKey,
          name: call?.function?.name ?? "(missing name)",
        });
        if (loopWindow.length > LOOP_WINDOW) loopWindow.shift();

        // Stop early if aborted (e.g. while a tool was running).
        if (signal?.aborted) {
          return { messages: protocolSafeMessages(turnMessages), finalText: "", aborted: true, cwd, usage };
        }
      }
      // Loop again: the model now sees the tool results and can continue.
    }
  } catch (err) {
    // A later request may fail after tools already changed the world. Preserve
    // that completed audit trail so sessions and subsequent turns stay honest.
    err.turnMessages = protocolSafeMessages(turnMessages);
    err.cwd = cwd;
    err.usage = usage;
    throw err;
  }
}

/**
 * No editor buffers / session payloads may violate the tool-call pairing
 * invariant: every `assistant` message's tool_call must be followed by a
 * matching `tool` message. Mid-loop guards (repeat guard, max steps inside the
 * tool loop, the per-turn result budget) throw AFTER the assistant reply is
 * pushed but BEFORE its tool executed — without this, an exposed
 * `err.turnMessages` would carry a dangling tool_call. Synthesize an error
 * tool result for every call that never executed, so the trail stays
 * replayable; already-safe turns are returned unchanged.
 */
export function protocolSafeMessages(turnMessages) {
  const out = [];
  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];
    out.push(msg);
    const calls = msg.role === "assistant" ? msg.tool_calls : undefined;
    if (!calls || calls.length === 0) continue;
    for (const call of calls) {
      const id = call?.id;
      // Pairing requires the matching tool result to come *after* this
      // assistant message; an earlier turn reusing the same call id (or the
      // same reply's earlier results) does not satisfy it.
      const matched = turnMessages
        .slice(i + 1)
        .some((m) => m.role === "tool" && m.tool_call_id === id);
      if (!matched) {
        out.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify({
            error: true,
            message: `tool call was never executed (${call?.function?.name ?? "(missing name)"})`,
          }),
        });
      }
    }
  }
  return out;
}

// How many executed (call, result) pairs the no-progress guard keeps in view;
// bounds the alternation patterns it can recognise.
const LOOP_WINDOW = 8;

/**
 * Decide whether the next tool call would extend a no-progress loop, from the
 * pairs already executed this turn:
 *   - period 1: the same call produced the same result twice in a row — this
 *     request would be the third identical one;
 *   - period 2: the last six executed pairs strictly alternate — this request
 *     repeats a two-leg A/B/A/B cycle for a third time (a plain repeat-streak
 *     resets on every key change and never trips on this).
 * A pair key is callKey joined to resultKey (NUL-separated), so results —
 * not just call shapes — must repeat for the guard to fire.
 */
export function detectCallLoop(repeatKey, window) {
  const n = window.length;
  if (n >= 2) {
    const last = window[n - 1];
    if (last.key === window[n - 2].key && last.callKey === repeatKey) {
      return { period: 1, name: last.name };
    }
  }
  if (n >= 6) {
    let alternating = true;
    for (let j = n - 1; j >= Math.max(n - 6, 2); j--) {
      if (window[j].key !== window[j - 2].key) {
        alternating = false;
        break;
      }
    }
    if (alternating) {
      return { period: 2, names: `${window[n - 1].name} / ${window[n - 2].name}` };
    }
  }
  return null;
}


/**
 * Fold one model call's usage into the running turn total without ever
 * counting the same tokens twice.
 *
 * Providers report per-request usage, and every request re-sends the whole
 * context so far (history + tool results). Summing `prompt_tokens` across the
 * steps of a multi-call turn would therefore count the same history once per
 * model call — the "X tokens used" number would grow with the request count,
 * not with the context. Instead:
 *
 *   - prompt_tokens  = the largest single prompt sent (the final request's
 *                      context); shared context is counted exactly once.
 *   - completion     = the sum of every step's output tokens (each step's
 *                      output is distinct).
 *   - total_tokens   = prompt_tokens + completion_tokens, recomputed so the
 *                      turn total stays consistent with its two members.
 *   - reasoning      = summed like completion (distinct per step).
 *   - cached         = the largest cached share of any prompt sent (a subset
 *                      of the prompt, so it is reported, not summed).
 *   - cache_creation = the largest cache block created by any request. Each
 *                      request with a `cache_control` marker can create (or
 *                      extend) a cache block; the biggest of them dominates,
 *                      because every later block reuses the earlier ones as a
 *                      prefix rather than adding on top of them.
 *
 * Members that don't apply to a given call are added as zero, and a missing
 * or malformed report is ignored.
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
    cacheCreation: n(stepUsage.prompt_tokens_details?.cache_creation_input_tokens),
  };
  if (!usage) {
    return {
      prompt_tokens: step.prompt,
      completion_tokens: step.completion,
      total_tokens: step.total,
      reasoning_tokens: step.reasoning,
      cached_tokens: step.cached,
      cache_creation_input_tokens: step.cacheCreation,
    };
  }
  const prompt = Math.max(usage.prompt_tokens, step.prompt);
  const completion = add(usage.completion_tokens, step.completion);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    reasoning_tokens: add(usage.reasoning_tokens, stepUsage.completion_tokens_details?.reasoning_tokens),
    cached_tokens: Math.max(usage.cached_tokens, step.cached),
    cache_creation_input_tokens: Math.max(usage.cache_creation_input_tokens, step.cacheCreation),
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
/** Stable identity for one tool request: name + canonical (parsed) arguments. */
export function canonicalToolCall(call) {
  const name = call?.function?.name ?? "";
  let args = call?.function?.arguments;
  try {
    args = stableStringify(JSON.parse(args ?? "{}"));
  } catch {
    args = String(args ?? "").trim();
  }
  return `${name}\u0000${args}`;
}

export async function executeToolCall(call, { cwd, signal, confirm, authorize, maxToolResultChars, toolState, onEvent = () => {} }) {
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

  onEvent({ type: "tool_call", name: toolName, args, raw: rawArguments, id: call?.id });

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
  onEvent({ type: "tool_result", name: toolName, ok: !result?.error, result, id: call?.id });

  let nextCwd = cwd;
  if (result && typeof result.cwd === "string" && result.cwd !== cwd) {
    nextCwd = result.cwd;
    onEvent({ type: "cwd_change", cwd: nextCwd });
  }
  return { result, cwd: nextCwd };
}

/**
 * Keep any tool—present or future—from flooding the next model request.
 *
 * Truncation is tail-first: the last chunk of the serialized result is kept
 * (the part a failing build's error shows up in), and the full output is
 * spilled to a tmp file whose path rides in the result so the model can read
 * any range of it with the read tool instead of guessing from a head slice.
 */
async function boundToolResult(result, maxChars = 50_000) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (err) {
    return { error: true, message: `tool result was not JSON-serializable: ${err.message}` };
  }
  if (serialized === undefined) return { error: true, message: "tool returned undefined" };
  if (serialized.length <= maxChars) return result;

  let context = {
    ...(typeof result?.path === "string" ? { path: result.path } : {}),
    ...(typeof result?.cwd === "string" ? { cwd: result.cwd } : {}),
    ...(Number.isInteger(result?.nextOffset) ? { nextOffset: result.nextOffset } : {}),
  };
  // A very long path/cwd must not defeat the cap it is meant to help explain.
  // Keep exact continuation context when it is reasonably small; otherwise
  // prefer a useful result preview and the hard size guarantee.
  for (const key of ["path", "cwd"]) {
    if (JSON.stringify(context[key] ?? "").length > maxChars / 3) delete context[key];
  }

  const fullPath = await spillFullResult(serialized);
  const message = fullPath
    ? `tool result exceeded ${maxChars} characters; full output at ${fullPath}`
    : `tool result exceeded ${maxChars} characters`;

  // Previews are JSON fragments, so embedding them re-escapes quotes/backslashes
  // and inflates the payload beyond a naive character count — binary-search the
  // largest tail that truly fits rather than trusting arithmetic. Dropping a
  // context field frees room and the search re-runs larger.
  const skeleton = () => ({
    ...(result?.error ? { error: true } : {}),
    ...context,
    truncated: true,
    originalChars: serialized.length,
    message,
    ...(fullPath ? { fullPath } : {}),
  });
  // Free context room (cwd first, then path) before ever giving the tail up —
  // the preview is the actionable part and context fields can be recovered from
  // the spilled file. nextOffset stays: dropping it would break read paging.
  for (;;) {
    const base = skeleton();
    let lo = 0;
    let hi = Math.min(serialized.length, maxChars);
    let best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = mid === 0 ? { ...base, preview: "" } : { ...base, preview: serialized.slice(-mid) };
      if (JSON.stringify(candidate).length <= maxChars) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
    if (Object.hasOwn(context, "cwd")) {
      delete context.cwd;
      continue;
    }
    if (Object.hasOwn(context, "path")) {
      delete context.path;
      continue;
    }
    // Config validation keeps this limit >= 500, so the minimal object fits.
    return base;
  }
}

/** Write an oversized tool result's full payload to the spill dir. */
async function spillFullResult(serialized) {
  try {
    const dir = join(argusHome(), "tmp");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `tool-result-${randomUUID()}.json`);
    await writeFile(file, serialized, "utf8");
    return file;
  } catch {
    // A spill failure must never fail the turn; the preview still carries the
    // actionable tail.
    return null;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

/** Build the chat request body once per step (measured and sent, never twice). */
function buildRequestBody(config, messages, toolList) {
  return buildBody({
    model: config.model,
    systemPrompt: config.systemPrompt,
    messages,
    tools: toolList,
    contextCache: config.contextCache,
  });
}

/**
 * One model step, retried at the loop level when the stream died before any
 * visible text arrived (a disconnect ahead of the first token, or a body that
 * produced nothing). Once a text/thinking delta has been forwarded the step is
 * not retried — re-streaming would duplicate the visible text in the
 * transcript — and it fails as it always has. The in-request `request()`
 * retries inside llm.mjs already cover the initial POST; this wraps the whole
 * step on top of that for mid-body failures.
 */
async function runModelStep(config, outgoingMessages, toolList, { body, onEvent, signal, stepRetries }) {
  for (let attempt = 0; ; attempt++) {
    let sawContent = false;
    const forward = (ev) => {
      if (ev.type === "text_delta" || ev.type === "thinking_delta") sawContent = true;
      onEvent(ev);
    };
    try {
      return {
        ...(await streamAssistant(config, outgoingMessages, toolList, forward, signal, body)),
        sawContent,
      };
    } catch (err) {
      // Only a pristine failure may be retried: a user abort, a step that
      // already streamed visible text, or a request that *already* exhausted
      // its in-`request()` retry budget (`LLM request …` errors) all fail the
      // step — re-running those would duplicate text or multiply the retries.
      if (signal?.aborted || sawContent || err?.message?.startsWith("LLM request ") || attempt >= stepRetries) throw err;
      const delayMs = 250 * 2 ** attempt;
      onEvent({ type: "retrying", reason: "step", attempt: attempt + 1, budget: stepRetries, delayMs });
      await abortableDelay(delayMs, signal);
    }
  }
}

/**
 * Stream one assistant reply from the model, emitting text deltas as they
 * arrive and returning the fully-assembled assistant message. `body` is the
 * prebuilt request body passed down so measurement and send share one object.
 */
async function streamAssistant(config, messages, toolList, onEvent, signal, body = null) {
  onEvent({ type: "assistant_start" });
  const stream = streamChat({
    ...config,
    messages,
    tools: toolList,
    signal,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    // Surface retry backoffs (notably the long quota waits) through the same
    // event channel as everything else.
    onEvent,
    ...(body ? { requestBody: body } : {}),
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
