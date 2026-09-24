# Progress

Dated change records, newest first. Never rewrite an entry; add a dated correction.
Earlier records are preserved verbatim in
[progress through the prior September checkpoint](docs/archive/progress-through-2026-09-09.md)
and [progress through 2026-08-17](docs/archive/progress-through-2026-08-17.md).
See the [archive index](docs/archive/README.md) for provenance.

---

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
