// Generation 13 (resident DESIGN §57.4, Task a7951534): a create whose answer was lost may land on GitHub only after the port's own
// read-back window. The staged publisher reads again and adopts a copy that is exactly what it sent, instead of withdrawing it and
// burning the head; it never sends the create again. Anything else keeps the old path.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { ADOPT_READ_DELAYS_MS, adoptReadAllowed, createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult, admittedFacts } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
// What the GitHub port throws when a 5xx answered the create (github.mjs ambiguousWrite): it may have landed.
const fault = code => Object.assign(new Error(code), { code, retryable: true, unsent: false, ambiguous: true });

// visibleAfter: how many readChecks calls after the lost create before GitHub shows the check (Infinity: never); alter: the copy
// GitHub shows differs from what was sent.
function lossyGithub({ visibleAfter = 2, alter = null } = {}) {
  const checks = []; let next = 100, hidden = null, reads = 0;
  return { fixture: true, checks, get reads() { return reads; },
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) {
      if (hidden) { reads += 1; if (reads >= visibleAfter) { checks.push(hidden); hidden = null; } }
      return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) };
    },
    async createCheck(body) {
      const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) };
      if (alter) alter(c);
      if (checks.length === 0 && hidden === null && Number.isFinite(visibleAfter)) { hidden = c; throw fault('github_http_502'); }
      if (!Number.isFinite(visibleAfter)) throw fault('github_http_502');
      checks.push(c); return structuredClone(c);
    },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}

async function world(t, github) {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 }).gitleaks;
  const c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const refs = Object.fromEntries(REFS.map(k => [k, record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true,
    hostQualified: true, publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
  const nativeAdmission = { fixture: true, async evaluatePr(j, packet, opts) { return admittedFacts(j, c, packet, { domain: 'fixture', batchClaim: opts.batchClaim }); } };
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const sleeps = [];
  const pub = createStagedCheckPublisherV2({ nativeAdmission, authority, github, journal, signers, configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j),
    protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs }, batchClaim: claimGeneration(c),
    domain: 'fixture', sleep: async ms => { sleeps.push(ms); } });
  return { publish: () => pub.publish({ job, envelope }), sleeps, journal };
}

test('the exact copy shows up after the port gave up: adopted, settled, never sent again, nothing withdrawn', async t => {
  const github = lossyGithub({ visibleAfter: 2 });
  const w = await world(t, github);
  const r = await w.publish();
  assert.deepEqual([r.status, r.sideEffects, github.checks.length, github.checks[0].conclusion], ['SETTLED', 1, 1, 'success'], JSON.stringify(r));
  assert.deepEqual(w.sleeps, [ADOPT_READ_DELAYS_MS[1]], 'read at once, then again after the first wait');
});

test('no copy at all: the old path (the create may have landed: UNCERTAIN, nothing guessed)', async t => {
  const github = lossyGithub({ visibleAfter: Infinity });
  const w = await world(t, github);
  const r = await w.publish();
  assert.equal(r.status, 'UNCERTAIN', JSON.stringify(r));
  assert.deepEqual(w.sleeps, ADOPT_READ_DELAYS_MS.filter(ms => ms > 0));
  assert.equal(github.checks.length, 0);
});

test('a copy that is not exactly what was sent is never adopted: withdrawn as before', async t => {
  const github = lossyGithub({ visibleAfter: 1, alter: c => { c.output = { ...c.output, summary: c.output.summary + ' (changed)' }; } });
  const w = await world(t, github);
  const r = await w.publish();
  assert.equal(r.status, 'REVOKED', JSON.stringify(r));
  assert.equal(github.checks[0].conclusion, 'failure');
});

test('a create GitHub refused outright (422) or a failure proven before sending cannot have landed: no wait, no read for a copy', async t => {
  for (const error of [Object.assign(new Error('github_http_422'), { code: 'github_http_422' }),
    Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed', retryable: true, unsent: true })]) {
    const github = lossyGithub({ visibleAfter: Infinity });
    let failed = false, readsAfter = 0;
    github.createCheck = async () => { failed = true; throw error; };
    const read = github.readChecks.bind(github); github.readChecks = async head => { if (failed) readsAfter++; return read(head); };
    const w = await world(t, github);
    const r = await w.publish();
    assert.deepEqual([w.sleeps.length, github.checks.length], [0, 0], `${error.code}: ${JSON.stringify(r)}`);
    assert.ok(readsAfter <= 1, `${error.code}: at most the error path's own discovery read, never the adopt schedule (${readsAfter})`);
  }
});

test('a check list that is not trusted (two checks with one id, or one on another head) is never adopted from', async t => {
  for (const spoil of [list => [...list, structuredClone(list[0])], list => list.map(c => ({ ...c, head_sha: 'f'.repeat(40) }))]) {
    const github = lossyGithub({ visibleAfter: 1 });
    const read = github.readChecks.bind(github);
    github.readChecks = async head => { const l = await read(head); return l.checks.length ? { ...l, checks: spoil(l.checks) } : l; };
    const w = await world(t, github);
    const r = await w.publish();
    assert.notEqual(r.status, 'SETTLED', JSON.stringify(r));
    assert.deepEqual(w.sleeps, ADOPT_READ_DELAYS_MS.filter(ms => ms > 0), 'every read refused, none adopted');
  }
});

test('the schedule: at once, then after 10 s and 25 s more (each only while the confirmation still fits the window)', () => {
  assert.deepEqual([...ADOPT_READ_DELAYS_MS], [0, 10_000, 25_000]);
});

test('which failed creates are looked for: a Native handle, a proof of not sending and a definite refusal never are (review round 2, MINOR 3)', () => {
  const ambiguous = fault('github_http_502');
  assert.equal(adoptReadAllowed(ambiguous, null), true);
  assert.equal(adoptReadAllowed(ambiguous, { native: false }), true);
  assert.equal(adoptReadAllowed(ambiguous, { native: true }), false, 'a Native publication recovers by its own ticket and finish');
  assert.equal(adoptReadAllowed(Object.assign(new Error('github_http_422'), { code: 'github_http_422' }), null), false);
  assert.equal(adoptReadAllowed(Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed', retryable: true, unsent: true }), null), false);
  assert.equal(adoptReadAllowed(Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed', retryable: true, unsent: false }), null), true);
});
