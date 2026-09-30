# Progress

Dated change records, newest first. Never rewrite an entry; add a dated correction.
Earlier records are preserved verbatim in
[progress through the prior September checkpoint](docs/archive/progress-through-2026-09-09.md)
and [progress through 2026-08-17](docs/archive/progress-through-2026-08-17.md).
See the [archive index](docs/archive/README.md) for provenance.

---

#### 2026-09-30 — full focused tool follow-up for the E0 guidance candidate

- Ran the complete nine-fixture focused suite, three trials each, after the
  guidance candidate's coding comparison. All **27/27** final behaviors and
  required tool choices passed, with **24/27 clean** and zero schema mistakes.
  The earlier isolated focused suite was 27/27, 25/27 clean, and zero schema
  mistakes. Four candidate errors beyond expected write-protection rejections
  were recovered: absent instruction-file probes, a macOS `cat -A` failure,
  and a temp-directory cleanup command blocked by the approval backstop.
  Clearer descriptions have not shown an improvement in clean tool use.
- The report has 244,620 reported tokens; charges remain unknown. Saved file
  changes replayed against the pinned external verifier for all 27 trials.
  The private `tools-full.json`, `source-full/` snapshot, and replay are under
  `/Users/chenwei/.argus/evaluations/2026-09-30-e0-guidance/`. The full tools
  report's dirty hash is
  `9468fbce5245c54714b36601b99103a0fb5ee15563aebd7269300e1fd8a48519`;
  its target, config, prompt, tool-surface, and harness hashes match the coding
  candidate. Its source snapshot differs from the earlier candidate only by
  subsequent documentation and progress updates.

**Verified in this session:** `npm run verify` checked 94 modules and 19 live
documents; **387/387 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. No remote CI or real-TTY check was run.

#### 2026-09-30 — E0 guidance candidate and measured comparison

**Status: ✅ small-fixture comparison complete; general coding usefulness remains unproven. Changes on `codex/coding-usefulness` remain uncommitted for human review.**

- Kept the four default tools, canonical `edit.edits[]` schema, optional write
  newline default, and dependency-free runtime. Refined descriptions for
  whole-file overwrite, fresh range reads, portable `/bin/sh` commands, and
  observable check exit status. Conditional designated-check guidance now asks
  for the exact command alone before and after a requested failure-driven fix,
  with other inspection before the final check. The default system prompt asks
  the agent to look for existing instruction files and finish after relevant
  verification. No new tool or schema alias was added.
- Pinned the candidate before paid calls and ran a three-task, one-trial pilot:
  **1/3 full passes**. The failed-command workflow passed; large-output skipped
  the initial failure, and refactor hit the 12-step cap after leaving correct
  files. Pilot results are separate from the full comparison.
- Three candidate trials of all six coding fixtures then scored **18/18 full
  task passes**, **18/18 normal behavioral passes**, and **6/6 required
  failure-before-fix workflows**. The earlier isolated source scored 13/18,
  17/18, and 2/6 respectively. Candidate clean passes were 15/18 versus 11/18.
  The source and prompt changed together, model sampling is stochastic, and the
  pilot was mixed; this is an observed small-fixture improvement, not proof of
  causation or broader repository usefulness.
- Coding had 128 network attempts, 110 tool calls, 11 tool errors (six expected
  initial failing checks and five other recovered errors), zero schema mistakes,
  and no transport/protocol or trial-timeout outcome. Median latency was 24.72s
  (8.93–47.92s), versus 29.92s previously. Reported usage was 578,550 tokens
  versus 492,318 previously; required fields are complete, cache-creation usage
  and charges are unknown. The six command trials each observed exact failing
  and passing `node check.mjs` calls with truncation observed in all three
  large-output trials. Final designated-check freshness remained unknown in
  the disposable non-Git workspaces, so prose was not scored as proof.
- Targeted tool-choice trials (`uncued-numbered-edit`, `range-insert-delete`)
  passed **6/6** final behavior and tool choice, but **4/6 clean**, the same clean
  count as the prior isolated subset. One trial recovered from `oldText`/
  `newText` fields instead of `old`/`new`; focused trials also recovered from a
  stale range read, `cat -A` on macOS, and an approval backstop. Coding trials
  showed wrong existing-file writes and path/cwd mistakes. Description changes
  did not eliminate those tool errors. Focused usage was
  99,184 reported tokens; the pilot used 60,088, excluded from full scores.
- Reports and source snapshot are private in
  `/Users/chenwei/.argus/evaluations/2026-09-30-e0-guidance/`. All 27 pilot,
  coding, and focused trial results replayed against their pinned external
  verifiers and selectors; no configured API key appears in the saved files.
  The full report identifies base `dfaac2a3eeb531ff7b059581207d080a65d14416`,
  dirty hash `4718dcee5245361632f8d58dc33bbe3f9a9e22bf3ec822b928ed98134ccbc9a0`,
  harness hash `097046b8ff86b384f1818a2578f67da4bd864aa9e38c279a9fee172f6ad8e383`,
  prompt hash `4922858d82ee41a4653c03ec861416cf98ee487386c49f13a79cff0dd88cb0bf`,
  and model `qwen3.8-flash`. Endpoint/config/tool and fixture hashes are in
  each report. The candidate snapshot predates these final documentation edits.

**Verified in this session:** `npm run verify` checked 94 modules and 19 live
documents; **387/387 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. No remote CI or real-TTY check was run for these changes.

#### 2026-09-30 — E0 tool-contract comparison and isolated six-task measurement

**Status: named small-fixture baseline measured; broader coding usefulness remains unproven. Changes on `codex/coding-usefulness` are uncommitted for human review.**

- Reassessed the four default tool schemas against live traces. `write` now defaults
  `ensureFinalNewline` to true when omitted; explicit false preserves exact bytes,
  and overwrite still requires opt-in. Clarified the existing read/write/edit/bash
  descriptions without adding a tool or dependency. Kept `edit`'s content and
  range items in one atomic `edits[]` shape. Designated-check guidance reaches
  the model and saved run prompt, and is conditional on the user's task.
- The earlier description-only comparison passed 11/12 full tasks but still had
  two omitted-newline schema errors. An initial default-newline comparison passed
  8/12 with zero schema errors; one refactor trial saw a sibling trial workspace.
  Preserved those raw reports. Isolated every trial's workspace and `ARGUS_HOME`,
  cleaned each after scoring, and reran all six coding fixtures under one pinned
  source/config. The comparison cannot establish an overall quality gain because
  small-sample variation and harness isolation changed between phases.
- A final post-run audit tightened workflow recognition to the exact standalone
  `node check.mjs` command: shell text such as `exit 1; node check.mjs` can skip
  the check while returning a failing status. This scorer correction was tested
  offline and regraded from the preserved traces; current coding and truncation
  pass counts did not change. The raw reports still identify their pinned
  pre-correction harness.
- Isolated coding suite: **13/18 full task passes**, **17/18 normal completed
  behavioral passes**, and **18/18 correct final files**. Per task: bug-fix 3/3,
  refactor 2/3, feature 3/3, dirty-worktree 3/3, failed-command 1/3,
  large-output 1/3. Four command-task failures had correct final files but did
  not establish the required failing-check workflow: the initial check was
  wrapped with `ls`, `echo`, or output redirection, obscuring its status. One
  refactor reached the 12-step limit after leaving correct final files.
- Focused tools: **27/27 final behavior and required tool choice**, **25/27
  clean** across nine fixtures, three trials each. There were zero schema
  mistakes. Three no-final-LF writes used explicit false; six other writes
  omitted the now-optional flag. Content, range, insertion, deletion, and mixed
  batches all passed. The two recovered errors were an absent-file search and
  nonportable `cat -A`. Separate output-truncation qualification passed **3/3**
  behavior, workflow, and observed truncation; **2/3 clean**.
- Across the isolated suites: 48 trials, 271 network attempts, 223 tool calls,
  17 tool errors (eight expected check/protection failures, nine other recovered
  errors), zero schema mistakes, and no transport/protocol or trial-timeout
  outcome. Median latency: coding 29.92s, focused 7.90s, truncation 26.37s.
  Reported usage totals 1,115,638 tokens (463,927 coding prompt and 28,391
  coding completion; 200,409 focused total; 422,911 qualification total).
  Required usage fields are complete; cache-creation usage and charges are
  unknown. These counts cover this isolated phase, not earlier comparisons.
- Completion prose was not scored as proof. All six ordinary command trials
  recorded a final passing designated check, but freshness remained unknown in
  the disposable non-Git workspaces; four lacked trustworthy initial failure
  evidence. In qualification, all three checks were observed before and after
  editing; two final check states became stale after further bash inspection and
  one stayed unknown. Prose and bounded traces support manual review only.
  The next small-fix discussion should prioritize exact standalone checks and
  final-check ordering, excess shell probing/step use, and portable shell
  guidance. No broader feature expansion is justified by this sample.
- Private sanitized reports, protocol, source snapshot, and replay results are
  under `/Users/chenwei/.argus/evaluations/2026-09-30-e0-isolated/`. The split
  coding reports share base `dfaac2a3eeb531ff7b059581207d080a65d14416`,
  dirty hash `6af01c527666df001fc19ab1559218b63b0abb9ff72accc0d432f95a6a202da6`,
  harness hash `f296d9214fb9d2cb208de822dd6b1e0fedc2dc8d1739e698e61843cba76c7104`,
  and model `qwen3.8-flash`; reports also retain endpoint/config/prompt/tool and
  fixture identifiers. Saved changes replayed against pinned external verifiers
  for all 48 trials. Arbitrary model shell effects outside owned workspaces
  remain outside this cleanup guarantee.

**Verified in this session:** `npm run verify` checked 94 modules and 19 live
documents; **387/387 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. No remote CI or real-TTY check was run for these changes.

#### 2026-09-29 — E0 scoring review after measurement

- Corrected a scorer race where a runner returning normal completion after the
  evaluation deadline could still pass with correct final code. Deadline and
  cancellation violations now fail the trial independently of final behavior.
  Added an explicit category for recovered tool errors in focused trials that
  otherwise use the expected tools. Regression tests cover both report outcomes.
- The live trials below had neither condition, so their original counts and
  pinned source snapshots are preserved. No additional provider calls were made.

**Verified in this session:** `npm run verify` checked 94 modules and 19 live
documents; **381/381 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. The paid baseline continues to identify the source
used during measurement, rather than this later harness correction. Product
follow-ups remain proposed for discussion; changes are uncommitted.

#### 2026-09-29 — E0 harness audit and first named coding baseline

**Status: ✅ initial measurement complete on `codex/coding-usefulness`; broader coding usefulness and V1 qualification remain open**

- Audited the harness before paid calls. Reproduced false passes from an imported
  module exiting before assertions and from weakened local checks. Added
  assertion-completion evidence, protected-check integrity, ordered check
  observations, supervised probe cleanup, separate infrastructure categories,
  planned/attempted counts, incomplete-suite failure, and bounded diagnostics,
  change details, and handoff text. Both evaluators now share the trial runner.
- The owner confirmed the configured `qwen3.8-flash` target at the Alibaba Cloud
  compatible endpoint and authorized unrestricted resource use, with no monetary
  ceiling. Ran a two-trial pilot, then three trials of all six coding fixtures
  and seven focused schema fixtures. The original pilot score was 1/2; a
  status-preserving wrapped-check scorer correction independently replayed it as
  2/2. Preserved the original report and excluded the pilot from baseline counts.
- Coding: **13/18 full fixture passes**, with bug-fix/refactor/feature/dirty-tree
  each 3/3, failed-command 1/3, and large-output 0/3. Independently reconstructed
  final files pass behavioral checks in **18/18**. Two failed-command reruns mask
  check status behind echo; two large-output trials skip the pre-edit failure,
  and all three redirect away the required truncation path. These are five
  workflow/evidence failures, not failed final repairs or full task successes.
- Focused tools: **21/21 final outcomes**, **18/21 strict tool-policy passes**.
  Extra behavioral verification in two range trials and read confirmation in
  one search trial trigger overly restrictive lists. Coding has four recovered
  schema errors (three omitted `ensureFinalNewline`, one foreign write field);
  focused trials have one recovered foreign bash field. Focused LF/no-LF and
  default write protection each pass 3/3; no edit-selector or gutter error was
  observed in those focused trials.
- Baseline coding/focused calls total 214 network attempts and 175 tool calls.
  Tool errors are 13/4 respectively: six expected failures/rejections, five
  schema mistakes, and six other coding errors across the two suites. All 39
  runs complete normally, with no failed transport/protocol trial or timeout.
  Median elapsed times are 21.75s coding and 8.87s focused (ranges 8.27–71.10s
  and 3.56–17.82s); the suites overlap, so latency can include shared endpoint
  load. Reported baseline usage is 425,321 prompt and 32,825 completion tokens;
  including pilot, 477,041 total tokens over 224 attempts. Required usage fields
  are complete; cache-creation counts and charges remain unknown.
- Verification honesty is only partially auditable. Final behavior agrees with
  completion claims, but all six designated checks remain failed/stale or
  not-run/unknown after wrapped reruns. Command stdout and some truncated detail
  are unavailable for auditing embedded status or exact assertion counts.
  Proposed priorities, not product changes: expose exact check requirements and
  qualify the truncation path; clarify always-required write newline policy;
  separate final behavior/workflow/tool-policy scores and allow reasonable
  verification calls. Discuss these before further scope.
- Sanitized reports, protocol, source snapshots, and replay scripts/results are
  outside the checkout in the private `2026-09-29-e0` evaluation directory.
  Both suites identify base `dfaac2a3eeb531ff7b059581207d080a65d14416`, dirty hash
  `4ef7296b07f7269217bdef5b307eb64f2aab88a6e17917288f04937bc840a713`, and harness
  hash `73ce8cec706501429dd6a2f2a5c541a03ca85d2a66e34ff6c932d1e297a6d771`;
  every trial includes fixture/config/prompt/tool identifiers. Owned workspaces
  and homes were cleaned; three identified model-created `/tmp` diagnostic
  leftovers were archived privately. Arbitrary shell effects are not isolated.

**Verified in this session:** `npm run verify` checked 94 modules and 19 live
documents; **379/379 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. Saved-report replay reproduced all 18 coding and 21
focused scores; separate final-behavior replay passed all 18 coding outcomes.
No remote CI, real-TTY, interruption/steering, or adversarial-isolation check was
run for this change. Runtime source, default tools, and dependencies are unchanged.
Changes remain uncommitted for human review.

#### 2026-09-29 — housekeeping approved for integration

The owner authorized committing the housekeeping work, merging it into `main`,
and pushing to the remote. The next session will prioritize E0: proving coding
usefulness through measured provider-backed tasks before adding more capability.

**Verified in this session:** `npm run verify` checked 92 modules and 19 live
documents; **370/370 offline tests pass** on macOS / Node v26.5.0.
`git diff --check` passed. No paid provider evaluation was run; this verification
does not establish coding usefulness or provider compatibility.

#### 2026-09-27 — housekeeping branch and live-design cleanup

**Status: ✅ reviewable housekeeping complete on `codex/housekeeping`**

- Moved active and idle `/steer` management into one TUI owner while preserving
  its saved queue, approval cancellation, and command behavior. Removed obsolete
  plan IDs from nearby code comments.
- Preserved the four superseded execution, evaluation, context, and interaction
  design documents verbatim in `docs/archive/`. Their live paths now contain
  only remaining qualification and point to the implemented contract owners.
  Updated the archive index, module map, and fact-ownership descriptions.
- Kept historical progress entries and earlier archive files unchanged. The
  default four-tool registry and dependency-free runtime are unchanged.

**Verified in this session:** `npm run verify` checked 92 modules and 19 live
documents; **370/370 offline tests pass** on macOS / Node v26.5.0. The four
new archive files were compared byte-for-byte with the former live files at
branch base; `git diff --check` passed. No live-provider run or real-terminal
check was performed for this documentation and steering refactor.

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
