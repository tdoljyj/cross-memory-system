// Production smoke for Information Flow (register L26): one dedicated test
// account drives the Part B chain against the live Worker and records every
// step and assertion. Nothing here touches the database directly, resets
// state, bypasses a trigger or reads another account: every call goes through
// the public Worker with the test account's own session or its own Binding.
//
// Chain: sign in -> own Binding -> Native intake -> list -> two-step promote
// -> accept a run-scoped Context Policy -> Agent compiles a pack over MCP
// (live tokenizer measurement) -> Evidence withdrawal -> manifest STALE and
// recompile excludes the record -> revoke the Binding.
//
// Required env: CLUED_E2E_EMAIL, CLUED_E2E_PASSWORD. Optional:
// CLUED_E2E_BASE_URL (default https://clued.pixelgrav.com), --evidence-out.
// Writes are permanent and stay in the test account (Receipts are immutable);
// each run withdraws its own Evidence so later packs exclude its record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSupabasePublicConfig } from '../../app/supabase-public-config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureDir = path.join(repoRoot, 'development/contracts/information-flow/vendored/m0a/fixtures/smoke/SMK-CAN-001');
const MCP_PROTOCOL = '2025-06-18';
const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base',
  model_mapping: 'gpt-4.1-2025-04-14' };

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const email = process.env.CLUED_E2E_EMAIL;
const password = process.env.CLUED_E2E_PASSWORD;
if (!email || !password) throw new Error('CLUED_E2E_EMAIL and CLUED_E2E_PASSWORD are required');
const base = new URL(process.env.CLUED_E2E_BASE_URL ?? 'https://clued.pixelgrav.com').origin;
const supabase = resolveSupabasePublicConfig({});
const runId = crypto.randomBytes(6).toString('hex');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const key = (label) => `prod-e2e-${runId}-${label}`;

const steps = [];
const checks = [];
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  checks.push({ id, label, pass, expected, actual });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${id} ${label}\n`);
  return pass;
}

async function call(channel, method, pathname, { bearer, body, headers = {}, url } = {}) {
  const started = performance.now();
  let response; let text = ''; let parsed = null; let networkError = null;
  try {
    response = await fetch(url ?? `${base}${pathname}`, { method, redirect: 'error',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    text = await response.text();
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).at(-1);
      parsed = data ? JSON.parse(data) : null;
    } else parsed = text ? JSON.parse(text) : null;
  } catch (error) { networkError = error.name; }
  const duration = Math.round(performance.now() - started);
  steps.push({ channel, method, target: pathname, http_status: networkError ? `network_error:${networkError}` : response.status,
    response_sha256: text ? sha256(text) : null, duration_ms: duration });
  return { status: response?.status ?? null, body: parsed, duration, networkError };
}

// 1. Test account session (fresh sign-in, so Native confirmations are allowed).
const signIn = await call('gotrue', 'POST', '/auth/v1/token?grant_type=password', {
  url: `${supabase.url}/auth/v1/token?grant_type=password`, headers: { apikey: supabase.key }, body: { email, password } });
if (!check('00.sign_in', 'the test account signs in', 200, signIn.status)) process.exit(1);
const jwt = signIn.body.access_token;
const native = (method, pathname, body) => call('worker_rest', method, pathname, { bearer: jwt, body });

// 2. The test account issues its own Agent Binding.
const bound = await native('POST', '/api/bindings', { vendor: 'Other', agentName: `prod-e2e ${runId}`,
  scopes: ['context:read', 'context:write'] });
check('00.binding', 'the test account issues an Agent Binding', [200, true],
  [bound.status, typeof bound.body?.token === 'string' && bound.body.token.startsWith('clued_bnd_')]);
const bindingToken = bound.body?.token;
const bindingId = bound.body?.binding?.id;
let mcpId = 0;
const tool = async (name, args) => {
  const res = await call('worker_mcp', 'POST', `/mcp tools/call ${name}`, { url: `${base}/mcp`, bearer: bindingToken,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_PROTOCOL },
    body: { jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name, arguments: args } } });
  return { ...res, structured: res.body?.result?.structuredContent ?? res.body?.error ?? res.body };
};

let failed = false;
try {
  const init = await call('worker_mcp', 'POST', '/mcp initialize', { url: `${base}/mcp`, bearer: bindingToken,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_PROTOCOL },
    body: { jsonrpc: '2.0', id: ++mcpId, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {},
      clientInfo: { name: 'clued-prod-e2e', version: '1.0.0' } } } });
  check('00.mcp_initialize', 'the Agent initializes an MCP session', 200, init.status);

  // 3. Native intake of the vendored smoke fixture under a run-unique segment id.
  const segmentId = `seg_prod_e2e_${runId}`;
  const segment = { ...JSON.parse(fs.readFileSync(path.join(fixtureDir, 'input.json'), 'utf8')), segment_id: segmentId };
  const candidates = { ...JSON.parse(fs.readFileSync(path.join(fixtureDir, 'output.json'), 'utf8')), segment_id: segmentId };
  const submit = await native('POST', '/v1/intake', { idempotency_key: key('submit'), scope: 'global', segment, candidates });
  check('01.submit', 'Native submit commits', 'committed', submit.body?.status);
  const candidateId = submit.body?.supplemental?.candidates?.[0]?.id;
  const evidenceId = submit.body?.evidence_ids?.[0];
  const listed = await native('GET', `/v1/intake?status=pending&scope=global&submission_id=${
    encodeURIComponent(submit.body?.supplemental?.submission_id ?? '')}`);
  check('01.listed', 'the candidate lists as pending', [candidateId], listed.body?.candidates?.map((c) => c.id));

  // 4. Two-step Native promotion.
  const issued = await native('POST', `/v1/intake/${candidateId}/confirmation`, { base_version: 1, authority: 'observed',
    native_type_fields: { execution_bucket: 'later' } });
  check('02.issue', 'step 1 issues a confirmation', 'issued', issued.body?.status);
  const recordId = issued.body?.record_id;
  const promoted = await native('POST', `/v1/intake/${candidateId}/promote`, { idempotency_key: key('promote'),
    base_version: 1, confirmation_token: issued.body?.confirmation_token, view_digest: issued.body?.view_digest });
  check('02.promote', 'step 2 promotes the candidate to Authority Information', ['committed', 'promoted'],
    [promoted.body?.status, promoted.body?.supplemental?.outcome]);

  // 5. Run-scoped Context Policy, accepted through the two Native steps.
  const taskClass = `prod-e2e.${runId}`;
  const policy = { schema: 'clued.context-policy.v1', task_class: taskClass, allowed_scopes: ['global'],
    allowed_record_types: ['decision', 'note', 'profile_fact', 'state', 'task'], require_evidence: true,
    fields: { required: ['title', 'content'], optional: [] }, max_items: 50, token_budget: 8000,
    tokenizer: TOKENIZER, freshness: { mode: 'current' } };
  const policyIssue = await native('POST', '/v1/context/policies/confirmation', { policy,
    rationale: `Production smoke ${runId} (synthetic)`, base_policy_version: 0 });
  check('03.policy_issue', 'policy confirmation is issued', 'issued', policyIssue.body?.status);
  const policyAccept = await native('POST', '/v1/context/policies', { idempotency_key: key('policy'), task_class: taskClass,
    base_policy_version: 0, confirmation_token: policyIssue.body?.confirmation_token, view_digest: policyIssue.body?.view_digest });
  check('03.policy_accept', 'the policy is accepted', 'committed', policyAccept.body?.status);

  // 6. The Agent compiles a pack over MCP; the Worker measures it live.
  const packed = await tool('clued_context_pack', { scope: 'global', task_class: taskClass });
  const pack = packed.structured;
  check('04.pack_ok', 'the Agent receives a pack', 'ok', pack?.status);
  const item = pack?.pack?.items?.find((row) => row.canonical_id === recordId);
  check('04.item', 'the pack holds the promoted Record, human_confirmed, with the submit Evidence',
    [true, true, true], [Boolean(item), item?.human_confirmed === true,
      (item?.evidence ?? []).some((row) => row.evidence_id === evidenceId)]);
  check('04.measured', 'the live Worker measured the pack with the bound tokenizer', ['measured', 'offline_target', true],
    [pack?.measurement?.status, pack?.measurement?.tokenizer_status, pack?.measurement?.pack_digest === pack?.pack_digest]);
  check('04.digest', 'sha256(pack_text) equals pack_digest', true,
    typeof pack?.pack_text === 'string' && sha256(pack.pack_text) === pack.pack_digest);
  check('04.claims', 'execution is never granted', 'NOT_GRANTED', pack?.pack?.execution_authorization);
  const manifestId = pack?.manifest?.id;

  // 7. Evidence withdrawal makes the manifest STALE and removes the record.
  const wdIssue = await native('POST', `/v1/evidence/${evidenceId}/withdrawal/confirmation`, { base_version: 0,
    reason: `Production smoke ${runId} cleanup (synthetic)` });
  check('05.withdraw_issue', 'withdrawal confirmation is issued', 'issued', wdIssue.body?.status);
  const withdrawn = await native('POST', `/v1/evidence/${evidenceId}/withdrawal`, { idempotency_key: key('withdraw'),
    base_version: 0, confirmation_token: wdIssue.body?.confirmation_token, view_digest: wdIssue.body?.view_digest });
  check('05.withdraw', 'the Evidence is withdrawn', ['committed', 'withdrawn'],
    [withdrawn.body?.status, withdrawn.body?.supplemental?.outcome]);
  const revalidated = await native('POST', '/v1/context/pack', { manifest_id: manifestId });
  check('05.revalidate', 'the earlier manifest revalidates as STALE (evidence_withdrawn)', [409, 'STALE', 'evidence_withdrawn'],
    [revalidated.status, revalidated.body?.revalidation, revalidated.body?.reason]);
  const recompiled = await tool('clued_context_pack', { scope: 'global', task_class: taskClass });
  check('05.recompile', 'a recompile no longer contains the record', false,
    (recompiled.structured?.pack?.items ?? []).some((row) => row.canonical_id === recordId));
} catch (error) {
  failed = true;
  process.stdout.write(`ERROR ${error.message}\n`);
} finally {
  // 8. Revoke the run's Binding whatever happened.
  if (bindingId) {
    const revoked = await native('DELETE', `/api/bindings?id=${encodeURIComponent(bindingId)}`);
    check('06.revoke', 'the run Binding is revoked', true, revoked.status >= 200 && revoked.status < 300);
  }
}

const passed = !failed && checks.every((row) => row.pass);
const evidence = { schema: 'clued.information-flow.prod-e2e/1', run_id: runId, base_url: base,
  ci_run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  source_commit: process.env.GITHUB_SHA ?? null, finished_at: new Date().toISOString(),
  verdict: passed ? 'PASS' : 'FAIL', checks, steps };
const out = arg('--evidence-out');
if (out) fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${evidence.verdict}: ${checks.filter((row) => row.pass).length}/${checks.length} checks\n`);
process.exit(passed ? 0 : 1);
