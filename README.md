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
To run this checkout as `argus` from any working directory:

```bash
cd /path/to/argus
npm link
mkdir -p ~/.argus
test -e ~/.argus/.env || cp .env.example ~/.argus/.env
chmod 600 ~/.argus/.env
# Edit ~/.argus/.env with your provider key, endpoint, and model.
cd /path/to/your/project
argus doctor
argus --new
```

`npm link` points the global command at this checkout, so source changes take
effect immediately. `argus doctor` checks the Node version and configuration,
then makes an unauthenticated HEAD request to check endpoint reachability; it
does not establish that credentials or the selected model work. This package is
private and is not published to the npm registry.

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
| `/continue` | Continue the latest unfinished run with recorded progress |
| `/resolve retry\|abandon` | Record what to do about an uncertain tool attempt before continuing |
| `/steer <text>` | Queue a correction during a run; `list` or `cancel ID` manages queued text |
| `/check <command>` | Mark an exact shell command as an optional check for the next turn; `list` or `clear` manages checks |
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

Run starts, completed steps, tool intent, and results are checkpointed; a crash
can still lose text since its last acknowledged chunk. Restart shows the saved
prefix without re-running tools. An intent lacking a result requires inspection
and `/resolve retry` or `/resolve abandon` before `/continue`. A continuation is
a new model request using recorded progress. `/model` overrides
persist per session; `/new` uses the configured default. Retention is opt-in through
`ARGUS_SESSION_KEEP`. Session format and recovery details are in
[docs/sessions.md](docs/sessions.md); failure inspection is in
[docs/debug-tool-failures.md](docs/debug-tool-failures.md).

## Headless mode

```bash
npm start -- "explain this repository"
npm start -- "continue the review" --session my-task
npm start -- --continue --session my-task
npm start -- --continue --session my-task --resolve abandon
npm start -- "fix the issue" --check "npm test" --session my-task
npm start -- --help
```

Assistant text goes to stdout; reasoning, tool calls, and errors go to stderr.
A named session resumes its history and saves the new turn. Destructive shell
commands requiring human approval are blocked in headless mode.
`--check` designates an exact shell command as a verification check; it does
not run the command automatically. Argus reports whether the model ran it,
its observed status, and whether later work made its evidence stale. Checks
not designated this way remain ordinary shell observations.
Exit status is 0 when the model ends normally, 130 when interrupted, and 1 for
failed, truncated, or locally limited runs. Normal completion does not certify
the requested work is correct.

## Execution and limits

The model requests actions; local code validates, authorizes, and executes them.
Tool execution is sequential, including batches returned by a provider. File reads
are bounded and paged. Edits support exact/fuzzy matching and fresh line ranges;
creation protects existing files unless overwrite is explicit. Destructive shell
patterns require confirmation in the TUI. This pattern gate is not a sandbox.
See [the tool contract](docs/tools.md) for exact behavior.

Long conversations use deterministic compaction. Tool results and complete
requests have size limits, and model calls have retry/timeout/step bounds.
The bounded context digest cites a private source artifact that can be paged
with `read`; it is lower-trust task data and may omit detail. Shell commands
are supervised on supported POSIX hosts. The footer shows a short live output
preview, and output beyond the 1 MB preview is drained into private files up
to an 8 MB artifact cap. Oversized tool results can be inspected through their
saved spill path. Reported
usage in the footer is a context/output display metric, not a billing total.
Saved timing records also retain reported usage by network attempt, with missing
reports marked unknown. Semantic and mid-run context reduction and provider
fallback remain future work; [GAPS.md](GAPS.md) records current limitations.

## Develop

Read [AGENTS.md](AGENTS.md) for the module map and
[docs/self-updating.md](docs/self-updating.md) for the workflow.
[docs/conventions.md](docs/conventions.md) defines reusable code, test, and tag
conventions; [docs/architecture.md](docs/architecture.md) explains the boundaries.

```bash
npm run verify                  # repository checks + offline tests
npm test -- --test-reporter=spec # offline tests with per-test output
npm run eval:tools              # opt-in real-provider tool-choice evaluation
npm run eval:coding             # opt-in coding-task trials (may incur API cost)
```

Offline tests use a scripted SSE server and a disposable home directory. Provider
evaluation needs credentials and may incur API cost. [PROGRESS.md](PROGRESS.md)
records verified changes; [NEXT_STEPS.md](NEXT_STEPS.md) ranks candidate work.
The coding evaluator uses six disposable task workspaces and external behavioral
checks. `ARGUS_EVAL_TASKS` selects task names; `ARGUS_EVAL_TRIALS` defaults to three.
`ARGUS_EVAL_TIMEOUT_MS` bounds a trial and `ARGUS_EVAL_TOTAL_TIMEOUT_MS` bounds
the whole run; the defaults are two and ten minutes respectively.
It prints a sanitized JSON summary without transcript content. Its process
boundary is for repeatability, not adversarial isolation.

## Acknowledgements

Argus grew from studying [pi](https://github.com/earendil-works/pi) as a conceptual
reference for a terminal tool-calling agent. This repository implements its own
smaller, dependency-free design.
