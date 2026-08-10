/**
 * Styling tokens for the TUI, centralised in one place.
 *
 * A soft, low-contrast "Tokyo Night" inspired palette chosen for readability on
 * dark terminals. Colors are hex strings we convert to ANSI truecolor.
 */
export const theme = {
  accent: "#7dcfff", // brand / borders / active
  heading: "#7dcfff", // markdown headings
  user: "#7aa2f7", // user prompts
  think: "#565f89", // reasoning / thinking (muted)
  tool: "#bb9af7", // tool call requests (soft purple)
  good: "#9ece6a", // success / ✓
  bad: "#f7768e", // errors / ✗
  dim: "#3b4261", // muted text
  code: "#e0af68", // inline / fenced code (warm amber)
  text: "#c0caf5", // normal assistant text
};
