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
  assert.match(readme, /^node [^\n]*publish\.mjs seal --request [^\n]*--decision [^\n]*--receipt [^\n]*--accepted-at /m);
  assert.ok(!/acceptance-draft/.test(readme), 'the old entry is gone from the README');
  assert.ok(!/attach-acceptance|attach-first-install-kit/.test(readme), 'no manual attach step is named in the README');
  assert.ok(!/install\.mjs first-install-kit/.test(readme), 'the manual take-the-kit step is gone from the README');
  assert.ok(!/^node [^\n]*first-install-kit/m.test(readme), 'no command line of the README runs a kit step by hand');
  assert.ok(!/^node [^\n]*install\.mjs source-hash/m.test(readme), 'the Source is prepare\'s, nobody fills it in by hand');
  // the flow: candidate -> drill -> the Owner's one acceptance -> seal
  assert.match(readme, /publish release -> publish prepare[^\n]*-> 候选演练[^\n]*-> Owner 接受[^\n]*-> publish seal/);
});
