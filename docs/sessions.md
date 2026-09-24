# Session records and recovery

This file owns the persisted session format. The public API is
`src/session/index.mjs`; [architecture.md](architecture.md) describes its module
boundaries. For inspecting failures, see [debug-tool-failures.md](debug-tool-failures.md).

## Storage and records

Each named session is an append-only `<name>.jsonl` file in the `sessions`
subdirectory of `ARGUS_HOME`. Configuration and path defaults are documented in
[.env.example](../.env.example). Session names are ASCII letters, digits, `-`,
and `_`, start with a letter or digit, and fit within 249 characters. The name
lives in the filename, so renaming does not rewrite history.

| Record type | Contents and meaning |
| --- | --- |
| `meta` | Format `version: 1`, initial model-visible `tools` snapshot and `toolSurfaceHash`. |
| `cwd` | Current working directory; later records supersede earlier ones. |
| `model` | Per-session model override; later records supersede earlier ones. |
| `config` | Credential-free configuration, including system prompt and endpoint, written on change. |
| `tools` | A changed model-visible schema snapshot and its `hash`. |
| `turn` | The model used, messages generated during the turn, display blocks, and `toolSurfaceHash`. |

Metadata can appear **between any two turns**. New turn records serialize `type`
first so metadata discovery can skip deserializing their payloads. Readers also
accept older records with a different field order. Unknown record types are
ignored to permit additive format extensions.

`configRecord()` in `session/data.mjs` owns the persisted configuration allowlist.
The API key is excluded. New frontend turns store only the model in their `config`
field; earlier records can carry the larger configuration there. To inspect the
configuration for a historical turn, fold metadata in file order up to that turn,
then apply its `config` fields. The final metadata state alone is insufficient
when a session changed configuration.

Messages record the user prompt, assistant tool calls, and serialized tool
results. Display blocks additionally retain reasoning, previews, authorization,
and timing. A partial assistant message has local `partial: true` metadata, and
a truncated model reply has local `truncated: true` metadata; neither flag is
sent as a provider message field. New timing blocks may record `runId`, terminal
`outcome`/`reason`, observed `partial` text/reasoning, per-request usage and
tool-attempt IDs. Earlier timing blocks without these fields remain readable.
Request totals sum reported counts only; `complete: false` means at least one
attempt lacks a full core usage report. These fields support inspection of the
conversation and schema in use. Compacted requests, transport extensions, and
interrupted network streams are not byte-for-byte HTTP request recordings.

## Reading and recovery

- Full loads stream one JSONL line at a time, accumulating valid turns. Invalid
  JSON and non-record values are skipped with line-number warnings, including
  interior damage. Unknown record types are ignored. Recovery does not imply
  that omitted damaged turns can be reconstructed.
- Metadata discovery scans the entire file to find the latest cwd/model/config,
  without retaining turns. Current turn records are skipped before JSON parsing;
  legacy turn records may still need parsing. Memory is bounded by one record
  plus metadata, not a fixed byte cap on an individual record.
- Folder-scoped default resume considers the newest 20 sessions and chooses the
  newest whose final cwd equals or sits below the launch folder. Unreadable
  candidates are skipped. Explicit resume performs a full load and shows warnings.
- Before appending to an existing file, the writer separates any unterminated
  final record with a newline. Subsequent valid records remain independently
  recoverable, and existing bytes are not rewritten.

## Writing and lifecycle

One `Session` handle serializes its writes. Metadata deduplication happens inside
that queue and advances only after a successful append; failed writes can retry
the same value. This is single-writer persistence, not cross-process locking.
Session storage uses directory mode `0700` and file mode `0600` on POSIX systems.

Each turn references its schema hash. A changed surface adds a `tools` record;
old executor aliases are unnecessary. The writable handle and the UI switch
sessions together. Rename drains queued writes before moving and repointing the
handle; deletion requires an exact inactive name. Configured retention preserves
the active session and applies in both frontends.

Session data is never migrated or pruned merely by a source refactor. Cleanup is
an explicit command or the user's configured retention policy. Interrupt and
continue with crash-safe checkpoints remains planned in
[interrupt-resume.md](interrupt-resume.md); a turn is still saved only at its end.
