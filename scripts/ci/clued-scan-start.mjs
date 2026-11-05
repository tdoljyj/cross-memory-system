// Trusted-base workflow entry. Runtime credentials remain in request memory;
// only the fixed Native first-insert permission can let the next scan step run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ENDPOINT = 'https://kooyumi.pixelgrav.com/v1/ci/scan-start';
export const AUDIENCE = 'clued-ci-scan-start-v1';
const REPO = 'tdoljyj/cross-memory-system', REPO_ID = 1334673495, APP_ID = 5368905;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const MARKER = 'clued-scan-start-subject/1 ';
const check = ok => { if (!ok) throw Error('SCAN_START_DENIED'); };
const exact = (v, names) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
async function bounded(response, max = 262144) {
  check(response.body); const chunks = [], reader = response.body.getReader(); let size = 0;
  try {
    for (;;) { const row = await reader.read(); if (row.done) break;
      size += row.value.byteLength; check(size <= max); chunks.push(row.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
async function request(fetchImpl, url, init, max) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      check(response.status === 200 && (!response.url || response.url === url));
      const length = response.headers.get('content-length');
      check(length === null || /^\d+$/.test(length) && Number(length) <= (max ?? 262144));
      return bounded(response, max);
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('SCAN_START_DENIED')); }, 30000); })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
export function subjectFromCheck(checks, head) {
  const rows = checks.filter(c => c?.app?.id === APP_ID && c.name === 'kooyumi-work-admission' && c.head_sha === head);
  check(rows.length === 1 && rows[0].status === 'completed' && rows[0].conclusion === 'success' && typeof rows[0].output?.summary === 'string');
  const summary = rows[0].output.summary;
  check(summary.split(MARKER).length === 2);
  const lines = summary.split('\n').filter(line => line.startsWith(MARKER)); check(lines.length === 1);
  const value = JSON.parse(lines[0].slice(MARKER.length));
  check(exact(value, ['claim_id', 'fence', 'epoch', 'source_manifest_sha256', 'registry_sha256'])
    && UUID.test(value.claim_id) && Number.isSafeInteger(value.fence) && value.fence > 0 && Number.isSafeInteger(value.epoch) && value.epoch > 0
    && HASH.test(value.source_manifest_sha256) && HASH.test(value.registry_sha256));
  return value;
}
export async function obtainScanStart({ env, event, fetchImpl = fetch, newId = randomUUID }) {
  check(env.GITHUB_REPOSITORY === REPO && env.GITHUB_EVENT_NAME === 'pull_request' && env.GITHUB_ACTIONS === 'true');
  const pr = event?.pull_request;
  check(Number.isSafeInteger(pr?.number) && pr.number > 0 && pr.state === 'open' && event.repository?.id === REPO_ID
    && pr.head?.repo?.full_name === REPO && pr.base?.repo?.full_name === REPO && pr.base.ref === 'main'
    && SHA.test(pr.head.sha) && SHA.test(pr.base.sha));
  const token = env.GITHUB_TOKEN;
  const expectedRole = { 'gitleaks-trusted-self-hosted': 'gitleaks', 'trivy-trusted-self-hosted': 'trivy' }[env.GITHUB_JOB];
  check(expectedRole);
  check(typeof token === 'string' && /^ghs_[A-Za-z0-9_]{16,500}$/.test(token));
  const checks = []; let total = null;
  for (let page = 1; page <= 20; page++) {
    const result = await request(fetchImpl, `https://api.github.com/repos/${REPO}/commits/${pr.head.sha}/check-runs?per_page=100&filter=all&app_id=${APP_ID}&page=${page}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    check(Number.isSafeInteger(result.total_count) && result.total_count >= 0 && result.total_count <= 2000
      && Array.isArray(result.check_runs) && result.check_runs.length <= 100 && (total === null || result.total_count === total));
    total ??= result.total_count; checks.push(...result.check_runs); check(checks.length <= total);
    if (checks.length === total) break;
    check(result.check_runs.length === 100 && page < 20);
  }
  check(checks.length === total && new Set(checks.map(c => c.id)).size === checks.length);
  const metadata = subjectFromCheck(checks, pr.head.sha), executionId = newId(); check(UUID.test(executionId));
  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  check(oidcUrl.protocol === 'https:' && /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(oidcUrl.hostname)
    && !oidcUrl.port && !oidcUrl.username && !oidcUrl.password && !oidcUrl.hash && !oidcUrl.searchParams.has('audience'));
  oidcUrl.searchParams.set('audience', AUDIENCE);
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  check(typeof bearer === 'string' && bearer.length > 0 && bearer.length <= 16384 && !/[\x00-\x20\x7f]/.test(bearer));
  const oidc = await request(fetchImpl, oidcUrl.href, { method: 'GET', headers: { authorization: `Bearer ${bearer}` } }, 16384);
  check(typeof oidc.value === 'string' && oidc.value.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(oidc.value));
  const input = { contract: 'clued.ci-scan-start-request/1', execution_id: executionId, ...metadata,
    pr: pr.number, head_sha: pr.head.sha, base_sha: pr.base.sha };
  // No retry: losing this reply may mean Native has already burned K.
  const answer = await request(fetchImpl, ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${oidc.value}`, 'x-github-read-token': token }, body: JSON.stringify(input) }, 16384);
  const grant = answer;
  check(exact(grant, ['status', 'contract', 'launch_allowed', 'execution_id', 'receipt_id', 'repository_id', 'head_sha', 'role', 'provider', 'start_requested_at'])
    && grant.status === 'committed' && grant.contract === 'clued.ci-scan-start-grant/1' && grant.launch_allowed === true
    && grant.execution_id === executionId && UUID.test(grant.receipt_id) && grant.repository_id === REPO_ID && grant.head_sha === pr.head.sha
    && grant.role === expectedRole && grant.provider === 'github-actions'
    && typeof grant.start_requested_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(grant.start_requested_at)
    && new Date(grant.start_requested_at).toISOString() === grant.start_requested_at);
  return { receipt_id: grant.receipt_id, role: grant.role };
}
export async function main(argv = process.argv.slice(2), env = process.env, output = process.stdout) {
  try {
    check(argv.length === 1 && argv[0] === '--run');
    const stat = await fs.stat(env.GITHUB_EVENT_PATH); check(stat.isFile() && stat.size > 0 && stat.size <= 1048576);
    const event = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    const result = await obtainScanStart({ env, event });
    output.write(JSON.stringify({ status: 'SCAN_START_GRANTED', receipt_id: result.receipt_id, role: result.role }) + '\n'); return 0;
  } catch { output.write(JSON.stringify({ status: 'SCAN_START_DENIED', automatic_retry: false }) + '\n'); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
