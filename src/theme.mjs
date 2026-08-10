/**
 * Styling tokens for the TUI, centralised in one place.
 *
 * Tuned for a LIGHT terminal theme: dark, high-contrast foregrounds that read
 * well on white/light backgrounds. Colors are hex strings we convert to ANSI
 * truecolor.
 */
export const theme = {
  accent: "#0969da", // brand / borders / caret / prompt marker (blue)
  heading: "#0550ae", // markdown headings (dark blue)
  user: "#8250df", // user prompts (purple)
  think: "#6e7781", // reasoning / thinking (gray)
  tool: "#0e7490", // tool call requests (teal)
  good: "#1a7f37", // success / ✓ (green)
  bad: "#cf222e", // errors / ✗ (red)
  dim: "#59636e", // muted text (gray)
  code: "#953800", // inline / fenced code (amber-brown)
  text: "#1f2328", // normal assistant text (near-black)
};
