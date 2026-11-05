// A script that decides whether it is the entry point by comparing
// process.argv[1] with import.meta.url does nothing behind a junction or a
// symlink: Node resolves the link in the module URL but not in argv[1]
// (defect 2102f7e1: apps/clued-cloud/scripts/run-tests.mjs ran no test and
// exited 0 when local-verify's cache was reached through a junction).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEGACY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'main-entry-legacy.json'), 'utf8')).files;
const SCRIPT = /\.(?:mjs|cjs|js)$/;

// A line that compares argv[1] with the module's own URL, without resolving links either way.
export const usesLinkBlindIdiom = (line) => /process\.argv\[1\]/.test(line) && /import\.meta\.url/.test(line) && !/realpath|import\.meta\.main/.test(line);

function trackedScripts() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return listed.status === 0 ? listed.stdout.split('\0').filter((file) => SCRIPT.test(file)) : null;
}

test('the idiom is recognised', () => {
  assert.ok(usesLinkBlindIdiom('if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {'));
  assert.ok(usesLinkBlindIdiom('if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){'));
  assert.ok(!usesLinkBlindIdiom('if (import.meta.main) {'));
  assert.ok(!usesLinkBlindIdiom('return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);'));
  assert.ok(!usesLinkBlindIdiom('const argv1 = process.argv[1];'));
});

test('no script decides by itself that it is the entry point with a comparison a link defeats, except the listed pinned ones', (t) => {
  const files = trackedScripts();
  if (files === null) return t.skip('not a git work tree');
  // (this file quotes the idiom in its own fixtures)
  const self = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
  const found = files.filter((file) => file !== self && fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').some(usesLinkBlindIdiom)).sort();
  const listed = new Set(LEGACY);
  assert.deepEqual(found.filter((file) => !listed.has(file)), [],
    'use `if (import.meta.main)` (Node 22.18 and later) so the script also runs behind a link; a new file may not use the comparison');
  assert.deepEqual(LEGACY.filter((file) => !found.includes(file)), [],
    'these listed files no longer use the comparison (or are gone): remove them from scripts/ci/main-entry-legacy.json');
});

// A link to a directory: a junction on Windows (no privilege needed), else a symlink.
function linkTo(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('run-tests.mjs behind a link runs the tests and reports their result, as it does at its real path', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-entry-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'scripts-link');
  linkTo(path.join(ROOT, 'apps', 'clued-cloud', 'scripts'), link);
  const marker = path.join(dir, 'ran.txt');
  const sample = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('sample', () => { fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n'); ${body} });\n`);
    return file;
  };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (script, file) => spawnSync(process.execPath, [script, '--test', file], { cwd: dir, env, encoding: 'utf8', windowsHide: true });
  const passing = sample('passing.test.mjs', '');
  const failing = sample('failing.test.mjs', "throw new Error('fails on purpose');");
  for (const [label, script] of [['real path', path.join(ROOT, 'apps', 'clued-cloud', 'scripts', 'run-tests.mjs')], ['through a link', path.join(link, 'run-tests.mjs')]]) {
    fs.rmSync(marker, { force: true });
    const ok = run(script, passing);
    assert.equal(ok.status, 0, `${label}: ${ok.stdout}${ok.stderr}`);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran\n', `${label}: the test ran`);
    fs.rmSync(marker, { force: true });
    const bad = run(script, failing);
    assert.equal(bad.status, 1, `${label}: a failing test fails the run (${bad.stdout}${bad.stderr})`);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran\n', `${label}: the failing test ran`);
  }
});

test('a script that uses import.meta.main runs behind a link, one that compares paths does not (why the comparison went)', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-entry-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'real'));
  fs.writeFileSync(path.join(dir, 'real', 'new.mjs'), "if (import.meta.main) console.log('ran');\n");
  fs.writeFileSync(path.join(dir, 'real', 'old.mjs'),
    "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nif (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('ran');\n");
  linkTo(path.join(dir, 'real'), path.join(dir, 'link'));
  const out = (script) => spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.equal(out(path.join(dir, 'real', 'new.mjs')), 'ran');
  assert.equal(out(path.join(dir, 'link', 'new.mjs')), 'ran');
  assert.equal(out(path.join(dir, 'real', 'old.mjs')), 'ran');
  assert.equal(out(path.join(dir, 'link', 'old.mjs')), '', 'the comparison is defeated by the link: the script does nothing, silently');
});
