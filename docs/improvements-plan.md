# Development implementation brief

Read [conventions](conventions.md) before implementing a workstream.
[NEXT_STEPS.md](../NEXT_STEPS.md) owns the priority order;
[GAPS.md](../GAPS.md) owns unresolved design questions. This brief gives scope
and acceptance criteria for the leading candidate without changing its status
to an active commitment.

The original W1–W6 audit is preserved verbatim in
[the archived plan](archive/improvements-plan-2026-09-24.md). Its shipped work,
corrections, and the repository baseline are recorded in
[PROGRESS.md](../PROGRESS.md). Do not use archived file anchors or commit rules
as current instructions.

## Interrupt and continue

The interaction proposal is [interrupt-resume.md](interrupt-resume.md). Reconcile
it with the current code before implementation, especially its proposed
`request_input` seam and the fixed default tool surface.

Scope the work around these boundaries:

1. **Agent outcome:** distinguish completed, failed, truncated, and interrupted
   outcomes. Keep executed tool results, trim incomplete calls, and retain partial
   assistant text exactly once. Propagate completed provider usage honestly.
2. **Persistence:** define any additive partial-turn record fields and legacy-load
   behavior in [sessions.md](sessions.md). Preserve the original append-only
   history and tool-call/result pairing after interruption.
3. **Interaction:** use `tui/turn.mjs` for outcome handling and `tui/input.mjs` for
   continuation input. Specify Enter, edited follow-up input, explicit resume,
   SIGINT, and headless behavior before adding a new mode or tool.
4. **Verification:** mock SSE interruption before/after text, during a tool, and
   between calls in a sequential batch; resume after process restart; assert no
   duplicated text, side effects, usage, or dangling tool results. Exercise the
   completed interaction in a real terminal before claiming terminal verification.

Acceptance: a user can interrupt and resume using the agreed interaction while
completed work and partial text stay coherent across frontend and process
boundaries. No added runtime dependency, implicit schema expansion, or unsupported
provider assumption is part of this brief.

## Deferred work from the original audit

Render caching and shared block projection are implemented; see the progress
record. Optional kitty keyboard negotiation and live bash output remain open.
Semantic and mid-turn compaction, fallback models, steering, and sub-agent work
remain candidates in the live gap/priority documents. Each needs its own bounded
brief and tests when selected.
