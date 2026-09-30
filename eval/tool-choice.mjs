#!/usr/bin/env node
/** Opt-in schema trials using the same bounded reporting as coding trials. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evalMain } from "./coding.mjs";
import { toolTasks } from "./tool-tasks.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await evalMain(toolTasks, "tools");
}
