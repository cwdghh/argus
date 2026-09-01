# NEXT_STEPS.md — candidate directions for argus

**Purpose:** a short list of concrete work that has not shipped, ranked by
likely value. This is a planning reference, not a commitment. Shipped work
belongs in `PROGRESS.md`; current design questions belong in `GAPS.md`.

The canonical four-tool surface and its loop/freshness policy were completed on
2026-08-24. See `docs/tool-surface.md`; do not reopen it here without behavioral
evidence.

## Current plan — see `docs/improvements-plan.md`

A full-repo audit (incl. `references/pi`) produced a verified, workstreamed plan:
`docs/improvements-plan.md` is the source of truth. Its top picks, in suggested
order:

1. **W3 — Reliability batch** — protocol-safe histories on mid-loop guards,
   interrupt/deny double markers, Ctrl-D mode guard, bash maxBuffer/shell fixes,
   non-atomic writes, write+rename.
2. **W2 — Tool output visibility** (highest user-facing value) — per-tool label
   resolver, multi-line result previews + `/show`, active-tool footer.
3. **W4 — Session durability/scale** — torn-line recovery, streaming meta
   scanner for resume.
4. **W5 — Core-loop hardening** — mid-stream step retry, body built once.
5. **W6 — Feature backlog** — interrupt→continue, render cache, structured
   compaction, fallback model, steering.

## Practical improvements

### 1. Broader behavioral evals

- **What:** grow beyond the opt-in `npm run eval:tools` surface checks into a
  small set of coding tasks with automated outcomes and recorded provider
  baselines.
- **Why:** deterministic tests protect the implementation and the existing
  evaluator protects basic tool choice, but neither measures general coding
  quality after prompt or model changes.
- **Considerations:** keep real-API cost explicit; choose tasks that predict
  real usefulness; avoid provider-specific score theater.

### 2. Desktop notifications for long tasks

- **What:** notify when a turn exceeding a configurable threshold completes.
- **Why:** useful after switching away from a long model or test run.
- **Considerations:** macOS/Linux/Windows mechanisms differ; keep terminal-only
  identity and failure behavior simple.

## Larger design directions

### 3. Smarter context summaries

- **What:** optionally use model-generated summaries for older turns instead of
  only deterministic digests.
- **Why:** may retain intent and decisions better in very long sessions.
- **Considerations:** adds latency, cost, and a second model call whose failure
  must not damage the append-only source history.

### 4. Native multi-provider support

- **What:** support a non-OpenAI-compatible provider such as Anthropic, or add
  a small provider registry.
- **Why:** expands endpoint choice beyond the already broad compatible API.
- **Considerations:** provider-specific message/tool/usage semantics can erode
  the project's minimal, auditable loop.

### 5. Transcript replay tests

- **What:** replay sanitized real-session traces through a deterministic model
  fixture.
- **Why:** preserves real call-shape regressions that hand-written cases may
  miss. Tool-surface hashes and snapshots now make historical traces precise.
- **Considerations:** strip secrets and unstable paths; separate deterministic
  protocol replay from live-model behavioral evaluation.

### 6. Process sandbox

- **What:** run shell commands inside an isolation boundary rather than directly
  on the host.
- **Why:** materially stronger safety than the current approval backstop.
- **Considerations:** containers/seccomp/platform differences add substantial
  complexity and may conflict with the dependency-free, host-native design.

## How to use this file

Choose one item only after checking its related gap and current code. When it
ships, append the verified work to `PROGRESS.md` and remove it here; do not keep
duplicate status narratives.
