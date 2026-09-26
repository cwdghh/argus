# Next steps

Recommended qualification ordering under the selected direction in
[product direction](docs/product-direction.md). Stable
work IDs, dependencies, and reusable session requests live in
[the implementation briefs](docs/improvements-plan.md).
[GAPS.md](GAPS.md) owns current open questions; history lives in [PROGRESS.md](PROGRESS.md).

1. **Measure E0:** run the six coding tasks for repeated trials against a named
   configured provider, record raw outcomes/usage, and compare subsequent
   changes against that baseline. Paid trials have not run yet.
2. **Qualify E2–E3 and I1–I2:** expand crash injection to the remaining effect
   boundaries and verify continuation against named compatible endpoints. The
   shell/stop/steer check passed in a real TTY against a local mock provider;
   keep unknown shell effects explicit.
3. **Qualify V1:** test misleading model claims, stale checks after edits, dirty
   trees, ignored dependencies, and non-Git folders against the coding suite.
4. **Qualify C1:** compare old-constraint retention and retrieval across repeated
   context revisions. Consider semantic and mid-run reduction only if measured
   results justify their extra state and provider usage.
5. **Revisit P1 only if needed:** admit one bounded compatible-model fallback
   after observed failures show benefit over ordinary retry.

Revisit isolation, authority, budgets, and escalation before any future shift to
unattended work; this roadmap alone does not supply those guarantees.

Lower-priority possibilities remain in the corresponding gaps: terminal protocol
refinements, notifications, sanitized replay, native providers, and sandboxing.
Parallel tools, sub-agents, plugins, and a fifth default tool each require the
admission decision described in product direction and the tool-surface contract.
