# Repository conventions

These are the engineering conventions for subsequent development. `AGENTS.md`
owns project constraints and the module map; [self-updating.md](self-updating.md)
owns the change workflow and documentation ownership.

## Code and module boundaries

- Use native ESM (`.mjs`), `node:` imports for built-ins, explicit file extensions,
  two-space indentation, semicolons, UTF-8, LF, and a final newline. Prefer named
  exports and descriptive names. `.editorconfig` and `.gitattributes` carry the
  editor and checkout settings.
- Give each module one responsibility. Separate pure transformations from network,
  filesystem, process, and terminal I/O. A file approaching 400 lines is a review
  cue, not a reason to split cohesive code arbitrarily.
- Keep dependencies flowing toward lower-level capabilities. No circular imports.
  The agent coordinator may use the model transport and tools; it must not import
  the TUI, headless frontend, or session persistence.
- Import the session package through `src/session/index.mjs` from outside that
  package. Internal helpers are imported directly from their owning modules;
  do not retain obsolete re-exports merely to avoid updating callers.
- Frontends consume agent events. Shared event-to-block behavior belongs in
  `src/transcript.mjs`; terminal input, turn presentation, layout, and lifecycle
  stay in their respective TUI modules. Avoid copying event switches between
  frontends for shared persisted behavior.
- Keep the model-visible tool schemas and runtime argument checks aligned.
  `docs/tools.md` owns behavior; `docs/tool-surface.md` owns design decisions.
- Resolve environment configuration lazily after dotenv loading. Do not capture
  environment-dependent paths at module import time. Defaults belong in
  `.env.example` and the owning configuration code.
- Comments explain invariants or tradeoffs. Remove obsolete plan item numbers and
  explanations of removed implementations when touching the surrounding code.

## Errors, state, and side effects

- Expected tool failures are structured results. Turn failures preserve completed
  messages, cwd, and provider usage. Never report a failed side effect as success.
- Keep state in one explicit owner. Pass cwd, cancellation, authorization, and
  clocks as context; avoid extra mutable global state. Shared theme state is
  deliberate and its revision participates in render cache invalidation.
- Dedupe persistence only after a successful write, inside the serialized queue.
  Release readers, timers, listeners, and temporary files on success and failure.
- Validate before side effects. Use exclusive creation for no-overwrite promises;
  a check followed by a write is insufficient. Replacement writes must preserve
  file modes and existing symlinks. Atomic replacement means readers see a whole
  file; it does not promise power-loss durability or coordinate multiple editors.
- Store credentials only in the user's environment/configuration. Session config
  records use an explicit allowlist. Tool output and session files can contain
  private project data, so generated persistence uses owner-only permissions.
- Preserve old session records as data. Readers may support older record shapes;
  that does not require exposing obsolete model tool schemas.

## Verification

Run `npm run verify` before declaring a change complete. It runs:

1. `npm run check`: syntax checks across source, tests, evaluation, and scripts;
   literal import resolution, built-in-only dependencies, source import cycles,
   agent/session boundaries, LF/final-newline checks for code, and local Markdown
   file links in living documentation. It is a deliberately small repository
   check, not a complete JavaScript parser or Markdown anchor validator.
2. `npm test`: Node's offline test suite in a disposable `ARGUS_HOME`. Mock SSE
   providers exercise protocol and frontend behavior without credentials.

Write regression tests for changed behavior and realistic failure paths. Assert
observable results and preserved invariants, not a copy of the implementation.
Use temporary workspaces and `t.after()` cleanup. Module moves can rely on the
existing integration tests; do not add tests merely to assert the new filenames.
`npm test -- --test-reporter=spec` selects readable test output. For a targeted
file, use `node --test test/<name>.test.mjs` with isolated fixtures.

CI runs the same verification command on Linux and macOS with Node 22 and 24.
The declared minimum remains in `package.json`. A local run on a different Node
version does not establish that the CI matrix passed. Live provider evals
(`npm run eval:tools`) are a separate, opt-in check with possible API cost.

## Commits and reference tags

- Keep a commit reviewable: implementation, relevant tests, and the owning docs.
  Prefix subjects with `refactor:`, `fix:`, `feat:`, `docs:`, `test:`, or `tui:`.
- Humans review and commit by default, as specified in `AGENTS.md`. An explicit
  request to commit or tag the completed outcome authorizes that local action.
  Do not invent co-author identities. Publishing requires user authorization.
- Use annotated `baseline/YYYY-MM-DD` tags for verified development checkpoints.
  Use release tags `vMAJOR.MINOR.PATCH` only for an intentional release with the
  matching package version. A baseline tag does not change the package version.
- Tag a commit containing the complete verified result, with a clean working
  tree. Record the scope, checks actually run, and known limitations in the tag
  message and the dated progress entry. Never move an existing tag to a new
  commit; use a new name if another checkpoint is needed.
