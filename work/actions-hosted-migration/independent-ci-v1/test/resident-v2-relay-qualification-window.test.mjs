// Read-only installed-window metadata can restrict execution, never authorize it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { hash } from '../src/resident-v2/prepare-record.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import { readRelayQualificationHoldWindow } from '../src/resident-v2/invoke-stage.mjs';
import { relayQualificationWindow, RELAY_QUALIFICATION_WINDOW_CONTRACT,
  RELAY_QUALIFICATION_AUTHORITY_ID } from '../src/resident-v2/relay-qualification-run.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { NOW, fixtureRecord } from './resident-v2-fixtures.mjs';

function record(window = true, until = NOW + 3600000) {
  const f = fixtureRecord(), config = JSON.parse(f.docs['installation.json']);
  const accepted = JSON.parse(f.docs['acceptance.json']);
  const subject = { repo: config.repository, runId: 'a'.repeat(16) + '-' + 'b'.repeat(12), pr: 987,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testSha: 'a'.repeat(40),
    sourceManifestSha256: config.sourceManifestSha256, nodeProfileSha256: hash(accepted.node),
    claimId: randomUUID(), fence: 9, executionEpoch: 1 };
  subject.stage1JobId = makeJobV2({ ...Object.fromEntries(['repo','pr','headSha','baseSha','testSha','sourceManifestSha256'].map(k => [k,subject[k]])),
    role: 'work-admission', attempt: 1, createdAt: new Date(NOW).toISOString() }).id;
  if (window) accepted.relayQualificationWindow = { contract: RELAY_QUALIFICATION_WINDOW_CONTRACT,
    qualificationRef: 'receipt:' + randomUUID(), sourceManifestSha256: config.sourceManifestSha256,
    ownerReceiptRef: accepted.ownerReceiptRef, authorityDecisionId: RELAY_QUALIFICATION_AUTHORITY_ID,
    authorityDecisionSha256: 'c'.repeat(64), authorityReadReceiptRef: randomUUID(), subject,
    validUntil: new Date(until).toISOString(), allowedPhases: ['initial','after-ref-move'],
    executionPolicy: 'staged', guarded: false, changedPaths: ['src/probe.mjs'], changedPathsSha256: digest(['src/probe.mjs']) };
  const save = () => {
    f.docs['acceptance.json'] = Buffer.from(canonical(accepted));
    config.acceptanceSha256 = hash(f.docs['acceptance.json']);
    f.docs['installation.json'] = Buffer.from(canonical(config));
  };
  save(); return { ...f, config, accepted, subject, save, nodeHash: hash(accepted.node) };
}

test('window lookup distinguishes verified absence from read/identity/structure failures', () => {
  const f = record(false);
  const options = { recordDocs: f.docs, now: NOW, nodeProfileSha256: f.nodeHash };
  assert.equal(readRelayQualificationHoldWindow(options).window, null);
  assert.throws(() => readRelayQualificationHoldWindow({ ...options, nodeProfileSha256: '0'.repeat(64) }));
  assert.throws(() => readRelayQualificationHoldWindow({ ...options, recordDocs: {} }));
  f.accepted.relayQualificationWindow = null; f.save();
  assert.throws(() => readRelayQualificationHoldWindow(options));
});

test('expired accepted window remains restrictive metadata but grants no current Stage13 capability', () => {
  const f = record(true, NOW - 1);
  const result = readRelayQualificationHoldWindow({ recordDocs: f.docs, now: NOW, nodeProfileSha256: f.nodeHash });
  assert.equal(result.authority, 'RESTRICTIVE_HOLD_ONLY');
  assert.deepEqual(result.window.subject, f.subject);
  assert.equal(relayQualificationWindow(validateRecordV2(f.docs, { now: NOW }), { now: NOW }), null);
});

test('window lookup re-derives the static Stage1 identity and validates installed node binding', () => {
  for (const field of ['stage1JobId','nodeProfileSha256']) {
    const f = record(); f.accepted.relayQualificationWindow.subject[field] = '0'.repeat(64); f.save();
    assert.throws(() => readRelayQualificationHoldWindow({ recordDocs:f.docs, now:NOW, nodeProfileSha256:f.nodeHash }));
  }
});
