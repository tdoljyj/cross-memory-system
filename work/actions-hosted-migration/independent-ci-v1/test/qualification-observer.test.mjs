import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualificationObserver } from '../src/hosted-relay-v1/qualification-observer.mjs';
import { GITHUB_OIDC_JWKS_URL, tokenFromAnnotation } from '../src/hosted-relay-v1/oidc.mjs';
import { createWorld, M0, OTHER, H, PR } from './fixtures/hosted-relay/world.mjs';

function setup(options = {}) {
  const world = createWorld();
  world.state.pr.merge_commit_sha = M0;
  world.allHosted(options);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(world.state.jwks), { status: 200 });
  };
  return { world, calls, fetchImpl, subject: { ...world.subject(), roles: ['gitleaks', 'trivy'] } };
}
const observer = x => createQualificationObserver({ github: x.world.github, registry: x.world.registry,
  fetchImpl: x.fetchImpl, clock: () => x.world.state.now });

test('real signature verifier and full E1-E8 reuse produce only bounded observation, never live qualification', async () => {
  const x = setup();
  const result = await observer(x).observe(x.subject);
  assert.equal(result.status, 'REGISTRY_REPIN_REQUIRED');
  assert.equal(result.registryRepinRequired, true);
  assert.ok(result.roles.every(r => !r.checkRunIdPresent && !r.registryBindsCheckRunId));
  assert.equal(result.liveQualified, false);
  assert.equal(result.fixture, true);
  assert.equal(result.authority, 'OBSERVATION_ONLY');
  assert.equal(result.roles.length, 2);
  for (const role of result.roles) {
    assert.equal(role.annotationsComplete, true);
    assert.equal(role.oldMergeReadBySha, true);
    assert.equal(role.oldMergeSha, M0);
    assert.equal(role.verifiedClaims.sha, M0);
    assert.equal(role.verifiedClaims.jti, undefined);
    assert.equal(role.verifiedClaims.exp, undefined);
    assert.match(role.claimsSha256, /^[a-f0-9]{64}$/);
  }
  for (const annotations of x.world.state.annotations.values()) {
    const raw = tokenFromAnnotation(annotations[0].message);
    assert.ok(!JSON.stringify(result).includes(raw));
    assert.ok(!JSON.stringify(result).includes(annotations[0].message));
  }
});

test('each invocation requires a new GET of fixed JWKS URL even with known signing kid', async () => {
  const x = setup(), o = observer(x);
  assert.equal((await o.observe(x.subject)).freshJwksGetCompleted, true);
  assert.equal((await o.observe(x.subject)).freshJwksGetCompleted, true);
  assert.equal(x.calls.length, 2);
  for (const call of x.calls) {
    assert.equal(call.url, GITHUB_OIDC_JWKS_URL);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
  }
});

test('check_run_id presence in a valid signed token requests explicit registry repin instead of qualification', async () => {
  // IDs are deterministically assigned by the existing fixture world.
  const x = setup({ gitleaks: { claims: { check_run_id: '900000' } }, trivy: { claims: { check_run_id: '900001' } } });
  const result = await observer(x).observe(x.subject);
  assert.equal(result.status, 'REGISTRY_REPIN_REQUIRED');
  assert.equal(result.registryRepinRequired, true);
  assert.equal(result.liveQualified, false);
  assert.ok(result.roles.every(r => r.checkRunIdPresent && !r.registryBindsCheckRunId));
});

test('malformed/masked annotation output never escapes as token, claim or raw error', async () => {
  const x = setup({ gitleaks: { token: '***' } });
  const result = await observer(x).observe(x.subject);
  assert.equal(result.status, 'OBSERVATION_REFUSED');
  assert.equal(result.roles, undefined);
  assert.equal(result.code, 'QUALIFICATION_FULL_ANNOTATIONS_REQUIRED');
  assert.ok(!JSON.stringify(result).includes('***'));
});

test('foreign issuer signature/key or changed claim binding never produces partial role proof', async () => {
  const x = setup({ trivy: { claims: { repository: 'foreign/repository' } } });
  const result = await observer(x).observe(x.subject);
  assert.equal(result.status, 'OBSERVATION_REFUSED');
  assert.equal(result.roles, undefined);
  assert.equal(result.code, 'QUALIFICATION_ATTESTATION_REFUSED');
  assert.ok(!JSON.stringify(result).includes('foreign/repository'));
});

test('fresh network failure and origin change are refusals even though fixture verifier could cache keys', async () => {
  for (const fetchImpl of [async () => { throw Error('secret-body-do-not-log'); },
    async () => ({ ok: true, url: 'https://attacker.invalid/jwks' })]) {
    const x = setup(); x.fetchImpl = fetchImpl;
    const result = await observer(x).observe(x.subject);
    assert.equal(result.status, 'OBSERVATION_REFUSED');
    assert.equal(result.freshJwksGetCompleted, undefined);
    assert.ok(!JSON.stringify(result).includes('secret-body'));
    assert.ok(!JSON.stringify(result).includes('attacker.invalid'));
  }
});

test('old merge proof requires changed ref for the same PR/head and then a fresh read of the original SHA', async () => {
  const x = setup(), o = observer(x);
  await o.observe(x.subject);
  x.world.state.pr.merge_commit_sha = OTHER;
  const beforeReads = x.world.state.calls.readGitCommit ?? 0;
  const proof = await o.observeOldMergeAfterMovement({ pr: PR, headSha: H, oldMergeSha: M0 });
  assert.equal(proof.movementObserved, true);
  assert.equal(proof.beforeRefSha, M0);
  assert.equal(proof.afterRefSha, OTHER);
  assert.equal(proof.oldMergeReadBySha, true);
  assert.equal(proof.liveQualified, false);
  assert.equal(x.world.state.calls.readGitCommit, beforeReads + 1);
  assert.equal(x.calls.length, 1, 'ref movement observation adds no JWT request or dispatch');
});

test('unchanged merge, moved HEAD and unreadable old merge refuse; no alternate SHA fallback', async () => {
  for (const change of [x => { x.world.state.pr.merge_commit_sha = M0; },
    x => { x.world.state.pr.merge_commit_sha = OTHER; x.world.state.pr.head.sha = OTHER; },
    x => { x.world.state.pr.merge_commit_sha = OTHER; x.world.state.commits.delete(M0); }]) {
    const x = setup(), o = observer(x); await o.observe(x.subject); change(x);
    const result = await o.observeOldMergeAfterMovement({ pr: PR, headSha: H, oldMergeSha: M0 });
    assert.equal(result.status, 'OBSERVATION_REFUSED');
    assert.equal(result.liveQualified, false);
    assert.equal(result.movementObserved, undefined);
  }
});

test('caller-selected old merge and a new observer cannot manufacture a before-ref observation', async () => {
  const x = setup();
  x.world.state.pr.merge_commit_sha = OTHER;
  const result = await observer(x).observeOldMergeAfterMovement({ pr: PR, headSha: H, oldMergeSha: M0 });
  assert.equal(result.code, 'QUALIFICATION_BEFORE_REF_UNCONFIRMED');
  assert.equal(result.movementObserved, undefined);
  assert.equal(x.world.state.calls.readGitCommit, undefined, 'no fallback lookup after missing provenance');
});

test('a matching-parent old object that was never this PR merge ref is not movement evidence', async () => {
  const x = setup(), o = observer(x);
  x.world.state.pr.merge_commit_sha = OTHER;
  await o.observe(x.subject); // verified old M0 claims do not authenticate current OTHER as M0.
  const result = await o.observeOldMergeAfterMovement({ pr: PR, headSha: H, oldMergeSha: M0 });
  assert.equal(result.code, 'QUALIFICATION_BEFORE_REF_UNCONFIRMED');
});

test('unknown thrown error codes and getters cannot enter public output', async () => {
  for (const error of [{ code: 'SECRET_PRIVATE_VALUE' },
    Object.defineProperty({}, 'code', { get() { throw Error('GETTER_EXECUTED'); } }),
    new Proxy({}, { getOwnPropertyDescriptor() { throw Error('TRAP_SECRET'); } })]) {
    const x = setup();
    let refuse = false, attempts = 0;
    const github = { ...x.world.github, async readPullRequest(...args) {
      if (refuse) { attempts += 1; throw error; }
      return x.world.github.readPullRequest(...args);
    } };
    const o = createQualificationObserver({ github, registry: x.world.registry, fetchImpl: x.fetchImpl });
    await o.observe(x.subject);
    assert.equal(o.currentMergeObservation({ pr: PR, headSha: H }).beforeRefSha, M0);
    refuse = true;
    const result = await o.observeOldMergeAfterMovement({ pr: PR, headSha: H, oldMergeSha: M0 });
    assert.equal(attempts, 1, 'the malicious error path was actually reached');
    assert.equal(result.code, 'QUALIFICATION_OBSERVATION_UNCONFIRMED');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('current merge provenance is private to the observing instance and exact PR/head', async () => {
  const x = setup(), o = observer(x);
  assert.equal(o.currentMergeObservation({ pr: PR, headSha: H }), null);
  await o.observe(x.subject);
  assert.equal(o.currentMergeObservation({ pr: PR, headSha: H }).beforeRefSha, M0);
  assert.equal(o.currentMergeObservation({ pr: PR + 1, headSha: H }), null);
  assert.equal(o.currentMergeObservation({ pr: PR, headSha: OTHER }), null);
  assert.equal(observer(x).currentMergeObservation({ pr: PR, headSha: H }), null);
});

test('one-role shortcut is rejected before any reads or network activity', async () => {
  const x = setup();
  await assert.rejects(observer(x).observe({ ...x.subject, roles: ['gitleaks'] }), e => e.code === 'QUALIFICATION_BOTH_ROLES_REQUIRED');
  assert.deepEqual(x.world.state.calls, {});
  assert.equal(x.calls.length, 0);
});
