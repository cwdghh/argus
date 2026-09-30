# Tools

Tools are the boundary between model requests and local side effects. The
default surface is intentionally fixed at `read`, `write`, `edit`, and `bash`.
`docs/tool-surface.md` owns the rationale; this file owns the current contract.

## Registry contract

A registry entry has three model-visible fields and model-invisible execution
policy:

```js
{
  name: "read",
  description: "...",          // model-visible usage documentation
  parameters: { /* schema */ }, // model-visible and runtime-validated
  risk: "read-only",            // model-invisible policy classification
  validate(args) { /* ... */ },  // optional cross-field validation
  approval(args) { /* ... */ },  // optional reason string requesting approval
  async execute(args, context) { /* ... */ },
}
```

The model proposes a call; the loop parses and validates it, performs any
authorization step, executes it, bounds the result, and returns the serialized
result as a tool message. The model never sees `risk`, `validate`, `approval`,
or `execute`.

Runtime schema validation is recursive and supports the subset the registry
uses: object/array/string/boolean/integer types, `required`,
`additionalProperties`, `items`, `minItems`, `minimum`, and `minLength`.
Semantic validators enforce rules that JSON Schema would express less clearly,
such as `edit`'s mutually exclusive selectors.

## Default tools

### `read`

```js
{ path: string, offset?: integer >= 1, limit?: integer >= 1 }
```

Reads UTF-8 text with absolute, 1-indexed line numbers. Paths resolve from the
current tool cwd. The scanner keeps memory bounded while computing the full
file hash and total line count; it does not load an arbitrarily large file
into memory. Use `read`, rather than a shell command, for ordinary text-file
inspection.

Success has this shape:

```js
{
  path, numberedText, startLine, endLine, totalLines,
  truncated?: true,
  nextOffset?: integer,
}
```

`numberedText` is bounded to 2,000 lines, 50 KB of source text, the requested
`limit`, and the active per-result serialization limit. When more lines exist,
`truncated` and `nextOffset` are present and the text includes a continuation
notice. Its `N │ ` prefixes are selection metadata, not file content. An empty
file reports line bounds `0`–`0`. An offset beyond EOF or a
single line too large to return is a structured error with `path` and
`message`; the latter recommends `bash` byte-range inspection without
constructing a shell command from an untrusted path.

Every successful page records the exact file hash and the displayed line
range in same-turn freshness state for range edits.

### `write`

```js
{
  path: string,
  content: string,
  ensureFinalNewline?: boolean,
  overwrite?: boolean,
}
```

Creates a complete UTF-8 text file. Existing files are protected unless
`overwrite: true` is explicit. `ensureFinalNewline` defaults to `true`, adding
LF only when `content` does not already end in one; `false` writes `content` exactly and
does not strip a newline already present. Success returns
`{ ok: true, path, bytes, finalNewline, newlineAdded }`. Filesystem failures
return `{ error: true, path?, message, code? }`.

Creation installs a completed temporary file with an exclusive link, so a
concurrent writer cannot defeat no-overwrite protection. Overwrite and edit use
atomic replacement, preserve existing POSIX permission bits, and follow existing
symlinks to their targets. Dangling symlinks are rejected rather than replaced.
Replacement does not preserve inode identity or hard-link relationships and is
not an fsync/power-loss durability guarantee.

Use `ensureFinalNewline: false` when exact bytes without a final LF matter.
The option is separate from `content` because live models can omit an invisible
trailing character even when prose asks for it. Parent directories
must already exist; relative paths resolve from the current tool cwd.
Use `write`, rather than shell redirection or a heredoc, to create text files.
`write` invalidates any freshness stamp for its resolved path. Use `edit` for
targeted changes to an existing file; `overwrite: true` is for an intentional
whole-file replacement.

### `edit`

```js
{
  path: string,
  edits: [
    { old: nonEmptyString, new: string },
    // or
    { startLine: integer >= 1, endLine?: integer >= 0, new: string },
  ],
  all?: boolean,
}
```

`edits[]` is required, non-empty, and is the only accepted input shape. Every
item requires `new` and exactly one selector: `old` or `startLine`. Unknown
fields and legacy top-level edit fields are rejected before execution.

Content mode matches `old` exactly first. If exact matching fails, it tolerates
line-number gutters, trailing whitespace, CRLF differences, compatible Unicode
forms, smart punctuation, and Unicode spaces. The normalization maintains an
offset map into the original text, so a fuzzy replacement changes only the
matched span and preserves unrelated punctuation and whitespace. A match must
be unique unless `all: true`; an empty normalized needle is rejected. `old`
may therefore be copied from read's `numberedText`, but `new` is always literal
file text and must not contain those prefixes. Before resolving the batch,
the engine rejects strong evidence of leaked display gutters—for example, a
numbered `old` that only fuzzy-matches paired with numbered `new`, or a numbered
range replacement over ordinary unnumbered lines. It never silently strips
`new`, and ambiguous insertions remain allowed so genuine numbered data is not
made impossible.

Range mode is line-oriented and replaces inclusive 1-indexed lines. `endLine`
defaults to `startLine`; `endLine = startLine - 1` inserts before the line;
`new = ""` deletes. A single-line replacement never merges with the following
line: the block always occupies whole lines. The same turn must first have
read the affected lines from the exact current file content. Partial pages
authorize only their shown range. A file change, a `write`/`edit` to that
path, or any executed `bash` call invalidates the relevant evidence.
Freshness state is never restored from a session.

Content and range items may be mixed. All items resolve against the original
file, overlapping replacements are rejected, and the batch is written only
after every item succeeds. UTF-8 BOM and CRLF style are preserved. Success
returns `{ ok: true, path, replacements, fuzzy?: true }`; failure returns a
structured error without a partial edit. Use `edit`, rather than a shell
text-rewrite command, for targeted text-file changes. `endLine` is valid only
with `startLine`. `all: true` is valid only when every item uses `old`; mixed or
range batches cannot request it.

### `bash`

```js
{ command: nonEmptyString }
```

Runs one `/bin/sh` command with a 60-second timeout and a 1 MB combined
stdout/stderr preview cap. It continues draining beyond that cap, setting
`outputTruncated: true` while retaining the actual exit status. Results carry
`stdout`, `stderr`, `exitCode` (or `null`), `signal` (or `null`), and
`termination` (`completed`, `cancelled`, `timeout`, `spawn_error`, or
`cleanup_uncertain`). A non-zero exit adds `error: true` and `message`.
Cancellation adds `aborted: true`; a deadline adds `timeout: true`. Output
remains available on those paths. A successfully extracted final cwd is returned
only after ordinary process completion and becomes the base directory for later
tools. `bash` owns search, listing, environment inspection, builds,
tests, and other open-ended CLI work; it does not replace
`read`, `write`, or `edit` for ordinary text-file operations.

`command` is its only argument and is run by `/bin/sh`, so login-shell or
`bash`-only features such as `PIPESTATUS` are not available. Choose portable
inspection commands when possible. For a verification check, run the check itself:
`node check.mjs; echo passed` reports the echo's status, and a pipeline reports
its last command's status. The tool's `exitCode` is the shell's observed status;
it cannot identify the individual status of every command in a compound string.
An exact designated check must occupy the whole call to be recorded as evidence.

On POSIX systems, the shell starts in an owned process group. Cancellation or
timeout sends SIGTERM, then SIGKILL after 500 ms, and stops waiting after a
further bounded cleanup period. Descendants that detach from that group can
escape; `cleanup_uncertain` means even the bounded close did not settle. This
is process control, not a sandbox. A capped live output preview reaches the
TUI footer. When output exceeds the 1 MB in-memory preview, private stdout and
stderr artifacts retain up to 8 MB combined; `artifactTruncated` identifies a
larger stream, and `artifactError` identifies a failed artifact write. A file
write failure does not stop pipe draining or change the observed command exit.
Named sessions keep artifacts with their private session directory and remove
them on session deletion; unnamed headless runs use the general private temp
directory. On unsupported hosts only the immediate shell is signalled; no
descendant cleanup guarantee is made.

Before execution, the loop asks the tool's approval policy whether the call
needs authorization. Recursive removal, raw disk tools, filesystem formatters,
power commands, and a fork-bomb form trigger a structured approval request.
Backslash-newline continuations are normalized for this check. The request
contains the tool, arguments, cwd, risk, and reason, and the decision is
recorded in the transcript. Headless mode denies such requests. This classifier
is a best-effort accident backstop, not a shell sandbox or complete security
policy.

Once a shell command is approved for execution, all read freshness is
invalidated because arbitrary shell code may mutate any path, even if it later
exits non-zero.

## Loop-level guarantees

- Requests ask for one tool call, but provider replies containing several are
  accepted and executed sequentially in reply order. Validation, authorization,
  cwd changes, budgets, and freshness apply to each call. Calls in a batch are
  not a transaction: completed side effects remain if a later call fails.
- The third consecutive identical call with the same result is refused as a
  no-progress loop. After three unchanged A/B cycles, another A is refused too.
  A different next call is allowed to break the cycle.
- A reply with `finish_reason: "length"` returns a truncated turn. Its partial
  text is retained and every unexecuted tool call gets an explicit error result.
  Failed and interrupted turns also repair missing results beside their own
  assistant reply, keeping the saved history replayable.
- A tool call is not run on the final allowed model step; one step is reserved
  for the model to interpret and report its result.
- `ARGUS_MAX_TOOL_RESULT_CHARS` bounds each serialized result.
  `ARGUS_MAX_TURN_TOOL_RESULT_CHARS` bounds their cumulative size in one active
  turn. Oversized results retain a bounded tail preview and spill their full
  serialized payload to an owner-private JSON file. Named sessions keep this
  file in their artifact directory; unnamed runs use `ARGUS_HOME/tmp`. Error
  results retain a bounded failure reason in their top-level message. The
  `fullPath` pointer is included when it fits; `nextOffset` and shell
  exit/termination/truncation facts are preserved. Spill failure does not fail
  the turn. Unnamed temp files have no automatic retention.
  `ARGUS_MAX_REQUEST_CHARS` independently bounds the complete outgoing
  request before network I/O.
- Invalid JSON, unknown tools, invalid arguments, authorization denial, and
  execution failures become structured tool errors when recovery is safe.

## Adding or changing a tool

Prefer refining one of the four tools. A fifth default requires evidence under
the admission rule in `docs/tool-surface.md`. When the surface changes:

1. update the registry object and its schema;
2. add validation, result, policy, and loop interaction tests;
3. update this contract, `AGENTS.md`, and any affected defaults in
   `.env.example`;
4. run the verification required by `docs/self-updating.md` and append the
   actual result to `PROGRESS.md`.

Use `npm run eval:tools` for an opt-in provider-backed check of tool choice and
call shapes. It creates isolated temporary workspaces and may incur API cost;
it is separate from the deterministic offline test suite. Set
`ARGUS_EVAL_TASKS` to a comma-separated task-name subset when isolating a
behavior, for example `ARGUS_EVAL_TASKS=content-edit,uncued-numbered-edit`.
