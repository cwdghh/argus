# Inspecting saved tool failures

Failed and interrupted turns are retained in the session JSONL. The record format
and recovery behavior are in [sessions.md](sessions.md); result semantics are in
[tools.md](tools.md).

Each `turn.messages` array contains assistant tool calls followed by `tool`
messages. A tool message's `content` is itself a **JSON string**, so the file has
two serialization layers. Searching the raw line for `"error":true` is unreliable:
the inner quotes are escaped. Parse the outer record and then its tool content.

## Inspect one session

Replace the filename below with a saved session name. When using a custom
`ARGUS_HOME`, point the command at its `sessions` directory.

```bash
node --input-type=module - "$HOME/.argus/sessions/my-task.jsonl" <<'NODE'
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const input = createReadStream(process.argv[2]);
const lines = createInterface({ input, crlfDelay: Infinity });
let lineNumber = 0;
for await (const line of lines) {
  lineNumber++;
  let record;
  try { record = JSON.parse(line); }
  catch { console.error(`unparseable record at line ${lineNumber}`); continue; }
  if (record?.type !== "turn") continue;
  const calls = new Map();
  for (const message of record.messages ?? []) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
    if (message.role !== "tool") continue;
    let result;
    try { result = JSON.parse(message.content); } catch { continue; }
    if (!result?.error) continue;
    const call = calls.get(message.tool_call_id);
    console.log(JSON.stringify({
      line: lineNumber,
      tool: call?.name,
      id: message.tool_call_id,
      message: result.message,
    }));
  }
}
NODE
```

The reported line identifies the whole saved turn. Inspect that record's assistant
call for the exact arguments and its matching result for the failure. Call IDs
should be interpreted in conversation order because providers may reuse them in
later replies.

## Interpret the result

- `{error: true}` describes a tool rejection or execution failure. A shell command
  returning nonzero can be an expected task result, such as a search with no match.
- Authorization denials appear in the tool result; approval decisions also produce
  transcript events. Headless execution cannot ask for interactive approval.
- Turn-level failures, such as a provider timeout or request-size guard, can appear
  only as display error blocks. Inspect `turn.blocks` as well as tool messages.
- Interrupted/truncated calls can have synthetic unexecuted results. They record
  that no side effect ran, rather than an executor failure.
- Timing blocks retain outcome text and available provider usage. Partial network
  replies without usage do not establish a token count.

For historical configuration, fold preceding `config`, `model`, `cwd`, and `tools`
records and apply the turn's own config fields. The latest metadata is not enough
for a turn created before a configuration change. Inspect the tool snapshot named
by `toolSurfaceHash`; do not assume today's registry describes an old request.

Saved transcripts are inspection evidence, not exact HTTP recordings. For repeatable
behavior measurements, use the opt-in `npm run eval:tools` harness in isolated
workspaces. A recurring failure should guide a targeted change backed by tests,
under the admission rule in [tool-surface.md](tool-surface.md).
