/**
 * Styling tokens for the TUI, centralised in one place.
 *
 * Two palettes — light and dark — and a mutable `theme` object that rendering
 * reads at call time, so `setTheme()` can switch palettes live.
 *
 * `theme` defaults to the LIGHT palette (dark, high-contrast foregrounds that
 * read well on light terminals). The TUI auto-detects the terminal background
 * (OSC 11) and calls `setTheme()` accordingly.
 */
export const lightTheme = {
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

export const darkTheme = {
  accent: "#7dcfff",
  heading: "#7dcfff",
  user: "#bb9af7",
  think: "#565f89",
  tool: "#7aa2f7",
  good: "#9ece6a",
  bad: "#f7768e",
  dim: "#565f89",
  code: "#e0af68",
  text: "#c0caf5",
};

/** Mutable theme used at render time. Defaults to light. */
export const theme = { ...lightTheme };

/** Switch the active palette ("light" | "dark"). */
export function setTheme(name) {
  Object.assign(theme, name === "dark" ? darkTheme : lightTheme);
}
