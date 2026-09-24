# argus

A minimal terminal coding agent: a streaming model loop with four tools,
`read`, `write`, `edit`, and `bash`. It runs on Node built-ins, with no install
or build step. The terminal UI and headless mode share the same agent and saved
transcript behavior.

## Run

Use the Node version declared in [package.json](package.json), then:

```bash
cp .env.example .env
# Set ARGUS_API_KEY in .env.
npm start
```

The committed template selects a DashScope-compatible endpoint and model. You can
choose another OpenAI-compatible chat-completions endpoint, including a local
server. All variables and defaults are documented in [.env.example](.env.example).
`OPENAI_API_KEY` is accepted as a fallback only for `api.openai.com`.

Configuration precedence is shell environment, project `.env`, home `.env`, then
built-in defaults. `ARGUS_HOME` relocates the home configuration and session store.
Optional `npm link` makes this checkout available as the `argus` command.

## Interactive use

The TUI shows streaming assistant text and reasoning, Markdown tables, a scrollable
transcript, a multiline editor, and a footer with cwd, model, git state, timing,
and reported token usage. Tools show concise labels and bounded result previews;
a slow tool is identified in the footer.

- Enter submits; Shift+Enter inserts a newline when supported by the terminal.
- Bracketed paste preserves newlines and inserts control bytes as text. Large
  unchanged pastes display a short marker while their full text reaches the model.
- Up/Down navigate suggestions or prompt history; multiline drafts survive history
  navigation. Tab accepts `@path`, command, or saved-session suggestions.
- PgUp/PgDn and the mouse wheel scroll; Home/End jump to the top or latest output.
- Esc interrupts a running turn. Ctrl-C interrupts, and a second press forces exit;
  when idle it exits. Ctrl-D exits only when idle with an empty editor.
- `/help` and `/keys` show the complete in-app reference.

`@path` is a reference for the model to read visibly, not eager file injection:

```text
Review @src/agent.mjs and explain its failure modes.
```

| Command | Action |
| --- | --- |
| `/help`, `/keys` | Command and keyboard reference |
| `/status` | Current session, model, cwd, usage, and limits |
| `/show <n>` | Show transcript block n and its stored tool result |
| `/model [name]` | Inspect or change the session model |
| `/sessions` | List recent sessions with sizes and last prompts |
| `/resume <name>` | Switch to a saved session |
| `/name <name>` | Rename this session |
| `/new [name]` | Start a fresh session |
| `/delete <name>` | Confirm deletion of an inactive session |
| `/exit`, `/quit` | Exit |

Starting without flags resumes a recent session associated with the current
folder, or starts fresh when none matches. Explicit choices:

```bash
npm start -- --new
npm start -- --session my-task
```

Turns save automatically, including failed and interrupted work. `/model` overrides
persist per session; `/new` uses the configured default. Retention is opt-in through
`ARGUS_SESSION_KEEP`. Session format and recovery details are in
[docs/sessions.md](docs/sessions.md); failure inspection is in
[docs/debug-tool-failures.md](docs/debug-tool-failures.md).

## Headless mode

```bash
npm start -- "explain this repository"
npm start -- "continue the review" --session my-task
npm start -- --help
```

Assistant text goes to stdout; reasoning, tool calls, and errors go to stderr.
A named session resumes its history and saves the new turn. Destructive shell
commands requiring human approval are blocked in headless mode.

## Execution and limits

The model requests actions; local code validates, authorizes, and executes them.
Tool execution is sequential, including batches returned by a provider. File reads
are bounded and paged. Edits support exact/fuzzy matching and fresh line ranges;
creation protects existing files unless overwrite is explicit. Destructive shell
patterns require confirmation in the TUI. This pattern gate is not a sandbox.
See [the tool contract](docs/tools.md) for exact behavior.

Long conversations use deterministic compaction. Tool results and complete
requests have size limits, and model calls have retry/timeout/step bounds.
Oversized tool results can be inspected through their saved spill path. Reported
usage is a context/output display metric, not a billing total. Lossless interrupt
and continue, steering, semantic compaction, and provider fallback remain future
work; [GAPS.md](GAPS.md) records current limitations.

## Develop

Read [AGENTS.md](AGENTS.md) for the module map and
[docs/self-updating.md](docs/self-updating.md) for the workflow.
[docs/conventions.md](docs/conventions.md) defines reusable code, test, and tag
conventions; [docs/architecture.md](docs/architecture.md) explains the boundaries.

```bash
npm run verify                  # repository checks + offline tests
npm test -- --test-reporter=spec # offline tests with per-test output
npm run eval:tools              # opt-in real-provider tool-choice evaluation
```

Offline tests use a scripted SSE server and a disposable home directory. Provider
evaluation needs credentials and may incur API cost. [PROGRESS.md](PROGRESS.md)
records verified changes; [NEXT_STEPS.md](NEXT_STEPS.md) ranks candidate work.

## Acknowledgements

Argus grew from studying [pi](https://github.com/earendil-works/pi) as a conceptual
reference for a terminal tool-calling agent. This repository implements its own
smaller, dependency-free design.
