# Interrupt → Continue: Design Spec

Status: **proposed** (approved by discussion 2026-08-18; implementation pending)

Tracks: [GAPS.md §5 Session persistence](../GAPS.md), [§7 Robustness](../GAPS.md)

## 1. Goal

Interrupting a running turn (Esc / Ctrl-C, or an external SIGINT/SIGTERM) must be
**lossless and naturally resumable at the interrupt point**:

- Every byte of progress survives: the partial assistant text, completed
  `tool` results, and the working directory.
- The user can continue from the exact interrupt point without re-stating the
  goal, re-doing completed work, or paying for tokens that were thrown away.
- Nothing invalid is ever sent to the model (a partial assistant message with
  dangling/partial `tool_calls` is the one thing the protocol forbids).
- Restarting the process (crash, SIGTERM, terminal close) lands on the same
  "Enter to continue" state as an in-TUI interrupt.

## 2. Non-goals

- Re-running a partially-killed tool as part of resume (v1: the killed step is
  dropped; the model re-issues it during the continuation). Separate design
  needed for idempotent rerun.
- Character-perfect "resume the same HTTP request" semantics. The provider sees
  a fresh request; we make that request *continue the interrupted message* (see
  §4).

## 3. Background: how pi handles this (reference only)

Verified in `references/pi` (conceptual reference, not copied):

- `stopReason: "aborted"` is a first-class assistant state
  (`packages/protocol/src/schemas.ts`, `AbortedAssistantTranscriptItemSchema`),
  persisted verbatim in the transcript; the partial is **displayed but never
  sent to the model**.
- `packages/agent/src/agent-loop.ts` refuses to continue from an assistant
  message (`agentLoopContinue`, line 74/131) and relies on **steering user
  messages** (`session.steer()`) or the next user prompt for continuation — a
  fresh turn over the aborted transcript.
- pi's Anthropic kernel cannot "continue from a truncated assistant"
  (Anthropic charges the full context on each request), so pi falls back to
  full-recontext on retries.

**Decision for argus:** pi's shape (partial persisted, never sent as a
truncated assistant) is right, but its continuation seam (next user prompt /
steer) is *not natural*. argus instead constructs the **native
assistant(tool_calls) → tool → assistant continuation seam** so the continuation
is a first-class protocol event, not a synthetic user message.

## 4. Core design

### 4.1 The continuation seam

The universal, provider-native continuation shape is:

```
assistant (text …, tool_calls: […, {id: I, function: {name: "request_input", arguments: "{}"}}])
tool (tool_call_id: I, content: "<the user's reply>")
assistant (the model continues its own message; now includes the user's input)
```

- **Trim:** when a turn is interrupted mid-stream, the assistant message is
  *trimmed*: partial text and completed text are kept; any partial tool calls
  and any fully-formed-but-unexecuted tool calls are stripped (see
  decision §7.3). A brand-new `request_input` tool call is appended on top of
  the trimmed message only at continuation time. The result is a **valid,
  replayable assistant message** — spec-legal to persist and re-send for any
  provider.

- **Marker:** the text ends with an `[INTERRUPTED]` marker (e.g. appended on
  its own line after the partial text) so the model unambiguously knows the
  message is incomplete — even when the stream was cut mid-word. Decision:
  always append (one token), see §7.2.

- **`request_input` tool:** special-purpose, protocol-specific. It is declared
  in the **continuation request's** `tools` array, and in the history replay
  (Anthropic validates that historical tool names are present; OpenAI is safer
  with it listed). It carries no schema burden beyond `{}`. Its execution is:
  prompt the user inline ("ask mode"), return their free-text reply as the tool
  result, or abort when dismissed.

- **Fresh ids:** every continuation constructs a **new `tool_call_id`**
  (reused ids across requests are invalid).

### 4.2 Why this is the most reasonable approach

| Option | Verdict |
|---|---|
| Discard partial text; user re-types "continue" | Wastes output tokens, blinds the model to the very text the user refers to. **Rejected.** |
| Re-send partial text embedded in a synthetic user message | Spec-legal but: text appears twice (prompt + transcript), reads as foreign context, model restart not a true continuation. pi's fallback. |
| Send the partial text as a truncated `assistant` (mid-word) | Protocol-invalid for OpenAI-compatible / ambiguous for Anthropic; may 400. **Rejected.** |
| **Trim + `request_input` seam (this design)** | The partial text is re-sent exactly once, as the **model's own words**; the user's input arrives as a first-class `tool` result; continuation is native. **Chosen.** |

Note: re-sending the partial text in the continuation request is unavoidable —
a stateless provider cannot know it otherwise. This design sends it exactly
once, in the least distorting position.

### 4.3 Guarantees (locked by tests)

- A persisted turn never contains a dangling `tool` message (no `tool` without
  a matching `assistant` tool call in the same turn).
- A persisted turn never contains an assistant message with partial (unparsed)
  tool calls.
- A resume-replayed history is a valid provider message list (every
  `tool` has its `assistant(tool_calls)` parent; the last message is a `user`
  or `tool`, never a bare partial `assistant`).
- Partial-turn bytes round-trip exactly (append → load → reconstruct).
- The continuation request includes `request_input` in `tools` and uses a fresh
  `tool_call_id` per continuation.

## 5. Component changes

<table>
  <tr><th>Piece</th><th>Change</th></tr>
  <tr>
    <td><code>src/agent.mjs</code></td>
    <td>
      <code>runTurn(…, { resume: true })</code>: skip synthesising a user
      message for the turn; instead execute the pending <code>request_input</code>
      call found in the last history message before the first model call, using
      a new <code>opts.ask</code> channel; then run the normal loop. On abort,
      return <code>{ partialText }</code> alongside <code>{ aborted, messages }</code>.
    </td>
  </tr>
  <tr>
    <td><code>src/tools.mjs</code></td>
    <td>
      Add a <code>request_input</code> tool to the registry, <strong>excluded
      from the default <code>tools</code> list</strong> (decision §7.1). The
      tool list for a continuation turn is <code>[...defaultTools,
      request_input]</code>.
    </td>
  </tr>
  <tr>
    <td><code>src/tui.mjs</code></td>
    <td>
      After an interrupt: persist the trimmed partial assistant message and show
      <code>⏸ interrupted — Enter to continue</code>. <strong>Enter</strong>
      runs the continuation (builds the <code>request_input</code> call on a
      copy of the trimmed assistant message); typing a new prompt instead
      starts a fresh turn over history that already includes the partial
      message. New <strong>ask mode</strong>: inline free-text prompt overlay,
      Enter = submit, Esc = abandon (aborts the turn again rather than feeding a
      null to the model).
    </td>
  </tr>
  <tr>
    <td><code>src/session/*</code></td>
    <td>
      <code>Session.appendTurn({ partial: true })</code> writes a partial turn
      whose <code>messages</code> end in the trimmed assistant message (never a
      dangling call). <code>sessionData</code> exposes <code>partial</code>
      state so startup auto-resume can offer Enter-to-continue after a
      crash/SIGTERM. The transient <code>request_input</code> pair only exists
      inside a live continuation and is persisted as part of the completed turn
      once answered.
    </td>
  </tr>
  <tr>
    <td><code>src/main.mjs</code> / <code>src/tui/lifecycle.mjs</code></td>
    <td>
      SIGINT/SIGTERM handling: TUI — first SIGINT aborts the turn and stays
      alive (same as Esc), second quits; SIGTERM settles the session write queue
      then exits. Headless — persist the partial turn, set <code>exitCode
      130</code>, no fake success. (Without flushing, external kills still lose
      the turn.)
    </td>
  </tr>
</table>

## 6. End-to-end flows

### 6.1 Interrupt while streaming text (TUI)

```
Esc/Ctrl-C
  → runTurn returns { aborted: true, partialText }
  → session.appendTurn({ partial: true, messages: […, trimmed-assistant], … })
  → header/footer: "⏸ interrupted — Enter to continue"
Enter
  → continuation turn:
      history ends with trimmed-assistant (rebuilt without text trim; keeps text,
       strips any tool calls, appends [INTERRUPTED])
      tools = [read, write, edit, bash, request_input]
      runTurn(resume: true) runs request_input first → ask mode → user types
      "finish that, and check the api error too"
      → tool result appended → normal loop → model continues its own message
Any other key / new prompt
  → fresh turn over history (includes the partial assistant message);
    the interrupt is lossless either way
```

### 6.2 Interrupt after completed tool(s)

```
tool A result persisted (assistant(tool_calls) + tool rows are in history,
                           valid)
interrupt during next answer
  → partial turn ends: [user, assistant(call A), tool(A), assistant("…text[INTERRUPTED]")]
Enter to continue
  → the model sees A's completed result + its partial text;
    continuation is one natural message
```

### 6.3 Interrupt mid-tool (bash killed)

```
assistant(call A) is in history, A's result was never produced
  → the killed step is dropped (v1)
  → partial turn ends: [user, assistant(call A)]
Enter to continue
  → model re-issues the tool call (fresh id) as part of the continuation
```

### 6.4 Process restart (SIGTERM / crash)

```
SIGTERM → flush write queue → exit
next start: default-resume picks this session
  → sessionData exposes partial:true → same "⏸ interrupted — Enter to continue"
    gate (decision §7.4)
```

### 6.5 Headless

```
argus "prompt" --session X  (Ctrl-C / SIGINT)
  → persist partial turn, exitCode 130, stderr note "interrupted; run with
    the same --session to continue"
```

## 7. Open decisions (confirm before implementing)

| # | Decision | Leaning |
|---|---|---|
| 7.1 | `request_input` visibility | **(a)** hidden — only in continuation requests (keeps tool surface at four; recommended); or **(b)** always available so the model can ask the user proactively. |
| 7.2 | `[INTERRUPTED]` marker | **Always** append (even when not cut mid-word, even with partial text) — one token removes all ambiguity. |
| 7.3 | Fully-formed-but-unexecuted tool calls at interrupt | **Drop and let the model re-issue** on continuation (idempotency-safe). Alternative: queue them for execution during resume. Recommend (a). |
| 7.4 | Auto-offer Enter-to-continue on startup when the latest session ends in a partial turn | **Yes for SIGTERM/crash** (auto-resume already picks the right session); explicit `/resume` + prompt only would be the conservative alternative. |

## 8. Test plan (same change, per AGENTS.md)

- `session.test.mjs` — partial-turn JSONL round-trip; `sessionData` exposes
  `partial`; no dangling `tool` in any persisted partial turn; replayable
  history invariant.
- `agent.test.mjs` — `runTurn(resume:true)`: `request_input` executed first
  (ask channel); continuation appends tool result and continues the model's own
  message; abort during ask mode returns aborted without feeding null.
- `tools.test.mjs` — `request_input` is in the registry but not exported in the
  default tool list; continuation tool list includes it.
- `tui.test.mjs` — interrupted → `interrupted` state; Enter runs continuation;
  ask mode overlay Enter/Esc; fresh prompt over partial history.
- `transcript.test.mjs` — partial assistant block renders with `[INTERRUPTED]`.
- `headless.test.mjs` — SIGINT persists partial turn + exit 130.

## 9. Docs to update in the same change

- `docs/tools.md` — `request_input` (registry entry, hidden from default list).
- `src/tools.mjs` header comment + `AGENTS.md` grid — tool surface note.
- `docs/architecture.md` — `runTurn` resume mode, ask mode, signal handling.
- `GAPS.md` §5/§7 status notes; `PROGRESS.md` entry.