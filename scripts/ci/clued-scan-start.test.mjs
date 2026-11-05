import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { obtainScanStart, subjectFromCheck, ENDPOINT, AUDIENCE } from './clued-scan-start.mjs';
const H = 'a'.repeat(40), B = 'b'.repeat(40);
function fixture(options = {}) {
  const claim = randomUUID(), execution = randomUUID(), receipt = randomUUID(), gh = 'ghs_' + 'x'.repeat(40), bearer = 'fixture-only-oidc-request';
  const metadata = { claim_id: claim, fence: 2, epoch: 3, source_manifest_sha256: 'c'.repeat(64), registry_sha256: 'd'.repeat(64) };
  const row = { id: 42, app: { id: 5368905 }, name: 'kooyumi-work-admission', head_sha: H, status: 'completed', conclusion: 'success',
    output: { summary: 'Public control metadata only.\nclued-scan-start-subject/1 ' + JSON.stringify(metadata) } };
  const env = { GITHUB_REPOSITORY: 'tdoljyj/cross-memory-system', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_JOB: 'trivy-trusted-self-hosted', GITHUB_TOKEN: gh, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions-fixture.actions.githubusercontent.com/idtoken?api-version=2.0' };
  const event = { repository: { id: 1334673495 }, pull_request: { number: 888, state: 'open',
    head: { sha: H, repo: { full_name: env.GITHUB_REPOSITORY } }, base: { sha: B, ref: 'main', repo: { full_name: env.GITHUB_REPOSITORY } } } };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    if (url.startsWith('https://api.github.com/repos/tdoljyj/cross-memory-system/commits/')) {
      assert.equal(init.headers.authorization, `Bearer ${gh}`);
      return Response.json({ total_count: 1, check_runs: [options.row ?? row] });
    }
    if (url.startsWith('https://run-actions-fixture.actions.githubusercontent.com/')) {
      assert.equal(new URL(url).searchParams.get('audience'), AUDIENCE);
      assert.equal(init.headers.authorization, `Bearer ${bearer}`); return Response.json({ value: 'fixture.oidc.signature' });
    }
    assert.equal(url, ENDPOINT); assert.equal(init.headers['x-github-read-token'], gh);
    assert.equal(init.headers.authorization, 'Bearer fixture.oidc.signature');
    assert.deepEqual(JSON.parse(init.body), { contract: 'clued.ci-scan-start-request/1', execution_id: execution, ...metadata, pr: 888, head_sha: H, base_sha: B });
    if (options.lost) throw new Proxy({}, { get() { throw Error('foreign error must not be rendered'); } });
    return Response.json(options.reply ?? { status: 'committed', contract: 'clued.ci-scan-start-grant/1', launch_allowed: true,
      execution_id: execution, receipt_id: receipt, repository_id: 1334673495, head_sha: H, role: 'trivy',
      provider: 'github-actions', start_requested_at: new Date().toISOString() });
  };
  return { env, event, calls, row, metadata, execution, receipt, gh, fetchImpl, run: () => obtainScanStart({ env, event, fetchImpl, newId: () => execution }) };
}
test('trusted-base entry uses independent public Native metadata then one fresh OIDC authenticated begin', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { receipt_id: f.receipt, role: 'trivy' });
  assert.equal(f.calls.length, 3); assert.equal(f.calls.filter(([url]) => url === ENDPOINT).length, 1);
  for (const [, init] of f.calls) assert.equal(init.redirect, 'error');
});
test('consumed, malformed, wrong-role and wrong-subject grants never let a scanner follow', async () => {
  const g = fixture();
  for (const reply of [{ status: 'consumed', launch_allowed: false }, { status: 'committed', launch_allowed: true },
    { status: 'committed', contract: 'clued.ci-scan-start-grant/1', launch_allowed: true, execution_id: g.execution,
      receipt_id: g.receipt, repository_id: 1334673495, head_sha: B, role: 'gitleaks', provider: 'github-actions', start_requested_at: new Date().toISOString() }]) {
    const f = fixture({ reply }); await assert.rejects(f.run()); assert.equal(f.calls.filter(([url]) => url === ENDPOINT).length, 1);
  }
});
test('loss of the only begin reply has no automatic retry or credential rendering', async () => {
  const f = fixture({ lost: true }); let caught = false;
  try { await f.run(); } catch { caught = true; }
  assert.ok(caught); assert.equal(f.calls.filter(([url]) => url === ENDPOINT).length, 1);
});
test('ambiguous/missing/extra-field subject markers and unknown admission cannot bootstrap a body', () => {
  const f = fixture();
  for (const row of [{ ...f.row, app: { id: 15368 } }, { ...f.row, conclusion: 'failure' },
    { ...f.row, output: { summary: 'missing' } }, { ...f.row, output: { summary: f.row.output.summary + '\n' + f.row.output.summary.split('\n')[1] } },
    { ...f.row, output: { summary: 'quoted clued-scan-start-subject/1 unused\n' + f.row.output.summary } },
    { ...f.row, output: { summary: 'clued-scan-start-subject/1 ' + JSON.stringify({ ...f.metadata, approved: true }) } }])
    assert.throws(() => subjectFromCheck([row], H));
  assert.throws(() => subjectFromCheck([f.row, { ...f.row, id: 43 }], H));
});
test('non-PR, wrong repository and hostile OIDC request origins stop before forwarding runtime credentials', async () => {
  for (const overrides of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'fixture/other' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/idtoken' }, { GITHUB_JOB: 'unknown-job' }]) {
    const f = fixture(); Object.assign(f.env, overrides); await assert.rejects(f.run());
    assert.equal(f.calls.filter(([url]) => url === ENDPOINT || !url.startsWith('https://api.github.com/')).length, 0);
  }
});
