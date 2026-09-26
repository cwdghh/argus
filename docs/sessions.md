# Session records and recovery

This file owns the persisted session format. All callers import
`src/session/index.mjs`. The frontend interaction is in [README](../README.md);
the module flow is in [architecture](architecture.md).

## Storage and records

Each named session is an append-only `<name>.jsonl` file below `ARGUS_HOME/sessions`.
Names use ASCII letters, digits, `-`, and `_`, begin with a letter or digit, and
fit within 249 characters. Renaming changes the filename, not old records. The
API key is excluded from the persisted `config` allowlist.

| Record | Meaning |
| --- | --- |
| `meta` | Version 2 for new files, stable `sessionId`, initial model-visible tool snapshot and hash. Version 1 files remain readable. |
| `cwd`, `model`, `config`, `tools` | Ordered metadata updates. `config` contains only credential-free fields. |
| `turn` | Legacy complete turn; still read and accepted by the legacy append API. |
| `run_start` | Version 2 run ID, sequence 0, user prompt, cwd, model, and optional parent run ID. |
| `checkpoint` | Next contiguous sequence for a complete assistant step, bounded partial text delta, authorized tool intent, tool result, or applied steering. |
| `run_end` | Final sequence with one complete turn projection: messages, display blocks, and configuration delta. It replaces a duplicate `turn` record. |
| `resolution` | Explicit user choice to retry or abandon an uncertain attempt. |
| `steering` | Persisted queued, applied, or cancelled instruction with a local ID. |
| `context_revision` | Bounded deterministic digest, covered source range/hash, retained message IDs, and private retrieval artifact path. |
| `session_id` | Adds a stable artifact identity when an older session first needs one. |

Metadata may appear between run records. Journal sequences count only
`run_start`, `checkpoint`, and `run_end`. Timing blocks may carry outcome,
request usage, tool attempts, and designated verification evidence. Local
`partial` and `truncated` message flags are removed from outgoing provider
requests. Sessions are evidence of what Argus recorded, not byte-for-byte HTTP
replays or proof that the requested coding task is correct.

## Write ordering and ownership

The host passes awaited run-start/checkpoint callbacks to the agent. The agent
does not import persistence. The writer syncs the user instruction before the
first model request, a complete assistant call before its tools, tool intent
after validation and approval but before invocation, and the result before a
dependent call or model step. Text deltas are saved in chunks of at most 4096
characters and at visible streaming boundaries; abrupt termination may lose
text since the last acknowledged chunk. A completed `run_end` contains the final
frontend transcript exactly once.

One session writer owns a lock for an active run; other metadata/legacy writes
take it for their individual append. The lock has an owner PID, host, and random
token. A dead local PID can be recovered under a separate recovery guard. An
ambiguous live PID, another host, an incomplete lock, or an existing recovery
guard blocks writing rather than stealing ownership. This is local filesystem
coordination; network filesystem guarantees are not claimed. Syncs cover file
content boundaries, while power loss and directory-sync support vary by host.

An intent without a result is **execution uncertain**. Arbitrary shell and file
effects cannot be made exactly once with the journal. Recovery never invokes a
tool automatically. The user must inspect uncertain effects and record retry or
abandon before continuation. A persisted result is reused as history, not
executed again. A restart can continue a verified prefix but cannot restore a
network stream or a shell instruction pointer.

If a frontend encounters an unexpected error before it receives a terminal run
result, it releases writer ownership without writing `run_end`. The TUI requires
the user to reload that session so the saved prefix and any uncertain effects
are shown before new work. Headless exits with an error and leaves the prefix
for explicit continuation.

## Reading and recovery

Readers keep legacy `turn` records in order and place journaled runs at their
`run_start` position. A valid `run_end` contributes one final turn. An unfinished
run contributes its contiguous saved prefix and a warning. Unstarted calls get
local `not_executed` results; a call with intent but no result gets
`execution_uncertain`. These describe Argus state and preserve assistant/tool
pairing. Partial assistant text is retained once as lower-priority assistant
content. A malformed tail yields the earlier valid prefix; an interior gap
marks the active run damaged and prevents later records from being trusted for
that run. Legacy malformed lines are skipped with line-number warnings.

Folder-scoped startup considers the newest 20 sessions and selects the newest
matching cwd. Metadata discovery scans the file without retaining turn payloads.
Explicit resume loads the transcript and warnings. The writer separates a torn
last line before appending; it does not rewrite historical bytes. Unknown record
types are ignored for additive compatibility, but older binaries may omit newer
run records and are not safe downgrade writers.

Queued steering is acknowledged only after its record is synced. A steering
checkpoint also marks it applied if a later applied-state record was lost in a
crash. Pending instructions are restored on restart. A linked continuation is a
new run with `parentRunId`; it does not change the earlier run's outcome.

## Private artifacts and lifecycle

The stable `sessionId` names a private artifact directory under
`ARGUS_HOME/context`. Context source files and bounded shell/spill files use
owner-only permissions and survive session rename. Deleting or pruning a
session removes its artifact directory; active ownership blocks housekeeping.
Unnamed headless runs use the general private `ARGUS_HOME/tmp` spill directory,
which currently has no automatic retention. Artifact paths can become unavailable
after explicit deletion or an external filesystem change; a saved pointer does
not guarantee the file still exists.

The current offline tests include crash-prefix reading, a child-process crash
after intent, competing writers, torn records, legacy turns, and artifact
cleanup. These establish those tested cases, not power-loss durability or
universal provider compatibility.
