# Next steps

Ranked candidates, not commitments. [GAPS.md](GAPS.md) owns open questions;
[the implementation brief](docs/improvements-plan.md) owns execution details.
Completed work belongs in [PROGRESS.md](PROGRESS.md).

1. **Interrupt and continue** — review the existing interaction proposal, then
   implement lossless partial-turn persistence and explicit continuation.
   Related: gaps 5 and 7. Begin with the brief linked above.
2. **Broader behavioral evaluation** — a small set of coding tasks with automatic
   outcomes and recorded provider/model baselines. Related: gap 9.
3. **Structured compaction** — an optional semantic summary with a deterministic
   fallback; preserve append-only source history. Related: gap 4.
4. **Steering** — define how new input enters an active turn and is persisted.
   Related: gap 8.
5. **Compatible-model fallback** — retry one eligible failed step on an explicitly
   configured fallback model, with clear events and accounting. Related: gap 6.

Lower-priority candidates remain in the corresponding gaps: truncated-outcome
presentation, live shell output, spill retention, terminal protocol refinements,
notifications, transcript replay, native provider support, and sandboxing.
Mid-turn compaction and a sub-agent capability require separate design work.

Choose one bounded change at a time. Reconfirm the code and its owning contract;
the archived audit's line numbers and commit instructions are historical only.
