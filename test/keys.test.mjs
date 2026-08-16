import test from "node:test";
import assert from "node:assert/strict";
import { decodeEscape } from "../src/tui/keys.mjs";

test("decodeEscape: plain text and an empty buffer are not sequences", () => {
  assert.equal(decodeEscape("a"), null);
  assert.equal(decodeEscape(""), null);
});

test("decodeEscape: a lone ESC waits for the rest of the sequence", () => {
  assert.equal(decodeEscape("\x1b"), null);
});

test("decodeEscape: cursor and editing CSI keys map to actions", () => {
  const cases = [
    ["\x1b[A", { type: "up" }],
    ["\x1b[B", { type: "down" }],
    ["\x1b[C", { type: "right" }],
    ["\x1b[D", { type: "left" }],
    ["\x1b[H", { type: "home" }],
    ["\x1b[F", { type: "end" }],
    ["\x1b[1~", { type: "home" }],
    ["\x1b[4~", { type: "end" }],
    ["\x1b[5~", { type: "pageup" }],
    ["\x1b[6~", { type: "pagedown" }],
    ["\x1b[3~", { type: "delete" }],
    ["\x1b[13;2u", { type: "shiftenter" }],
  ];
  for (const [buf, action] of cases) {
    assert.deepEqual(decodeEscape(buf), { consumed: buf.length, action }, buf);
  }
});

test("decodeEscape: SGR mouse wheel maps to scroll actions", () => {
  assert.deepEqual(decodeEscape("\x1b[<64;5;3M"), { consumed: 10, action: { type: "wheel", dir: 1 } });
  assert.deepEqual(decodeEscape("\x1b[<65;5;3m"), { consumed: 10, action: { type: "wheel", dir: -1 } });
  // Non-wheel mouse buttons are consumed and ignored.
  const ok = decodeEscape("\x1b[<0;5;3M");
  assert.ok(ok.consumed > 0 && ok.ignored, "other buttons are dropped");
  assert.equal(decodeEscape("\x1b[<64;5"), null, "incomplete mouse event waits");
});

test("decodeEscape: bracketed paste start is signalled", () => {
  assert.deepEqual(decodeEscape("\x1b[200~"), { consumed: 6, pasting: true });
});

test("decodeEscape: OSC sequences are consumed and ignored", () => {
  // BEL-terminated theme response
  assert.deepEqual(decodeEscape("\x1b]11;rgb:0000/0000/0000\x07tail"), { consumed: 24, ignored: true });
  // ST-terminated OSC
  assert.deepEqual(decodeEscape("\x1b]10;rgb:ffff/ffff/ffff\x1b\\tail"), { consumed: 25, ignored: true });
  assert.equal(decodeEscape("\x1b]11;rgb:x"), null, "incomplete OSC waits");
});

test("decodeEscape: unknown CSI sequences are consumed without leaking bytes", () => {
  assert.deepEqual(decodeEscape("\x1b[123Q"), { consumed: 6, ignored: true });
  assert.equal(decodeEscape("\x1b[1"), null, "incomplete CSI waits");
});

test("decodeEscape: Alt+key is consumed and ignored", () => {
  assert.deepEqual(decodeEscape("\x1bX"), { consumed: 2, ignored: true });
});
