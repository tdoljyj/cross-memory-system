// Task ce2e5c1a step 2: no fixture of this suite reads the real clock when its file loads, or beside a fake clock it was given.
// The scanner and its own tests live with the resident suite (work/independent-ci-resident-v1/test/clock-lock.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOCK_LOCK_FIX, scanClockLock, shownFinding, testFilesIn } from '../../../independent-ci-resident-v1/test/clock-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the Source v2 suite: no fixture reads the real clock when its file loads, or beside the fake clock it takes', () => {
  const findings = scanClockLock(testFilesIn(here));
  assert.deepEqual(findings.map(f => shownFinding(f, here)), [], CLOCK_LOCK_FIX);
});
