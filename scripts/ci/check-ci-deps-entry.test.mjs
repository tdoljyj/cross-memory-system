import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGACY, main, offendingLines, readLegacy, verdict } from './check-ci-deps-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lines = (file, text) => offendingLines(file, text).map(({ line }) => line);

test('shell installs in workflows, actions and scripts are found; comments and the entry itself are not', () => {
  const workflow = [
    'run: npm ci --ignore-scripts',
    '  timeout 8m npm ci --cache "$HOME/.npm" --prefer-offline',
    '  npm install --prefix x esbuild@0.28.1',
    '  npm i left-pad',
    '  npm.cmd ci',
    '  (cd app && npm ci)',
    '  # npm ci in a comment',
    '  node scripts/ci/ci-deps.mjs install apps/clued-cloud',
    '  npm run build',
    '  npm rebuild @embedded-postgres/linux-x64',
    '  npm cinema',
  ].join('\n');
  assert.deepEqual(lines('.github/workflows/x.yml', workflow), ['run: npm ci --ignore-scripts',
    'timeout 8m npm ci --cache "$HOME/.npm" --prefer-offline', 'npm install --prefix x esbuild@0.28.1', 'npm i left-pad', 'npm.cmd ci',
    '(cd app && npm ci)']);
  assert.equal(lines('scripts/ci/setup.sh', 'npm ci\n').length, 1);
  assert.equal(lines('scripts/ci/setup.ps1', '& npm install\n').length, 1);
  assert.equal(lines('.github/actions/a/action.yml', '      run: npm ci\n').length, 1);
});

test('program code passing ci/install/add to npm is found; a hint in a message is not', () => {
  assert.equal(lines('scripts/ci/x.py', '    done = subprocess.run([npm, "ci", "--ignore-scripts"], cwd=app)\n').length, 1);
  assert.equal(lines('scripts/ci/x.mjs', "  npm(['ci', '--ignore-scripts'], dir);\n").length, 1);
  assert.equal(lines('scripts/runner/x.mjs', "spawnSync('npm', ['install', 'x']);\n").length, 1);
  assert.equal(lines('scripts/ci/x.mjs', "const [npm, ...prefix] = npmCommand(); spawnSync(npm, [...prefix, 'add', 'y']);\n").length, 1);
  assert.deepEqual(lines('scripts/ci/x.mjs', "const hint = '(first run  cd apps/clued-cloud && npm ci)';\n// npm(['ci'])\n"), []);
  assert.deepEqual(lines('scripts/ci/x.mjs', "spawnSync('npm', ['run', 'lint']);\n"), []);
});

test('tests, fixtures, JSON snapshots and ci-deps.mjs are not scanned', () => {
  for (const file of ['scripts/ci/x.test.mjs', 'scripts/ci/test_x.py', 'scripts/ci/fixtures/a.yml', 'scripts/runner/test/a.mjs',
    'scripts/ci/clued-gated-proof-profiles.json', 'scripts/ci/ci-deps.mjs', 'scripts/ci/README.md']) {
    assert.deepEqual(offendingLines(file, 'npm ci\nnpm(["ci"])\n'), [], file);
  }
});

test('only listed workflow lines pass; the list only shrinks; nothing but a workflow line may be listed', () => {
  const hit = (file, line, number = 1) => ({ file, line, number });
  const legacy = [{ file: '.github/workflows/a.yml', line: 'run: npm ci' }];
  assert.deepEqual(verdict([hit('.github/workflows/a.yml', 'run: npm ci')], legacy), []);
  const unlisted = verdict([hit('.github/workflows/a.yml', 'run: npm ci'), hit('.github/workflows/a.yml', 'run: npm ci', 9)], legacy);
  assert.equal(unlisted.length, 1, 'a second copy of a listed line is new');
  assert.match(unlisted[0], /a\.yml:9: installs dependencies without scripts\/ci\/ci-deps\.mjs/);
  assert.match(unlisted[0], /ci-deps\.mjs prepare <app-dir>.*ci-deps\.mjs install <app-dir>/);
  const gone = verdict([], legacy);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /lists a line that is gone/);
  assert.throws(() => readLegacy(JSON.stringify({ entries: [{ file: 'scripts/ci/x.py', line: 'npm ci' }] })), /only a line of a protected workflow file/);
  assert.throws(() => readLegacy('{}'), /entries must be a list/);
});

test('the repository passes: every install outside the listed workflow lines goes through ci-deps.mjs', () => {
  assert.equal(main(['--root', ROOT]), 0);
  for (const { file } of readLegacy(fs.readFileSync(path.join(ROOT, LEGACY), 'utf8'))) assert.match(file, /^\.github\/workflows\//);
});

test('a new install in a CI script fails the check', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-deps-entry-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(repo, LEGACY), JSON.stringify({ entries: [] }));
  fs.writeFileSync(path.join(repo, 'scripts/ci/ok.mjs'), "spawnSync('node', ['scripts/ci/ci-deps.mjs', 'install', 'app']);\n");
  git('add', '-A');
  assert.equal(main(['--root', repo]), 0);
  fs.writeFileSync(path.join(repo, 'scripts/ci/bad.py'), 'subprocess.run(["npm", "ci"], cwd=app)\n');
  git('add', '-A');
  assert.equal(main(['--root', repo]), 1);
});
