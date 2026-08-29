import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const url = process.env.MCP_ISOLATED_URL ?? "http://127.0.0.1:8787/mcp";
const samples = [];
for (let index = 0; index < 30; index += 1) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: index + 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "clued-latency-observer", version: "1.0" },
      },
    }),
  });
  const elapsed = performance.now() - started;
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.result?.protocolVersion, "2025-06-18");
  assert.ok(elapsed < 60_000);
  samples.push(elapsed);
}

samples.sort((left, right) => left - right);
const percentile = (value) => samples[Math.ceil(samples.length * value) - 1];
console.log(JSON.stringify({
  status: "PASS",
  requests: samples.length,
  timeouts: 0,
  concurrency: 1,
  milliseconds: {
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    max: Number(samples.at(-1).toFixed(3)),
  },
}));
