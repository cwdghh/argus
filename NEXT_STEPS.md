# Next steps

Recommended ordering under the selected D1–D3 direction in
[product direction](docs/product-direction.md). D4–D6 remain pending. Stable
work IDs, dependencies, and reusable session requests live in
[the implementation briefs](docs/improvements-plan.md).
[GAPS.md](GAPS.md) owns current open questions; history lives in [PROGRESS.md](PROGRESS.md).

1. **Establish evidence (E0):** measure representative coding tasks and use the
   normalized E1 outcomes as the baseline. E0 can expand alongside later work.
2. **Make stopping and recovery dependable (E2 → E3 → I1):** supervise shell
   lifecycles, checkpoint progress, then expose explicit continuation. Treat
   uncertain side effects as a first-class recovery case.
3. **Make correction easy (I2):** persist steering and apply it at safe boundaries.
4. **Preserve intent over longer tasks (C1):** start with bounded deterministic
   context revisions; admit semantic reduction only after comparative evaluation.
5. **Improve handoff confidence (V1):** record verification evidence and freshness.
   Move this directly after E3 if verification trust is chosen as the top priority.
6. **Add model fallback only with evidence (P1):** bounded recovery for observed
   compatible-provider failures after outcome/accounting foundations exist.

Revisit isolation, authority, budgets, and escalation before any future shift to
unattended work; this roadmap alone does not supply those guarantees.

Lower-priority possibilities remain in the corresponding gaps: terminal protocol
refinements, notifications, sanitized replay, native providers, and sandboxing.
Parallel tools, sub-agents, plugins, and a fifth default tool each require the
admission decision described in product direction and the tool-surface contract.
