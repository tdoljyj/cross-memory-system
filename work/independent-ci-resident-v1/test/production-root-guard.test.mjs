// Layer B of the 11-19 ruling (Clued Task fe8a2cbf; "补：测试守卫判据"): under a test marker the request writers of rearm-tool.mjs
// write only inside the temporary directory, judged by file system identity; anything they cannot place there is refused.
// Every run here goes to the REPOSITORY copy of the tool. "Outside the temporary directory" is a scratch folder made in this
// working tree (and removed after); the production root is never named, opened or resolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// The guard as a namespace: a name a fix adds fails only the test that uses it.
import * as guard from '../src/production-root-guard.mjs';
import { tempRoot } from './helpers.mjs';

const { REFUSED_UNDER_TEST, TEST_MARKERS, underTest } = guard;
const TOOL = fileURLToPath(new URL('../tools/rearm-tool.mjs', import.meta.url));
const HERE = fileURLToPath(new URL('..', import.meta.url));
const SID = 'S-1-5-21-1-2-3-1001';
const HEX = 'a'.repeat(64);
const REFUSED = { code: 1, out: { status: 'REFUSED', code: 'REFUSED_UNDER_TEST' } };
const windows = process.platform === 'win32';

// Every mode the tool dispatches, read from its source, so a mode added later is covered without editing this list.
async function toolModes() {
  const text = await fs.readFile(TOOL, 'utf8');
  return [...new Set([...text.matchAll(/positionals\[0\] === '([a-z-]+)'/g)].map(m => m[1]))];
}
// Arguments that let each mode write (so before the guard a run really writes into the scratch folder).
const ARGS = ['--reason', 'guard test', '--by', SID, '--expected-halt-sha256', HEX, '--expected-paused-sha256', HEX,
  '--batch-key', HEX, '--expected-ledger-entry-sha256', HEX, '--ref', 'guard-test'];

// A resident-shaped root: the request folders the modes write into, and what inspect reads.
async function residentRoot(parent) {
  const root = path.join(parent, 'resident');
  for (const d of ['requests', 'owner', path.join('owner', 'train-review')]) await fs.mkdir(path.join(root, d), { recursive: true });
  for (const d of ['ledger', 'ledger-heads', 'ledger-unexecuted', 'ledger-flow-ends', 'halts', 'ledger-attempt2', 'receipts']) await fs.mkdir(path.join(root, 'state', d), { recursive: true });
  return root;
}
async function countFiles(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1;
  return n;
}
// A scratch folder in this working tree, outside the temporary directory (the test skips if the tree itself lies inside it).
async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(HERE, '.guard-scratch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tmp = await fs.realpath(os.tmpdir()), real = await fs.realpath(dir);
  const inside = path.relative(tmp, real);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) { t.skip('this working tree lies inside the temporary directory'); return null; }
  return dir;
}
// env: the markers given and nothing else of them (the inherited NODE_TEST_CONTEXT is removed unless named).
function envWith(markers) {
  const env = { ...process.env };
  for (const m of TEST_MARKERS) delete env[m];
  return Object.assign(env, markers);
}
async function run(env, ...args) {
  try { const r = await promisify(execFile)(process.execPath, [TOOL, ...args], { env }); return { code: 0, out: JSON.parse(r.stdout) }; }
  catch (e) { return { code: e.code, out: JSON.parse(e.stdout) }; }
}
const shortName = p => {
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const s = r.status === 0 ? r.stdout.trim() : '';
  return s && s.toLowerCase() !== p.toLowerCase() ? s : null;
};

test('inside the temporary directory a marked run writes as before', async t => {
  const root = await residentRoot(await tempRoot(t, 'clued-guard-tmp-'));
  for (const markers of [{ NODE_TEST_CONTEXT: 'child-v8' }, { CLUED_UNDER_TEST: '1' }]) {
    const r = await run(envWith(markers), 'request-intake-pause', '--root', root, '--reason', 'r');
    assert.equal(r.out.status, 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES', JSON.stringify(markers));
  }
  assert.equal((await fs.readdir(path.join(root, 'requests'))).length, 2);
});

test('outside the temporary directory every writing mode refuses under either marker and writes nothing; inspect still reads', async t => {
  const dir = await scratch(t); if (!dir) return;
  const root = await residentRoot(dir);
  const modes = await toolModes();
  assert.ok(modes.includes('request-intake-pause') && modes.includes('mark-train-shadow-reviewed') && modes.length >= 11, modes.join(','));
  // the incident's own command first
  for (const markers of [{ NODE_TEST_CONTEXT: 'child-v8' }, { CLUED_UNDER_TEST: '1' }]) {
    assert.deepEqual(await run(envWith(markers), 'request-intake-pause', '--root', root, '--holder', 'drill', '--reason', 'first-install drill', '--minutes', '120'), REFUSED);
  }
  const env = envWith({ CLUED_UNDER_TEST: '1' });
  for (const mode of modes.filter(m => m !== 'inspect')) {
    assert.deepEqual(await run(env, mode, '--root', root, ...ARGS), REFUSED, mode);
    assert.deepEqual(await run(env, mode, '--root', root), REFUSED, `${mode} bare: the guard comes before any other check`);
  }
  const inspected = await run(env, 'inspect', '--root', root);
  assert.equal(inspected.code, 0, `inspect writes nothing and is not guarded: ${JSON.stringify(inspected.out)}`);
  assert.equal(await countFiles(dir), 0, 'nothing was written outside the temporary directory');
});

test('a junction in the temporary directory that leads outside it is refused, as --root and as a write folder', { skip: !windows && 'junctions are Windows only' }, async t => {
  const dir = await scratch(t); if (!dir) return;
  const live = await residentRoot(dir);
  const tmp = await tempRoot(t, 'clued-guard-tmp-');
  const env = envWith({ NODE_TEST_CONTEXT: 'child-v8' });
  // --root itself is the junction
  await fs.symlink(live, path.join(tmp, 'via-junction'), 'junction');
  assert.deepEqual(await run(env, 'request-intake-pause', '--root', path.join(tmp, 'via-junction'), '--reason', 'r'), REFUSED);
  // --root is a real folder in the temporary directory; the folders the modes write into are junctions out of it
  const fixture = path.join(tmp, 'resident');
  await fs.mkdir(path.join(fixture, 'state'), { recursive: true });
  await fs.symlink(path.join(live, 'requests'), path.join(fixture, 'requests'), 'junction');
  await fs.symlink(path.join(live, 'owner'), path.join(fixture, 'owner'), 'junction');
  for (const mode of (await toolModes()).filter(m => m !== 'inspect')) {
    assert.deepEqual(await run(env, mode, '--root', fixture, ...ARGS), REFUSED, mode);
  }
  assert.equal(await countFiles(dir), 0, 'nothing reached the scratch folder through the junctions');
});

test('other spellings of a folder outside: device prefixes, UNC, 8.3 name: all refused', { skip: !windows && 'Windows paths' }, async t => {
  const dir = await scratch(t); if (!dir) return;
  const root = await residentRoot(dir);
  const env = envWith({ CLUED_UNDER_TEST: '1' });
  const spellings = [`\\\\?\\${root}`, `\\\\.\\${root}`];
  const unc = `\\\\localhost\\${root[0]}$${root.slice(2)}`;
  try { await fs.access(unc); spellings.push(unc); } catch { t.diagnostic(`UNC case skipped: ${unc} is not reachable on this machine (no administrative share)`); }
  const short = shortName(dir);
  if (short) spellings.push(path.join(short, 'resident')); else t.diagnostic('8.3 case skipped: this volume gives no short names');
  for (const r of spellings) assert.deepEqual(await run(env, 'request-intake-pause', '--root', r, '--reason', 'r'), REFUSED, r);
  assert.equal(await countFiles(dir), 0);
});

test('the temporary directory in another spelling (device prefix, 8.3 name) is still inside: the judgment does not read text', { skip: !windows && 'Windows paths' }, async t => {
  const parent = await tempRoot(t, 'clued-guard-long-name-tmp-');
  const root = await residentRoot(parent);
  const env = envWith({ CLUED_UNDER_TEST: '1' });
  const spellings = [`\\\\?\\${root}`];
  const short = shortName(parent);
  if (short) spellings.push(path.join(short, 'resident')); else t.diagnostic('8.3 case skipped: this volume gives no short names');
  for (const r of spellings) assert.equal((await run(env, 'request-intake-pause', '--root', r, '--reason', 'r')).out.status, 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES', r);
  assert.equal((await fs.readdir(path.join(root, 'requests'))).length, spellings.length);
});

test('without a marker a folder outside is written as before', async t => {
  const dir = await scratch(t); if (!dir) return;
  const root = await residentRoot(dir);
  const r = await run(envWith({}), 'request-intake-resume', '--root', root, '--reason', 'r', '--holder', 'drill');
  assert.equal(r.out.status, 'INTAKE_RESUME_REQUESTED');
  assert.equal((await fs.readdir(path.join(root, 'requests'))).length, 1);
});

// The judgment itself on stubs: what it asks the file system, and that every failure refuses.
test('the judgment: no marker touches nothing; under a marker any failure to resolve or identify refuses', () => {
  const { writableUnderTest } = guard;
  assert.equal(underTest({}), false);
  assert.equal(underTest({ NODE_TEST_CONTEXT: '' }), false);
  assert.equal(underTest({ NODE_TEST_CONTEXT: 'child' }), true);
  assert.equal(underTest({ CLUED_UNDER_TEST: '1' }), true);
  const calls = [];
  const err = code => Object.assign(new Error(code), { code });
  // A file system of stubs: realpath maps through `links`, stat gives each real folder an identity from `ids`.
  const fsStub = ({ links = {}, ids = {}, realFail = null, statFail = null }) => ({
    realpath: p => { calls.push(['realpath', p]); if (realFail) throw err(realFail); if (p in links) return links[p]; if (p in ids) return p; throw err('ENOENT'); },
    stat: p => { calls.push(['stat', p]); if (statFail) throw err(statFail); if (!(p in ids)) throw err('ENOENT'); return { dev: ids[p][0], ino: ids[p][1] }; },
  });
  // Absolute on this platform: Z:\T on Windows, /T elsewhere (Z: need not exist: every access goes to the stubs).
  const R = s => (windows ? `Z:${s.split('/').join('\\')}` : s);
  const base = { [R('/T')]: [1n, 10n], [R('/T/fixture')]: [1n, 11n], [R('/W')]: [1n, 20n], [R('/W/scratch')]: [1n, 21n], [R('/')]: [1n, 1n] };
  const opts = (stub, env = { CLUED_UNDER_TEST: '1' }) => ({ env, tmpdir: () => R('/T'), ...stub });
  // no marker: true, and nothing asked
  calls.length = 0;
  assert.equal(writableUnderTest(R('/W/scratch'), opts(fsStub({ ids: base }), {})), true);
  assert.deepEqual(calls, []);
  // inside, also below a folder that does not exist yet
  assert.equal(writableUnderTest(R('/T/fixture/requests'), opts(fsStub({ ids: base }))), true);
  // outside
  assert.equal(writableUnderTest(R('/W/scratch/requests'), opts(fsStub({ ids: base }))), false);
  // a link inside the temporary directory that resolves outside
  assert.equal(writableUnderTest(R('/T/link/requests'), opts(fsStub({ ids: base, links: { [R('/T/link')]: R('/W/scratch') } }))), false);
  // the same folder under another name is the same identity (no text is compared)
  assert.equal(writableUnderTest(R('/X/alias'), opts(fsStub({ ids: { ...base, [R('/X/alias')]: [1n, 10n], [R('/X')]: [1n, 30n] } }))), true);
  // failures: resolution other than "not there", identity, a zero identity, nothing resolvable at all
  assert.equal(writableUnderTest(R('/T/fixture'), opts(fsStub({ ids: base, realFail: 'EACCES' }))), false);
  assert.equal(writableUnderTest(R('/T/fixture'), opts(fsStub({ ids: base, statFail: 'EPERM' }))), false);
  assert.equal(writableUnderTest(R('/T/fixture'), opts(fsStub({ ids: { ...base, [R('/T/fixture')]: [1n, 0n], [R('/T')]: [1n, 0n] } }))), false);
  assert.equal(writableUnderTest(R('/T/fixture'), opts({ realpath: () => { throw err('ENOENT'); }, stat: () => { throw err('ENOENT'); } })), false);
  assert.equal(writableUnderTest('relative', opts(fsStub({ ids: base }))), false);
  assert.throws(() => guard.refuseUnderTest(R('/W/scratch'), opts(fsStub({ ids: base }))), e => e.code === REFUSED_UNDER_TEST);
});

// windows/request-upgrade.ps1 (ruling 11-19, "补：PR-丁 余项"): its root is always the production root, so it refuses on a marker alone.
// The script is NEVER run whole here (before the guard its -Cancel branch writes into the live upgrade\inbox): it is only parsed, and
// the guard's own definitions, taken out by the syntax tree, are the only code executed.
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const REQUEST_UPGRADE = fileURLToPath(new URL('../windows/request-upgrade.ps1', import.meta.url));
const psq = s => `'${String(s).replace(/'/g, "''")}'`;
function powershell(command, env = envWith({})) {
  return spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 120000, env });
}
// The top-level statements of the script in order, classified from the syntax tree: a function definition, an assignment whose value
// is literal (no command, call, variable or subexpression in it), Set-StrictMode, or anything else (by its text); and the guard's parts.
function requestUpgradeShape() {
  const r = powershell(`$ErrorActionPreference = 'Stop'; $t = $null; $e = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(${psq(REQUEST_UPGRADE)}, [ref]$t, [ref]$e)
    if (@($e).Count) { throw 'PARSE_FAILED' }
    $L = 'Management.Automation.Language.'
    $active = { param($a) $a -is ($L + 'CommandAst') -or $a -is ($L + 'InvokeMemberExpressionAst') -or $a -is ($L + 'VariableExpressionAst') -or $a -is ($L + 'SubExpressionAst') }
    $kinds = @(foreach ($s in $ast.EndBlock.Statements) {
      if ($s -is ($L + 'FunctionDefinitionAst')) { 'function' }
      elseif ($s -is ($L + 'AssignmentStatementAst') -and $null -eq $s.Right.Find($active, $true)) { 'literal' }
      elseif ($s.Extent.Text -ceq 'Set-StrictMode -Version 2.0') { 'strict' }
      else { 'statement:' + $s.Extent.Text.Split([char]10)[0].Trim() } })
    $markers = @($ast.EndBlock.Statements | Where-Object { $_ -is ($L + 'AssignmentStatementAst') -and $_.Left.Extent.Text -ceq '$TestMarkers' } | ForEach-Object {
      $_.Right.FindAll({ param($a) $a -is ($L + 'StringConstantExpressionAst') }, $true) | ForEach-Object { $_.Value } })
    $guard = @($ast.EndBlock.Statements | Where-Object { ($_ -is ($L + 'AssignmentStatementAst') -and $_.Left.Extent.Text -ceq '$TestMarkers') -or
      ($_ -is ($L + 'FunctionDefinitionAst') -and $_.Name -ceq 'Assert-NotUnderTest') } | ForEach-Object { $_.Extent.Text }) -join [char]10
    ConvertTo-Json -Compress -InputObject ([ordered]@{ kinds = $kinds; markers = $markers; guard = $guard })`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}

test('request-upgrade.ps1: the refusal is the first thing its main flow does, before any file is read or written', { skip: process.platform !== 'win32' && 'Windows PowerShell' }, () => {
  const { kinds } = requestUpgradeShape();
  const first = kinds.findIndex(k => k.startsWith('statement:'));
  assert.ok(first > 0, kinds.join(' | '));
  assert.equal(kinds[first], 'statement:Assert-NotUnderTest', `before it only definitions and literal values: ${kinds.slice(0, first + 2).join(' | ')}`);
});

test('request-upgrade.ps1 names exactly the markers production-root-guard.mjs exports', { skip: process.platform !== 'win32' && 'Windows PowerShell' }, () => {
  assert.deepEqual(requestUpgradeShape().markers, [...TEST_MARKERS]);
});

test('request-upgrade.ps1: its guard alone refuses under either marker and lets an unmarked session through', { skip: process.platform !== 'win32' && 'Windows PowerShell' }, () => {
  const { guard } = requestUpgradeShape();
  assert.match(guard, /function Assert-NotUnderTest/);
  const run = markers => {
    const r = powershell(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0
${guard}
try { Assert-NotUnderTest; 'PASSED' } catch { $_.Exception.Message }`, envWith(markers));
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(run({ NODE_TEST_CONTEXT: 'child-v8' }), REFUSED_UNDER_TEST);
  assert.equal(run({ CLUED_UNDER_TEST: '1' }), REFUSED_UNDER_TEST);
  assert.equal(run({}), 'PASSED');
  assert.equal(run({ CLUED_UNDER_TEST: '' }), 'PASSED');
});
