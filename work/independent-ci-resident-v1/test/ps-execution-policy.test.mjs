// D2' of the first-install r5 design (D:/w/tmp/FABLE-first-install-r5-20261121.md sections 1.2 and 2): a freshly installed Windows machine has
// the execution policy Restricted, and the resident service starts node with only SystemRoot, WINDIR and PATH (ResidentServiceHost.cs), so
// nothing is inherited. One rule: every PowerShell the package starts says "-ExecutionPolicy Bypass" itself. The Node side has one door
// (src/powershell-argv.mjs); the rule is held for every language by one scan of the files the package carries (selectTree).
//   1. the real argv of the engine's Windows archive and of the companion's relay / bundle calls, spawned with exactly the service's
//      environment, run the probe script under Bypass (before: the machine's policy, RemoteSigned on DESK and on the CI nodes);
//   2. the other Node argv builders carry the same four leading options;
//   3. the scan: any line of the package that holds -NoProfile holds -ExecutionPolicy and Bypass; the exceptions are a constant.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { argv as companionArgv } from '../src/companion.mjs';
import { WindowsEngine } from '../src/engine-windows.mjs';
import { toastArgv } from '../src/pr-status.mjs';
import { taskFactsArgv } from '../src/notifier-main.mjs';
import { readWin32Process } from '../src/resident-lock.mjs';
import { machineWslValidationArgv } from '../src/wsl-client.mjs';
import * as U from '../rollout/fleet/universal.mjs';
import { CLOSURE } from '../rollout/fleet/facts.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = path.resolve(RES, '..', '..');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows = process.platform === 'win32';
const PREFIX = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// What ResidentServiceHost.cs gives the node it starts, and so what node gives a child that passes nothing on: three variables.
const serviceEnv = () => ({ SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR ?? process.env.SystemRoot, PATH: process.env.PATH });
function spawnLikeService(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { env: serviceEnv(), encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const POLICY_PROBE = 'param([string]$Mode, [string]$Sequence, [string]$ExpectedBundleSha256, [string]$ExpectedNodeProfileSha256, [string]$BatchId,\n'
  + '  [string]$BatchKey, [string]$Reason, [switch]$CheckRefs, [switch]$Rebundle)\n'
  + '$p = [string](Get-ExecutionPolicy)\n'
  + "[ordered]@{ verified = $false; directory = $null; moved = $null; code = 'PROBE'; scope = $null; policy = $p } | ConvertTo-Json -Compress\n";
const policyOf = text => JSON.parse(text.trim()).policy;

test('D2-prime: the engine\'s Windows archive runs its tool under Bypass with only the service\'s environment', { skip: !windows }, async t => {
  const root = await tempRoot(t);
  const KEY = 'a1'.repeat(32);
  const sourceRoot = path.join(root, 'source', 'e'.repeat(64));
  const v2 = path.join(sourceRoot, 'work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2');
  await fsp.mkdir(v2, { recursive: true });
  await fsp.writeFile(path.join(v2, 'archive-windows-spool.ps1'), POLICY_PROBE);
  const answers = [];
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, busy: () => false, sleep: async () => {}, clock: () => Date.parse('2026-11-21T08:00:00Z'),
    companionMailbox: { async send() { return {}; }, async await() { return {}; } },
    run: async argv => { const r = spawnLikeService(argv); answers.push(r); return r; },
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe', powershellExe: POWERSHELL, scExe: 'C:\\Windows\\System32\\sc.exe' } });
  await engine.archiveWindows({ key: KEY, batchId: `${KEY.slice(0, 16)}-${'0'.repeat(12)}` }, 'success-close');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].code, 0, answers[0].stderr);
  assert.equal(policyOf(answers[0].stdout), 'Bypass');
});

test('D2-prime: the companion\'s relay and bundle calls run their scripts under Bypass with only the service\'s environment', { skip: !windows }, async t => {
  const root = await tempRoot(t);
  const probe = path.join(root, 'probe.ps1');
  await fsp.writeFile(probe, POLICY_PROBE);
  const cfg = { powershellExe: POWERSHELL, relayScript: probe, bundleScript: probe, wslExe: 'C:\\Windows\\System32\\wsl.exe', distribution: 'Ubuntu-24.04',
    bridgeManifestSha256: '9'.repeat(64), nodeProfileSha256: TEST_NODE_SHA, linuxTool: '/opt/x' };
  const a = companionArgv(cfg);
  const BATCH = '0123456789abcdef-0123456789ab';
  const calls = { relay: a.relay('SendIssue', 0), bundle: a.bundle(BATCH), checkRefs: a.checkRefs(BATCH), rebundle: a.rebundle(BATCH) };
  for (const [name, argv] of Object.entries(calls)) {
    const r = spawnLikeService(argv);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.equal(policyOf(r.stdout), 'Bypass', name);
  }
});

test('D2-prime: every other Node builder of a PowerShell argv carries the four leading options', async () => {
  const lead = argv => assert.deepEqual(argv.slice(1, 5), PREFIX, argv[0]);
  lead(toastArgv(POWERSHELL, 'title', 'body'));
  lead(taskFactsArgv());
  lead(machineWslValidationArgv('C:\\helper.ps1'));
  let seen = null;
  await readWin32Process(4242, { run: async (file, args) => { seen = [file, ...args]; return ''; } });
  assert.ok(seen, 'readWin32Process asked PowerShell');
  lead(seen);
});

test('D2-prime: the one door is a module of the resident, and the four options are written once', async () => {
  const door = await import('../src/powershell-argv.mjs');
  assert.deepEqual([...door.POWERSHELL_PREFIX], PREFIX);
  assert.deepEqual(door.powershellArgv(POWERSHELL, '-File', 'x.ps1'), [POWERSHELL, ...PREFIX, '-File', 'x.ps1']);
  assert.deepEqual(door.powershellArgs('-Command', 'x'), [...PREFIX, '-Command', 'x']);
});

// ---- the scan -----------------------------------------------------------------------------------------------------------------------

// A line that starts PowerShell without the policy: it holds -NoProfile but not both -ExecutionPolicy and Bypass.
const unguardedLines = text => text.split(/\r?\n/).map((line, i) => [i + 1, line]).filter(([, l]) => l.includes('-NoProfile') && !(l.includes('-ExecutionPolicy') && l.includes('Bypass')));

// The exceptions. A file is listed with the number of such lines it holds today and why it may. Two kinds only:
//  - SOURCE: a file of the accepted Source closure (source-closure.json); its bytes are pinned by ciSourceManifestSha256, the package cannot change one.
//  - TEXT: a line that talks about the option and starts nothing.
// A listed file with another count, or one that no longer needs its entry, is red: the set cannot go stale.
const SOURCE = 'the file is in source-closure.json: pinned by ciSourceManifestSha256, a change needs a new Source acceptance (open point for the design owner)';
const A = 'work/actions-hosted-migration/independent-ci-v1';
const EXCEPTIONS = Object.freeze({
  'scripts/ci/clued-independent-supervisor.mjs': { count: 1, kind: 'SOURCE', reason: SOURCE },
  [`${A}/runtime/protected-files.mjs`]: { count: 2, kind: 'SOURCE', reason: SOURCE },
  [`${A}/src/independent-control-checks-v1/publisher.mjs`]: { count: 1, kind: 'SOURCE', reason: SOURCE },
  [`${A}/src/resident-v2/archive-windows-spool.ps1`]: { count: 1, kind: 'SOURCE', reason: SOURCE },
  [`${A}/src/resident-v2/held-record.mjs`]: { count: 1, kind: 'SOURCE', reason: SOURCE },
  [`${A}/worker/protected-job-bridge-v2/held-source.mjs`]: { count: 1, kind: 'SOURCE', reason: SOURCE },
  [`${A}/worker/protected-job-bridge-v2/mailbox.mjs`]: { count: 2, kind: 'SOURCE', reason: SOURCE },
  [`${A}/worker/protected-job-bridge-v4/mailbox.mjs`]: { count: 1, kind: 'SOURCE', reason: SOURCE },
  [`${A}/worker/protected-job-bridge-v4/relay-public.ps1`]: { count: 1, kind: 'SOURCE', reason: SOURCE },
  'work/independent-ci-resident-v1/windows/test-first-install-host.ps1': { count: 1, kind: 'TEXT',
    reason: 'a pattern the test matches against first-install-host.ps1\'s text (the one in front of -NoProfile); it starts nothing' },
});

function realTree() {
  const out = spawnSync('git', ['-C', CHECKOUT, 'ls-files', '-s', '-z'], { maxBuffer: 1 << 28 });
  assert.equal(out.status, 0, String(out.stderr));
  const listing = new Map();
  for (const rec of out.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [mode, oid] = rec.slice(0, tab).split(' ');
    listing.set(rec.slice(tab + 1), { mode, oid });
  }
  const read = async paths => new Map(await Promise.all(paths.map(async p => [p, await fsp.readFile(path.join(CHECKOUT, ...p.split('/')))])));
  return { listing, read };
}

test('D2 rule: the scan sees a line without the policy and passes the guarded forms (the counter-example)', () => {
  assert.deepEqual(unguardedLines('a\n$a = @(\'-NoProfile\', \'-NonInteractive\', \'-File\', $x)\nb').map(([n]) => n), [2]);
  assert.deepEqual(unguardedLines('powershell.exe -NoProfile -File x.ps1 -Check').map(([n]) => n), [1]);
  assert.deepEqual(unguardedLines('powershell.exe -NoProfile -ExecutionPolicy Bypass -File x.ps1').map(([n]) => n), []);
  assert.deepEqual(unguardedLines('["-NoProfile", "-ExecutionPolicy"]').map(([n]) => n), [1], 'the option without Bypass is no guard');
  assert.deepEqual(unguardedLines('x\r\n-NoProfile\r\n').map(([n]) => n), [2], 'CRLF');
});

test('D2 rule: every PowerShell the package starts or prints names -ExecutionPolicy Bypass; the exceptions are exactly the listed ones', async () => {
  const { listing, read } = realTree();
  const selected = await U.selectTree(listing, read);
  const closure = new Set(JSON.parse((await read([CLOSURE])).get(CLOSURE).toString('utf8')).paths);
  const found = new Map();
  for (const [p, bytes] of await read(selected)) {
    if (bytes.includes(0)) continue;   // a binary file
    const lines = unguardedLines(bytes.toString('utf8'));
    if (lines.length) found.set(p, lines);
  }
  const unlisted = [...found].filter(([p]) => !(p in EXCEPTIONS)).map(([p, ls]) => ls.map(([n, l]) => `${p}:${n}: ${l.trim().slice(0, 120)}`)).flat();
  assert.deepEqual(unlisted, [], 'lines that start or print PowerShell without -ExecutionPolicy Bypass');
  for (const [p, e] of Object.entries(EXCEPTIONS)) {
    assert.equal(found.get(p)?.length ?? 0, e.count, `${p}: the exception is for exactly ${e.count} line(s)`);
    if (e.kind === 'SOURCE') assert.ok(closure.has(p), `${p} is in the Source closure`);
    assert.ok(e.reason.length > 20, `${p} says why`);
  }
});

test('D2 rule: the scan reads the files selectTree selects, and the package carries the Node door', async () => {
  const { listing, read } = realTree();
  const selected = await U.selectTree(listing, read);
  const R = 'work/independent-ci-resident-v1';
  for (const p of [`${R}/src/engine-windows.mjs`, `${R}/src/companion.mjs`, `${R}/src/powershell-argv.mjs`, `${R}/windows/companion-gh-login.ps1`, `${R}/rollout/fleet/install.mjs`])
    assert.ok(selected.includes(p), p);
  assert.ok(fs.existsSync(path.join(RES, 'src', 'powershell-argv.mjs')));
});
