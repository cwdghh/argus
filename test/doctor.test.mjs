import assert from "node:assert/strict";
import { test } from "node:test";
import { runDoctor, supportedNode } from "../src/doctor.mjs";
import { parseArgs } from "../src/main.mjs";

test("doctor is a standalone CLI action and accepts the minimum Node release", () => {
  assert.equal(parseArgs(["doctor"]).doctor, true);
  assert.equal(parseArgs(["explain", "doctor"]).prompt, "explain doctor");
  assert.equal(supportedNode("22.8.9"), false);
  assert.equal(supportedNode("22.9.0"), true);
  assert.equal(supportedNode("24.0.0"), true);
});

test("doctor checks reachability without sending credentials or treating HTTP errors as network failures", async () => {
  const lines = [];
  let options;
  const ok = await runDoctor({ baseUrl: "https://example.test/v1", model: "test", apiKey: "secret" }, {
    fetchImpl: async (_url, received) => {
      options = received;
      return { status: 404 };
    },
    write: (line) => lines.push(line),
  });
  assert.equal(ok, true);
  assert.equal(options.method, "HEAD");
  assert.equal(options.headers, undefined);
  assert.equal(lines.join("").includes("secret"), false);
  assert.match(lines.join(""), /OK Endpoint: example\.test/);
});

test("doctor reports invalid configuration without exposing an embedded URL secret", async () => {
  const lines = [];
  const ok = await runDoctor({ baseUrl: "bad-secret-endpoint", model: "test", apiKey: "" }, {
    fetchImpl: () => { throw new Error("must not fetch"); },
    write: (line) => lines.push(line),
  });
  assert.equal(ok, false);
  assert.doesNotMatch(lines.join(""), /bad-secret-endpoint/);
  assert.match(lines.join(""), /FAIL Configuration/);
});
