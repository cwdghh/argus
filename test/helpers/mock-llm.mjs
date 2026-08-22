/**
 * A scripted SSE "LLM" server for tests. It replaces the real API so the
 * agent loop, abort, cwd, and persistence can be verified deterministically.
 *
 *   const srv = await createMockServer((callIndex, reqBody) => [
 *     { content: "hello " },
 *     { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{}' } }] },
 *     { delay: 200 },            // pause (for abort tests)
 *   ]);
 *   runTurn({ baseUrl: srv.url, ... }, ...);
 *   srv.close();
 *
 * If the script throws for a call, the server responds with HTTP 500, which the
 * client surfaces as an LLM request error.
 */
import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createMockServer(script) {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let reqBody = null;
      try {
        reqBody = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const idx = calls++;
      try {
        let deltas;
        try {
          deltas = await script(idx, reqBody);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err?.message ?? "mock script error" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        let finishReason = "stop";
        for (const d of deltas ?? []) {
          if (d && d.delay) {
            await sleep(d.delay);
            continue;
          }
          if (d && d.finishReason) {
            finishReason = d.finishReason;
            continue;
          }
          if (d && d.usage) {
            res.write(`data: ${JSON.stringify({ choices: [], usage: d.usage })}\n\n`);
            continue;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: d ?? {} }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {
        try {
          res.end();
        } catch {
          /* socket already gone (e.g. aborted) */
        }
      }
    });
  });
  const port = await new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () => new Promise((r) => srv.close(r)),
  };
}
