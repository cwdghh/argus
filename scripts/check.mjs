#!/usr/bin/env node
/** Offline repository checks; intentionally uses only Node built-ins. */
import { readdir, readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const problems = [];
async function filesUnder(dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? filesUnder(join(dir, entry.name))
    : [join(dir, entry.name)]));
  return nested.flat().sort();
}

const code = (await Promise.all(["src", "test", "eval", "scripts"].map(filesUnder)))
  .flat().filter((file) => file.endsWith(".mjs"));
const sources = new Map(await Promise.all(code.map(async (file) => [file, await readFile(join(root, file), "utf8")])));
const graph = new Map();
for (const [file, source] of sources) {
  const checked = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (checked.status !== 0) problems.push(`${file}: ${checked.stderr || checked.error?.message || "syntax check failed"}`);
  if (/\r/.test(source) || !source.endsWith("\n")) problems.push(`${file}: use LF and a final newline`);
  // This checks the literal import forms used in this repository. It is a
  // dependency-boundary check, not a general JavaScript parser or formatter.
  const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)];
  const dependencies = [];
  for (const [, specifier] of imports) {
    if (isBuiltin(specifier)) {
      if (!specifier.startsWith("node:")) problems.push(`${file}: prefix built-ins with node: (${specifier})`);
      continue;
    }
    if (!specifier.startsWith(".")) {
      problems.push(`${file}: external import ${specifier}; this repo is dependency-free`);
      continue;
    }
    const target = relative(root, resolve(root, dirname(file), specifier));
    if (!sources.has(target)) problems.push(`${file}: missing local module ${specifier}`);
    if (file.startsWith("src/")) {
      if (!target.startsWith("src/")) problems.push(`${file}: runtime must not import ${target}`);
      if (target.startsWith("src/session/") && !file.startsWith("src/session/") && target !== "src/session/index.mjs") {
        problems.push(`${file}: import the public session/index.mjs API`);
      }
      if ((file === "src/agent.mjs" || file.startsWith("src/agent/")) && /^src\/(tui|headless|session)([/.])/.test(target)) {
        problems.push(`${file}: agent code must not depend on a frontend or session persistence`);
      }
      dependencies.push(target);
    }
  }
  if (file.startsWith("src/")) graph.set(file, dependencies);
}

const visited = new Set();
function visit(file, stack = []) {
  if (stack.includes(file)) {
    problems.push(`import cycle: ${[...stack, file].join(" → ")}`);
    return;
  }
  if (visited.has(file)) return;
  for (const dependency of graph.get(file) ?? []) visit(dependency, [...stack, file]);
  visited.add(file);
}
for (const file of graph.keys()) visit(file);

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (Object.keys(pkg[key] ?? {}).length) problems.push(`package.json: ${key} must stay empty`);
}

const docs = [...(await filesUnder("docs")).filter((file) => file.endsWith(".md") && !file.startsWith("docs/archive/")),
  "AGENTS.md", "README.md", "PROGRESS.md", "GAPS.md", "NEXT_STEPS.md"];
for (const file of docs) {
  const source = await readFile(join(root, file), "utf8");
  for (const [, raw] of source.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:|^#/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#")[0]);
    try {
      await access(resolve(root, dirname(file), target));
    } catch {
      problems.push(`${file}: broken local link ${raw}`);
    }
  }
}

if (problems.length) {
  process.stderr.write(problems.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${code.length} modules and ${docs.length} live documents: syntax, imports, boundaries, cycles, and local links.\n`);
}
