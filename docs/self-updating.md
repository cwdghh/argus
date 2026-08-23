# Self-updating: how argus changes argus

argus can modify its own source — the loop, the tools, the TUI, and the docs
you are reading. That is not a trick; it is the design goal. argus exists to
make the shape of an agent legible, and an agent that cannot safely read and
revise its own instructions is not legible.

The safety model is the same one argus applies everywhere: **the model
proposes; the code disposes.** Self-modification is safe because it is
bounded — small diffs, a test suite that must stay green, and docs that let
the next session reconstruct *why* things are the way they are. This file is
the contract that makes that work.

## The documentation set

argus's docs form a closed, cross-referenced system. Each file has exactly
one job; when behaviour changes, the doc that owns that job changes in the
same commit. **Each fact has exactly one owning file** (see "Fact ownership"
below); every other mention is a *pointer*, never a retelling — if a change
makes a fact appear twice, one of the two mentions must become a pointer.

| File | Job | Update when… |
|------|-----|--------------|
| `AGENTS.md` | The rulebook: what argus is, where things live, the one rule | a module, tool, or rule changes |
| `README.md` | The user-facing story: run, configure, use | a user-visible capability changes |
| `docs/architecture.md` | How the code fits together | a module boundary moves |
| `docs/tools.md` | The tool contract, tool by tool | any tool's name, schema, or behaviour changes |
| `docs/self-updating.md` | This contract: how argus changes argus | the workflow itself changes |
| `docs/archive/` | Frozen history: old `PROGRESS.md` entries, executed one-time plans | never — archived, read only when you need it |
| `PROGRESS.md` | Dated changelog, newest first | every real change (append an entry) |
| `GAPS.md` | Open design questions, one numbered section per gap | a question is resolved, refined, or scheduled |
| `NEXT_STEPS.md` | Concrete candidate steps, ranked by impact | a step is taken, superseded, or added |

Everything under `docs/archive/` is frozen history; everything else is a living document.

## Fact ownership

One fact, one owner. Decide *which file owns a fact* from this table, then
write it there and point everywhere else. If you catch a fact living in two
places (a status retold in two files, a default spelled out twice), keep the
owner's copy and turn the other mention into a pointer.

| Fact | Owner | Pointers live in |
|------|-------|------------------|
| The one rule | `AGENTS.md` | restated nowhere — referenced from `docs/self-updating.md` |
| Module list / file map | `AGENTS.md` | `README.md` links to it |
| Env var defaults | `.env.example` (values + prose) and `src/config.mjs` (code) | README config table (short), `docs/architecture.md` when relevant |
| Tool contract (name/schema/behaviour) | `docs/tools.md` | tool list in `AGENTS.md` is a pointer |
| How the code fits together | `docs/architecture.md` | referenced everywhere, retold nowhere |
| User-facing story | `README.md` | — |
| History (dates, what shipped) | `PROGRESS.md` | GAPS status blocks **point at** PROGRESS dates, short |
| Current design state (resolved / open) | `GAPS.md` | `NEXT_STEPS.md` points at gap numbers, short |
| Next actions, ranked | `NEXT_STEPS.md` | — |
| The self-updating workflow | `docs/self-updating.md` | — |

## Reading order at bootstrap

A fresh session reads before touching anything:

1. `AGENTS.md` — rules and file map
2. `docs/self-updating.md` — the contract (this file)
3. `docs/architecture.md` — how the code fits together
4. `docs/tools.md` — the tool contract

Then consult by topic: `GAPS.md` for current design state, `NEXT_STEPS.md` for
what to do next, `PROGRESS.md` for what already happened (newest first),
README for the user view, `docs/*` for specifics (e.g. `docs/interrupt-resume.md`
for the interrupt→continue design).

## The one rule (restated)

**Clarity and quality over compactness.** Two constraints stay hard: the
default tool set stays minimal (`read`, `write`, `edit`, `bash`), and the
runtime stays dependency-free. A change that adds a tool, a dependency, or a
new concept updates the docs that describe it *in the same change*.

## The workflow

1. **Read the docs first.** `AGENTS.md` (rules), `docs/architecture.md` (how
   it fits together), `docs/tools.md` (tool contract), and the relevant
   `GAPS.md` section when the change touches an open question.
2. **Make the change.** Use `read` to inspect, `edit`/`write` to change,
   `bash` to run checks. Prefer small, focused diffs over large clever ones.
3. **Update docs in the same change.** Match the doc to its job in the table
   above. If behaviour changed and no doc mentions it, either add the
   mention or note in the PROGRESS entry why none applies.
4. **Verify.**
   - `node --check` on every `src/**/*.mjs` and `test/*.mjs` — syntax.
   - `npm test` — the mock-LLM suite (`test/helpers/mock-llm.mjs`) confirms
     the loop still terminates and tool results flow.
   - If you changed tools, exercise each one directly.
   - If something cannot be verified (no API key, no TTY), say so in the
     PROGRESS entry instead of claiming verification.
5. **Record.** Append a dated `#### YYYY-MM-DD` entry at the top of
   `PROGRESS.md` with a status word (✅ done / 🚧 in progress / ⏳ planned);
   update `GAPS.md` if you resolved an open question, and `NEXT_STEPS.md` if
   you took a step.
6. **Review before commit.** The human reviews and commits. A gate that
   argus cannot open by itself is the point.

## Changing these docs

The docs are the memory the next session reads. Treat them with the same
care as code:

- **Cross-references go both ways.** If `GAPS.md` #12 points at
  `docs/tools.md`, then `docs/tools.md` points back at `GAPS.md` #12. When
  you remove or renumber a target, find every reference to it first.
- **Never silently rewrite history.** `PROGRESS.md` entries are dated
  records of what happened. If one turns out wrong or stale, add a dated
  correction note to it rather than editing the original words. Status words
  *may* change (⏳ → ✅) — that is new information, not revision.
- **Statuses are claims, not wishes.** Mark ✅ only when the change is in
  the tree and verified. ⏳ planned describes an agreement, not a promise.
- **One job per file.** When a doc starts doing two jobs, split it — the
  same rule as for code modules.
- **Archive aggressively.** History and one-time plans are not “facts to
  keep handy” — they are context to *not* carry. When a live doc grows past
  roughly 400 lines, move the superseded stretch to `docs/archive/` with a
  header naming the cutoff, preserve the words verbatim, and update every
  pointer. `docs/archive/README.md` is the record of what lives there.
- **Archived files stay frozen.** `docs/archive/` holds immutable history
  (old `PROGRESS.md` entries, executed one-time plans like the 2026-08-17
  refactor). Never edit archived content in place; a correction is a dated
  note in the archive or `PROGRESS.md`, never a rewrite.
- **Live docs stay small.** A live doc that grows past roughly 400 lines
  should move its historical/superseded stretch into `docs/archive/` and
  leave a pointer (see “Archiving” below) — an agent reads these files on
  every session, so size is context cost.

## Self-development: when argus changes argus

Self-modification is the normal case of this workflow, not a special one —
but two failure modes deserve an explicit bar:

1. **Drift.** Every session changes a little; code, docs, and history slowly
   stop agreeing. The defence is this workflow: docs travel with code,
   cross-references go both ways, and `PROGRESS.md` is the audit trail a
   fresh session reads to re-orient. When you notice drift (a stale status,
   a stranded section, a broken reference), repair it and record the repair.
2. **Self-congratulation.** An agent grading its own work tends to find it
   good. The defence is mechanical: the test suite must pass, the
   verification actually performed is listed in the PROGRESS entry, and the
   human commits.

When argus changes argus, the bar is:

- **Test in the same change.** A change is declared done only when the suite
  covers it; write the test as part of the change.
- **Docs in the same change.** Loop, tool, or session-format changes update
  `docs/architecture.md` or `docs/tools.md` in the same commit.
- **Convention changes are called out.** If a change alters the doc
  conventions themselves (this file), the PROGRESS entry says so explicitly
  — the next session's argus will read the new rules as if they had always
  been true.

That last point is the bootstrap: **the rules you are reading were written
under these rules.** Change them carefully, and record the change.

## Boundaries

- **Never** commit secrets (`.env` is gitignored).
- **Don't** copy code wholesale from `references/pi` — argus has its own
  character. Use pi only as a conceptual reference.
- **The default tool set stays minimal** (`read`, `write`, `edit`, `bash`).
  New tools must earn their place; document the reason. (This constraint is
  about the agent's tool surface, not about how the code is organised.)
