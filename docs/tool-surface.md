# Tool surface — canonical decisions

**Status: implemented.** This file owns the answer to
which tools argus exposes to the model and the design rules for that surface.
`docs/tools.md` owns the executable contract; this file records the rationale.

## The surface

Argus exposes exactly four tools:

| Tool | Specific job | Why it stays distinct |
|------|--------------|-----------------------|
| `read` | Bounded, line-numbered text inspection | Gives `edit` auditable line references without shell quoting or unbounded output. |
| `write` | Create a complete file, with explicit overwrite opt-in | Makes whole-file creation simple and protects existing files by default. |
| `edit` | Atomic targeted changes to an existing text file | Preserves surrounding content and offers exact/fuzzy content edits plus fresh line-range edits. |
| `bash` | Search, listing, builds, tests, and other CLI work | Covers the open-ended command surface without adding a model schema for every utility. |

The set is deliberately small. A new default tool must materially improve at
least one of model reliability, context cost, safety, or transcript
auditability, and must be measurably better than composing the four existing
tools. Convenience alone is not enough because every schema is sent on every
model request.

## Design rules

1. **One canonical input shape.** The schema and recursive runtime validation
   agree. Cross-field validation rejects ambiguous `edit` combinations. There
   are no hidden model-call aliases or legacy executor shapes.
2. **Sequential execution.** The provider receives the single-call hint. If it
   returns several calls, the loop executes them in order under the same policy
   and budgets; it never runs tools in parallel.
3. **Descriptions own tool mechanics.** The system prompt carries repository
   behavior, not a second copy of parameter and result guidance. Each
   description also states its boundary with `bash`, so ordinary text-file
   reads and mutations remain attributable to the structured tools.
4. **Failures are data.** Tool failures return `{ error: true, message, ... }`
   so the model can recover. Mutating successes keep `ok: true`; `read` and
   `bash` return their natural payloads. Shell output truncation is independent
   of the observed exit status; an unobserved exit remains unknown.
5. **Output is bounded twice.** Every result has a per-result character cap,
   and every active turn has a cumulative tool-result budget. `read` also has
   line and byte bounds with structured pagination.
6. **Safety metadata is model-invisible.** Registry entries classify risk as
   `read-only`, `filesystem-write`, or `shell`. Approval requests contain the
   tool, arguments, cwd, risk, reason, and decision. The destructive shell
   classifier remains explicitly best-effort, not a security boundary.
7. **Line edits require evidence.** A range edit is allowed only after the
   same turn read the affected lines from the exact current file contents.
   Writes invalidate that path; any executed shell command invalidates all
   read stamps. Read results call their rendered field `numberedText` so its
   `N │ ` gutters are visibly metadata: selectors may copy them, replacements
   must not.
8. **Sessions preserve the historical surface.** Each turn records a stable
   tool-surface hash, and a schema snapshot is appended when the surface
   changes. Old executor compatibility code is therefore unnecessary for
   auditability.

## Current decision register

| # | Decision | Resolution |
|---|----------|------------|
| D1 | Default set | keep exactly `read`, `write`, `edit`, `bash`; test-enforced. |
| D2 | Calls per model step | Request one; accept provider batches and execute sequentially. Historical changes are recorded in [PROGRESS.md](../PROGRESS.md). |
| D3 | Repetition guard | Bound identical and alternating no-progress cycles while allowing different work to break the cycle; see [tools.md](tools.md). |
| D4 | Model-visible `edit` shape | canonical `edits[]` only. |
| D5 | Legacy top-level `edit` fields | remove them from validation, execution, and tests. Session schema snapshots preserve history without executable aliases. |
| D6 | Search/list tools | do not add them; `bash` owns this job until behavioral evidence shows a material deficit. |
| D7 | Schema validation | recursively enforce the advertised minimal subset (`type`, `required`, `additionalProperties`, `items`, `minItems`, `minimum`, `minLength`) and use semantic validators for cross-field rules. |
| D8 | Risk declaration | add model-invisible risk classes and structured authorization requests. Keep the shell pattern gate as a backstop. |
| D9 | Result convention | structured errors; natural success payloads; structured continuation for bounded results; distinct timeout and abort states. |
| D10 | Names | keep the familiar four names; renaming adds churn without evidence of better tool choice. |
| D11 | Freshness and parallelism | same-turn range freshness is loop-scoped state; execution remains sequential. |
| D12 | Extra model-visible metadata | keep essential bounds in descriptions; do not add a second metadata protocol. |
| D13 | Prompt duplication | remove repeated tool mechanics from the default system prompt (119 words to 59). |
| D14 | Tool-choice evaluation | keep an opt-in real-model evaluator for content edit, range edit, uncued numbered-read editing, shell search, and file creation with/without a final newline. The harness is shipped; provider baselines are measurements, not test-suite claims. |
| D15 | `/exit` and `/quit` | retain the harmless user-facing alias; it costs the model nothing. |

## Evaluated alternatives

| Candidate | Outcome | Reason |
|-----------|---------|--------|
| `grep`, `search`, `ls`, `glob`, `find` | Not added | `bash` already owns open-ended CLI inspection; no measured benefit justifies permanent schema cost. |
| unified-diff `patch` | Not added | Duplicates `edit` and creates two competing mutation contracts. |
| model-to-user `ask` | Separate feature | It belongs to interrupt/continue and human-in-the-loop design, not filesystem/tool surface design. |
| parallel tool calls | Not added | Sequential execution is easier to authorize, audit, and couple to freshness state. |

## How to revisit

Run `npm run eval:tools` with a configured provider to collect tool traces and
task outcomes. If a recurring failure cannot be fixed by improving an existing
description or schema, document the evidence here before proposing a fifth
tool. The evaluator is opt-in and may incur provider cost; the normal test
suite remains deterministic and offline.
