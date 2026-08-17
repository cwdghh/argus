/**
 * Shared block folding for pretty transcript rendering.
 *
 * Both frontends (the TUI and headless mode) render a running turn as a list
 * of display blocks. Streaming text arrives as many tiny deltas; this helper
 * folds consecutive deltas of the same kind into one growing block so the
 * transcript stays readable and the session JSONL stays compact. It lives
 * here so the TUI and headless never drift apart.
 */

/**
 * Append a text delta to `blocks`, folding it into the previous block when it
 * has the same kind (so streamed tokens accumulate into one block). Blocks are
 * `{ kind, text, ... }` objects; mutating the array in place keeps the simple
 * "append-only" model every frontend already uses.
 */
export function appendBlock(blocks, kind, delta) {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) last.text += delta;
  else blocks.push({ kind, text: delta });
  return blocks;
}
