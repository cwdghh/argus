# Refactoring Plan

## Current State (2025-08-14)

| File | Lines | Status | Notes |
|------|-------|--------|-------|
| `src/tui.mjs` | 1633 | ⚠️ Needs splitting | Contains 4 distinct concerns in one file |
| `src/tools.mjs` | 226 | ✅ OK | Clean, could extract tool definitions later |
| `src/session.mjs` | 171 | ✅ OK | Well-structured |
| `src/config.mjs` | 73 | ✅ OK | Simple config loader |
| `src/theme.mjs` | 45 | ✅ OK | Just theme definitions |
| `src/agent.mjs` | 213 | ✅ OK | Agent loop logic |
| `src/llm.mjs` | 283 | ✅ OK | LLM communication |

## Tasks

### 1. Split `src/tui.mjs` (Priority: HIGH)

The file contains four natural sections:

| Section | Lines | Content | Dependencies |
|---------|-------|---------|--------------|
| A | 1-76 | Imports, HELP_TEXT, ESC constants | None |
| B | 79-221 | ANSI + text helpers | None |
| C | 224-511 | Markdown rendering | Uses B |
| D | 514-562 | Block rendering | Uses B + C |
| E | 566-1633 | MinimalTui class | Uses A + B + C + D |

**Plan:**
- [x] Create `src/tui/renderers.mjs` (Sections B + C + D)
- [ ] Update `src/tui.mjs` to import from renderers
- [ ] Update imports in test files
- [ ] Run tests to verify no regressions

### 2. Clean up command handling in `tui.mjs` (Priority: MEDIUM)

Current: Hardcoded if/else chain in `runCommand()` (~80 lines)

**Plan:**
- [ ] Extract command definitions to `src/tui/commands.mjs`
- [ ] Add dynamic command discovery for tab-completion
- [ ] Add visual feedback for available commands

### 3. Improve tool call/result visibility (Priority: LOW - DONE)

- [x] Removed dim flag from tool/result text
- [x] Added bold to rail bars
- [x] Single space between rail and content
- [x] Improved light theme colors

## Progress Tracking

| Date | Task | Status |
|------|------|--------|
| 2025-08-14 | Tool visibility improvements | ✅ Done |
| 2025-08-14 | Split tui.mjs - create renderers.mjs | ✅ Done |
| 2025-08-14 | Split tui.mjs - update imports | ✅ Done |
| 2025-08-14 | Split tui.mjs - run tests (62/62 pass) | ✅ Done |
| - | Command handling refactor | ⏸️ Pending |

## Results

- `src/tui.mjs`: 1633 → 1158 lines (class + lifecycle + input handling)
- `src/tui/renderers.mjs`: 498 lines (pure rendering, zero TUI coupling)
- All 62 tests pass with zero regressions
