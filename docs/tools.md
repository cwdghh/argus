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
| `read`    | Read a file's contents as text |
| `write`   | Overwrite/create a file with text |
| `edit`    | Replace an exact string in a file |
| `bash`    | Run a shell command, return stdout/stderr |

### read

```js
{ name: "read", parameters: { path: string } }
```

### write

```js
{ name: "write", parameters: { path: string, content: string } }
```

Overwrites the whole file.

### edit

```js
{ name: "edit", parameters: { path: string, old: string, new: string } }
```

Replaces every occurrence of the exact string `old` with `new`. Errors if `old`
is not found. Use this for precise, small changes; use `write` for full files.

### bash

```js
{ name: "bash", parameters: { command: string } }
```

Runs `command` with a 60s timeout and returns `{ stdout, stderr }`. Non-zero exit
is returned as `{ error: true, ... }`, never thrown.

## Guidelines for writing tools

1. **Write the description for the model**, not for humans — it decides *when* to
   call the tool from this text.
2. **Return JSON-serialisable values.** The result is stringified and fed back to
   the model as a `tool` message.
3. **Fail gracefully.** Return an error in the result object; don't throw
   (unless you want the loop to record it as an error result).
4. **Keep side effects predictable.** A tool should do one thing well.

## Adding a tool

Add one object to the `tools` array in `src/tools.mjs`. The loop and TUI pick it
up automatically. Update this file and the tool list in `AGENTS.md`. See
`self-updating.md` for the full workflow.
