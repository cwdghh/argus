# NEXT_STEPS.md — candidate directions for argus

**Purpose:** a short list of concrete next steps, grouped by impact and
complexity. This is a planning reference — not a commitment. Pick whichever
direction fits the current goals.

See `GAPS.md` for the broader design territory and open questions.

> **Recently completed (2026-08-17, details in `PROGRESS.md`):** bounded
> numbered reads (2000 lines / 50KB, `offset`/`limit` paging), exact→fuzzy
> edits with atomic `edits[]` batches, line-range edit mode for whole-block
> rewrites/inserts, markdown table rendering with CJK/emoji-aware widths,
> relaxed timeouts for long-reasoning models, and a global `~/.argus/.env`
> config file (process env > project `.env` > home `.env` > defaults). Item 2
> below (read-before-edit freshness) is the main direction that work
> deliberately deferred.

---

## High impact, moderate complexity

### 1. Parallel tool execution

- **What:** run independent tool calls concurrently instead of sequentially.
- **Why:** common patterns (reading several files, running several reads before
  a write) finish much faster.
- **Considerations:**
  - How to order results so the model can still reason about them clearly?
  - Should the model opt in (e.g. an explicit parallel flag), or should the
    agent decide automatically?
  - Safety: parallel `bash` calls share the same shell cwd — is that a problem?

### 2. Read-before-edit freshness guard (stale-line protection)

- **What:** track a per-file "read after last modification" stamp in the
  agent loop and have `edit` (especially range mode) refuse to run on a file
  whose content the model hasn't seen since it last changed: *"re-read
  first — line numbers must come from the most recent read."*
- **Why:** range-mode line numbers and content-mode `old` strings are only
  trustworthy when fresh. A stale-but-successful edit silently corrupts a
  file; an error that says "re-read" is cheap by comparison. Numbered reads
  make the re-read cheap, so the guard mostly enforces good behavior.
- **Considerations:**
  - Bookkeeping: a monotonically increasing sequence stamped on `read`
    (ok), on `edit`/`write` (we know what we wrote), and a global
    "unknown write" bump on every `bash` call — conservative, but forces
    re-reads after every shell command.
  - Does a *partial* read (one `offset`/`limit` page) count as fresh for
    edits inside that window, or is a whole-file read required?
  - Escape hatch: `force: true`, or keep it a soft rule (prompt + error
    messages, the current state). The guard should be a knob, not a law.
  - Rejected alternative for now: per-edit verification anchors (an
    `expect` field) — they burden every edit for a safety net that rarely
    fires. See `GAPS.md` #11 for the full trade-off.

### 3. Desktop notifications for long tasks

- **What:** when a turn takes longer than a threshold (e.g. 30s), send a
  desktop notification when it completes.
- **Why:** useful when you switch to another window while waiting for the
  model or a long-running tool.
- **Considerations:**
  - Cross-platform: macOS, Linux, and Windows each have their own mechanism.
  - Should the threshold be configurable?

---

## Practical improvements

### 4. Session management commands

- **What:** `/session delete <name>` and `/session rename <old> <new>` for
  housekeeping.
- **Why:** `/sessions` already lists sessions, but there's no way to clean up
  old ones without manually deleting files.
- **Considerations:**
  - Confirmation before delete?
  - Should delete accept multiple names or a glob?

### 5. Behavioral evals

- **What:** a small suite of coding tasks ("fix this bug", "add this feature",
  "explain this code") with automated success criteria.
- **Why:** the current test suite covers regression well, but doesn't test
  actual coding quality. Evals catch quality regressions when changing the
  system prompt or model.
- **Considerations:**
  - Which tasks actually predict useful coding performance?
  - Should evals run against the real API or a mock?
  - One high-value task: does the model pick content vs range edits
    correctly, copy line numbers from a numbered read, and recover cleanly
    from fuzzy-fallback edits? That directly protects the edit-reliability
    work.

### 6. Smarter context compaction

- **What:** model-generated summaries for older turns, instead of deterministic
  truncation.
- **Why:** preserves more relevant context in long sessions.
- **Considerations:**
  - Adds latency and cost for the summarization call.
  - A hybrid approach (deterministic for recent turns, model-generated for
    older ones) might balance cost and quality.

---

## Nice-to-have

### 7. Multi-provider support

- **What:** native Anthropic support (or a provider registry) beyond the
  current OpenAI-compatible protocol.
- **Why:** expands the user base to Anthropic users.
- **Considerations:**
  - Requires maintaining provider-specific message formats.
  - The abstraction layer needs careful design to stay minimal.

### 8. Transcript replay as tests

- **What:** save real sessions and replay them as tests.
- **Why:** catches regressions in actual usage patterns, not just mock
  scenarios. The session JSONL already stores everything needed.
- **Considerations:**
  - Real sessions depend on the model, so replay would need a recorded
    response trace or a deterministic mock.

### 9. Process sandbox

- **What:** run shell tools in a sandbox (containers, seccomp, etc.) instead
  of on the host.
- **Why:** improves safety for destructive commands.
- **Considerations:**
  - Adds significant complexity.
  - May conflict with argus's minimal philosophy.

---

## How to use this file

When starting a new session, pick one item and move it to `PROGRESS.md` as
"⏳ planned". When it's done, mark it "✅ done" in `PROGRESS.md` and remove it
from here (or leave it as a reference for similar future work).
