// PR-A review fixes on the Source side (each test failed before its fix):
//   v1 pins of the modules the v1 one-shot loads; the v2 Native verify timeout; a local K refusal is UNKNOWN;
//   uncoded exceptions are never transient; contract-placement is never relayed (registry and spec).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V1_REQUIRED_SOURCE } from '../runtime/one-shot.mjs';
import { protectedAuthority } from '../runtime/one-shot-v2.mjs';
import { outcomeFailureCode, TRANSIENT_CODES, UNKNOWN_CODES } from '../src/resident-v2/stage-fact.mjs';
import { RELAYABLE_ROLES } from '../src/hosted-relay-v1/registry.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CI = 'work/actions-hosted-migration/independent-ci-v1/';
const blocked = (reason, sideEffects = 0) => ({ status: 'BLOCKED', reason, sideEffects, mayHavePublished: sideEffects !== 0 });

test('v1 one-shot pins every Source module the v1 publisher loads (static import closure of staged-check-publisher.mjs)', () => {
  const seen = new Set(), queue = [CI + 'src/staged-check-publisher.mjs'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
    for (const m of text.matchAll(/^import\s[^'"]*from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  }
  const missing = [...seen].filter(p => !V1_REQUIRED_SOURCE.includes(p));
  assert.deepEqual(missing, []);
  for (const p of ['attest.mjs', 'registry.mjs', 'oidc.mjs']) assert.ok(V1_REQUIRED_SOURCE.includes(`${CI}src/hosted-relay-v1/${p}`), p);
});

test('v2 protected Native verify carries the same bounded 10 s signal as v1', async () => {
  let opts = null;
  const auth = protectedAuthority({ config: { supabaseUrl: 'https://x.supabase.co/', publishableKey: 'k', scope: 'project:x' }, accepted: {},
    github: { async readChangedPaths() { return { paths: ['a'] }; } }, fetchImpl: async (url, o) => { opts = o; throw new Error('offline'); }, nativeToken: 't', live() {}, log() {} });
  await assert.rejects(auth.observe({ id: 'x' }, { claimId: 'c', fence: 1, epoch: 1 }), { code: 'native_claim_observation_unconfirmed' });
  assert.ok(opts?.signal instanceof AbortSignal, 'a timeout signal is passed');
  assert.equal(opts.signal.aborted, false);
});

test('a local publication refused by K (role_already_published_on_head) is UNKNOWN on every stage, never a clean block', () => {
  for (const stage of [3, 5, 7, 9]) assert.equal(outcomeFailureCode(blocked('role_already_published_on_head'), stage), 'ROLE_ALREADY_PUBLISHED_ON_HEAD', String(stage));
  assert.ok(UNKNOWN_CODES.includes('ROLE_ALREADY_PUBLISHED_ON_HEAD'));
});

test('uncoded exceptions are never a transient code (no automatic attempt 2 can follow them)', () => {
  for (const [reason, stage] of [['publication_observation_unconfirmed', 3], ['NATIVE_CHECK_UNCONFIRMED', 1], ['publication_operation_unconfirmed', 3],
    ['WORK_ADMISSION_OPERATION_UNCONFIRMED', 1], ['CONTROL_CHECK_OPERATION_UNCONFIRMED', 8], ['ENTRY_OPERATION_UNCONFIRMED', 2]])
    assert.ok(!TRANSIENT_CODES.includes(outcomeFailureCode(blocked(reason), stage)), `${reason}@${stage}`);
  // explicit transport facts stay transient
  assert.equal(outcomeFailureCode(blocked('github_transient_unavailable'), 3), 'GITHUB_TRANSIENT_UNAVAILABLE');
  assert.equal(outcomeFailureCode(blocked('full_admission_unavailable'), 1), 'NATIVE_ADMISSION_UNAVAILABLE');
  // the v2 publishers' default for an uncoded exception is not a transport reason any more
  for (const f of ['src/staged-check-publisher-v2.mjs', 'src/formal-work-admission-check-v2/publisher.mjs', 'src/independent-control-checks-v2/publisher.mjs']) {
    const text = fs.readFileSync(path.join(ROOT, ...(CI + f).split('/')), 'utf8');
    assert.ok(!/: '(publication_observation_unconfirmed|NATIVE_CHECK_UNCONFIRMED)';/.test(text), f);
  }
});

test('contract-placement is never relayed: neither the production registry nor its spec registers it', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, ...`${CI}src/hosted-relay-v1/registry.json`.split('/')), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, ...`${CI}src/hosted-relay-v1/registry.spec.json`.split('/')), 'utf8'));
  assert.deepEqual(Object.keys(registry.roles).sort(), Object.keys(RELAYABLE_ROLES).sort());
  assert.deepEqual(Object.keys(spec.roles).sort(), Object.keys(RELAYABLE_ROLES).sort());
  assert.ok(!Object.hasOwn(RELAYABLE_ROLES, 'contract-placement'));
  const admission = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'clued-work-admission.mjs'), 'utf8');
  assert.match(admission, /contract-placement is never relayed/, 'the placement registration says so');
});
