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

- **What:** currently we do one request → one complete reply. The user sees
  nothing until the model finishes the whole turn.
- **Why it matters:** makes the agent feel responsive and lets you inspect
  thinking/tool-call intent while it's happening.
- **pi's approach (conceptual):** streams token deltas and emits events
  (`text_delta`, `thinking_delta`, `toolcall_delta`) that the TUI renders live.
- **Open questions for argus:**
  - Stream text only, or also live-view tool calls as they're requested?
  - Do we want to surface the reasoning/thinking content at all?
  - Keep it raw terminal output, or build a small TUI?

## 2. Tool execution policy (permission / safety gate)

- **What:** currently any requested tool call runs immediately, with no human
  check. The model can ask to run anything.
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

- **What:** we re-send the entire history every request. It grows without bound.
- **Why it matters:** the context window is a budget; long sessions overflow.
- **pi's approach (conceptual):** summarizes/compacts old messages, truncates
  what no longer fits.
- **Open questions for argus:**
  - Auto-compact, or let the user decide when to summarize?
  - What's the simplest correct compaction that preserves argus's character?

## 5. Session persistence

- **What:** state lives only in memory; closing the terminal loses everything.
- **Why it matters:** agents that survive restarts are far more useful (resume a
  task, audit what happened).
- **pi's approach (conceptual):** session backends (memory, SQLite, JSONL) that
  store the transcript.
- **Open questions for argus:**
  - Plain JSONL files (simple, readable) vs SQLite?
  - Should sessions be automatically saved per-run, or opt-in?

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

- **What:** basic guards exist (unknown tool, parse error, thrown error) but the
  loop has no retry, no "length" handling, no recovery from a bad turn.
- **Why it matters:** real sessions hit malformed output, token limits, and API
  hiccups; an agent should degrade gracefully.
- **pi's approach (conceptual):** treats a `length` stop as "arguments may be
  truncated" and fails the batch rather than executing possibly-broken calls;
  encodes failures as error events.
- **Open questions for argus:**
  - Retry on transient API errors? With backoff?
  - How should a truncated tool call be reported to the model?

## 8. Terminal UX

> **Status: resolved (2026-08-10)** — a minimal, dependency-free TUI
> (`src/tui.mjs`, raw-mode + ANSI) with markdown, scrollable history, a bottom
> editor with caret, thinking display, and a model/path/git/mode footer.

- **What:** a bare `readline` prompt; output is printed after the fact.
- **Why it matters:** the interface shapes how it feels to drive the agent.
- **pi's approach (conceptual):** a full differential-rendering TUI.
- **Open questions for argus:**
  - Bare REPL, or a richer interface (status lines, colors, command palette)?
  - Are there meta-commands worth adding (`/help`, `/new`, `/model`)?

## 9. Testing & evals

- **What:** no test suite beyond ad-hoc runs.
- **Why it matters:** the loop's behavior is subtle; evals catch regressions.
- **pi's approach (conceptual):** a full eval harness and conformance tests.
- **Open questions for argus:**
  - A mock-LLM test harness (like the one we used) blessed as a real test?
  - Do we want a way to replay saved transcripts as tests?

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
