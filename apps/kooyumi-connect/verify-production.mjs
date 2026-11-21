import { readFile, writeFile } from 'node:fs/promises';
import { sha256 } from './build-release.mjs';
import { PROPAGATION_WINDOW_MS } from '../clued-cloud/scripts/currentness-live-build.mjs';
import { verifyServedAgentContract } from '../clued-cloud/scripts/verify-served-agent-contract.mjs';

// Public browser entry and authenticated issuer are deliberately independent.
export const PUBLIC_ORIGIN = 'https://kooyomi.com';
export const ORIGIN = 'https://kooyumi.pixelgrav.com';
export const LEGACY_ORIGIN = 'https://clued.pixelgrav.com';
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

export function verifyConnectRelease({ commit, revision, contract, page, smoke, resource, issuer, servedContract, bootstrap, notBefore }) {
  const errors = [];
  for (const [name, result] of Object.entries({ page, smoke, resource, issuer, servedContract, bootstrap })) {
    if (result?.status !== 200) errors.push(`connect_${name}_http_${result?.status ?? 0}`);
  }
  if (!/BeamingFace Connect/.test(page?.body ?? '')) errors.push('connect_brand_mismatch');
  const body = smoke?.body;
  if (body?.ok !== true || body?.state_machine?.ok !== true || body?.connect_service !== 'clued-connect') errors.push('connect_smoke_failed');
  if (body?.revision !== revision) errors.push('connect_revision_mismatch');
  if (body?.source_commit !== commit || !/^[0-9a-f]{40}$/.test(commit ?? '')) errors.push('connect_source_commit_mismatch');
  if (!(Date.parse(body?.checked_at ?? '') >= notBefore - 5_000)) errors.push('connect_smoke_not_fresh');
  if (body?.upstream?.healthz !== 200 || body?.upstream?.continuity_policy !== 200 || body?.upstream?.official_skill !== 200) errors.push('connect_upstream_unavailable');
  if (body?.upstream?.origin !== ORIGIN || body?.upstream?.resource !== ORIGIN + '/mcp') errors.push('connect_upstream_origin_mismatch');
  // Bootstrap identifies the repository contract; the served document also has
  // origin-specific service information. Bind each hash to its own byte boundary.
  errors.push(...verifyServedAgentContract({ contract, served: servedContract?.body, bootstrap: bootstrap?.body })
    .map(error => `connect_${error}`));
  if (bootstrap?.body?.lifecycle?.contract?.url !== ORIGIN + '/clued-agent.md') errors.push('connect_contract_origin_mismatch');
  if (typeof servedContract?.body !== 'string' || body?.upstream?.official_skill_sha256 !== sha256(servedContract.body)) {
    errors.push('connect_contract_mismatch');
  }
  if (resource?.body?.resource !== ORIGIN + '/mcp' || JSON.stringify(resource?.body?.authorization_servers) !== JSON.stringify([ORIGIN])) errors.push('connect_resource_mismatch');
  if (issuer?.body?.issuer !== ORIGIN || issuer?.body?.authorization_endpoint !== ORIGIN + '/oauth/authorize' || issuer?.body?.token_endpoint !== ORIGIN + '/oauth/token') errors.push('connect_issuer_mismatch');
  return errors;
}

export async function collectChecks(commit, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (url, accept = 'application/json') => {
    try {
      // Read-only: never create an Installation Request, download an issued package or call protected MCP.
      const response = await fetchImpl(`${url}?release=${commit}`, { method: 'GET', redirect: 'error', cache: 'no-store',
        signal, headers: { accept } });
      return { status: response.status, body: accept === 'application/json' ? await response.json() : await response.text() };
    } catch { return { status: 0, body: null }; }
  };
  const [page, smoke, resource, issuer, servedContract, bootstrap] = await Promise.all([
    get(PUBLIC_ORIGIN + '/connect', 'text/html'), get(PUBLIC_ORIGIN + '/connect/api/smoke'),
    get(ORIGIN + '/.well-known/oauth-protected-resource/mcp'), get(ORIGIN + '/.well-known/oauth-authorization-server'),
    get(ORIGIN + '/clued-agent.md', 'text/markdown'), get(ORIGIN + '/v1/continuity/bootstrap'),
  ]);
  return { page, smoke, resource, issuer, servedContract, bootstrap };
}

async function main() {
  const commit = process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('source_commit_missing');
  const source = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const revision = /\bREV='([^']+)'/.exec(source)?.[1];
  if (!revision) throw new Error('connect_revision_missing');
  const contract = (await readFile(new URL('../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const expected = { commit, revision, contract, notBefore: Date.now() };
  const deadline = performance.now() + PROPAGATION_WINDOW_MS;
  let checks, errors;
  for (let remainingMs = PROPAGATION_WINDOW_MS; remainingMs > 0; remainingMs = deadline - performance.now()) {
    checks = await collectChecks(commit, fetch, Math.min(REQUEST_TIMEOUT_MS, Math.ceil(remainingMs)));
    errors = verifyConnectRelease({ ...expected, ...checks });
    if (!errors.length) break;
    const delayMs = Math.min(RETRY_DELAY_MS, deadline - performance.now());
    if (delayMs > 0) await new Promise(done => setTimeout(done, Math.ceil(delayMs)));
  }
  if (errors.length) throw new Error('connect_release_blocked:' + errors.join(','));
  const result = { status: 'passed', source_commit: commit, revision, source_sha256: sha256(source), contract_sha256: sha256(contract),
    served_contract_sha256: sha256(checks.servedContract.body),
    check: checks.smoke.body, checked_at: new Date().toISOString() };
  const index = process.argv.indexOf('--evidence-out'), evidence = process.argv[index + 1];
  if (index < 0 || !evidence) throw new Error('evidence_path_required');
  await writeFile(evidence, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
