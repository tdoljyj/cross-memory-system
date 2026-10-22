import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildRelease, sha256 } from '../build-release.mjs';
import { collectChecks, verifyConnectRelease, PUBLIC_ORIGIN, ORIGIN, LEGACY_ORIGIN } from '../verify-production.mjs';
import { contractVersionOf } from '../../clued-cloud/scripts/verify-served-agent-contract.mjs';

const commit = 'a'.repeat(40), notBefore = Date.parse('2026-10-15T10:00:00Z');
const contract = '# Clued Agent Contract\n\nContract version: 49\n\nContract fixture.\n';
// The real /clued-agent.md response appends this service-information boundary.
const serviceTail = `
---

Kernel: 0.8.1
Canonical store: clued-cloud/supabase
MCP endpoint: ${ORIGIN}/mcp
HTTP bootstrap: ${ORIGIN}/v1/continuity/bootstrap
Binding portal: ${ORIGIN}/
`;
const servedContract = contract + serviceTail, contractSha = sha256(contract), servedSha = sha256(servedContract);
function healthy() {
  return { commit, revision: '0.2.16', contract, notBefore,
    page: { status: 200, body: '<b>BeamingFace Connect</b>' },
    smoke: { status: 200, body: { ok: true, connect_service: 'clued-connect', revision: '0.2.16', source_commit: commit,
      checked_at: '2026-10-15T10:00:01Z', state_machine: { ok: true },
      upstream: { origin: ORIGIN, resource: ORIGIN + '/mcp', healthz: 200, continuity_policy: 200, official_skill: 200, official_skill_sha256: servedSha } } },
    resource: { status: 200, body: { resource: ORIGIN + '/mcp', authorization_servers: [ORIGIN] } },
    issuer: { status: 200, body: { issuer: ORIGIN, authorization_endpoint: ORIGIN + '/oauth/authorize', token_endpoint: ORIGIN + '/oauth/token' } },
    servedContract: { status: 200, body: servedContract },
    bootstrap: { status: 200, body: { lifecycle: { contract: { version: 49, url: ORIGIN + '/clued-agent.md' } },
      agent_contract: { version: 49, sha256: contractSha } } },
  };
}

test('release build is deterministic, binds the exact commit and refuses missing provenance', async () => {
  const source = await readFile(new URL('../worker.mjs', import.meta.url), 'utf8');
  const built = buildRelease(source, commit);
  assert.deepEqual(buildRelease(source, commit), built);
  assert.equal(built.manifest.source_commit, commit);
  assert.equal(built.manifest.source_sha256, sha256(source));
  assert.equal(built.manifest.artifact_sha256, sha256(built.artifact));
  assert.equal(built.artifact, `const KOOYUMI_RELEASE_COMMIT="${commit}";\n` + source);
  for (const invalid of [undefined, '', 'main', 'a'.repeat(39), 'A'.repeat(40), commit + ' extra']) {
    assert.throws(() => buildRelease(source, invalid), /source_commit_missing/);
  }
  assert.throws(() => buildRelease('export default {};', commit), /connect_revision_missing/);
});

test('the built module reports its compiled commit through read-only smoke without storage or credentials', async () => {
  const source = await readFile(new URL('../worker.mjs', import.meta.url), 'utf8');
  const { artifact } = buildRelease(source, commit);
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(artifact).toString('base64'));
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    assert.equal(new URL(url).origin, ORIGIN);
    return String(url).endsWith('/clued-agent.md') ? new Response(servedContract) : Response.json({ ok: true });
  };
  try {
    const response = await worker.fetch(new Request(PUBLIC_ORIGIN + '/connect/api/smoke'), { KOOYUMI_UPSTREAM_ORIGIN: ORIGIN });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.source_commit, commit);
    assert.equal(result.upstream.origin, ORIGIN);
    assert.equal(result.upstream.resource, ORIGIN + '/mcp');
    assert.equal(result.upstream.official_skill_sha256, servedSha);
    assert.notEqual(result.upstream.official_skill_sha256, contractSha);
    assert.deepEqual(calls, [ORIGIN + '/healthz', ORIGIN + '/.well-known/clued-continuity', ORIGIN + '/clued-agent.md']);
  } finally { globalThis.fetch = previous; }
});

test('the real repository contract and service tail retain distinct verified hashes', async () => {
  const value = healthy();
  value.contract = (await readFile(new URL('../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const version = contractVersionOf(value.contract);
  assert.ok(Number.isSafeInteger(version) && version > 0, 'repository contract must name a valid version');
  value.bootstrap.body.lifecycle.contract.version = version;
  value.bootstrap.body.agent_contract.version = version;
  value.servedContract.body = value.contract + serviceTail;
  value.bootstrap.body.agent_contract.sha256 = sha256(value.contract);
  value.smoke.body.upstream.official_skill_sha256 = sha256(value.servedContract.body);
  assert.notEqual(value.smoke.body.upstream.official_skill_sha256, value.bootstrap.body.agent_contract.sha256);
  assert.deepEqual(verifyConnectRelease(value), []);
  value.bootstrap.body.lifecycle.contract.version = version - 1;
  assert.ok(verifyConnectRelease(value).includes('connect_bootstrap_contract_version_mismatch'));
  value.bootstrap.body.lifecycle.contract.version = version;
  value.bootstrap.body.agent_contract.version = version - 1;
  assert.ok(verifyConnectRelease(value).includes('connect_bootstrap_agent_contract_version_mismatch'));
});

test('production verification refuses wrong code, old issuers, failed upstream checks and stale responses', async t => {
  assert.deepEqual(verifyConnectRelease(healthy()), []);
  const cases = [
    [value => { value.smoke.body.source_commit = 'b'.repeat(40); }, 'connect_source_commit_mismatch'],
    [value => { value.smoke.body.revision = '0.2.13'; }, 'connect_revision_mismatch'],
    [value => { value.smoke.body.ok = false; }, 'connect_smoke_failed'],
    [value => { value.smoke.body.state_machine.ok = false; }, 'connect_smoke_failed'],
    [value => { value.smoke.body.checked_at = '2026-10-15T09:00:00Z'; }, 'connect_smoke_not_fresh'],
    [value => { value.smoke.body.upstream.healthz = 503; }, 'connect_upstream_unavailable'],
    [value => { value.smoke.body.upstream.origin = LEGACY_ORIGIN; }, 'connect_upstream_origin_mismatch'],
    [value => { value.smoke.body.upstream.official_skill_sha256 = 'b'.repeat(64); }, 'connect_contract_mismatch'],
    [value => { value.smoke.body.upstream.official_skill_sha256 = contractSha; }, 'connect_contract_mismatch'],
    [value => { value.servedContract.body += 'unexpected changed bytes'; }, 'connect_contract_mismatch'],
    [value => {
      value.servedContract.body = value.servedContract.body.replace('Contract fixture.', 'Tampered canonical instructions.');
      value.smoke.body.upstream.official_skill_sha256 = sha256(value.servedContract.body);
    }, 'connect_served_agent_contract_differs_from_repository'],
    [value => { value.bootstrap.body.agent_contract.sha256 = servedSha; }, 'connect_bootstrap_agent_contract_sha256_mismatch'],
    [value => { value.bootstrap.body.agent_contract.version = 48; }, 'connect_bootstrap_agent_contract_version_mismatch'],
    [value => { value.bootstrap.body.lifecycle.contract.version = 48; }, 'connect_bootstrap_contract_version_mismatch'],
    [value => { value.bootstrap.body.lifecycle.contract.url = LEGACY_ORIGIN + '/clued-agent.md'; }, 'connect_contract_origin_mismatch'],
    [value => { value.servedContract.status = 503; }, 'connect_servedContract_http_503'],
    [value => { value.bootstrap.status = 503; }, 'connect_bootstrap_http_503'],
    [value => { value.resource.body.authorization_servers = [LEGACY_ORIGIN]; }, 'connect_resource_mismatch'],
    [value => { value.issuer.body.token_endpoint = LEGACY_ORIGIN + '/oauth/token'; }, 'connect_issuer_mismatch'],
    [value => { value.page.body = '<b>Clued Connect</b>'; }, 'connect_brand_mismatch'],
    [value => { value.page.body = '<b>KooYomi Connect</b>'; }, 'connect_brand_mismatch'],
    [value => { value.page.status = 302; }, 'connect_page_http_302'],
  ];
  for (const [mutate, expected] of cases) await t.test(expected, () => {
    const value = healthy(); mutate(value);
    assert.ok(verifyConnectRelease(value).includes(expected));
  });
});

test('production observation uses public GET checks only and refuses redirects or transport failure', async () => {
  const requested = [], value = healthy();
  const bodies = new Map([
    [PUBLIC_ORIGIN + '/connect', value.page],
    [PUBLIC_ORIGIN + '/connect/api/smoke', value.smoke], [ORIGIN + '/.well-known/oauth-protected-resource/mcp', value.resource],
    [ORIGIN + '/.well-known/oauth-authorization-server', value.issuer],
    [ORIGIN + '/clued-agent.md', value.servedContract], [ORIGIN + '/v1/continuity/bootstrap', value.bootstrap],
  ]);
  const checks = await collectChecks(commit, async (url, options) => {
    const target = new URL(url); requested.push(target.origin + target.pathname);
    assert.equal(target.searchParams.get('release'), commit);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
    const expected = bodies.get(target.origin + target.pathname);
    assert.ok(expected, 'unapproved observation route');
    assert.equal(options.headers.accept, target.pathname === '/clued-agent.md' ? 'text/markdown'
      : target.pathname === '/connect' ? 'text/html' : 'application/json');
    return typeof expected.body === 'string' ? new Response(expected.body) : Response.json(expected.body);
  });
  assert.deepEqual(new Set(requested), new Set(bodies.keys()));
  assert.ok(requested.every(url => [PUBLIC_ORIGIN, ORIGIN].includes(new URL(url).origin)), 'public entry and issuer checks must use only the two reviewed origins');
  assert.equal(Object.hasOwn(checks, 'legacyPage'), false);
  assert.deepEqual(verifyConnectRelease({ ...value, ...checks }), []);
  const unavailable = await collectChecks(commit, async () => { throw new Error('redirect or network failure'); });
  assert.ok(Object.values(unavailable).every(result => result.status === 0 && result.body === null));
});

test('Connect joins the existing main production release after its Grant and main/PDF verification', async () => {
  const require = createRequire(new URL('../../clued-cloud/package.json', import.meta.url));
  const { parse } = require('yaml');
  const workflow = parse(await readFile(new URL('../../../.github/workflows/clued-cloud-production-release.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.release, steps = job.steps, index = name => steps.findIndex(step => step.name === name);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /github\.actor == github\.repository_owner/);
  assert.match(job.if, /github\.triggering_actor == github\.repository_owner/);
  assert.equal(job.environment, 'clued-release');
  assert.equal(job.defaults.run['working-directory'], 'apps/clued-cloud');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const ordered = ['Verify and build Kooyumi Connect release source', 'Block release unless database and Worker heartbeat are ready',
    'Consume the Owner Grant for this commit', 'Deploy Clued PDF extractor Worker', 'Deploy Clued production Worker',
    'Verify exact live commit and currentness transport', 'Verify production serves the repository Agent contract',
    'Verify the PDF extractor service binding', 'Deploy Kooyumi Connect Worker', 'Verify Kooyumi Connect production release',
    'Verify projection currentness after deployment'].map(index);
  assert.ok(ordered.every((position, i) => position >= 0 && (i === 0 || position > ordered[i - 1])));
  const build = steps[index('Verify and build Kooyumi Connect release source')];
  assert.match(build.run, /node --test \.\.\/kooyumi-connect\/tests\/\*\.test\.mjs/);
  assert.match(build.run, /node --test tests\/oauth-origin\.test\.mjs/);
  assert.match(build.run, /--out-dir "\$RUNNER_TEMP\/kooyumi-connect-build"/);
  for (const name of ['Deploy Kooyumi Connect Worker', 'Verify Kooyumi Connect production release']) {
    assert.equal(steps[index(name)].if, "${{ inputs.mode == 'deploy' }}");
  }
  const deploy = steps[index('Deploy Kooyumi Connect Worker')];
  assert.match(deploy.run, /wrangler deploy "\$RUNNER_TEMP\/kooyumi-connect-build\/worker\.mjs"/);
  assert.match(deploy.run, /--config \.\.\/kooyumi-connect\/wrangler\.production\.jsonc --no-bundle --keep-vars/);
  assert.equal(deploy.env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2 }}');
  assert.equal(deploy.env.CLOUDFLARE_ACCOUNT_ID, '${{ vars.CLUED_CLOUDFLARE_ACCOUNT_ID }}');
  assert.equal(deploy['continue-on-error'], undefined);
  const preserved = steps.find(step => step.name === 'Preserve release evidence').with.path;
  assert.match(preserved, /connect-build\.json\n/);
  assert.match(preserved, /connect-postflight\.json\n/);
});
