# Progress

Dated change records, newest first. Never rewrite an entry; add a dated correction.
Earlier records are preserved verbatim in
[progress through the prior September checkpoint](docs/archive/progress-through-2026-09-09.md)
and [progress through 2026-08-17](docs/archive/progress-through-2026-08-17.md).
See the [archive index](docs/archive/README.md) for provenance.

---

#### 2026-09-26 — bounded artifact growth and SIGTERM shutdown

- Replaced per-revision full-history context artifacts with one atomically
  replaced, indexed source file per session. Older covered messages remain
  available, while stored source bytes no longer multiply with each revision.
- Added cooperative SIGTERM handling to the TUI and headless frontend. Both
  request cancellation and exit 143; the TUI restores terminal modes within a
  bounded shutdown, and headless saves an interrupted outcome when possible.

**Verified in this session:** `npm run verify` checked 91 modules and 19 live
documents; **369/369 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. A real pseudo-terminal smoke check observed TUI
exit 143 and restored bracketed-paste mode after SIGTERM. A child-process test
observed headless exit 143 and a saved interrupted outcome. This does not test
power loss or guarantee that every effect settles before a forced deadline.

#### 2026-09-26 — remote verification of terminal-agent foundations

Commit `4ca52e1` was pushed to `origin/main`. The [Verify workflow](https://github.com/cwdghh/argus/actions/runs/36246372596)
completed successfully for Ubuntu and macOS on Node 22 and 24 (four jobs).
This updates the earlier entry's “remote CI not run” status; no paid live-provider
coding or continuation trials have been performed.

#### 2026-09-26 — verification correction and context retrieval check

The entry below recorded 365 tests before the final omitted-constraint retrieval
case was added. The final `npm run verify` checked 91 modules and 19 live
documents with **366/366 offline tests passing** on macOS / Node v26.5.0;
`git diff --check` passed. The retrieval case used a local mock provider to
read a private source artifact through the existing `read` tool. It does not
establish that a live model will choose to retrieve an omitted constraint.

#### 2026-09-26 — minimal terminal-agent foundations and recovery qualification

**Status: ✅ U0, E2–E3, I1–I2, and first C1/V1 slices implemented; ⏳ live E0 baseline and broader qualification pending**

- Added `argus doctor` and a documented local install path. An isolated global
  install launched `argus --help` outside the checkout. Kept the four default
  tools and dependency-free runtime.
- Added six reproducible coding tasks with external behavioral verifiers and an
  opt-in provider runner. Reports include fixture and source hashes, raw trial
  outcomes, timing, tool failures, and reported usage without transcripts or
  configured secrets. No paid baseline has been run.
- Supervised shell processes with bounded live previews and private output
  artifacts. Exit, termination, output completeness, and cwd are separate facts.
  Added awaited session checkpoints, exclusive local writer ownership,
  conservative recovery, and explicit uncertain-effect resolution. An unexpected
  frontend error leaves the synced run prefix unfinished rather than sealing it.
- Added explicit continuation in both frontends and persisted steering in the
  TUI. Steering is applied at safe boundaries; obsolete calls receive local
  `not_executed` results. A failed run journal must be reloaded before the TUI
  starts another run.
- Added bounded lower-trust context revisions with source hashes and private
  retrieval artifacts, plus optional exact-command verification evidence with
  observed status and freshness. D4–D6 were selected for evidence-backed
  completion, tested provider breadth, and measured admission of new concepts.

**Verified in this session:** `npm run verify` checked 91 modules and 19 live
Markdown documents; **365/365 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. An isolated global installation launched the CLI.
A real TTY with a local mock provider confirmed shell preview, Esc cancellation,
`/continue`, and `/steer`. SIGKILL recovery was checked before intent, after
intent, and after a saved result. No paid live-provider baseline, live-provider
continuation check, or remote CI run was performed. These offline checks do not
establish power-loss durability or universal provider compatibility.

#### 2026-09-24 — normalized run outcomes and request accounting (E1)

**Status: ✅ E1 implemented; ⏳ checkpointed recovery and live-provider validation pending**

- `runTurn` now returns one terminal `outcome` with a stable reason and human
  message for normal completion, interruption, model truncation, model failure,
  and local limits. A normal model ending is not a claim that the task is correct.
  Both frontends show unfinished outcomes; headless exits 1 for failed,
  truncated, or limited runs and 130 for interruption.
- Preserved observed partial text once in replayable history after cancellation
  or a stream failure. Incomplete tool arguments are not executed. Local partial
  and truncation metadata is removed from provider messages. A late stop does
  not rewrite an already completed final reply, while a pending tool batch is
  stopped before side effects.
- Added local run, model-step, request-attempt, and tool-attempt identifiers.
  Actual request reports and summed reported counts remain separate from the
  existing context display metric. Retry attempts without usage remain unknown;
  repeated usage chunks for one request count once. Additive timing metadata
  persists outcomes, partial data, and attempt records without changing the
  session format version or old-session loading.
- Updated the implemented architecture, session contract, README, gaps, and
  roadmap. E2–E3 shell supervision and checkpoints remain future work; no
  crash-safe continuation or billing estimate is implied by E1.

**Verified in this session:** `npm run verify` checked 73 modules and 19 live
Markdown documents; **321/321 offline tests pass** on macOS / Node v26.5.0.
No live-provider evaluation, real-terminal check, or remote CI run was performed.

#### 2026-09-24 — product choices and tool clarity

**Status: ✅ D1–D3 selected and tool-focused slice complete; ⏳ future capabilities pending**

- The owner delegated the primary direction: an everyday coding partner with an
  inspectable, minimal core; recoverability when priorities conflict; and
  human-directed execution. D4–D6 remain open in the decision ledger. The
  tool interface was prioritized ahead of the roadmap workstreams.
- Kept the four default tools and dependency-free runtime. Clarified their
  model-facing descriptions and rejected ambiguous `edit` combinations:
  `endLine` without `startLine`, and `all: true` with any range edit.
- Preserved trailing spaces on the final line of a paged `read` result. Changed
  `bash` capture overflow from apparent success to an explicit error with
  unknown completion and no new cwd. Bounded results keep the error reason;
  failed command stdout/stderr now appears in the transcript preview when it
  fits the result cap.
- Updated the tool contract, surface rationale, current gaps, product ledger,
  and next-action ordering. No E0–P1 capability was implemented in this slice.

**Verified in this session:** `npm run verify` checked 73 modules and 19 live
Markdown documents; **314/314 offline tests pass** on macOS / Node v26.5.0.
Targeted tool and format tests and `git diff --check` also passed. No live-provider
tool-choice trials, real-terminal checks, or remote CI run were performed; model
tool-choice quality remains unmeasured against a live provider.

#### 2026-09-24 — future design and product discussion

**Status: ✅ design draft prepared; ⏳ owner choices and feature implementation pending**

- Added a proposed product identity and decision ledger, with explicit pending
  status for primary use, tradeoffs, autonomy, verification, provider breadth,
  and concept admission. No unanswered preference was treated as approval.
- Added stable work IDs and reusable future-session briefs. Detailed proposals
  cover outcomes/accounting, shell lifecycle, checkpoints/ownership/recovery,
  interruption, steering, context provenance, behavioral evaluation, verification
  evidence, and compatible-model fallback. Each defines dependencies and acceptance.
- Preserved the earlier continuation proposal verbatim in the archive and drafted
  a replacement. Corrected its unconditional crash-losslessness promise and its
  assumption that continuation needs a fabricated model input-tool call. Checked
  the OpenAI Chat message reference and function-calling guide; other compatible
  endpoints still require their own verification.
- Updated discovery, ownership, gaps, and recommended next actions. This is a
  documentation-only change; the verified baseline tag remains unchanged and the
  proposed capabilities have not been implemented.

**Verified in this session:** `npm run verify` checked 73 modules and 19 live
Markdown documents; **312/312 offline tests pass** on macOS / Node v26.5.0.
The new archive was compared byte-for-byte with its pre-change source.
`git diff --check` passed. No live-provider trials, real-terminal checks, or
remote CI run was performed; this verification checks the repository and document
links, not the effectiveness of unimplemented designs.

#### 2026-09-24 — verified development baseline

**Status: ✅ done**

**Reference checkpoint:** `baseline/2026-09-24` (local annotated Git tag).
The user authorized aggressive refactoring and tagging the completed outcome;
this authorizes the local baseline commit under the clarified repository rule.

- Split the agent coordinator from model-step retries, tool dispatch, result
  bounds/spill handling, protocol/loop bookkeeping, and usage aggregation.
- Split shell policy/execution, atomic file replacement, and schema validation
  from the tool registry. Model-visible tool names, descriptions, and schemas
  remain identical to the previous commit; no runtime dependency was added.
- Split session names/paths, catalog operations, streaming readers, and the
  serialized writer while retaining the public `session/index.mjs` boundary.
  Split TUI input/action handling and turn orchestration from the controller.
- Corrected atomic file creation to use exclusive installation instead of a
  check/rename race. Replacement preserves executable permissions and existing
  symlinks; dangling symlinks remain intact and return an error.
- Corrected session discovery to honor metadata after earlier turns. New turn
  records put `type` first for efficient metadata scanning; legacy field orders
  still load. Invalid non-record JSON warns instead of crashing. Metadata dedupe
  advances only after successful writes; appending after a torn final record
  separates the next valid record without rewriting existing bytes.
- Fixed pairing across reused call IDs, allowed a different call to break an
  alternating no-progress cycle, kept result caps when spill paths are long,
  made spill files owner-private, released completed retry listeners, and
  invalidated rendering caches when the detected terminal theme changes.
- Added `docs/conventions.md` and `docs/sessions.md`, updated the module map,
  architecture, tool contract, user guide, and failure-inspection instructions.
  Replaced stale status narratives with concise live gaps and next actions.
  Preserved the old progress log and W1–W6 plan verbatim in new archive files.
- Added `.editorconfig`, `.gitattributes`, `npm run check`, `npm run verify`,
  disposable test homes, and a CI matrix for Linux/macOS on Node 22/24.
  Documented annotated baseline tags separately from versioned releases.

**Corrections to earlier records and docs:** W5 accepts provider tool batches
sequentially; old single-call rejection text was obsolete. W4 metadata can occur
between turns, so the head-only discovery assumption was incorrect. W2's blanket
"every item" status did not implement its optional live shell streaming item.
A capture-buffer overflow can terminate a shell process; its truncated output
must not be read as proof of successful completion. Session data supports audit
and reconstruction of saved messages, not byte-for-byte network replay. Original
historical wording and dates remain unchanged in the archive.

**Verified in this session:**

- `npm run verify`: 73 modules / 14 live documents checked; **312/312 tests pass**
  (16 new regression tests), on macOS with Node **v26.5.0**. Tests include direct
  execution of all four tools, mock-provider/headless flows, and TUI input/render
  behavior without a real terminal.
- Model-visible tool snapshot compared against pre-refactor `HEAD`: identical.
- Both new archive files compared with their pre-refactor originals: byte-identical.
- `git diff --check`: clean.

**Not run:** live-provider evaluations, a real-terminal interaction session, or
the remote CI matrix. Remaining features and known limits live in
[GAPS.md](GAPS.md) and [NEXT_STEPS.md](NEXT_STEPS.md); the baseline does not claim
those future capabilities are implemented.
