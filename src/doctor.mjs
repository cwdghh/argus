/** Small, read-only installation check for the standalone CLI. */
import { validateConfig } from "./config.mjs";

const MIN_NODE = [22, 9, 0];

export function supportedNode(version = process.versions.node) {
  const parts = String(version).split(".").map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    if (!Number.isInteger(parts[i])) return false;
    if (parts[i] !== MIN_NODE[i]) return parts[i] > MIN_NODE[i];
  }
  return true;
}

/** A response of any HTTP status proves reachability, not provider readiness. */
export async function runDoctor(config, { fetchImpl = fetch, write = (line) => process.stdout.write(line) } = {}) {
  const checks = [];
  checks.push({ name: "Node", ok: supportedNode(), detail: `${process.version} (requires >=22.9.0)` });

  let configError = null;
  try {
    validateConfig(config);
  } catch (error) {
    configError = error.message;
  }
  const safeError = configError && config.baseUrl
    ? configError.replaceAll(String(config.baseUrl), "[endpoint]")
    : configError;
  checks.push({ name: "Configuration", ok: configError === null, detail: safeError ?? `${config.model} (credential value hidden)` });

  let endpoint = "invalid URL";
  let reachable = false;
  if (!configError || configError.includes("API_KEY")) {
    try {
      endpoint = new URL(config.baseUrl).host;
      const response = await fetchImpl(config.baseUrl, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
      reachable = Boolean(response);
    } catch (error) {
      endpoint = `${endpoint}: ${error.name === "TimeoutError" ? "timed out" : "unreachable"}`;
    }
  }
  checks.push({ name: "Endpoint", ok: reachable, detail: endpoint });
  for (const check of checks) write(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}\n`);
  return checks.every((check) => check.ok);
}
