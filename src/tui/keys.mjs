/**
 * Terminal escape-sequence decoding.
 *
 * Raw terminal input arrives as a byte stream: ordinary characters are text,
 * while keys, the mouse, and bracketed paste arrive as escape sequences. This
 * module knows that protocol and nothing else — it turns the start of a buffer
 * into a `{ consumed, ... }` result so the TUI can slice the buffer and act on
 * it. Keeping the protocol here (rather than in the controller) mirrors
 * `renderers.mjs`: pure, table-driven, and directly unit-testable.
 */

/**
 * Decode the escape sequence at the start of `buf`.
 *
 * @param {string} buf raw input bytes received so far
 * @returns {null | { consumed: number, action?: object, pasting?: boolean, ignored?: boolean }}
 *   `null` when `buf` may be an incomplete sequence (caller should wait for
 *   more bytes). Otherwise `consumed` is how many characters belong to the
 *   sequence, plus exactly one outcome:
 *   - `action` — a key or mouse action to dispatch;
 *   - `pasting: true` — bracketed-paste start; the payload follows;
 *   - `ignored: true` — an OSC query / unknown CSI / Alt+key: consume and drop.
 */
export function decodeEscape(buf) {
  // Bracketed paste start: collect the entire payload so embedded newlines
  // cannot accidentally submit several prompts. The TUI pastes the payload
  // literally and preserves the newlines (see pasteLiteral in tui.mjs).
  if (buf.startsWith("\x1b[200~")) return { consumed: 6, pasting: true };

  // OSC sequence (theme response etc.): consume up to ESC \ or BEL.
  if (buf.startsWith("\x1b]")) {
    const st = buf.indexOf("\x1b\\", 2);
    const bel = buf.indexOf("\x07", 2);
    let end = -1;
    if (st !== -1 && (bel === -1 || st < bel)) end = st + 2;
    else if (bel !== -1) end = bel + 1;
    if (end === -1) return null;
    return { consumed: end, ignored: true };
  }

  // SGR mouse events (wheel = buttons 64/65).
  if (buf.startsWith("\x1b[<")) {
    const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
    if (!m) return null;
    const btn = Number(m[1]);
    const action =
      btn === 64 ? { type: "wheel", dir: 1 } : btn === 65 ? { type: "wheel", dir: -1 } : null;
    return { consumed: m[0].length, ...(action ? { action } : { ignored: true }) };
  }

  // CSI key sequences.
  const CSI = [
    [/^\x1b\[A/, { type: "up" }],
    [/^\x1b\[B/, { type: "down" }],
    [/^\x1b\[C/, { type: "right" }],
    [/^\x1b\[D/, { type: "left" }],
    [/^\x1b\[H/, { type: "home" }],
    [/^\x1b\[F/, { type: "end" }],
    [/^\x1b\[1~/, { type: "home" }],
    [/^\x1b\[4~/, { type: "end" }],
    [/^\x1b\[5~/, { type: "pageup" }],
    [/^\x1b\[6~/, { type: "pagedown" }],
    [/^\x1b\[3~/, { type: "delete" }],
    [/^\x1b\[13;2u/, { type: "shiftenter" }],
  ];
  for (const [re, action] of CSI) {
    const m = re.exec(buf);
    if (m) return { consumed: m[0].length, action };
  }

  // Unknown CSI sequence: consume up to and including the final byte (in range
  // 0x40-0x7E), so no trailing bytes leak into text.
  if (buf.startsWith("\x1b[")) {
    let j = 2;
    while (j < buf.length && buf.charCodeAt(j) < 0x40) j++;
    if (j >= buf.length) return null; // incomplete sequence
    return { consumed: j + 1, ignored: true };
  }

  // Alt+key escape: consume ESC + next byte, ignore.
  if (buf.length >= 2) return { consumed: 2, ignored: true };
  return null;
}
