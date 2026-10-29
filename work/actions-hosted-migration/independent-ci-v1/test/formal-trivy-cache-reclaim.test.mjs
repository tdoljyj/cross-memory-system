// Trivy cache reclaim (resident Task 4aedda54, independent-ci-resident-v1 DESIGN §34): after a confirmed promotion the
// kind's staging copies and every generation of the kind but the current and the previous one are removed; nothing of
// the other kind, nothing of another shape, and never through a link. Temporary directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reclaimCache } from '../worker/formal-trivy-v3/cache.mjs';

const hex = c => c.repeat(64);
async function cacheRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trivy-reclaim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const sub of ['staging', 'generations']) await fs.mkdir(path.join(root, sub));
  const make = async (sub, name) => { await fs.mkdir(path.join(root, sub, name, 'db'), { recursive: true }); await fs.writeFile(path.join(root, sub, name, 'db', 'trivy.db'), 'x'); };
  return { root, make, list: async sub => (await fs.readdir(path.join(root, sub))).sort() };
}

test('a confirmed DB promotion keeps the current and the previous generation and removes every staging copy of the kind', async t => {
  const c = await cacheRoot(t);
  for (const ch of ['1', '2', '3']) { await c.make('staging', `db-${hex(ch)}`); await c.make('generations', `gen-db-${hex(ch)}`); }
  await c.make('staging', `checks-${hex('4')}`); await c.make('generations', `gen-checks-${hex('4')}`);
  await fs.mkdir(path.join(c.root, 'generations', 'unrelated-name')); await fs.mkdir(path.join(c.root, 'staging', 'db-short'));
  const r = await reclaimCache({ root: c.root, kind: 'db', currentDirectory: path.join(c.root, 'generations', `gen-db-${hex('3')}`),
    previousDirectory: path.join(c.root, 'generations', `gen-db-${hex('2')}`) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, { staging: [`db-${hex('1')}`, `db-${hex('2')}`, `db-${hex('3')}`], generations: [`gen-db-${hex('1')}`] });
  assert.deepEqual(await c.list('generations'), [`gen-checks-${hex('4')}`, `gen-db-${hex('2')}`, `gen-db-${hex('3')}`, 'unrelated-name']);
  assert.deepEqual(await c.list('staging'), [`checks-${hex('4')}`, 'db-short'], 'the other kind and other shapes stay');
});

test('the first promotion (no previous pointer) keeps only the current generation; the checks kind is reclaimed the same way', async t => {
  const c = await cacheRoot(t);
  await c.make('staging', `checks-${hex('a')}`); await c.make('generations', `gen-checks-${hex('a')}`); await c.make('generations', `gen-db-${hex('b')}`);
  const r = await reclaimCache({ root: c.root, kind: 'checks', currentDirectory: path.join(c.root, 'generations', `gen-checks-${hex('a')}`) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, [`gen-checks-${hex('a')}`]);
  assert.deepEqual(await c.list('generations'), [`gen-checks-${hex('a')}`, `gen-db-${hex('b')}`]);
  assert.deepEqual(await c.list('staging'), []);
});

test('links are removed as links, never followed; a failed removal is reported and does not stop the others', async t => {
  const c = await cacheRoot(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'trivy-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'keep.txt'), 'outside');
  await c.make('staging', `db-${hex('1')}`);
  await fs.symlink(outside, path.join(c.root, 'staging', `db-${hex('1')}`, 'escape'), 'junction');
  await c.make('generations', `gen-db-${hex('1')}`); await c.make('generations', `gen-db-${hex('2')}`); await c.make('generations', `gen-db-${hex('3')}`);
  const r = await reclaimCache({ root: c.root, kind: 'db', currentDirectory: path.join(c.root, 'generations', `gen-db-${hex('3')}`),
    previousDirectory: path.join(c.root, 'generations', `gen-db-${hex('2')}`) });
  assert.equal(r.ok, true);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside', 'the link target is untouched');
  // A generation that cannot be removed is reported; the staging copies still go.
  await c.make('staging', `db-${hex('5')}`); await c.make('generations', `gen-db-${hex('4')}`);
  const failing = await reclaimCache({ root: c.root, kind: 'db', currentDirectory: path.join(c.root, 'generations', `gen-db-${hex('3')}`),
    previousDirectory: path.join(c.root, 'generations', `gen-db-${hex('2')}`),
    removeTree: async dir => { if (dir.includes('gen-db-')) throw Object.assign(new Error('x'), { code: 'EACCES' }); await fs.rm(dir, { recursive: true }); } });
  assert.equal(failing.ok, false);
  assert.deepEqual(failing.failed, [{ name: `gen-db-${hex('4')}`, code: 'EACCES' }]);
  assert.deepEqual(failing.removed.staging, [`db-${hex('5')}`]);
});

test('out-of-scope directories are refused before anything is removed', async t => {
  const c = await cacheRoot(t);
  await c.make('generations', `gen-db-${hex('1')}`);
  await assert.rejects(reclaimCache({ root: c.root, kind: 'db', currentDirectory: path.join(c.root, 'staging', `db-${hex('1')}`) }), { code: 'CACHE_RECLAIM_SCOPE' });
  await assert.rejects(reclaimCache({ root: c.root, kind: 'db', currentDirectory: path.join(c.root, 'generations', `gen-checks-${hex('1')}`) }), { code: 'CACHE_RECLAIM_SCOPE' });
  await assert.rejects(reclaimCache({ root: c.root, kind: 'policy', currentDirectory: path.join(c.root, 'generations', `gen-db-${hex('1')}`) }), { code: 'CACHE_RECLAIM_SCOPE' });
  assert.deepEqual(await c.list('generations'), [`gen-db-${hex('1')}`]);
});

test('promote() reclaims only after the pointer readback (source order)', async () => {
  const text = await fs.readFile(new URL('../worker/formal-trivy-v3/cache.mjs', import.meta.url), 'utf8');
  const activate = text.indexOf('const after = await activatePointer('), reclaim = text.indexOf('await reclaimCache({ root, kind, currentDirectory: directory');
  assert.ok(activate > 0 && reclaim > activate, 'reclaim follows the confirmed activation');
  assert.match(text, /previousDirectory: originalPointer\.value\?\.directory \?\? null/);
});
