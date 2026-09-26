# Interrupt, continue, and steering

Status: **core interaction implemented; qualification and refinements remain**.
Work IDs I1–I2.
The earlier proposal is preserved [verbatim in the archive](archive/interrupt-resume-2026-09-24.md).
The implemented commands and limits live in [README](../README.md),
[architecture](architecture.md), and [sessions](sessions.md). This file retains
the design reasoning and the remaining verification matrix. Execution boundaries
are owned by [E1–E3](design/execution.md).

## I1 — Stop and continue

The intended interaction is a new model request using recorded progress and the
user's continuation instruction. It is not restoration of a network stream or
an instruction pointer inside a shell process.

| State/action | Proposed behavior |
| --- | --- |
| Working + Esc or Ctrl-C | Request cancellation immediately; show stopping until the model/tool settles. Keep any editor draft. |
| Stopping + repeated stop | Request forceful owned-process cleanup; show what remains uncertain. Avoid starting another run. |
| Idle after interruption | Show the reason and available actions, including `/continue`. |
| `/continue` | Continue the latest resumable run using an explicit recorded user continuation instruction. |
| Nonempty submitted draft | Start a follow-up linked to the interrupted run, using the supplied correction. |
| Empty Enter | Remain idle; no accidental paid request. A shortcut can be reconsidered after usage evidence. |
| Restart with unfinished run | Show the recovered prefix, uncertainty, and continuation action; never execute automatically. |
| SIGTERM / terminal shutdown | Attempt bounded cooperative checkpoint and cleanup; exit with explicit interruption status where possible. |

The TUI `/continue` and headless `--continue --session` paths are implemented.
SIGTERM-specific exit handling and machine-readable headless results remain open.
Keep continuation separate from selecting/loading a saved session. Completion, truncation, failure, and
interruption should each offer context-appropriate follow-up wording. Continuing
must not change a historical outcome to completed; it creates a linked run.

Headless mode returns 130 for user interruption and 1 for failed, truncated, or
limited outcomes. Successful model termination can exit zero but does not
certify task correctness. A machine-readable result option and SIGTERM-specific
code remain open. Headless continuation is explicit, targets a named session,
and fails
clearly when user input is needed; it must not wait forever for a hidden prompt.

## Transcript and protocol projection

Persist the original observed partial text without appending a marker into its
bytes. Store interruption/partial status as local metadata. At continuation,
project messages using these rules:

1. Keep completed assistant messages and known tool results in original order.
2. Keep partial assistant text once as assistant content; omit incomplete streamed
   tool arguments from the executable conversation. Preserve them as diagnostic
   partial data if useful, with an explicit size bound.
3. For a complete assistant tool-call batch, retain the calls and produce one
   result per call before another user/assistant message. Known results remain
   exact; unstarted calls receive a local `not_executed` result; uncertain attempts
   receive an explicit local `execution_uncertain` result. Those messages describe
   Argus's state, not a fabricated successful tool return.
4. Add the user's continuation as a user message, with a clearly delimited local
   recovery note if needed. Do not manufacture a model-issued input tool call.
5. Preserve existing role/provenance; interruption does not promote past content
   into higher-priority instructions. Validate call/result pairing before send.

For uncertain shell/write effects, the UI requires explicit inspect/retry/abandon
resolution before resuming autonomous execution. Read-only inspection may proceed;
never let a continuation silently replay the unresolved operation. Record the
resolution and any resulting new attempt as new facts. This gate follows actual
uncertainty, not every ordinary cancellation.

OpenAI's [Chat message reference](https://developers.openai.com/api/reference/resources/chat)
allows assistant content, and its [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
shows tool outputs linked to returned call IDs. These support a conventional
message projection; they do not establish universal compatibility with every
compatible endpoint. The preceding projection is an Argus design choice. Test
it against each supported target before claiming support. Reasoning/signature
extensions require their own adapter policy; do not infer them from text fields.

## I2 — Steering an active run

The TUI accepts explicit `/steer <text>` while work is active. Ordinary typed
input remains a next-turn draft. Accepted steering is acknowledged only after it
is persisted, with a local ID and state: queued, applied, or cancelled. The user
can inspect/remove queued instructions before application. A submission race at
run completion must become a visible queued follow-up, never disappear.

Queued steering is applied in FIFO order at the next safe boundary:

- During model streaming: finish that response, record it, then consume steering
  before dispatching its tools. Mark skipped calls `not_executed` and ask the model
  to reconsider under the new instruction. Esc provides immediate stop if waiting
  for the stream is unacceptable.
- During a tool: let it settle, persist its result, then consume steering before
  starting the next call. Do not inject text into shell stdin.
- During an approval: cancel the pending approval and skip the obsolete call;
  reconsider the batch under the new instruction. A late approval reply must not
  authorize a different call.
- At a boundary: close any outstanding call/result segment before appending user
  messages. Apply no steering halfway through a filesystem replacement.

Later instructions may contradict earlier ones; retain both and their order,
without guessing that two messages can be merged. Use explicit logical run IDs,
not every `role: user` message, to define compaction and usage groups. On restart,
restore queued steering and offer continuation; do not auto-apply it into a new
unrelated task. Active session switching must first settle or stop the run.

A combined stop-and-steer shortcut remains a later ergonomic refinement.
The implemented queue holds at most eight instructions of 4096 characters each.
Steering needs no additional model tool.

## Verification and delivery gates

I1 depends on E1–E3. Mock interruption before text, midword, during partial JSON,
after a complete batch, mid-tool, between calls, and after the final result before
run-end persistence. Verify exact-once display, valid pairs, known-result reuse,
and uncertainty resolution across restart. Include interruption during compaction
and fallback if those features are present.

I2 additionally depends on I1. Test multiple queued corrections, cancellation,
approval races, submission at final completion, persistence failure, repeated
provider call IDs, and restart with pending steering. Assert no skipped operation
runs and the final model request contains the accepted instruction exactly once.

Run both frontends against mock providers. Exercise the keyboard behavior in a
real terminal before claiming it works there. Run a small opt-in live-provider
continuation matrix before claiming protocol compatibility. Update README,
architecture, sessions, tools (only if behavior changes), and gaps at delivery;
move implemented contracts into their permanent owners.
