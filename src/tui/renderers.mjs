/**
 * Pure text + ANSI rendering helpers for the TUI.
 *
 * Everything here is a string-in/string-out function over plain text, theme
 * tokens, and terminal display widths — zero coupling to the controller.
 *
 * Sibling modules build on these primitives:
 *   - src/tui/markdown.mjs  — markdown/table rendering (uses these helpers)
 *   - src/tui/blocks.mjs    — transcript block -> lines (uses markdown)
 *   - src/format.mjs        — neutral value formatting (duration/tokens/summaries)
 */
import { theme } from "../theme.mjs";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

// ---------------------------------------------------------------------------
// ANSI + text helpers
// ---------------------------------------------------------------------------

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function styleText(text, { fg, bold, dim, italic, underline, strike } = {}) {
  // Never let model/tool/file content inject terminal control sequences.
  text = String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const codes = [];
  if (fg) codes.push(`38;2;${rgb(fg).join(";")}`);
  if (bold) codes.push("1");
  if (dim) codes.push("2");
  if (italic) codes.push("3");
  if (underline) codes.push("4");
  if (strike) codes.push("9");
  if (!codes.length) return text;
  return `${ESC}[${codes.join(";")}m${text}${RESET}`;
}

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function wrap(text, width) {
  width = Math.max(1, width);
  const out = [];
  let line = "";
  let columns = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (line && columns + cw > width) {
      out.push(line);
      line = "";
      columns = 0;
    }
    line += ch;
    columns += cw;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

export function previousCharIndex(text, index) {
  if (index <= 0) return 0;
  const cp = text.codePointAt(index - 1);
  return index - (cp >= 0xdc00 && cp <= 0xdfff ? 2 : 1);
}

export function nextCharIndex(text, index) {
  if (index >= text.length) return text.length;
  const cp = text.codePointAt(index);
  return index + (cp > 0xffff ? 2 : 1);
}

export function previousWordIndex(text, index) {
  let i = index;
  while (i > 0 && /\s/.test(text.slice(previousCharIndex(text, i), i))) i = previousCharIndex(text, i);
  while (i > 0 && !/\s/.test(text.slice(previousCharIndex(text, i), i))) i = previousCharIndex(text, i);
  return i;
}

export function truncateMiddle(text, max) {
  if (max <= 0) return "";
  if (dispWidth(text) <= max) return text;
  if (max === 1) return "…";

  const chars = [...text];
  const leftBudget = Math.ceil((max - 1) / 2);
  const rightBudget = Math.floor((max - 1) / 2);
  let left = "";
  let leftWidth = 0;
  for (const ch of chars) {
    const width = charWidth(ch);
    if (leftWidth + width > leftBudget) break;
    left += ch;
    leftWidth += width;
  }
  let right = "";
  let rightWidth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const width = charWidth(chars[i]);
    if (rightWidth + width > rightBudget) break;
    right = chars[i] + right;
    rightWidth += width;
  }
  return `${left}…${right}`;
}

export function truncateEnd(text, max) {
  if (max <= 0) return "";
  if (dispWidth(text) <= max) return text;
  if (max === 1) return "…";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const charColumns = charWidth(ch);
    if (width + charColumns > max - 1) break;
    out += ch;
    width += charColumns;
  }
  return `${out}…`;
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  return isZeroWidthCp(cp) ? 0 : isWideCp(cp) ? 2 : 1;
}

/** Zero-width code points: never occupy a terminal column. */
function isZeroWidthCp(cp) {
  return (
    /[\p{Mn}\p{Me}\p{Cf}]/u.test(String.fromCodePoint(cp)) ||
    (0x1160 <= cp && cp <= 0x11ff) || // Hangul Jungseong/Jongseong jamo (compose)
    (0x1f3fb <= cp && cp <= 0x1f3ff) // emoji skin tone modifiers
  );
}

/** Code points rendered two columns wide (East Asian wide + emoji). */
function isWideCp(cp) {
  return (
    (0x1100 <= cp && cp <= 0x115f) || // Hangul Jamo init. consonants
    cp === 0x2329 || cp === 0x232a || // CJK angle brackets
    (0x2e80 <= cp && cp <= 0x303e) || // CJK Radicals .. CJK Symbols
    (0x3041 <= cp && cp <= 0x33ff) || // Hiragana .. CJK Compatibility
    (0x3400 <= cp && cp <= 0x4dbf) || // CJK Ext A
    (0x4e00 <= cp && cp <= 0x9fff) || // CJK Unified Ideographs
    (0xa000 <= cp && cp <= 0xa4cf) || // Yi Syllables
    (0xac00 <= cp && cp <= 0xd7a3) || // Hangul Syllables
    (0xf900 <= cp && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (0xfe10 <= cp && cp <= 0xfe19) || // Vertical Forms
    (0xfe30 <= cp && cp <= 0xfe6f) || // CJK Compatibility Forms
    (0xff00 <= cp && cp <= 0xff60) || // Fullwidth Forms
    (0xffe0 <= cp && cp <= 0xffe6) || // Fullwidth Signs
    (0x20000 <= cp && cp <= 0x2fffd) || // CJK Ext B+
    (0x30000 <= cp && cp <= 0x3fffd) || // CJK Ext G+
    isBmpEmojiCp(cp) ||
    isAstralEmojiCp(cp)
  );
}

/** BMP emoji that render wide even without VS16. */
function isBmpEmojiCp(cp) {
  return (
    cp === 0x231a || cp === 0x231b || // watch, hourglass
    (0x23e9 <= cp && cp <= 0x23ec) || // fast-forward/rewind arrows
    cp === 0x23f0 || cp === 0x23f3 || // alarm clock, hourglass done
    (0x25fd <= cp && cp <= 0x25fe) || // ◽ ◾
    (0x2614 <= cp && cp <= 0x2615) || // umbrella with rain, hot beverage
    (0x2648 <= cp && cp <= 0x2653) || // zodiac signs
    cp === 0x267f || // wheelchair symbol
    cp === 0x2693 || // anchor
    cp === 0x26a1 || // high voltage
    (0x26aa <= cp && cp <= 0x26ab) || // ⚪ ⚫
    (0x26bd <= cp && cp <= 0x26be) || // soccer, baseball
    (0x26c4 <= cp && cp <= 0x26c5) || // snowman, sun behind cloud
    cp === 0x26ce || cp === 0x26d4 || // ophiuchus, no entry
    cp === 0x26ea || // church
    (0x26f2 <= cp && cp <= 0x26f3) || // fountain, flag in hole
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || // sailboat, tent, fuel pump
    cp === 0x2705 || // white heavy check mark
    (0x270a <= cp && cp <= 0x270b) || // raised fist, raised hand
    cp === 0x2728 || // sparkles
    cp === 0x274c || cp === 0x274e || // cross mark, cross button
    (0x2753 <= cp && cp <= 0x2755) || // question/ exclamation marks
    cp === 0x2757 || // heavy exclamation mark
    (0x2795 <= cp && cp <= 0x2797) || // heavy plus/minus/division
    cp === 0x27b0 || cp === 0x27bf // curly loop, double curly loop
  );
}

/** Astral-plane emoji (U+1F000+). Skin tones are zero-width, checked first. */
function isAstralEmojiCp(cp) {
  return (
    cp === 0x1f004 || // mahjong red dragon
    cp === 0x1f0cf || // joker
    cp === 0x1f18e || // AB button
    (0x1f191 <= cp && cp <= 0x1f19a) || // squared Latin letters
    (0x1f200 <= cp && cp <= 0x1f320) || // squared CJK .. shooting star
    (0x1f32d <= cp && cp <= 0x1f335) || // hot dog .. cactus
    (0x1f337 <= cp && cp <= 0x1f37c) || // tulip .. baby bottle
    (0x1f37e <= cp && cp <= 0x1f393) || // champagne .. graduation cap
    (0x1f3a0 <= cp && cp <= 0x1f3ca) || // carousel .. swimmer
    (0x1f3cf <= cp && cp <= 0x1f3d3) || // cricket .. ping pong
    (0x1f3e0 <= cp && cp <= 0x1f3f0) || // houses .. castle
    cp === 0x1f3f4 || // black flag
    (0x1f3f8 <= cp && cp <= 0x1f43e) || // badminton .. paw prints
    cp === 0x1f440 || // eyes
    (0x1f442 <= cp && cp <= 0x1f4fc) || // ear .. videocassette
    (0x1f4ff <= cp && cp <= 0x1f53d) || // prayer beads .. down button
    (0x1f54b <= cp && cp <= 0x1f54e) || // kaaba .. menorah
    (0x1f550 <= cp && cp <= 0x1f567) || // clocks
    cp === 0x1f57a || // man dancing
    (0x1f595 <= cp && cp <= 0x1f596) || // middle finger, vulcan salute
    cp === 0x1f5a4 || // black heart
    (0x1f5fb <= cp && cp <= 0x1f64f) || // mount fuji .. person with folded hands
    (0x1f680 <= cp && cp <= 0x1f6c5) || // rocket .. left luggage
    cp === 0x1f6cc || // person in bed
    (0x1f6d0 <= cp && cp <= 0x1f6d2) || // synagogue, mosque, hindu temple
    (0x1f6d5 <= cp && cp <= 0x1f6d7) || // hut .. elevator
    (0x1f6eb <= cp && cp <= 0x1f6ec) || // airplane departure/arrival
    (0x1f6f4 <= cp && cp <= 0x1f6fc) || // scooter .. roller skate
    (0x1f7e0 <= cp && cp <= 0x1f7eb) || // colored circles/squares
    cp === 0x1f7f0 || // heavy equals sign
    (0x1f90c <= cp && cp <= 0x1f93a) || // pinched fingers .. fencer
    (0x1f93c <= cp && cp <= 0x1f945) || // wrestlers .. goal net
    (0x1f947 <= cp && cp <= 0x1f9ff) || // medals .. nazar amulet
    (0x1fa70 <= cp && cp <= 0x1fa7c) || // ballet shoes .. crutch
    (0x1fa80 <= cp && cp <= 0x1fa88) || // yo-yo .. flute
    (0x1fa90 <= cp && cp <= 0x1fabe) || // ringed planet .. labrador
    (0x1fabf <= cp && cp <= 0x1fac5) || // mouse .. pregnant person
    cp === 0x1face || // moose
    (0x1fae0 <= cp && cp <= 0x1fae8) || // melting face .. shaking face
    (0x1faf0 <= cp && cp <= 0x1faf8) // handshake .. heart hands
  );
}

/** Approximate terminal display width of a string. */
export function dispWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Wrap styled segments into lines of `width` visible columns. */
