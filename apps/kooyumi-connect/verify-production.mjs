import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './build-release.mjs';

export const ORIGIN = 'https://kooyumi.pixelgrav.com';
export const LEGACY_ORIGIN = 'https://clued.pixelgrav.com';
const ATTEMPTS = 6;

export function verifyConnectRelease({ commit, revision, contractSha, page, legacyPage, smoke, resource, issuer, notBefore }) {
  const errors = [];
  for (const [name, result] of Object.entries({ page, legacyPage, smoke, resource, issuer })) {
    if (result?.status !== 200) errors.push(`connect_${name}_http_${result?.status ?? 0}`);
  }
  if (!/Kooyumi Connect/.test(page?.body ?? '') || !/Kooyumi Connect/.test(legacyPage?.body ?? '')) errors.push('connect_brand_mismatch');
  const body = smoke?.body;
  if (body?.ok !== true || body?.state_machine?.ok !== true || body?.connect_service !== 'clued-connect') errors.push('connect_smoke_failed');
  if (body?.revision !== revision) errors.push('connect_revision_mismatch');
  if (body?.source_commit !== commit || !/^[0-9a-f]{40}$/.test(commit ?? '')) errors.push('connect_source_commit_mismatch');
  if (!(Date.parse(body?.checked_at ?? '') >= notBefore - 5_000)) errors.push('connect_smoke_not_fresh');
  if (body?.upstream?.healthz !== 200 || body?.upstream?.continuity_policy !== 200 || body?.upstream?.official_skill !== 200) errors.push('connect_upstream_unavailable');
  if (body?.upstream?.origin !== ORIGIN || body?.upstream?.resource !== ORIGIN + '/mcp') errors.push('connect_upstream_origin_mismatch');
  if (body?.upstream?.official_skill_sha256 !== contractSha) errors.push('connect_contract_mismatch');
  if (resource?.body?.resource !== ORIGIN + '/mcp' || JSON.stringify(resource?.body?.authorization_servers) !== JSON.stringify([ORIGIN])) errors.push('connect_resource_mismatch');
  if (issuer?.body?.issuer !== ORIGIN || issuer?.body?.authorization_endpoint !== ORIGIN + '/oauth/authorize' || issuer?.body?.token_endpoint !== ORIGIN + '/oauth/token') errors.push('connect_issuer_mismatch');
  return errors;
}

export async function collectChecks(commit, fetchImpl = fetch) {
  const get = async (url, text = false) => {
    try {
      // Read-only: never create an Installation Request, download an issued package or call protected MCP.
      const response = await fetchImpl(`${url}?release=${commit}`, { method: 'GET', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(20_000), headers: { accept: text ? 'text/html' : 'application/json' } });
      return { status: response.status, body: text ? await response.text() : await response.json() };
    } catch { return { status: 0, body: null }; }
  };
  const [page, legacyPage, smoke, resource, issuer] = await Promise.all([
    get(ORIGIN + '/connect', true), get(LEGACY_ORIGIN + '/connect', true), get(ORIGIN + '/connect/api/smoke'),
    get(ORIGIN + '/.well-known/oauth-protected-resource/mcp'), get(ORIGIN + '/.well-known/oauth-authorization-server'),
  ]);
  return { page, legacyPage, smoke, resource, issuer };
}

async function main() {
  const commit = process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('source_commit_missing');
  const source = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const revision = /\bREV='([^']+)'/.exec(source)?.[1];
  if (!revision) throw new Error('connect_revision_missing');
  const contract = (await readFile(new URL('../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const expected = { commit, revision, contractSha: sha256(contract), notBefore: Date.now() };
  let checks, errors;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    checks = await collectChecks(commit);
    errors = verifyConnectRelease({ ...expected, ...checks });
    if (!errors.length) break;
    if (attempt < ATTEMPTS) await new Promise(done => setTimeout(done, 5_000));
  }
  if (errors.length) throw new Error('connect_release_blocked:' + errors.join(','));
  const result = { status: 'passed', source_commit: commit, revision, source_sha256: sha256(source), contract_sha256: expected.contractSha,
    check: checks.smoke.body, checked_at: new Date().toISOString() };
  const index = process.argv.indexOf('--evidence-out'), evidence = process.argv[index + 1];
  if (index < 0 || !evidence) throw new Error('evidence_path_required');
  await writeFile(evidence, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
