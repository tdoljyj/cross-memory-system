// The universal package writes the Owner's WSL memory limit (Task 87d330d0, FABLE-drill-memory-short-20261124.md section 3, PR-B'):
// the node's capacity profile in scripts/ci/self-hosted/node-profiles.json (the one source, carried in the package) names memory=,
// rollout/fleet/wsl-capacity.mjs writes it into %USERPROFILE%\.wslconfig [wsl2] and nothing else: every other byte kept, a backup
// first, no WSL, no restart (the new limit takes effect when the Owner's WSL VM next starts). A host it cannot place is skipped,
// never an error. Under a test marker it writes nowhere outside the temporary directory (src/production-root-guard.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { NODE_PROFILES, applyWslCapacity, setWslMemory, wslCapacityOfArchive } from '../rollout/fleet/wsl-capacity.mjs';
import { TREE_FILES } from '../rollout/fleet/universal.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const PROFILES = fs.readFileSync(path.join(REPO, ...NODE_PROFILES.split('/')));
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function home(bytes) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wslcap-'));
  dirs.push(d);
  const file = path.join(d, '.wslconfig');
  if (bytes !== null) fs.writeFileSync(file, bytes);
  return { d, file, others: () => fs.readdirSync(d).filter(n => n !== '.wslconfig') };
}
const NOW = Date.parse('2026-11-24T03:30:00.000Z');

test('DESK (workstation-v1): memory=28GB becomes 17GB; the unrelated [experimental] section and every other byte unchanged; a backup of the old file', () => {
  const old = '[wsl2]\r\nmemory=28GB\r\nprocessors=16\r\nswap=8GB\r\n\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\nsparseVhd=true\r\n';
  const h = home(old);
  const r = applyWslCapacity({ profilesBytes: PROFILES, hostname: 'DESK-W-591', configPath: h.file, now: NOW });
  assert.deepEqual({ status: r.status, from: r.from, to: r.to }, { status: 'written', from: '28GB', to: '17GB' }, JSON.stringify(r));
  assert.equal(fs.readFileSync(h.file, 'utf8'), old.replace('memory=28GB', 'memory=17GB'));
  assert.ok(fs.readFileSync(h.file, 'utf8').endsWith('\r\n\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\nsparseVhd=true\r\n'));
  assert.equal(path.dirname(r.backup), h.d);
  assert.deepEqual(h.others(), [path.basename(r.backup)], 'one backup, no temporary file left');
  assert.equal(fs.readFileSync(r.backup, 'utf8'), old);
});

test('a host name not in the registry: skipped, the file untouched, no backup', () => {
  const old = '[wsl2]\nmemory=28GB\n';
  const h = home(old);
  const r = applyWslCapacity({ profilesBytes: PROFILES, hostname: 'NOT-A-NODE', configPath: h.file, now: NOW });
  assert.deepEqual([r.status, r.reason], ['skipped', 'HOST_NOT_REGISTERED']);
  assert.equal(fs.readFileSync(h.file, 'utf8'), old);
  assert.deepEqual(h.others(), []);
});

test('already 17GB: unchanged, nothing written, no backup', () => {
  const old = '[wsl2]\r\nmemory=17GB\r\nprocessors=16\r\n';
  const h = home(old);
  const before = fs.statSync(h.file).mtimeMs;
  const r = applyWslCapacity({ profilesBytes: PROFILES, hostname: 'desk-w-591', configPath: h.file, now: NOW });
  assert.deepEqual({ status: r.status, from: r.from, to: r.to, backup: r.backup }, { status: 'unchanged', from: '17GB', to: '17GB', backup: null });
  assert.equal(fs.readFileSync(h.file, 'utf8'), old);
  assert.equal(fs.statSync(h.file).mtimeMs, before);
  assert.deepEqual(h.others(), []);
});

test('no .wslconfig yet: one is made with [wsl2] memory= only, no backup', () => {
  const h = home(null);
  const r = applyWslCapacity({ profilesBytes: PROFILES, hostname: 'DESK-W-591', configPath: h.file, now: NOW });
  assert.deepEqual([r.status, r.from, r.to, r.backup], ['written', null, '17GB', null]);
  assert.equal(fs.readFileSync(h.file, 'utf8'), '[wsl2]\r\nmemory=17GB\r\n');
  assert.deepEqual(h.others(), []);
});

test('setWslMemory: only the [wsl2] memory= value changes; LF, a BOM, comments, other sections and a missing key or section are handled', () => {
  assert.deepEqual(setWslMemory('﻿# mine\n[wsl2]\nswap=0\n  Memory = 28GB  \n[other]\nmemory=99GB\n', '17GB'),
    { text: '﻿# mine\n[wsl2]\nswap=0\n  Memory = 17GB  \n[other]\nmemory=99GB\n', from: '28GB' });
  assert.deepEqual(setWslMemory('[wsl2]\nswap=0\n', '17GB'), { text: '[wsl2]\nmemory=17GB\nswap=0\n', from: null });
  assert.deepEqual(setWslMemory('[wsl2]', '17GB'), { text: '[wsl2]\r\nmemory=17GB\r\n', from: null });
  assert.deepEqual(setWslMemory('[experimental]\r\nsparseVhd=true\r\n', '17GB'),
    { text: '[experimental]\r\nsparseVhd=true\r\n\r\n[wsl2]\r\nmemory=17GB\r\n', from: null });
  assert.deepEqual(setWslMemory('[wsl2]\nmemory=17gb\n', '17GB'), { text: '[wsl2]\nmemory=17gb\n', from: '17gb' });
});

test('never an error, never a write it cannot place: an unknown profile, a bad memory value, no profiles, a file not UTF-8', () => {
  const reg = (over) => Buffer.from(JSON.stringify({ capacity_profiles: { p: { wsl_memory_gb: 17 } }, hosts: [{ hostname: 'H1', capacity_profile: 'p', ...over }] }));
  const h = home('[wsl2]\nmemory=28GB\n');
  const run = (profilesBytes, hostname = 'H1', configPath = h.file) => applyWslCapacity({ profilesBytes, hostname, configPath, now: NOW });
  assert.equal(run(reg({ capacity_profile: 'nope' })).reason, 'PROFILE_UNKNOWN');
  assert.equal(run(Buffer.from(JSON.stringify({ capacity_profiles: { p: { wsl_memory_gb: 0 } }, hosts: [{ hostname: 'H1', capacity_profile: 'p' }] }))).reason, 'PROFILE_MEMORY_REFUSED');
  assert.equal(run(Buffer.from(JSON.stringify({ capacity_profiles: { p: { wsl_memory_gb: 17 } }, hosts: [{ hostname: 'H1', capacity_profile: 'p' }, { hostname: 'h1', capacity_profile: 'p' }] }))).reason, 'HOST_AMBIGUOUS');
  assert.equal(run(null).reason, 'PROFILES_MISSING');
  assert.equal(run(Buffer.from('{')).reason, 'PROFILES_UNREADABLE');
  assert.equal(fs.readFileSync(h.file, 'utf8'), '[wsl2]\nmemory=28GB\n');
  const u = home(Buffer.from('[\0w\0s\0l\x002\0]\0', 'latin1'));
  assert.equal(run(reg({}), 'H1', u.file).reason, 'CONFIG_NOT_UTF8');
  assert.deepEqual([h.others(), u.others()], [[], []]);
});

test('under a test marker the Owner\'s real .wslconfig is never written: a path outside the temporary directory is skipped', () => {
  const r = applyWslCapacity({ profilesBytes: PROFILES, hostname: 'DESK-W-591', configPath: path.join(os.homedir(), '.wslconfig'), now: NOW });
  assert.deepEqual([r.status, r.reason], ['skipped', 'REFUSED_UNDER_TEST']);
});

test('the package carries node-profiles.json at its repository path (one source), and the step reads it from the archive', () => {
  assert.ok(TREE_FILES.includes(NODE_PROFILES), 'node-profiles.json is a tree file of the universal package');
  const h = home('[wsl2]\nmemory=28GB\n');
  const byPath = new Map([[`tree/${NODE_PROFILES}`, PROFILES]]);
  assert.equal(wslCapacityOfArchive(byPath, { hostname: 'DESK-W-591', configPath: h.file, now: NOW }).to, '17GB');
  assert.equal(wslCapacityOfArchive(new Map(), { hostname: 'DESK-W-591', configPath: h.file, now: NOW }).reason, 'PROFILES_MISSING');
});
