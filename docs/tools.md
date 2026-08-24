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
  ensureFinalNewline: boolean,
  overwrite?: boolean,
}
```

Creates a complete UTF-8 text file. Existing files are protected unless
`overwrite: true` is explicit. `ensureFinalNewline: true` appends LF when
`content` does not already end in one; `false` writes `content` exactly and
does not strip a newline already present. Success returns
`{ ok: true, path, bytes, finalNewline, newlineAdded }`. Filesystem failures
return `{ error: true, path?, message, code? }`.

The newline decision is required and separate from `content` because live
models can omit an invisible trailing character even when prose asks for it.
Use `write`, rather than shell redirection or a heredoc, to create text files.
`write` invalidates any freshness stamp for its resolved path. Use `edit` for
targeted changes to an existing file.

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
text-rewrite command, for targeted text-file changes.

### `bash`

```js
{ command: nonEmptyString }
```

Runs one shell command with a 60-second timeout and a 1 MB child-process
buffer. It returns bounded `{ stdout, stderr, cwd? }`; a non-zero exit adds
`error: true` and `message`. User cancellation reports `aborted: true`, while a
deadline reports `timeout: true`. A successfully extracted final cwd becomes
the base directory for later tools. `bash` owns search, listing, environment
inspection, builds, tests, and other open-ended CLI work; it does not replace
`read`, `write`, or `edit` for ordinary text-file operations.

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

- Exactly one tool call may appear in a provider reply. A reply containing
  several is rejected before any call runs.
- The third consecutive identical call with the same result is refused as a
  no-progress loop. Intervening work resets the streak.
- A tool call is not run on the final allowed model step; one step is reserved
  for the model to interpret and report its result.
- `ARGUS_MAX_TOOL_RESULT_CHARS` bounds each serialized result.
  `ARGUS_MAX_TURN_TOOL_RESULT_CHARS` bounds their cumulative size in one active
  turn. The complete outgoing request is also checked against the context
  character safety limit before network I/O.
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
