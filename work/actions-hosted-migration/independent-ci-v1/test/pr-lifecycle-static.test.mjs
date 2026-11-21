// FABLE 11-19 §4.1 (10): a PR binding ends only on a GitHub fact (webhook, the resident's lifecycle report, adopt). Giving back a
// merge slot carries no end: no caller passes the old end flag to clued_work_merge_slot_return_v1, and stage 10 never ends a
// closed PR through returnSlot (the closed front is reported closed, and its slot given back, by two separate calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE_ROOTS = ['scripts', 'work', 'apps/clued-cloud/worker', 'apps/clued-cloud/app', 'apps/clued-cloud/scripts', 'kernel', '.github'];
const CODE = /\.(mjs|cjs|js|ts|tsx|ps1|psm1|py|yml|yaml)$/;
const SKIP_DIR = new Set(['node_modules', 'test', 'tests', 'dist', '.git', 'generated']);
const OLD_FLAG = ['github', 'state'].join('_');

function* codeFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) yield* codeFiles(p); }
    else if (CODE.test(e.name) && !/\.test\.(mjs|js|ts|py)$|^test_.*\.py$/.test(e.name)) yield p;
  }
}

test('no caller passes the end flag to the merge-slot return', () => {
  const hits = [];
  for (const root of SOURCE_ROOTS) for (const file of codeFiles(path.join(ROOT, root)))
    if (fs.readFileSync(file, 'utf8').includes(OLD_FLAG)) hits.push(path.relative(ROOT, file).replaceAll('\\', '/'));
  assert.deepEqual(hits, []);
});

test('stage 10 ends no closed PR through returnSlot; the closed front is reported and its slot given back separately', () => {
  const file = path.join(ROOT, 'work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-maintenance.mjs');
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.includes('endedBound'), false, 'the bound-PR end loop is replaced by the lifecycle reconcile');
  const returns = [...source.matchAll(/native\.returnSlot\(/g)];
  assert.equal(returns.length, 1, 'one returnSlot: the closed front');
  const branch = source.slice(source.indexOf("front.state === 'closed'"), returns[0].index);
  assert.match(branch, /reportLifecycle\(/, 'the closed front is reported closed before its slot is given back');
});
