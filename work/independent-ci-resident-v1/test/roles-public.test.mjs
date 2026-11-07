// DESIGN §63 (Task 3ea699f6): the companion keeps a public copy of the six live Linux role files in
// upgrade\mailbox\responses\roles-public.json, so the next upgrade package can be built without a root export run with UAC.
// Offline: the root reads are a fake of `wsl --user root --exec /usr/bin/base64 -w 0 -- <fixed path>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { COMPANION_CONFIG_CONTRACT, UpgradeLane, argv, validateCompanionConfig } from '../src/companion.mjs';
import { UPGRADE_TOOL_PATH, UpgradeMailbox, VERSION_FACTS_REFRESH_MS } from '../src/upgrade-mailbox.mjs';
import { ROLES_PUBLIC_CONTRACT, ROLES_PUBLIC_FILE, ROLES_PUBLIC_LINUX_DIR, ROLES_PUBLIC_NAMES, readRolesPublic, rolePublicBytes, rolesPublicCurrent,
  rolesPublicDocument, validateRolesPublic } from '../src/roles-public.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const T0 = Date.parse('2026-11-07T08:00:00Z');
const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });

// The live roles-v3 of one generation: six files of public JSON.
const liveRoles = generation => Object.fromEntries(ROLES_PUBLIC_NAMES.map(n => [n, Buffer.from(canonicalJson(n.endsWith('.qualification.json')
  ? { payload: { role: n.split('.')[0], generation }, signature: 'c2lnbmVk' } : { role: n.split('.')[0], generation, sourceManifestSha256: 'a'.repeat(64) }) + '\n')]));
const factsOf = (generation, files, at) => ({ contract: 'clued.independent-ci.linux-version-facts/1', generation, ciSourceManifestSha256: 'b'.repeat(64),
  sourceCommit: 'c'.repeat(40), manifestSha256: 'd'.repeat(64), pinsOk: true, staged: null, upgradeToolSha256: 'e'.repeat(64), observedAt: new Date(at).toISOString(),
  roles: Object.fromEntries(['gitleaks', 'trivy', 'contract-placement'].map(r => [r, { policySha256: sha256(files[`${r}.json`]), qualificationSha256: sha256(files[`${r}.qualification.json`]) }])) });

// A fake Linux host: the frozen tool's facts over `live`, and base64 of a live file for the fixed role read (root only via the argv).
async function host(t) {
  const root = await tempRoot(t);
  let now = T0;
  const linux = { generation: 2, live: liveRoles(2), tamper: null, failRead: null };
  const roots = [];
  const box = await UpgradeMailbox.open(path.join(root, 'upgrade', 'mailbox'), () => now);
  const run = async (a, o) => {
    assert.deepEqual(a.slice(0, 11), [cfg.wslExe, '--distribution', cfg.distribution, '--user', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'LC_ALL=C']);
    const linuxArgv = a.slice(11);
    roots.push(linuxArgv);
    if (linuxArgv[0] === UPGRADE_TOOL_PATH && linuxArgv[1] === 'version-facts') return { code: 0, stdout: JSON.stringify(factsOf(linux.generation, linux.live, now)) + '\n' };
    if (linuxArgv[0] === '/usr/bin/base64') {
      assert.equal(o.timeoutMs, 60_000);
      const name = linuxArgv[4].slice(ROLES_PUBLIC_LINUX_DIR.length + 1);
      if (linux.failRead === name) return { code: null, stdout: '', timedOut: true, tree: 'zero' };
      const bytes = linux.tamper?.name === name ? linux.tamper.bytes : linux.live[name];
      return { code: 0, stdout: bytes.toString('base64') };   // base64 -w 0 writes no newline
    }
    return { code: 1, stdout: '' };
  };
  const lane = new UpgradeLane({ cfg, mailbox: box, run, clock: () => now });
  return { root, box, lane, linux, roots, advance: ms => { now += ms; }, now: () => now,
    copyFile: path.join(box.responses, ROLES_PUBLIC_FILE), reads: () => roots.filter(r => r[0] === '/usr/bin/base64') };
}

test('roles-public: the fixed root read is base64 of one of the six fixed files, nothing else', () => {
  const a = argv(cfg);
  assert.deepEqual(a.rolePublic('trivy.qualification.json'), [cfg.wslExe, '--distribution', cfg.distribution, '--user', 'root', '--exec', '/usr/bin/env', '-i',
    'PATH=/usr/bin:/bin', 'LANG=C', 'LC_ALL=C', '/usr/bin/base64', '-w', '0', '--', '/etc/clued-independent-ci/roles-v3/trivy.qualification.json']);
  for (const bad of ['../secrets/key.pem', 'gitleaks', 'trivy.qualification.payload.json', '/etc/shadow', 'gitleaks.json ', '', null]) {
    assert.throws(() => a.rolePublic(bad), { code: 'COMPANION_ROLE_PUBLIC_NAME_INVALID' }, String(bad));
  }
  assert.deepEqual([...ROLES_PUBLIC_NAMES].sort(), ['contract-placement.json', 'contract-placement.qualification.json', 'gitleaks.json', 'gitleaks.qualification.json',
    'trivy.json', 'trivy.qualification.json']);
});

test('roles-public: right after an install the first facts bring the copy, every file the facts\' own bytes; the next facts read nothing', async t => {
  const h = await host(t);
  assert.deepEqual(await h.lane.step(), { answered: [], facts: true });
  assert.equal(h.lane.rolesPublic, 'written');
  assert.deepEqual(h.reads().map(r => r[4]), ROLES_PUBLIC_NAMES.map(n => `${ROLES_PUBLIC_LINUX_DIR}/${n}`));
  const copy = await readRolesPublic(h.box.responses);
  assert.equal(copy.contract, ROLES_PUBLIC_CONTRACT);
  assert.equal(copy.generation, 2);
  for (const n of ROLES_PUBLIC_NAMES) assert.deepEqual(Buffer.from(copy.files[n].base64, 'base64'), h.linux.live[n], n);
  assert.equal(rolesPublicCurrent(copy, await h.box.readVersionFacts()), true);
  // the periodic facts: the copy is current, no root read at all
  h.roots.length = 0;
  h.advance(VERSION_FACTS_REFRESH_MS);
  assert.equal((await h.lane.step()).facts, true);
  assert.equal(h.lane.rolesPublic, 'current');
  assert.deepEqual(h.roots.map(r => r[1]), ['version-facts']);
});

test('roles-public: the next generation (a switch) rewrites the copy; a file that does not hash to the facts leaves the old copy', async t => {
  const h = await host(t);
  await h.lane.step();
  const before = await fs.readFile(h.copyFile);
  // generation 3 is live; one read returns other bytes than the facts name (a change between the facts and the read)
  h.linux.generation = 3; h.linux.live = liveRoles(3);
  h.linux.tamper = { name: 'trivy.json', bytes: liveRoles(2)['trivy.json'] };
  h.advance(VERSION_FACTS_REFRESH_MS);
  await h.lane.step();
  assert.equal(h.lane.rolesPublic, 'failed');
  assert.deepEqual(await fs.readFile(h.copyFile), before, 'the old copy is left as it was');
  assert.equal(rolesPublicCurrent(await readRolesPublic(h.box.responses), await h.box.readVersionFacts()), false);
  // a read that timed out: nothing written either, and the reads stop at the first failure
  h.linux.tamper = null; h.linux.failRead = 'gitleaks.qualification.json';
  h.roots.length = 0;
  h.advance(VERSION_FACTS_REFRESH_MS);
  await h.lane.step();
  assert.equal(h.lane.rolesPublic, 'failed');
  assert.equal(h.reads().length, 2);
  assert.deepEqual(await fs.readFile(h.copyFile), before);
  // the next facts: all six read, the copy is generation 3's
  h.linux.failRead = null;
  h.advance(VERSION_FACTS_REFRESH_MS);
  await h.lane.step();
  assert.equal(h.lane.rolesPublic, 'written');
  const copy = await readRolesPublic(h.box.responses);
  assert.equal(copy.generation, 3);
  for (const n of ROLES_PUBLIC_NAMES) assert.equal(copy.files[n].sha256, sha256(h.linux.live[n]));
  assert.deepEqual((await fs.readdir(h.box.responses)).filter(n => n.startsWith('.tmp-')), [], 'no temporary file left');
});

test('roles-public: facts that do not name all six files, or a mailbox without a responses directory, copy nothing and read nothing', async t => {
  const h = await host(t);
  const facts = factsOf(2, h.linux.live, T0);
  delete facts.roles['contract-placement'];
  assert.equal(await h.lane.refreshRolesPublic(h.box, facts), 'skipped');
  assert.equal(await h.lane.refreshRolesPublic({}, factsOf(2, h.linux.live, T0)), 'skipped');
  assert.equal(await h.lane.refreshRolesPublic(h.box, { ...factsOf(2, h.linux.live, T0), generation: null }), 'skipped');
  assert.deepEqual(h.roots, []);
  assert.equal(await readRolesPublic(h.box.responses), null);
});

test('roles-public: the document is refused when changed (bytes, entry sha, keys, contract, size)', () => {
  const live = liveRoles(4);
  const doc = rolesPublicDocument(factsOf(4, live, T0), live, T0);
  assert.equal(validateRolesPublic(structuredClone(doc)).generation, 4);
  const changed = [
    d => { d.files['gitleaks.json'].base64 = Buffer.from('{"role":"gitleaks","x":1}\n').toString('base64'); },
    d => { d.files['gitleaks.json'].sha256 = 'f'.repeat(64); },
    d => { delete d.files['trivy.json']; },
    d => { d.files['extra.json'] = d.files['trivy.json']; },
    d => { d.contract = 'clued.independent-ci.linux-roles-public/2'; },
    d => { d.generation = 0; },
    d => { d.files['trivy.json'].base64 += '\n'; },
    d => { d.files['trivy.json'].base64 = Buffer.alloc(16 * 1024 + 1, 0x20).toString('base64'); },
    d => { d.path = '/etc/shadow'; },
  ];
  for (const [i, change] of changed.entries()) {
    const d = structuredClone(doc); change(d);
    assert.throws(() => validateRolesPublic(d), { code: 'ROLES_PUBLIC_COPY_REFUSED' }, String(i));
  }
  // facts of another generation, or other bytes: not current
  assert.equal(rolesPublicCurrent(doc, factsOf(4, live, T0)), true);
  assert.equal(rolesPublicCurrent(doc, factsOf(5, live, T0)), false);
  assert.equal(rolesPublicCurrent(doc, factsOf(4, liveRoles(5), T0)), false);
  // the root read's stdout: only canonical base64 of bytes that hash to the facts
  const b = live['gitleaks.json'];
  assert.deepEqual(rolePublicBytes(b.toString('base64') + '\n', sha256(b)), b);
  for (const bad of ['', 'not base64!', b.toString('base64').slice(1), b.toString('base64') + 'A']) assert.equal(rolePublicBytes(bad, sha256(b)), null, bad);
  assert.equal(rolePublicBytes(b.toString('base64'), 'f'.repeat(64)), null);
});
