import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJobV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { APP_ID, CHECKS, makeIndependentPublicationIdentity as make, validateIndependentPublicationIdentity as validate,
  assertIndependentPublicationTarget as bind, independentPublicationExternalId as externalId } from './clued-independent-publication-identity.mjs';
const claim = { claim_id: '11111111-2222-4333-8444-555555555555', fence: 4, execution_epoch: 3 };
const controller_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const job = role => makeJobV2({ repo: 'tdoljyj/cross-memory-system', pr: 937, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  testSha: 'c'.repeat(40), sourceManifestSha256: 'd'.repeat(64), role, createdAt: '2026-10-29T04:00:00Z', attempt: 1 });
const identity = role => make({ job: job(role), claim, controller_id });
const changed = (value, edit) => { const next = structuredClone(value); edit(next); return next; };
test('six real job/3 identities use App536 and finite role/check pairs, without a fabricated Actions run', () => {
  for (const role of Object.keys(CHECKS)) {
    const value = identity(role); assert.deepEqual(validate(value), value); assert.equal(value.app_id, APP_ID);
    assert.equal(value.check_name, CHECKS[role]); assert.equal(Object.hasOwn(value, 'run_id'), false);
    assert.equal(externalId(value, '99999999-8888-4777-8666-555555555555'), `independent-ci:native:v1:${value.job.id}:p99999999-8888-4777-8666-555555555555`);
  }
});
test('head, tested merge, Source, attempt and job contract tampering fail before an effect can be named', () => {
  for (const edit of [v => v.job.headSha = 'e'.repeat(40), v => v.job.testSha = 'e'.repeat(40),
    v => v.job.sourceManifestSha256 = 'e'.repeat(64), v => v.job.attempt = 2,
    v => v.job.contract = 'clued.independent-ci.job/2', v => v.run_id = '123']) {
    assert.throws(() => validate(changed(identity('gitleaks'), edit)));
  }
});
test('another publisher App, check role or caller-selected effect key cannot cross the binding', () => {
  for (const edit of [v => v.app_id = 5164952, v => v.check_name = 'trivy', v => v.effect_key = 'e'.repeat(64),
    v => v.publication_key = '99999999-8888-4777-8666-555555555555']) assert.throws(() => validate(changed(identity('gitleaks'), edit)));
});
test('controller replacement does not create fresh spending; scanner and admission generations keep their separate domains', () => {
  for (const role of Object.keys(CHECKS)) {
    const a = identity(role), b = make({ job: job(role), claim, controller_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
    assert.equal(a.effect_key, b.effect_key); assert.equal(a.publication_key, b.publication_key);
    const c = make({ job: job(role), claim: { ...claim, execution_epoch: 4 }, controller_id });
    assert.equal(a.effect_key === c.effect_key, ['gitleaks', 'trivy', 'contract-placement'].includes(role));
  }
});
test('current authoritative target must match every claim generation and GitHub subject field', () => {
  const value = identity('control-admission'); const target = { repository: value.job.repo, pr_ref: `${value.job.repo}#937`,
    head_sha: value.job.headSha, base_sha: value.job.baseSha, ...claim };
  assert.deepEqual(bind(value, target), value);
  for (const edit of [v => v.fence++, v => v.execution_epoch++, v => v.claim_id = controller_id,
    v => v.pr_ref = `${value.job.repo}#938`, v => v.base_sha = 'e'.repeat(40), v => v.head_sha = 'e'.repeat(40)]) {
    assert.throws(() => bind(value, changed(target, edit)), /target_changed/);
  }
});
test('identity validation consumes data only and refuses hidden fields or executable accessors', () => {
  let calls = 0; const value = identity('trivy');
  Object.defineProperty(value, 'job', { enumerable: true, get() { calls++; throw Error('must not execute'); } });
  assert.throws(() => validate(value), /identity_invalid/); assert.equal(calls, 0);
  const hidden = identity('trivy'); hidden[Symbol('extra')] = true; assert.throws(() => validate(hidden));
});
