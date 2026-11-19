// The one node entry (bootstrap.ps1) and what it relies on, from the independent review of 29c53c38c (REPORT-api-review-first-install.md):
//   M6  the package's paths are ASCII only: bootstrap.ps1 extracts the archive with Windows' own tar.exe (no Python yet on a new node),
//       which cannot write other names. At this commit no packaged path has another character (git ls-files of the repository, 2026-11-16);
//       the builder makes that a rule instead of a coincidence. The README names one entry for a node: bootstrap.ps1.
//   L4  the README's paths are text (no control character), and continue.py says how a stopped first install continues.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TREE_FILES, selectTree } from '../universal.mjs';
import { CLOSURE, RESIDENT } from '../facts.mjs';

const FLEET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.resolve(FLEET, '..', '..');
const readme = fs.readFileSync(path.join(FLEET, 'README.md'), 'utf8');

test('M6: a path outside printable ASCII is refused by the package builder (bootstrap.ps1 extracts with tar.exe)', async () => {
  const listing = new Map(TREE_FILES.map(p => [p, { mode: '100644', oid: null }]));
  const closure = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.source-closure/2', paths: [] }));
  const read = async paths => new Map(paths.map(p => [p, p === CLOSURE ? closure : Buffer.alloc(0)]));
  assert.equal((await selectTree(listing, read)).length, new Set(TREE_FILES).size);
  for (const bad of [`${RESIDENT}/src/\u8bf4\u660e.md`, `${RESIDENT}/windows/caf\u00e9.ps1`]) {
    const l = new Map(listing); l.set(bad, { mode: '100644', oid: null });
    await assert.rejects(selectTree(l, read), e => e.code === 'UNIVERSAL_TREE_PATH_NOT_ASCII' && e.detail === bad, bad);
  }
});

test('M6: the README names one entry for a node, bootstrap.ps1; prepare is what it runs, never an Owner command', () => {
  assert.match(readme, /fleet-node-<v>\.bootstrap\.ps1 -From <目录>/);
  assert.ok(!/^node [^\n]*install\.mjs prepare/m.test(readme), 'no command line runs install.mjs prepare by hand');
  assert.match(readme, /\| `FLEET_NODE_UPGRADE_NEEDS_REINSTALL` \|[^\n]*bootstrap\.ps1/);
  assert.ok(!/不用 Windows 的 `tar\.exe`/.test(readme), 'the entry extracts with tar.exe; the rule that makes that safe is named instead');
  assert.match(readme, /ASCII/);
});

test('L4: the README holds no control character (a "\\f" once turned a path into a form feed)', () => {
  const bad = [...readme].map((c, i) => [c.charCodeAt(0), i]).filter(([c]) => (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) || c === 0x7f);
  assert.deepEqual(bad, []);
  assert.ok(readme.includes('C:\\ProgramData\\CluedIndependentCI\\first-install\\facts.json'));
});

test('L4: continue.py says how a stopped first install continues (the same bootstrap command), not that it is an open gap', () => {
  const text = fs.readFileSync(path.join(RES, 'reinstall', 'launcher', 'continue.py'), 'utf8');
  assert.ok(!/open gap/.test(text));
  const at = text.indexOf("'PRIOR_LAUNCHER_IS_A_FIRST_INSTALL_NOT_CONTINUED'");
  const comment = text.slice(text.lastIndexOf('\n    need(lit(', at), at);
  assert.match(comment, /the same bootstrap command/);
});

test('the acceptance has two commands in the README, prepare before the Owner and seal after; no draft entry, no hand-attached kit or acceptance', () => {
  // Fable 3bc571a6 ruling section 3 (Task 758989fa): the two halves, each one command; the steps under them have no command of their own
  assert.match(readme, /^node [^\n]*publish\.mjs prepare --version <version> --dir /m);
  assert.match(readme, /^node [^\n]*publish\.mjs seal --request [^\n]*--decision-record /m);
  assert.ok(!/acceptance-draft/.test(readme), 'the old entry is gone from the README');
  assert.ok(!/attach-acceptance|attach-first-install-kit/.test(readme), 'no manual attach step is named in the README');
  assert.ok(!/install\.mjs first-install-kit/.test(readme), 'the manual take-the-kit step is gone from the README');
  assert.ok(!/^node [^\n]*first-install-kit/m.test(readme), 'no command line of the README runs a kit step by hand');
  assert.ok(!/^node [^\n]*install\.mjs source-hash/m.test(readme), 'the Source is prepare\'s, nobody fills it in by hand');
  // the flow: candidate -> drill -> the Owner's one acceptance -> seal
  assert.match(readme, /publish release -> publish prepare[^\n]*-> 候选演练[^\n]*-> Owner 接受[^\n]*-> publish seal/);
});

test('the acceptance in the README: seal takes the Decision record, not three hand-copied values; the delivery directory is the Release\'s assets, not prepare\'s --out', () => {
  // FABLE-renew-key-algorithm-ruling-20261119.md section 4 and its supplement; review suggestions 3 and 4
  assert.match(readme, /^node [^\n]*publish\.mjs seal --request [^\n]*--decision-record /m);
  assert.ok(!/^node [^\n]*publish\.mjs seal [^\n]*--(decision|receipt|accepted-at) /m.test(readme), 'no Decision, receipt or time on seal\'s command line');
  assert.match(readme, /clued_record_mutate/);
  assert.match(readme, /PASS_A_FULL/);
  assert.match(readme, /PASS_A_PER_NODE_STEPS_REMAIN/);
  assert.ok(!/可直接交给 `install\.mjs first-install-check --from` 和 `bootstrap\.ps1 -From`/.test(readme), 'prepare\'s --out is not the delivery directory');
  assert.match(readme, /交付目录/);
  // the three references every acceptance carries: where they come from is written once
  assert.match(fs.readFileSync(path.join(FLEET, 'BATCH1-INTERFACES.md'), 'utf8'), /\| `ownerAuthorizationRef`、`publisherQualificationRef`、`ownerPackageAcceptanceRef` \|[^\n]*publish\.mjs prepare/);
});

test('no file of the package names a publish.mjs command that no longer exists', () => {
  for (const f of [path.join(FLEET, 'bootstrap.ps1'), path.join(RES, 'reinstall', 'tools', 'export-role-image.ps1')]) {
    assert.ok(!/publish\.mjs (attach-first-install-kit|attach-acceptance|acceptance-draft)/.test(fs.readFileSync(f, 'utf8')), f);
  }
});

// review r2: the README's delivery directory is fetched by a command whose patterns take every asset bootstrap.ps1 requires for a first install
// (the list read from bootstrap.ps1's own Get-RequiredAssets), and a role image; no other way of fetching it is named there
test('the README\'s delivery directory: its one command takes every asset bootstrap.ps1 requires for a first install, and role images', () => {
  const boot = fs.readFileSync(path.join(FLEET, 'bootstrap.ps1'), 'utf8');
  const body = boot.slice(boot.indexOf('function Get-RequiredAssets'), boot.indexOf('function Test-AssetSet'));
  const v = '2026.11.19-0123abcd', t = `fleet-node-${v}`;
  const required = [...body.matchAll(/"\$t\.([^"]+)"|'([^']+)'/g)].map(m => (m[1] ? `${t}.${m[1]}` : m[2])).filter(n => n !== 'fleet-node-');
  assert.deepEqual(required.sort(), [`${t}.acceptance.json`, `${t}.bootstrap.ps1`, `${t}.first-install-kit.json`, `${t}.first-install.SHA256SUMS`, `${t}.prereq-manifest.json`,
    `${t}.release.json`, `${t}.tar`, 'SHA256SUMS'].sort(), 'bootstrap.ps1\'s list as this test reads it');
  const para = readme.split('\n').find(l => l.startsWith('**交付目录**'));
  assert.ok(para, 'the README has its delivery directory paragraph');
  assert.ok(!/fetch\.mjs/.test(para), 'fetch.mjs takes only the tar, the acceptance and SHA256SUMS: not a way to a delivery directory');
  const commands = [...para.matchAll(/`(gh release download [^`]+)`/g)].map(m => m[1]);
  assert.equal(commands.length, 1, 'one command');
  const patterns = [...commands[0].matchAll(/--pattern "([^"]+)"/g)].map(m => m[1].replaceAll('<version>', v));
  const glob = p => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`);
  for (const n of [...required, `role-image-${'c'.repeat(64)}.tar.gz`]) assert.ok(patterns.some(p => glob(p).test(n)), `${n} is fetched`);
  assert.match(commands[0], /^gh release download fleet-node-<version> /);
});
