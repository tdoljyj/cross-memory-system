// Layer B of the 11-19 ruling (Clued Task fe8a2cbf): the request modes of rearm-tool.mjs refuse under a test marker when
// their --root is the fixed production root or below it. Every run here goes to the REPOSITORY copy of the tool and to
// temporary directories only: the "fixed root" a CLI run sees is a temporary directory named through
// CLUED_UNDER_TEST_FIXED_ROOT, never C:\ProgramData\CluedIndependentCI (that constant is only compared as a string below).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXTRA_FIXED_ROOT_VARIABLE, FIXED_PRODUCTION_ROOT, REFUSED_UNDER_TEST, TEST_MARKERS, isSameOrBelow, refuseUnderTest, underTest }
  from '../src/production-root-guard.mjs';
import { tempRoot } from './helpers.mjs';

const TOOL = fileURLToPath(new URL('../tools/rearm-tool.mjs', import.meta.url));
const SID = 'S-1-5-21-1-2-3-1001';
const HEX = 'a'.repeat(64);

// Every mode the tool dispatches, read from its source, so a mode added later is covered without editing this list.
async function toolModes() {
  const text = await fs.readFile(TOOL, 'utf8');
  return [...new Set([...text.matchAll(/positionals\[0\] === '([a-z-]+)'/g)].map(m => m[1]))];
}
// Arguments that would let each mode write (so before the guard a run really writes into the fake fixed root).
const ARGS = ['--reason', 'guard test', '--by', SID, '--expected-halt-sha256', HEX, '--expected-paused-sha256', HEX,
  '--batch-key', HEX, '--expected-ledger-entry-sha256', HEX, '--ref', 'guard-test'];

// A resident-shaped root: the request folders the modes write into.
async function residentRoot(parent) {
  const root = path.join(parent, 'resident');
  for (const d of ['requests', 'owner', path.join('owner', 'train-review'), 'state']) await fs.mkdir(path.join(root, d), { recursive: true });
  return root;
}
async function countFiles(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1;
  return n;
}
// env: the markers given and nothing else of them (the inherited NODE_TEST_CONTEXT is removed unless named).
function envWith(markers, extraRoot) {
  const env = { ...process.env };
  for (const m of TEST_MARKERS) delete env[m];
  delete env[EXTRA_FIXED_ROOT_VARIABLE];
  Object.assign(env, markers);
  if (extraRoot) env[EXTRA_FIXED_ROOT_VARIABLE] = extraRoot;
  return env;
}
async function run(env, ...args) {
  try { const r = await promisify(execFile)(process.execPath, [TOOL, ...args], { env }); return { code: 0, out: JSON.parse(r.stdout) }; }
  catch (e) { return { code: e.code, out: JSON.parse(e.stdout) }; }
}

test('the incident path: request-intake-pause under either marker, aimed at the fixed root, refuses and writes nothing', async t => {
  const fixed = await tempRoot(t, 'clued-fixed-root-');
  const root = await residentRoot(fixed);
  for (const markers of [{ NODE_TEST_CONTEXT: 'child-v8' }, { CLUED_UNDER_TEST: '1' }]) {
    const r = await run(envWith(markers, fixed), 'request-intake-pause', '--root', root, '--holder', 'drill', '--reason', 'first-install drill', '--minutes', '120');
    assert.deepEqual(r, { code: 1, out: { status: 'REFUSED', code: REFUSED_UNDER_TEST } }, JSON.stringify(markers));
    assert.equal(await countFiles(fixed), 0, 'no request file was written');
  }
});

test('every writing mode of rearm-tool refuses under a marker at the fixed root, before any other check; inspect still reads', async t => {
  const fixed = await tempRoot(t, 'clued-fixed-root-');
  const root = await residentRoot(fixed);
  const modes = await toolModes();
  assert.ok(modes.includes('request-intake-pause') && modes.includes('mark-train-shadow-reviewed') && modes.length >= 11, modes.join(','));
  const env = envWith({ CLUED_UNDER_TEST: '1' }, fixed);
  for (const mode of modes.filter(m => m !== 'inspect')) {
    assert.deepEqual(await run(env, mode, '--root', root, ...ARGS), { code: 1, out: { status: 'REFUSED', code: REFUSED_UNDER_TEST } }, mode);
    // A mode with missing arguments refuses the same way: the guard comes first.
    assert.deepEqual(await run(env, mode, '--root', root), { code: 1, out: { status: 'REFUSED', code: REFUSED_UNDER_TEST } }, `${mode} bare`);
  }
  assert.equal(await countFiles(fixed), 0, 'no mode wrote a file');
  const inspected = await run(env, 'inspect', '--root', root);
  assert.notEqual(inspected.out.code, REFUSED_UNDER_TEST, 'inspect writes nothing and is not guarded');
});

test('a link into the fixed root counts as the fixed root', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async t => {
  const fixed = await tempRoot(t, 'clued-fixed-root-');
  const root = await residentRoot(fixed);
  const other = await tempRoot(t, 'clued-link-');
  const link = path.join(other, 'via-junction');
  await fs.symlink(root, link, 'junction');
  const r = await run(envWith({ CLUED_UNDER_TEST: '1' }, fixed), 'request-intake-pause', '--root', link, '--reason', 'r');
  assert.deepEqual(r, { code: 1, out: { status: 'REFUSED', code: REFUSED_UNDER_TEST } });
  assert.equal(await countFiles(fixed), 0);
});

test('a fixture root under a marker, and the fixed root without a marker, write as before', async t => {
  const fixture = await residentRoot(await tempRoot(t, 'clued-fixture-root-'));
  const underMarker = await run(envWith({ NODE_TEST_CONTEXT: 'child-v8', CLUED_UNDER_TEST: '1' }), 'request-intake-pause', '--root', fixture, '--reason', 'r');
  assert.equal(underMarker.out.status, 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES');
  assert.equal((await fs.readdir(path.join(fixture, 'requests'))).length, 1);
  // No marker: the extra root alone changes nothing (outside a test the tool behaves exactly as before).
  const fixed = await tempRoot(t, 'clued-fixed-root-');
  const root = await residentRoot(fixed);
  const operator = await run(envWith({}, fixed), 'request-intake-resume', '--root', root, '--reason', 'r', '--holder', 'drill');
  assert.equal(operator.out.status, 'INTAKE_RESUME_REQUESTED');
  assert.equal((await fs.readdir(path.join(root, 'requests'))).length, 1);
});

test('the judgment: markers, the fixed root in its spellings, and what is not below it (strings only, no file system)', () => {
  assert.equal(underTest({}), false);
  assert.equal(underTest({ NODE_TEST_CONTEXT: '' }), false);
  assert.equal(underTest({ NODE_TEST_CONTEXT: 'child' }), true);
  assert.equal(underTest({ CLUED_UNDER_TEST: '1' }), true);
  const w = path.win32;
  for (const p of [FIXED_PRODUCTION_ROOT, 'C:\\ProgramData\\CluedIndependentCI\\', 'c:/programdata/cluedindependentci/resident',
    'C:\\ProgramData\\CluedIndependentCI\\resident\\..\\resident\\requests', '\\\\?\\C:\\ProgramData\\CluedIndependentCI\\resident']) {
    assert.equal(isSameOrBelow(p, FIXED_PRODUCTION_ROOT, w), true, p);
  }
  for (const p of ['C:\\ProgramData\\CluedIndependentCI-fixture', 'C:\\ProgramData', 'D:\\ProgramData\\CluedIndependentCI', 'D:\\agent-temp\\x']) {
    assert.equal(isSameOrBelow(p, FIXED_PRODUCTION_ROOT, w), false, p);
  }
  // Without a marker the judgment never refuses, whatever the target (it does not even look at it).
  assert.doesNotThrow(() => refuseUnderTest(FIXED_PRODUCTION_ROOT, {}));
});
