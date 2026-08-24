# Finding tool failures in saved sessions

Every turn argus runs is persisted as JSONL under
`~/.argus/sessions/<name>.jsonl` (or `$ARGUS_HOME/sessions` when `ARGUS_HOME`
is set) — **including** turns that failed or were interrupted. A failed tool
call is kept verbatim in the transcript as a `tool` message whose `content` is
the serialized `{ error: true, message, ... }` object, so the raw material for
post-hoc failure analysis is already on disk. This page explains how to find it
without adding any machinery.

Read `docs/tools.md` for the tool contract and `docs/architecture.md` for the
session store before relying on details here.

## Where the failures live

Two representations matter:

- **The loop (`src/agent.mjs`)** returns a failed tool result to the model as a
  `tool` message:
  `{ role: "tool", tool_call_id, content: JSON.stringify(result) }`, where the
  serialized `result` has `error: true` plus a `message` (and often `path`,
  `code`, `cwd`, etc.).
- **The session file** stores every completed, failed, and interrupted turn
  (`type: "turn"`), along with `config`, `messages`, and `blocks` (the
  on-screen transcript, which includes the error block). The JSONL is
  append-only; a torn final record is tolerated with a warning, and the schema
  snapshot (`type: "tools"`) is written whenever the tool surface changes so
  historical handling stays precise.

## Finding failures with grep

The simplest, dependency-free query targets the serialized `error: true` that
the loop writes into every failed tool result:

```bash
# Enumerate every failure across all saved sessions, one JSON line each.
grep -h '"error":true' ~/.argus/sessions/*.jsonl

# Include the session name so you can trace the surrounding turn.
grep -H '"error":true' ~/.argus/sessions/*.jsonl

# Only `edit` failures, showing the message:
grep -h '"error":true' ~/.argus/sessions/*.jsonl | grep -o '"message": *"[^"]*"'
```

Notes on the pattern:

- `"error":true` (no space) is the exact serialization the agent writes. A
  broader grep for `"error":` would also match `{ error: ... }` blocks from
  `bash` non-zero exits and structured read messages — useful when you want
  every structured failure, not just tool mutations.
- The `tool_call` that preceded a failed result lives one JSON array earlier
  in the same `messages`, showing the tool name and **exact arguments the model
  chose**. Read a session file with your editor and search backwards from a hit
  to see the full call + failure pair.

## Trending with a short pipe

Because JSONL is one object per line and each failure already carries
`message` (and the query above adds the session name), a one-liner can group
by failure message:

```bash
grep -h '"error":true' ~/.argus/sessions/*.jsonl \
  | grep -o '"message": *"[^"]*"' \
  | sort | uniq -c | sort -rn
```

This is the "where did `edit` fail most, and with what message?" summary — no
code change, no new module.

## Distinguishing real failures from other `error` texts

Not everything with `error` is a tool failure:

- `bash` results with a non-zero exit add `error: true` plus `message` — that
  is often the *expected* result of a search that found nothing, not a tool
  crash.
- Read results for a missing file, a too-large line, or an offset past EOF are
  structured errors too.
- Turn-level failures (provider errors, abort) are surfaced as `blocks` of
  kind `error` with the exception text, and a `timing` block records the
  `outcome` (`completed` / `failed` / `interrupted`) plus real token usage.
- Authorization denials are `result` blocks (`ok: false`, summary
  `denied: <tool> ...`), distinct from execution failures.

For a precise per-tool audit, the strongest signal is the `tool` message's
serialized result: if `content` contains `{}` around an `"error"` field with
the tool's own failure text, it is a genuine tool rejection.

## Reconstructing a full failure turn

The session file already contains everything needed to re-run or inspect a
failed turn exactly:

- `config` (model, base URL, system prompt) on the turn;
- `messages` — the verbatim requests and replies, including the assistant's
  `tool_call` and the loop's serialized `tool` result;
- `toolSurfaceHash` plus the `tools` snapshot line, so you know which schema
  was in force;
- `blocks` — the rendered transcript as the user saw it (including the error
  block), which `sessionData` in `src/session/data.mjs` reassembles for the
  TUI and headless mode.

`npm start` resumes the newest session used in the current folder; use
`npm start -- --session <name>` to open a specific one, and read the `.jsonl`
directly for the exact JSON details.

## Why we don't need a separate failure log

- Every outcome — success, failure, interrupt — is already persisted; adding a
  second write path would duplicate the transcript and cost disk for a signal
  that is already queryable.
- The tool-surface hash + snapshot keep historical traces meaningful even as
  schemas evolve.
- The opt-in `npm run eval:tools` evaluator already emits structured per-task
  traces (including invalid calls) for *controlled* experiments; these
  instructions cover the *real-usage* case from saved sessions.
- If a recurring failure surfaces, the agreed improvement path is to refine the
  relevant tool description or schema (see `docs/tool-surface.md`), backed by
  the evidence gathered here.
