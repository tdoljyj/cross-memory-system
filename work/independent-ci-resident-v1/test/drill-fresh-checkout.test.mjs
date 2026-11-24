// A drill from a fresh worktree (task 87d330d0, design FABLE-drill-sync-deps-20261124 §4.1, §5): the host makes a detached
// worktree, installs nothing, and runs the steps before the boot from it. Twice (drills r10, r11) that stopped at the sync with
// DRILL_SERVER_SYNC_TOOL_MISSING: the sync script needed apps/clued-cloud/node_modules. What the host runs before a boot may import
// only node: modules and files the repository tracks.
//
// The fresh worktree here is a copy of the tracked files of apps/clued-cloud, work and scripts/ci (byte for byte, uncommitted edits
// included; not git worktree add, which writes the shared .git and holds only HEAD). scripts/ci: drill-server-check.mjs reaches
// scripts/ci/clued-merge-train-native.mjs through work/actions-hosted-migration. A tracked file missing here can only make a test
// fail, never pass: add its directory to COPIED. The real Sync-DrillServer of the copy's drill-vm.ps1
// runs the copy's own sync script with a fixture password; production's list is this test's file (GitHub is not this test's
// business) and the copy's drill-server.json names no pooler host, so the script stops there: after its client is loaded, before
// the password is read or anything is connected to.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ps, q, tmp } from './drill-vm-fixtures.mjs';

const windows = process.platform === 'win32';
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const DB_USER = 'postgres.uscrdifznmlvczcekqpw';
const DB_PASSWORD = `fixture-${crypto.randomBytes(12).toString('hex')}`;
// The node entries of the steps before a boot: the five of a drill run (universal.mjs build, publish.mjs prepare, make-drill-kit.mjs
// twice, drill-vm.ps1) and the scripts drill-vm.ps1 runs on the host before it (Invoke-Drill*Node).
const ENTRIES = ['work/independent-ci-resident-v1/rollout/fleet/universal.mjs', 'work/independent-ci-resident-v1/rollout/fleet/publish.mjs',
  'work/independent-ci-resident-v1/drill/make-drill-kit.mjs', 'work/independent-ci-resident-v1/drill/drill-server-check.mjs',
  'apps/clued-cloud/scripts/drill-test-sync.mjs'];

const COPIED = ['apps/clued-cloud', 'work', 'scripts/ci'];

let fresh = null;
function freshCheckout() {
  if (fresh !== null) return fresh;
  const root = path.join(tmp, 'fresh');
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...COPIED], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr);
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const from = path.join(repository, file);
    if (!fs.existsSync(from)) continue; // deleted in the working tree: a fresh checkout of it would not have it either
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(from, path.join(root, file));
  }
  // Only tracked files: no node_modules in the copy, and none with pg above it (Node looks upward: one there would make this pass
  // here and the drill host fail).
  const inside = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') inside.push(path.join(dir, entry.name)); else walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  assert.deepEqual(inside, [], 'the copy holds only tracked files');
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'pg')), false,
      `${path.join(dir, 'node_modules', 'pg')} is above the copy: Node would find it; run with TEMP somewhere without one`);
    if (path.dirname(dir) === dir) break;
  }
  // The committed drill-server.json names the real pooler: the copy's names none, so nothing is connected to.
  const serverFile = path.join(root, 'work', 'independent-ci-resident-v1', 'drill', 'drill-server.json');
  const server = JSON.parse(fs.readFileSync(serverFile, 'utf8').replace(/^﻿/, ''));
  fs.writeFileSync(serverFile, JSON.stringify({ ...server, poolerHost: null }, null, 2) + '\n');
  fresh = root;
  return root;
}

// This test's own Release directory with its first-install kit, production's list and a fixture database credential.
function syncWorld() {
  const root = path.join(tmp, 'fresh-sync-world'), from = path.join(root, 'from'); fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'fleet-node-1.2.3.first-install-kit.json'),
    JSON.stringify({ record: { scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f', repository: 'tdoljyj/cross-memory-system' } }));
  const applied = path.join(root, 'production-applied.json');
  fs.writeFileSync(applied, JSON.stringify({ contract: 'clued.production-applied.v1', source_commit: 'c'.repeat(40), run_id: '9001',
    applied: [{ version: '20260101000000', name: 'first', statements_md5: '0'.repeat(32) }, { version: '20261124140000', name: 'context_archive_structure_v1', statements_md5: '1'.repeat(32) }] }) + '\n');
  const credFile = path.join(root, 'server-database.clixml');
  const credential = `(New-Object System.Management.Automation.PSCredential ${q(DB_USER)}, (ConvertTo-SecureString ${q(DB_PASSWORD)} -AsPlainText -Force))`;
  return { from, applied, credFile, credential };
}

test('a fresh worktree syncs before the boot with nothing installed: its own sync script loads its client and stops only at the pooler host', { skip: !windows }, () => {
  const root = freshCheckout();
  const w = syncWorld();
  // The copy's drill-vm.ps1, dot-sourced again: $script:DrillScriptPath is the copy's, and the real Sync-DrillServer is back.
  // $script:Drill.SyncTool is not set: the host takes the checkout's own script.
  const r = ps(`. ${q(path.join(root, 'work', 'independent-ci-resident-v1', 'drill', 'drill-vm.ps1'))}
    $script:Drill.ServerDatabaseCredential = ${q(w.credFile)}
    if (-not (Test-Path -LiteralPath ${q(w.credFile)})) { ${w.credential} | Export-Clixml -LiteralPath ${q(w.credFile)} }
    function Invoke-DrillProductionListNode([string]$Node) { @{ exit = 0; stdout = ${q(JSON.stringify({ run: 9001, file: w.applied, cached: false }))}; stderr = '' } }
    $c = $null; $d = $null; $m = $null
    try { Sync-DrillServer ${q(w.from)} '1.2.3' | Out-Null } catch { $x = Get-DrillCode $_; $c = $x.code; $d = [string]$x.detail; $m = [string]$_.Exception.Message }
    [ordered]@{ tool = Get-DrillSyncTool; code = $c; detail = $d; message = $m }`);
  assert.ok(path.resolve(r.tool).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep), `the copy's own sync script: ${r.tool}`);
  assert.deepEqual({ code: r.code, detail: r.detail }, { code: 'DRILL_SERVER_POOLER_HOST_NOT_SET', detail: '' }, r.message);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(DB_PASSWORD));
});

test('every node entry before a boot loads from the tracked files alone', { skip: !windows }, () => {
  const root = freshCheckout();
  for (const entry of ENTRIES) {
    const file = path.join(root, entry);
    assert.ok(fs.existsSync(file), entry);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)});`],
      { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    assert.equal(run.status, 0, `${entry}: ${run.stderr}`);
  }
});
