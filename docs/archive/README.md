# Archive

Immutable history and one-time plans, kept out of the live docs so the files an
agent reads on every session stay small. **Never edit archived content in
place.** A wrong archived entry gets a dated correction note (in this folder or
in `PROGRESS.md`), never a rewrite.

| File | What it holds |
|------|---------------|
| `progress-through-2026-08-17.md` | `PROGRESS.md` entries dated 2026-08-17 and earlier (moved 2026-08-23) |
| `progress-through-2026-09-09.md` | Verbatim prior live progress log, preserved at the 2026-09-24 baseline; original entry dates retained |
| `improvements-plan-2026-09-24.md` | Original W1–W6 audit plan, superseded by the live implementation brief; deferred items remain in the live gap/priority documents |
| `interrupt-resume-2026-09-24.md` | Verbatim earlier continuation proposal; revised interaction is a pending proposal in the live design, not a retroactive change to prior discussion |
| `refactor-plan.md` | The 2026-08-17 refactor proposal + execution record (frozen) |

When to archive (see `docs/self-updating.md` → Archiving):

- a live doc grows past roughly 400 lines — move the historical/superseded
  stretch out and leave a pointer;
- a one-time plan is fully executed (e.g. `refactor-plan.md`) — it becomes
  history, not a living document.

Name archived files by what they cover and the cutoff date (`progress-…-YYYY-MM-DD.md`),
preserve the content verbatim, and update every pointer to the old path.
