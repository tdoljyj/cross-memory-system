import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

// The serving Worker's gateway egress, run in workerd rather than Node (Task 942adbdb). Node's fetch accepts
// RequestInit modes workerd refuses: redirect:'error' threw a TypeError before any request left, every merge
// notification answered 500 and Node fetch mocks stayed green. Here the runtime itself decides, so a mode or
// option workerd does not implement fails these cases whatever it is. Bundle: wrangler's own dry-run of the
// harness entry (evals/public-mcp/worker.ts, the handleContinuityRequest the production entry calls), loaded
// as evals/information-flow-e2e/worker-host.mjs loads it; compatibility date and flags are production's.
// The outbound service receives every subrequest; nothing leaves the machine.
const root = fileURLToPath(new URL('../', import.meta.url));
const production = JSON.parse(readFileSync(path.join(root, 'wrangler.production.jsonc'), 'utf8'));
const work = mkdtempSync(path.join(os.tmpdir(), 'clued-gateway-egress-'));
const outdir = path.join(work, 'bundle');
const wrangler = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run',
  '--outdir', outdir, '--config', 'evals/information-flow-e2e/wrangler.jsonc'], { cwd: root, encoding: 'utf8',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', WRANGLER_LOG_PATH: path.join(work, 'logs') } });
assert.equal(wrangler.status, 0, `wrangler dry-run failed: ${wrangler.stderr}`);

const DB = 'https://db.example.invalid';
const LEAK = 'https://never-follow.invalid/credential-leak';
const secret = randomBytes(32).toString('hex');
let calls = [];
let reply = () => Response.json({ status: 'ok' });
const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [{
  config: { name: 'gateway-egress-fixture', type: 'worker', compatibilityDate: production.compatibility_date,
    compatibilityFlags: production.compatibility_flags,
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: readFileSync(path.join(outdir, 'worker.js'), 'utf8') } } },
    env: Object.fromEntries(Object.entries({ SUPABASE_URL: DB, SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
      CLUED_DB_GATEWAY_TOKEN: 'fixture-gateway-token', GITHUB_WEBHOOK_SECRET: secret }).map(([name, value]) => [name, { type: 'text', value }])) },
  dev: { outboundService: { type: 'fetcher', handler: async (request) => {
    calls.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.text() });
    return reply();
  } } },
}] });
after(async () => { await runtime.dispose(); rmSync(work, { recursive: true, force: true }); });

// One dispatch: the response, its JSON (if any) and what reached the outbound service.
async function send(url, init, stub = () => Response.json({ status: 'ok' })) {
  calls = []; reply = stub;
  const response = await runtime.dispatchFetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, calls };
}
const redirect = () => new Response('fixture-redirect-body', { status: 307, headers: { location: LEAK } });
const refused = () => Response.json({ status: 'refused' });
const hex = (value) => createHash('sha256').update(value).digest('hex');

const delivery = (merged) => {
  const body = JSON.stringify({ action: 'closed', number: 1179, repository: { full_name: 'Org/Repo', default_branch: 'main' },
    pull_request: { merged, base: { ref: 'main' }, merge_commit_sha: merged ? 'ab'.repeat(20) : null } });
  return ['https://app.example.invalid/v1/github/events', { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } }];
};
const token = 'fixture-node-token-' + randomBytes(16).toString('hex');
const nodeId = randomUUID();
const nodeStatus = () => ['https://app.example.invalid/v1/ci/node/status', { method: 'POST', body: JSON.stringify({ node_id: nodeId }),
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token } }];
const renewInput = { contract: 'clued.ci-connection-renew/1', project_id: randomUUID(), node_id: nodeId, kind: 'ci',
  identity_fingerprint: 'c'.repeat(64), old_binding_id: randomUUID(), old_token_hash: 'd'.repeat(64), generation: 1, new_token_hash: null };
const renew = () => ['https://app.example.invalid/v1/ci/node/renew', { method: 'POST',
  body: JSON.stringify({ ...renewInput, issued_at: new Date().toISOString(), signature: 'A'.repeat(86) }),
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' } }];

test('workerd: a signed merged delivery reaches clued_work_pr_merged_event_v1 once', async () => {
  const r = await send(...delivery(true));
  assert.deepEqual({ status: r.status, calls: r.calls.length }, { status: 200, calls: 1 });
  assert.equal(r.calls[0].url, DB + '/rest/v1/rpc/clued_work_pr_merged_event_v1');
  assert.equal(r.calls[0].authorization, 'Bearer fixture-gateway-token');
  assert.deepEqual(JSON.parse(r.calls[0].body), { p_input: { repository: 'Org/Repo', pr_number: 1179, merge_sha: 'ab'.repeat(20) } });
});

test('workerd: a signed closed-unmerged delivery reaches the gateway once with merged:false', async () => {
  const r = await send(...delivery(false));
  assert.deepEqual({ status: r.status, calls: r.calls.length }, { status: 200, calls: 1 });
  assert.equal(r.calls[0].url, DB + '/rest/v1/rpc/clued_work_pr_merged_event_v1');
  assert.equal(JSON.parse(r.calls[0].body).p_input.merged, false);
});

test('workerd: /v1/ci/node/status asks clued_ci_node_trust_v1 once and relays its refusal', async () => {
  const r = await send(...nodeStatus(), refused);
  assert.deepEqual({ status: r.status, calls: r.calls.length, body: r.body },
    { status: 403, calls: 1, body: { status: 'refused', error_code: 'CI_NODE_TRUST_REFUSED' } });
  assert.equal(r.calls[0].url, DB + '/rest/v1/rpc/clued_ci_node_trust_v1');
  assert.deepEqual(JSON.parse(r.calls[0].body), { p_token_hash: hex(token), p_node_id: nodeId });
});

test('workerd: the renewal asks clued_ci_connection_renew_trust_v1 once and returns a definite answer', async () => {
  const r = await send(...renew(), refused);
  assert.deepEqual({ status: r.status, calls: r.calls.length, body: r.body },
    { status: 403, calls: 1, body: { status: 'rejected', error_code: 'RENEW_IDENTITY_REFUSED' } });
  assert.equal(r.calls[0].url, DB + '/rest/v1/rpc/clued_ci_connection_renew_trust_v1');
  assert.equal(r.calls[0].authorization, 'Bearer fixture-gateway-token');
  assert.equal(JSON.parse(r.calls[0].body).p_node_id, nodeId);
});

// The gateway token must never follow a Location: a 3xx is a failure, sent once, and the Location gets nothing.
test('workerd: a 307 from the gateway is a failure at every entry and is never followed', async () => {
  for (const [name, request, status, body] of [
    ['merge notification', delivery(true), 500, null],
    ['node status', nodeStatus(), 503, { status: 'refused', error_code: 'CI_NODE_GATEWAY_UNCONFIRMED' }],
    ['renewal', renew(), 503, { status: 'rejected', error_code: 'RENEW_INTERNAL_RETRY' }],
  ]) {
    const r = await send(...request, redirect);
    assert.deepEqual({ status: r.status, calls: r.calls.length, body: r.body }, { status, calls: 1, body }, name);
    assert.equal(r.calls[0].url.startsWith(DB + '/rest/v1/rpc/'), true, name);
    assert.equal(r.calls.some((call) => new URL(call.url).hostname === new URL(LEAK).hostname), false, name);
  }
});
