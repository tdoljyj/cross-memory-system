import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindFrozenParent, bindFrozenParents } from '../scripts/information-flow/frozen-parent-adapter.mjs';

test('unrecognized identity cannot substitute a parent', () => {
  assert.throws(() => bindFrozenParent('MODEL-PROGRAM-M0', '.'), /Unknown parent/);
});

test('caller cannot invent an accepted root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clued-parent-invalid-'));
  try {
    writeFileSync(join(dir, 'SHA256SUMS'), '0'.repeat(64) + '  fake.json\n');
    assert.throws(() => bindFrozenParent('IF-MVP0-A', dir), /Frozen root mismatch/);
  } finally { rmSync(dir, { recursive: true }); }
});

const parentsAvailable = Boolean(process.env.M0A_ROOT && process.env.M0B_ROOT && process.env.M0C_ROOT);
test('recovered parents preserve all three frozen identities', { skip: !parentsAvailable }, () => {
  const result = bindFrozenParents({ 'IF-MVP0-A': process.env.M0A_ROOT, 'IF-MVP0-B': process.env.M0B_ROOT, 'IF-MVP0-C': process.env.M0C_ROOT });
  assert.deepEqual(result.parents.map(p => p.verified_files), [35, 12, 159]);
  assert.equal(result.runtime_or_model_acceptance, false);
});

for (const [label, mutate] of [
  ['altered declared bytes', dir => writeFileSync(join(dir, 'README.md'), 'changed')],
  ['undeclared payload', dir => writeFileSync(join(dir, 'extra.json'), '{}')],
]) {
  test('rejects ' + label, { skip: !parentsAvailable }, () => {
    const temp = mkdtempSync(join(tmpdir(), 'clued-parent-negative-'));
    const dir = join(temp, 'copy');
    try {
      cpSync(process.env.M0B_ROOT, dir, { recursive: true });
      mutate(dir);
      assert.throws(() => bindFrozenParent('IF-MVP0-B', dir), /Frozen file mismatch|Undeclared frozen file/);
    } finally { rmSync(temp, { recursive: true }); }
  });
}
