// The stage-1 publisher's "settled on a PR that merged" (settledMerged: true; FABLE-resident-halt-merge-race-followup-20261123
// section 1) reaches the resident only through the entry's outcome record and the stage fact, each of which names its fields.
// Only the boolean, only on stage 1's own SETTLED ending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { outcomeFacts, validateOutcome } from '../src/resident-v2/stage-fact.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';

const ADMISSION = Object.freeze({ stage: 1, entryRole: 'work-admission' });
async function carried(t, result, plan = ADMISSION) {
  const nonce = randomUUID().replace(/-/g, '');
  const written = await writeOutcome({ receiptsRoot: await tempDir(t, 'clued-settled-merged-'), nonce, plan, jobIds: [], result });
  assert.equal(validateOutcome(written, { nonce, plan }), written, 'the record is a bound outcome');
  return { written, facts: outcomeFacts(written) };
}

test('settledMerged travels from the stage-1 result through the outcome record into the stage fact', async t => {
  const { written, facts } = await carried(t, { status: 'SETTLED', sideEffects: 2, settledMerged: true });
  assert.deepEqual([written.settledMerged, facts.settledMerged, facts.status], [true, true, 'SETTLED']);
});

test('settledMerged: only true, only SETTLED, only the work-admission entry', async t => {
  for (const [what, result, plan] of [
    ['absent', { status: 'SETTLED', sideEffects: 2 }, ADMISSION],
    ['a merge sha, not the boolean', { status: 'SETTLED', sideEffects: 2, settledMerged: 'e'.repeat(40) }, ADMISSION],
    ['false', { status: 'SETTLED', sideEffects: 2, settledMerged: false }, ADMISSION],
    ['a withdrawn check', { status: 'REVOKED', sideEffects: 2, settledMerged: true }, ADMISSION],
    ['another entry', { status: 'SETTLED', sideEffects: 2, settledMerged: true }, { stage: 3, entryRole: 'check-publisher' }],
  ]) {
    const { written, facts } = await carried(t, result, plan);
    assert.deepEqual(['settledMerged' in written, 'settledMerged' in facts], [false, false], what);
  }
  // the stage fact names it again: a record that carries it on any other ending, or as anything but true, loses it there
  const { written } = await carried(t, { status: 'SETTLED', sideEffects: 2, settledMerged: true });
  assert.equal('settledMerged' in outcomeFacts({ ...written, status: 'REVOKED' }), false);
  assert.equal('settledMerged' in outcomeFacts({ ...written, settledMerged: 1 }), false);
});
