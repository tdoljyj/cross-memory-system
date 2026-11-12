import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMechanicalPolicy, readMechanicalPolicy, markerOnlyDiff, markerPatterns, mechanicalFieldDiff, computeMechanicalPathsProven } from './component-version-integration-policy.mjs';

const policy = { schema: 1, repository: 'tdoljyj/cross-memory-system',
  context_keys: ['project:0597aa60-9b98-4da6-a4ab-63d7705b632f'],
  mechanical_paths: ['config/clued-components.json', 'apps/clued-cloud/worker/generated/**'] };

test('the repository list parses, in the format with marker_paths and the one before it', () => {
  const repo = readMechanicalPolicy(path.resolve(import.meta.dirname, '../..'));
  assert.ok(repo.marker_paths.length > 0);
  assert.deepEqual(parseMechanicalPolicy(JSON.stringify(policy)), policy);
  assert.deepEqual(parseMechanicalPolicy(JSON.stringify({ ...policy, marker_paths: ['scripts/a.mjs'] })).marker_paths, ['scripts/a.mjs']);
});

test('unreviewed policy scope, malformed paths or overlapping sections fail closed', () => {
  for (const value of [ { ...policy, context_keys: ['global'] }, { ...policy, mechanical_paths: ['**'] },
    { ...policy, mechanical_paths: ['../source.ts'] }, { ...policy, allow_all: true },
    { ...policy, marker_paths: ['scripts/**'] }, { ...policy, marker_paths: ['../a.mjs'] },
    { ...policy, marker_paths: ['config/clued-components.json'] }, { ...policy, marker_paths: 'x' } ]) {
    assert.throws(() => parseMechanicalPolicy(JSON.stringify(value)), /invalid scoped mechanical-file policy/);
  }
});

test('a marker file may change only its declared version line and digests', () => {
  const manifest = JSON.stringify({ components: [{ id: 'a', root: 'scripts', version_marker: { file: 'a.py', pattern: '__version__ = "{version}"' } }] });
  const patterns = markerPatterns(manifest, 'scripts/a.py');
  const before = '__version__ = "1.0.0"\nPIN = "' + 'a'.repeat(40) + '"\nbudget = 1\n';
  assert.equal(markerOnlyDiff(before, before.replace('1.0.0', '1.0.1'), patterns), true);
  assert.equal(markerOnlyDiff(before, before.replace('a'.repeat(40), 'b'.repeat(40)), patterns), true);
  assert.equal(markerOnlyDiff(before, before.replace('budget = 1', 'budget = 2'), patterns), false);
  assert.equal(markerOnlyDiff(before, before.replace('"1.0.0"', '"1.0.1"; evil()'), patterns), false);
  assert.equal(markerOnlyDiff(before, before + 'x\n', patterns), false);
  assert.equal(markerOnlyDiff(before, null, patterns), false);
  // The manifest's component entries are hand-written: only version/content_sha256 are generated.
  const m = { schema: 1, components: [{ id: 'a', version: '1.0.0', content_sha256: 'x', files: ['a.py'] }, { id: 'b', version: '1', files: ['b.py'] }] };
  const bumped = structuredClone(m); bumped.components[0].version = '1.0.1'; bumped.components[0].content_sha256 = 'y';
  assert.equal(markerOnlyDiff(JSON.stringify(m), JSON.stringify(bumped), [], 'config/clued-components.json'), true);
  const removed = structuredClone(m); removed.components.pop();
  assert.equal(markerOnlyDiff(JSON.stringify(m), JSON.stringify(removed), [], 'config/clued-components.json'), false);
});

test('a CI proof covers a marker file only for a generated-line change at the exact base/head', async () => {
  const p = { ...policy, mechanical_paths: ['apps/clued-cloud/worker/generated/**'], marker_paths: ['config/clued-components.json', 'scripts/a.py'] };
  const manifest = JSON.stringify({ schema: 1, components: [{ id: 'a', root: 'scripts', version: '1.0.0', files: ['a.py'],
    version_marker: { file: 'a.py', pattern: '__version__ = "{version}"' } }] });
  const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
  const files = { [baseSha]: { 'scripts/a.py': '__version__ = "1.0.0"\nx = 1\n', 'config/clued-components.json': manifest },
    [headSha]: { 'scripts/a.py': '__version__ = "1.0.1"\nx = 1\n', 'config/clued-components.json': manifest.replace('"1.0.0"', '"1.0.1"') } };
  const run = () => computeMechanicalPathsProven({ policy: p, baseSha, headSha, changedPaths: ['scripts/a.py', 'config/clued-components.json'],
    readFileAt: async (file, ref) => files[ref][file], readFileEntryAt: async () => ({ type: 'blob', mode: '100644' }) });
  assert.deepEqual(await run(), ['config/clued-components.json', 'scripts/a.py']);
  files[headSha]['scripts/a.py'] = '__version__ = "1.0.1"\nx = 2\n';
  files[headSha]['config/clued-components.json'] = manifest.replace('"a.py"]', '"a.py","b.py"]');
  assert.deepEqual(await run(), []);
});

test('a shared version script never exempts an actual runtime edit', () => {
  const before = "export const COMPONENT_VERSION='1.0.0';\nexport const budget=1;\n";
  assert.equal(mechanicalFieldDiff('scripts/source.mjs', before, before.replace('1.0.0', '1.0.1')), true);
  assert.equal(mechanicalFieldDiff('scripts/source.mjs', before, before.replace('budget=1', 'budget=0')), false);
  assert.equal(mechanicalFieldDiff('scripts/source.mjs', before, before.replace("'1.0.0'", "'1.0.1'; evil()")), false);
  assert.equal(mechanicalFieldDiff('scripts/source.mjs', before, null), false);
});

test('component source definitions still need ownership; only generated version/hash differences are proven', () => {
  const p = { schema: 1, components: [{ id: 'a', version: '1.0.0', content_sha256: 'old', files: ['source/a.py'] }] };
  const q = structuredClone(p); q.components[0].version = '1.0.1'; q.components[0].content_sha256 = 'new';
  assert.equal(mechanicalFieldDiff('config/clued-components.json', JSON.stringify(p), JSON.stringify(q)), true);
  q.components[0].files = ['source/other.py'];
  assert.equal(mechanicalFieldDiff('config/clued-components.json', JSON.stringify(p), JSON.stringify(q)), false);
});

test('proof is bound to exact base/head and semantic edits or unavailable content never receive a waiver', async () => {
  const p = { ...policy, mechanical_paths: [...policy.mechanical_paths, 'scripts/version.mjs'] };
  const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
  const before = "export const COMPONENT_VERSION='1.0.0';\nexport const budget=1;\n";
  let calls = [];
  const readFileAt = async (file, ref) => { calls.push([file, ref]); return ref === baseSha ? before : before.replace('budget=1', 'budget=0'); };
  const options = { policy: p, baseSha, headSha, changedPaths: ['scripts/version.mjs', 'config/clued-components.json', 'source/a.py'], readFileAt,
    readFileEntryAt: async () => ({ type: 'blob', mode: '100644' }) };
  assert.deepEqual(await computeMechanicalPathsProven(options), []);
  assert.ok(calls.every(([, ref]) => ref === baseSha || ref === headSha));
  calls = [];
  assert.deepEqual(await computeMechanicalPathsProven({ ...options, baseSha: 'main' }), []);
  assert.deepEqual(calls, []);
});
