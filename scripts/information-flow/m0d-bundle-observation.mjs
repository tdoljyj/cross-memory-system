#!/usr/bin/env node
// Tokenizer bundle/CPU observation (S6 plan section 9; register L14).
// Local only: records dist/server sizes from `npm run build` (the build must
// already have run), the harness Worker dry-run bundle size, workerd startup
// in Miniflare, and the E2E pack timings (first compile includes tokenizer
// initialisation). Never uses the production wrangler config (its build step
// reads production). Result label: observation_local_workerd_not_production.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cloudRoot = path.join(repoRoot, 'apps/clued-cloud');
const { values: args } = parseArgs({ options: { out: { type: 'string' }, 'e2e-evidence': { type: 'string' } } });
if (!args.out) throw new Error('--out <bundle-observation.json> is required');

const sizeOf = (file) => {
  const bytes = fs.readFileSync(file);
  return { raw_bytes: bytes.length, gzip_bytes: zlib.gzipSync(bytes, { level: 9 }).length };
};

// 1. dist/server from `npm run build`.
const serverDir = path.join(cloudRoot, 'dist/server');
const serverFiles = fs.existsSync(serverDir)
  ? fs.readdirSync(serverDir, { recursive: true }).filter((name) => fs.statSync(path.join(serverDir, name)).isFile())
    .sort().map((name) => ({ file: `dist/server/${name}`, ...sizeOf(path.join(serverDir, name)) }))
  : null;
const serverTotal = serverFiles && serverFiles.reduce((acc, row) => ({ raw_bytes: acc.raw_bytes + row.raw_bytes,
  gzip_bytes: acc.gzip_bytes + row.gzip_bytes }), { raw_bytes: 0, gzip_bytes: 0 });
const tokenizerChunks = (serverFiles ?? []).filter((row) => /o200k|tiktoken/i.test(row.file));

// 2. Harness Worker dry-run bundle (harness config only).
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0d-bundle-'));
const dry = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', bundleDir, '--config',
  'evals/information-flow-e2e/wrangler.jsonc'], { cwd: cloudRoot, encoding: 'utf8',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
if (dry.status !== 0) throw new Error(`wrangler dry-run failed: ${dry.stderr}`);
const harnessBundle = sizeOf(path.join(bundleDir, 'worker.js'));

// 3. workerd startup in Miniflare and a first static request.
const { WorkerHost } = await import(pathToFileURL(path.join(cloudRoot, 'evals/information-flow-e2e/harness.mjs')).href);
const startups = [];
for (let i = 0; i < 3; i += 1) {
  const host = new WorkerHost({ bundleDir, persistDir: fs.mkdtempSync(path.join(os.tmpdir(), 'm0d-persist-')),
    gatewayOrigin: 'http://127.0.0.1:9', publishableKey: 'local-observation-only',
    guardLedger: path.join(bundleDir, `guard-${i}.json`), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const started = performance.now();
  await host.start();
  const ready = performance.now() - started;
  const t0 = performance.now();
  const res = await fetch(`${host.url}/healthz`);
  await res.text();
  startups.push({ host_ready_ms: Math.round(ready), miniflare_reported_ms: host.ready.startup_ms,
    first_request_ms: Math.round(performance.now() - t0) });
  await host.stop();
}
fs.rmSync(bundleDir, { recursive: true, force: true });

// 4. Pack timings from the E2E evidence (Worker-measured compiles over MCP/REST).
let packTimings = null;
if (args['e2e-evidence']) {
  const durations = [];
  for (const sub of ['e2e', 'continuity']) {
    const dir = path.join(args['e2e-evidence'], sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => /^E2E-\d+\.json$/.test(n)).sort()) {
      const evidence = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      for (const step of evidence.steps ?? []) {
        if (step.extracted?.measurement_status === 'measured') {
          durations.push({ scenario: evidence.scenario_id, n: step.n, ms: step.duration_ms });
        }
      }
    }
  }
  const sorted = durations.map((row) => row.ms).sort((a, b) => a - b);
  packTimings = { measured_pack_responses: durations.length,
    first_in_run_ms_note: 'The first measured compile of each Worker host includes tokenizer initialisation.',
    min_ms: sorted[0] ?? null, p50_ms: sorted[Math.floor(sorted.length / 2)] ?? null, max_ms: sorted.at(-1) ?? null };
}

const observation = {
  schema: 'clued.information-flow.m0d.bundle-observation/1',
  label: 'observation_local_workerd_not_production',
  runtime: { node: process.version },
  dist_server: serverFiles ? { total: serverTotal, tokenizer_chunks: tokenizerChunks, files: serverFiles.length }
    : { missing: 'run npm run build first' },
  s4_baseline_reference: { dist_server_raw_bytes: 3670682, o200k_chunk_raw_bytes: 2325569, o200k_chunk_gzip_mb_approx: 1.14 },
  harness_dry_run_bundle: harnessBundle,
  workerd_startup: startups,
  pack_timings: packTimings,
  cloudflare_limits: {
    status: 'NOT_RETRIEVED',
    reason: 'developers.cloudflare.com is blocked by the egress proxy of this environment; limits are not hardcoded from memory.',
    consequence: 'The plan-limit comparison (compressed size, startup CPU) and a production CPU observation are a precondition of any authorized production apply (register L14).',
  },
};
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(observation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ harness: harnessBundle, startup: startups[0], pack: packTimings })}\n`);
