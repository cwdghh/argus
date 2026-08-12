# GAPS.md — where argus stands vs. a production agent

**Purpose:** a living reference for what argus deliberately omits, and the open
design questions we want to discuss in detail later. This is *not* a checklist to
copy from `pi` line by line. Argus should grow its own characteristics — this file
just records the territory so we can decide what argus wants to be.

**How to use:** each gap lists *what it is*, *why it matters*, *pi's high-level
approach* (conceptual only), and *open questions specific to argus*. The open
questions are deliberately unresolved — we'll discuss them.

---

## 1. Streaming output

> **Status: resolved (2026-08-10)** — text AND reasoning/thinking are streamed via
> `src/llm.mjs` (SSE) and rendered live by the TUI (thinking shown muted).

- **What:** text and reasoning stream live. Tool calls are assembled from stream
  fragments and shown once their arguments are complete.
- **Why it matters:** makes the agent feel responsive and lets you inspect
  thinking/tool-call intent while it's happening.
- **pi's approach (conceptual):** streams token deltas and emits events
  (`text_delta`, `thinking_delta`, `toolcall_delta`) that the TUI renders live.
- **Open questions for argus:**
  - Should incomplete tool-call arguments ever be shown live, or only after
    they form valid JSON?

## 2. Tool execution policy (permission / safety gate)

> **Status: partially resolved (2026-08-11)** — destructive shell patterns ask
> for confirmation in the TUI and are blocked headlessly. File replacement and
> ambiguous edits require explicit intent. This remains a best-effort gate, not
> a sandbox or comprehensive shell policy.

- **What:** file tools and ordinary shell commands run immediately; a small set
  of destructive shell patterns requires a human check in the TUI.
- **Why it matters:** "model proposes, code disposes" is only meaningful if the
  code actually *decides*. A gate is where safety, trust, and control live.
- **pi's approach (conceptual):** `beforeToolCall` / `afterToolCall` hooks that
  can allow, block, or rewrite tool calls; containerized/sandboxed execution.
- **Open questions for argus:**
  - Ask before every tool, or only "risky" ones (e.g. `bash` vs `read_file`)?
  - Allowlist/denylist by tool name or by pattern?
  - Should argus support a sandbox, or stay host-native deliberately?

## 3. Parallel tool execution

- **What:** we run tool calls one at a time, in order.
- **Why it matters:** independent calls (e.g. read three files) could run
  concurrently and finish faster.
- **pi's approach (conceptual):** sequential vs parallel modes, with ordering
  caveats around correctness.
- **Open questions for argus:**
  - Do we value simplicity (sequential) more than speed?
  - If parallel, how do we order results so the model can still reason?

## 4. Context management (compaction / truncation)

> **Status: resolved at the minimal level (2026-08-11)** — deterministic
> compaction keeps recent turns and summarizes older user intent + outcomes.
> Tool results also have a hard per-result cap. Smarter semantic summaries and
> cumulative per-turn token accounting remain open.

- **What:** recent history is sent verbatim; older turns are compacted into a
  deterministic summary after a configurable character budget.
- **Why it matters:** the context window is a budget; long sessions overflow.
- **pi's approach (conceptual):** summarizes/compacts old messages, truncates
  what no longer fits.
- **Open questions for argus:**
  - When is a real model-generated summary worth its latency and complexity?
  - Should the budget use provider token counts instead of character estimates?

## 5. Session persistence

> **Status: resolved (2026-08-10)** — append-only JSONL sessions auto-save and
> resume transcript, messages, configuration, and working directory.

- **What:** turns are appended to readable JSONL files and the latest session is
  resumed automatically unless the user asks for a new or named session.
- **Why it matters:** agents that survive restarts are far more useful (resume a
  task, audit what happened).
- **pi's approach (conceptual):** session backends (memory, SQLite, JSONL) that
  store the transcript.
- **Open questions for argus:**
  - Do we need session deletion/renaming commands or automatic retention?
  - When would JSONL stop being sufficient and justify SQLite?

## 6. Multi-provider abstraction

- **What:** we're hard-wired to the OpenAI-compatible protocol (by design, and it
  covers a lot: DashScope, OpenAI, Ollama, vLLM, …).
- **Why it matters:** a thin abstraction lets one agent talk to many backends.
- **pi's approach (conceptual):** a provider layer (`packages/ai`) that maps a
  common message type to each vendor.
- **Open questions for argus:**
  - Is OpenAI-compatible enough, or do we want Anthropic natively?
  - Do we want a provider registry, or keep it intentionally minimal?

## 7. Robustness / error handling

> **Status: partially resolved (2026-08-13)** — model requests have bounded
> timeout/retry behavior, turns have a step cap, tool arguments are validated,
> truncated tool calls never run, and tool results are size-bounded.
> Stream-protocol diagnostics and process isolation remain intentionally small.

- **What:** expected failures have bounded handling, but malformed provider
  streams and subprocess isolation remain limited.
- **Why it matters:** real sessions hit malformed output, token limits, and API
  hiccups; an agent should degrade gracefully.
- **pi's approach (conceptual):** treats a `length` stop as "arguments may be
  truncated" and fails the batch rather than executing possibly-broken calls;
  encodes failures as error events.
- **Open questions for argus:**
  - Should malformed SSE events fail fast or remain compatibility-tolerant?
  - Is process-group cleanup enough, or should shell tools run in a sandbox?

## 8. Terminal UX

> **Status: resolved (2026-08-10)** — a minimal, dependency-free TUI
> (`src/tui.mjs`, raw-mode + ANSI) with markdown, scrollable history, a bottom
> editor with caret, thinking display, and a model/path/git/mode footer.

- **What:** a raw-mode ANSI TUI provides streaming markdown, a fixed editor,
  transcript scrolling, theme detection, and live status.
- **Why it matters:** the interface shapes how it feels to drive the agent.
- **pi's approach (conceptual):** a full differential-rendering TUI.
- **Open questions for argus:**
  - Is runtime model switching worth adding beyond the current local commands?
  - Should narrow terminals use a deliberately reduced footer?

## 9. Testing & evals

> **Status: resolved for regression testing (2026-08-11)** — the dependency-free
> mock-LLM suite covers the loop, tools, aborts, sessions, headless mode, safety,
> compaction, CLI parsing, retries/timeouts, and TUI behavior. Behavioral evals
> of model quality are still open.

- **What:** deterministic integration tests exercise a scripted local SSE model;
  there is not yet a behavioral eval suite for answer quality.
- **Why it matters:** the loop's behavior is subtle; evals catch regressions.
- **pi's approach (conceptual):** a full eval harness and conformance tests.
- **Open questions for argus:**
  - Do we want a way to replay saved transcripts as tests?
  - Which behavioral evals would actually predict useful coding performance?

## 10. Model catalog / configuration

- **What:** one model + one system prompt, read from env.
- **Why it matters:** model choice and prompt are the user-facing "knobs."
- **pi's approach (conceptual):** a generated model catalog; per-session config.
- **Open questions for argus:**
  - Multiple named models switchable at runtime?
  - Version the system prompt as a first-class artifact?

---

## Meta-question (the one we'll return to)

Each gap above is a *direction*, not a mandate. When we discuss in detail, the
question is: **which characteristics should define argus?** For example:

- Minimal-and-correct (few moving parts, everything auditable)?
- Educational (every feature exists to teach a concept clearly)?
- Opinionated-single-provider (great one experience) vs. portable-neutral?

We'll settle this together. For now, this file is just the reference map.
