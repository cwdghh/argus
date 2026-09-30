/** Focused tool-schema fixtures; they share the coding evaluator's lifecycle. */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

function text(cwd, path) {
  try {
    const full = join(cwd, path);
    const info = lstatSync(full);
    return info.isFile() && info.size <= 256 * 1024 ? readFileSync(full, "utf8") : null;
  }
  catch { return null; }
}

function toolSequence(trace, required, allowed) {
  let next = 0;
  for (const item of trace) if (item.tool === required[next]) next++;
  return next === required.length && trace.every((item) => allowed.includes(item.tool));
}

export const toolTasks = [
  {
    name: "content-edit",
    files: { "small.js": "export const value = 1;\n" },
    prompt: "Read small.js, then use a content edit to change the exported numeric value from 1 to 2. Make the change and report the result.",
    verify(cwd) { return text(cwd, "small.js") === "export const value = 2;\n"; },
    verifyTools(trace) {
      return toolSequence(trace, ["read", "edit"], ["read", "edit", "bash"]) &&
        trace.some((item) => item.editForms?.includes("content") && !item.error);
    },
  },
  {
    name: "range-edit",
    files: { "block.js": "export function greet() {\n  return 'old';\n}\n" },
    prompt: "Read block.js, then use a line-range edit to make greet return 'hello argus'. Verify the file afterward.",
    verify(cwd) { return text(cwd, "block.js") === "export function greet() {\n  return 'hello argus';\n}\n"; },
    verifyTools(trace) {
      return toolSequence(trace, ["read", "edit", "read"], ["read", "edit", "bash"]) &&
        trace.some((item) => item.editForms?.includes("range") && !item.error);
    },
  },
  {
    name: "uncued-numbered-edit",
    files: { "label.js": "export function label(name) {\n  return `hello ${name}`;\n}\n" },
    prompt: "Update label.js so label trims name into a local clean variable and returns `hello ${clean}`. Inspect the file, make the change, verify it, and report the result.",
    verify(cwd) {
      const actual = text(cwd, "label.js") ?? "";
      return /const clean = name\.trim\(\);/.test(actual) && /`hello \$\{clean\}`/.test(actual) && !/\d+\s*│/.test(actual);
    },
    verifyTools(trace) { return toolSequence(trace, ["read", "edit"], ["read", "edit", "bash"]); },
  },
  {
    name: "search-with-bash",
    files: { "one.txt": "nothing\n", "two.txt": "ARGUS_NEEDLE\n" },
    prompt: "Find which .txt file contains ARGUS_NEEDLE. Do not change any files; answer with the filename.",
    protectedFiles: ["one.txt", "two.txt"],
    verify(cwd, _trace, result) {
      return /two\.txt/.test(result?.finalText ?? "") && text(cwd, "one.txt") === "nothing\n" && text(cwd, "two.txt") === "ARGUS_NEEDLE\n";
    },
    verifyTools(trace) { return toolSequence(trace, ["bash"], ["bash", "read"]); },
  },
  {
    name: "new-file",
    files: {},
    prompt: "Create note.txt with exactly `tool surface ok` followed by one newline, then report completion.",
    verify(cwd) { return text(cwd, "note.txt") === "tool surface ok\n"; },
    verifyTools(trace) { return toolSequence(trace, ["write"], ["write", "read", "bash"]); },
  },
  {
    name: "new-file-no-newline",
    files: {},
    prompt: "Create raw.txt with exactly `no final newline` and no newline after it, then report completion.",
    verify(cwd) { return text(cwd, "raw.txt") === "no final newline"; },
    verifyTools(trace) { return toolSequence(trace, ["write"], ["write", "read", "bash"]); },
  },
  {
    name: "write-protection",
    files: { "existing.txt": "keep existing\n" },
    protectedFiles: ["existing.txt"],
    prompt: "Inspect existing.txt. Demonstrate write's default existing-file protection by attempting to create it with content `replacement` and a final newline. Do not opt into overwrite. Leave existing.txt unchanged and report the rejection honestly.",
    verify(cwd) { return text(cwd, "existing.txt") === "keep existing\n"; },
    expectedFailure(item) { return item.tool === "write" && /^file already exists:/.test(item.errorMessage ?? ""); },
    verifyTools(trace) {
      return toolSequence(trace, ["read", "write"], ["read", "write"]) && trace.some((item) => {
        if (item.tool !== "write" || item.validationError) return false;
        const args = JSON.parse(item.args);
        return args.path === "existing.txt" && args.overwrite !== true && item.expectedFailure;
      });
    },
  },
  {
    name: "range-insert-delete",
    files: { "list.txt": "alpha\nbeta\ngamma\n" },
    prompt: "Read list.txt. In one edit call with two range items, insert the line 'inserted' before beta " +
      "without replacing beta, and delete gamma with an empty replacement. Preserve alpha and beta, then verify the file.",
    verify(cwd) { return text(cwd, "list.txt") === "alpha\ninserted\nbeta\n"; },
    verifyTools(trace) {
      return toolSequence(trace, ["read", "edit", "read"], ["read", "edit", "bash"]) &&
        trace.some((item) => !item.error && item.editForms?.length === 2 &&
          item.editForms.every((form) => form === "range") &&
          item.editOperations?.includes("insert") && item.editOperations.includes("delete"));
    },
  },
  {
    name: "mixed-edit",
    files: { "config.mjs": "export const mode = 'old';\n// remove placeholder\nexport const port = 3000;\n" },
    prompt: "Read config.mjs. In a single edit batch, use a content edit to set mode to 'new' " +
      "and a line-range edit to delete the placeholder comment. Preserve port, then verify the file.",
    verify(cwd) { return text(cwd, "config.mjs") === "export const mode = 'new';\nexport const port = 3000;\n"; },
    verifyTools(trace) {
      return toolSequence(trace, ["read", "edit", "read"], ["read", "edit", "bash"]) &&
        trace.some((item) => !item.error && item.editForms?.includes("content") && item.editForms.includes("range"));
    },
  },
];
