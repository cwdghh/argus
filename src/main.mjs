/**
 * Entry point: read config and start the minimal TUI.
 */
import { getConfig } from "./config.mjs";
import { MinimalTui } from "./tui.mjs";

const tui = new MinimalTui(getConfig());
tui.start();
