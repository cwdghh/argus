#!/usr/bin/env node
/** Run the offline suite with a disposable ARGUS_HOME, including spill files. */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryHome = await mkdtemp(join(tmpdir(), "argus-tests-"));
try {
  const files = (await readdir(join(root, "test")))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort().map((name) => join("test", name));
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
      cwd: root,
      env: { ...process.env, ARGUS_HOME: temporaryHome },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(temporaryHome, { recursive: true, force: true });
}
