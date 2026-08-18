# Tools

Tools are how the agent touches the world. They are the interface between the
model's world (text) and the real world (files, processes).

## The contract

Every tool is one object with four fields:

```js
{
  name:        "read",        // handle the model uses to request it
  description: "...",         // the model's only documentation — write it well
  parameters:  { /* JSON Schema */ },
  execute:     async (args) => result,  // runs only in your code
}
```

The model only ever sees `name`, `description`, and `parameters`. It never sees
`execute`. **The model proposes; `execute` disposes.**

## Default tools

| Tool | Purpose |
|------|---------|
| `read`    | Read a file as text, bounded (2000 lines / 50KB) with `offset`/`limit` paging |
| `write`   | Create a file, with explicit opt-in for overwrite |
| `edit`    | Replace a string (or several, atomically) with fuzzy fallback |
| `bash`    | Run a shell command, return stdout/stderr |

### read

```js
{ name: "read", parameters: { path: string, offset?: int, limit?: int } }
```

Returns the file's contents as text with **absolute line numbers** on every
line, so the model never has to count lines itself:

```
  1 │ const a = 1;
  2 │ const b = 2;
```

Reads are **bounded** so a big file never floods the context window: at most
2000 lines or 50KB (whichever hits first) are returned, and the result ends
with a notice such as

```
[Showing lines 1-2000 of 12000. Use offset=2001 to continue.]
```

Pass `offset` (1-indexed) and `limit` to page through large files (line
numbers are always absolute, across pages). A line that alone exceeds the
byte limit is not returned; the result suggests a `bash` one-liner
(`sed -n 'Np' path | head -c 50000`) to read it in chunks.

### write

```js
{ name: "write", parameters: { path: string, content: string, overwrite?: boolean } }
```

Creates a new file. Existing files are protected unless `overwrite: true` is
passed explicitly. Prefer `edit` for focused changes to an existing file.

### edit

```js
{ name: "edit", parameters: {
    path: string,
    edits?: [                 // mix and match in one atomic call
        { old?: string, new?: string },            // content form
        { startLine?: int, endLine?: int, new?: string },  // range form
    ],
    old?: string, new?: string,      // legacy content form
    startLine?: int, endLine?: int,  // legacy range form
    all?: boolean,
} }
```

**Content mode** (`old`/`new`) replaces one or more targeted strings, matched
exactly first, then tolerant of the small differences that make edits "fail
with no old strings": trailing whitespace, line-number gutters, smart quotes,
unicode dashes, and CRLF line endings are normalised before matching (NFKC +
ASCII folding). Edited lines are rebuilt from the normalised text and overlaid
back onto the file, so untouched lines keep their exact bytes; the file's CRLF
style and UTF-8 BOM are preserved. The result includes `fuzzy: true` when a
relaxed match was used.

**Range mode** (`startLine`/`endLine`/`new`) replaces the inclusive 1-indexed
line range `[startLine, endLine]` with `new` — copy the numbers from a `read`,
don't count them. `endLine` defaults to `startLine`; `endLine = startLine - 1`
inserts `new` before `startLine`; `new = ""` deletes the range. Range mode is
line-oriented (like `sed`): the block occupies whole lines and never merges
with its neighbours, and CRLF is preserved. Use it for whole-function rewrites,
insertions, or deletions where reproducing the old content byte-for-byte would
be wasteful.

Both modes may be mixed in one `edits[]` call; every replacement is resolved
against the original file and applied bottom-up, and the whole call is
rejected if any replacements overlap. In content mode each `old` must be
unique; an ambiguous match errors unless `all: true` is passed explicitly.
Use content mode for small, precise changes; use `write` for full files.

### bash

```js
{ name: "bash", parameters: { command: string } }
```

Runs `command` with a 60s timeout and returns `{ stdout, stderr, cwd }`. The
shell's actual final directory is captured, so quoted and compound commands
such as `cd "a b" && pwd` persist correctly. Non-zero exit is returned as
`{ error: true, ... }`, never thrown.

## Guidelines for writing tools

1. **Write the description for the model**, not for humans — it decides *when* to
   call the tool from this text.
2. **Return JSON-serialisable values.** The result is stringified and fed back to
   the model as a `tool` message.
3. **Fail gracefully.** Return an error in the result object; don't throw
   (unless you want the loop to record it as an error result).
4. **Keep side effects predictable.** A tool should do one thing well.
5. **Use simple schemas.** Required arguments, primitive types, arrays, objects,
   integers, and string `minLength` are validated before execution.

## Adding a tool

Add one object to the `tools` array in `src/tools.mjs`. The loop and TUI pick it
up automatically. Update this file and the tool list in `AGENTS.md`. See
`self-updating.md` for the full workflow.

## Open design questions

The exact shape of the tool surface is an open discussion — scheduled as the
next session's opener (2026-08-18); the full agenda is `GAPS.md` #12. In
short: what *earns* a tool a place among the default four, whether tools
should declare a risk level so the safety gate can route on it, result-shape
conventions (error shape, truncation notice, "how to continue" guidance), and
whether the read-before-edit freshness guard or parallel execution change this
contract or stay loop-level state.
