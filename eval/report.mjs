/** Credential-free identifiers and bounded review details for local evaluations. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function positiveInt(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > maximum) throw new Error(`invalid evaluation limit: ${value}`);
  return n;
}

export function sanitizer(config) {
  const url = new URL(config.baseUrl);
  const secrets = [config.apiKey, config.baseUrl, url.username, url.password,
    ...url.searchParams.values()].filter((value) => value && value.length >= 4);
  return (value, limit = 500) => {
    let text = String(value ?? "");
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    return text.length > limit ? text.slice(0, limit) + "…[truncated]" : text;
  };
}

function sourceIdentity() {
  try {
    const git = (args) => execFileSync("git", args, { cwd: sourceRoot, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"] });
    const revision = git(["rev-parse", "HEAD"]).toString().trim();
    const diff = git(["diff", "--no-ext-diff", "--binary", "HEAD"]);
    const paths = git(["ls-files", "--others", "--exclude-standard", "-z"])
      .toString().split("\0").filter(Boolean).sort();
    const digest = createHash("sha256").update(diff);
    let bytes = diff.length;
    for (const path of paths) {
      const full = join(sourceRoot, path);
      const info = lstatSync(full);
      if (bytes + info.size > 16 * 1024 * 1024) return { sourceRevision: revision, sourceDirtyHash: null };
      const content = info.isSymbolicLink() ? Buffer.from(readlinkSync(full))
        : info.isFile() ? readFileSync(full) : null;
      if (!content) return { sourceRevision: revision, sourceDirtyHash: null };
      bytes += content.length;
      digest.update(path).update("\0").update(content).update("\0");
    }
    return { sourceRevision: revision, sourceDirtyHash: digest.digest("hex"), sourceDirty: diff.length > 0 || paths.length > 0 };
  } catch { return { sourceRevision: null, sourceDirtyHash: null, sourceDirty: null }; }
}

export function identifiers(config) {
  const url = new URL(config.baseUrl);
  const keys = ["model", "contextCache", "maxRetries", "quotaRetries", "quotaRetryDelayMs",
    "requestTimeoutMs", "streamIdleTimeoutMs", "maxRequestChars", "maxToolResultChars", "maxTurnToolResultChars"];
  const settings = Object.fromEntries(keys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
  return {
    ...sourceIdentity(), node: process.version, platform: process.platform,
    endpoint: url.host, endpointHash: hash(config.baseUrl), model: config.model,
    promptHash: hash(config.systemPrompt ?? ""), config: settings, configHash: hash(JSON.stringify(settings)),
    // Helper changes affect fixture scoring even when individual task text is unchanged.
    harnessHash: hash(["coding.mjs", "coding-tasks.mjs", "tool-choice.mjs", "tool-tasks.mjs", "report.mjs"]
      .map((name) => name + "\0" + readFileSync(join(sourceRoot, "eval", name), "utf8")).join("\0")),
  };
}

/** Limit traversal, file reads and stored text; never follow fixture symlinks. */
export function snapshot(cwd) {
  const files = {};
  let complete = true;
  let visited = 0;
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      if (++visited > 100) { complete = false; break; }
      const path = join(dir, name);
      const relative = prefix + name;
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path, relative + "/");
      else if (info.isSymbolicLink()) files[relative] = { kind: "symlink", hash: hash(readlinkSync(path)), content: null };
      else if (info.isFile() && info.size <= 256 * 1024) {
        const bytes = readFileSync(path);
        files[relative] = { kind: "file", bytes: bytes.length, hash: hash(bytes), content: bytes.toString("utf8").slice(0, 2_000),
          truncated: bytes.length > 2_000 };
      } else {
        complete = false;
        files[relative] = { kind: "unread", bytes: info.size, hash: null, content: null };
      }
    }
  };
  walk(cwd);
  return { files, complete };
}

export function changeDetails(before, after, clean) {
  const changes = [];
  let remaining = 12_000;
  let omitted = 0;
  for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const old = before.files[path] ?? null;
    const next = after.files[path] ?? null;
    if (old?.hash && old.hash === next?.hash) continue;
    if (changes.length >= 20 || remaining <= 0) { omitted++; continue; }
    const item = { path: clean(path), beforeHash: old?.hash ?? null, afterHash: next?.hash ?? null,
      kind: next?.kind ?? "deleted", bytes: next?.bytes ?? null };
    for (const [key, value] of [["before", old], ["after", next]]) {
      item[key] = value?.content == null ? null : clean(value.content, Math.min(2_000, remaining));
      remaining -= item[key]?.length ?? 0;
      if (value?.truncated) item.truncated = true;
    }
    changes.push(item);
  }
  return { changes, omitted, complete: before.complete && after.complete && omitted === 0 };
}

export function writeReport(path, report) {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
