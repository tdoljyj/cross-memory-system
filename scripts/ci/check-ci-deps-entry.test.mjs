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

test('shell installs in workflows, actions and scripts are found, with options before the command and its aliases', () => {
  const workflow = [
    'run: npm ci --ignore-scripts',
    '  timeout 8m npm ci --cache "$HOME/.npm" --prefer-offline',
    '  npm install --prefix x esbuild@0.28.1',
    '  npm i left-pad',
    '  npm.cmd ci',
    '  (cd app && npm ci)',
    '  npm --prefix x ci',
    '  npm --ignore-scripts clean-install',
    '  # npm ci in a comment',
    '  - name: npm ci',
    '  node scripts/ci/ci-deps.mjs install apps/clued-cloud',
    '  npm run build',
    '  npm run ci',
    '  npm rebuild @embedded-postgres/linux-x64',
    '  npm config get cache',
    '  npm cinema',
  ].join('\n');
  assert.deepEqual(lines('.github/workflows/x.yml', workflow), ['run: npm ci --ignore-scripts',
    'timeout 8m npm ci --cache "$HOME/.npm" --prefer-offline', 'npm install --prefix x esbuild@0.28.1', 'npm i left-pad', 'npm.cmd ci',
    '(cd app && npm ci)', 'npm --prefix x ci', 'npm --ignore-scripts clean-install']);
  assert.equal(lines('.github/workflows/x.yml', 'run: npm ci # see ci-deps.mjs\n').length, 1, 'naming the entry exempts nothing');
  assert.equal(lines('scripts/ci/setup.sh', 'npm ci\n').length, 1);
  assert.equal(lines('scripts/ci/setup.ps1', '& npm install\n').length, 1);
  assert.equal(lines('scripts/ci/setup.cmd', 'call npm update\n').length, 1);
  assert.equal(lines('.github/actions/a/action.yml', '      run: npm ci\n').length, 1);
});

test('program code: npm handed an install command, or shell text in a line that starts a command; a message is not one', () => {
  assert.equal(lines('scripts/ci/x.py', '    done = subprocess.run([npm, "ci", "--ignore-scripts"], cwd=app)\n').length, 1);
  assert.equal(lines('scripts/ci/x.mjs', "  npm(['ci', '--ignore-scripts'], dir);\n").length, 1);
  assert.equal(lines('scripts/runner/x.mjs', "spawnSync('npm', ['install', 'x']);\n").length, 1);
  assert.equal(lines('scripts/ci/x.mjs', "spawn(npm, ['--prefix', app, 'ci']);\n").length, 1);
  assert.equal(lines('scripts/ci/x.mjs', 'execSync("npm install");\n').length, 1);
  assert.equal(lines('scripts/ci/x.mjs', 'execSync(`npm ci --prefix ${app}`);\n').length, 1);
  assert.equal(lines('scripts/ci/x.py', 'subprocess.run("npm ci", shell=True)\n').length, 1);
  assert.deepEqual(lines('scripts/ci/x.mjs', "const hint = '(first run  cd apps/clued-cloud && npm ci)';\n// npm(['ci'])\n"), []);
  assert.deepEqual(lines('scripts/ci/x.mjs', 'reason: `${missing} is missing; run npm ci in apps/clued-cloud`,\n'), []);
  assert.deepEqual(lines('scripts/ci/x.mjs', "spawnSync('npm', ['run', 'lint']);\n"), []);
});

test('test files, fixtures, JSON snapshots and ci-deps.mjs are not scanned; the pinned workflow copies are data', () => {
  for (const file of ['scripts/ci/x.test.mjs', 'scripts/ci/test_x.py', 'scripts/ci/fixtures/a.yml', 'scripts/runner/test/a.test.mjs',
    'scripts/ci/clued-gated-proof-profiles.json', 'scripts/ci/ci-deps.mjs', 'scripts/ci/README.md']) {
    assert.deepEqual(offendingLines(file, 'npm ci\nnpm(["ci"])\n'), [], file);
  }
  assert.equal(offendingLines('scripts/runner/test/helper.sh', 'npm ci\n').length, 1, 'a script beside the tests is scanned');
  assert.deepEqual(offendingLines('scripts/ci/clued-workflow-profile.mjs', 'const SOURCE3_WORKFLOW_DEFINITIONS = {"run":"npm ci --prefix a"};\n'), []);
  assert.equal(offendingLines('scripts/ci/clued-workflow-profile.mjs', 'execSync("npm ci");\n').length, 1);
});

test('only listed workflow lines pass; against the base the list only shrinks; nothing but a workflow line may be listed', () => {
  const hit = (file, line, number = 1) => ({ file, line, number });
  const legacy = [{ file: '.github/workflows/a.yml', line: 'run: npm ci' }];
  assert.deepEqual(verdict([hit('.github/workflows/a.yml', 'run: npm ci')], legacy), []);
  const unlisted = verdict([hit('.github/workflows/a.yml', 'run: npm ci'), hit('.github/workflows/a.yml', 'run: npm ci', 9)], legacy);
  assert.equal(unlisted.length, 1, 'a second copy of a listed line is new');
  assert.match(unlisted[0], /a\.yml:9: installs dependencies without scripts\/ci\/ci-deps\.mjs/);
  assert.match(unlisted[0], /use: node scripts\/ci\/ci-deps\.mjs install <app-dir>/);
  const gone = verdict([], legacy);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /lists a line that is gone/);
  const two = [...legacy, { file: '.github/workflows/b.yml', line: 'run: npm i x' }];
  const found = [hit('.github/workflows/a.yml', 'run: npm ci'), hit('.github/workflows/b.yml', 'run: npm i x')];
  assert.deepEqual(verdict(found, two, two), []);
  assert.deepEqual(verdict(found.slice(0, 1), legacy, two), [], 'shrinking is fine');
  const grown = verdict(found, two, legacy);
  assert.equal(grown.length, 1);
  assert.match(grown[0], /may only shrink; the base does not list: \.github\/workflows\/b\.yml: run: npm i x/);
  assert.throws(() => readLegacy(JSON.stringify({ entries: [{ file: 'scripts/ci/x.py', line: 'npm ci' }] })), /only a line of a protected workflow file/);
  assert.throws(() => readLegacy('{}'), /entries must be a list/);
});

test('the repository passes: every install outside the listed workflow lines goes through ci-deps.mjs', () => {
  assert.equal(main(['--root', ROOT]), 0);
  for (const { file } of readLegacy(fs.readFileSync(path.join(ROOT, LEGACY), 'utf8'))) assert.match(file, /^\.github\/workflows\//);
});

test('a new install in a CI script fails the check; so does a list that grew since the base', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-deps-entry-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, LEGACY), JSON.stringify({ entries: [] }));
  fs.writeFileSync(path.join(repo, 'scripts/ci/ok.mjs'), "spawnSync('node', ['scripts/ci/ci-deps.mjs', 'install', 'app']);\n");
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  assert.equal(main(['--root', repo, '--base', base]), 0);
  assert.equal(main(['--root', repo, '--base', 'deadbeef']), 1, 'a base it cannot read is no reason to skip the shrink check');
  fs.writeFileSync(path.join(repo, 'scripts/ci/bad.py'), 'subprocess.run(["npm", "ci"], cwd=app)\n');
  git('add', '-A');
  assert.equal(main(['--root', repo, '--base', base]), 1);
  fs.rmSync(path.join(repo, 'scripts/ci/bad.py'));
  fs.writeFileSync(path.join(repo, '.github/workflows/w.yml'), 'run: npm ci\n');
  fs.writeFileSync(path.join(repo, LEGACY), JSON.stringify({ entries: [{ file: '.github/workflows/w.yml', line: 'run: npm ci' }] }));
  git('add', '-A');
  assert.equal(main(['--root', repo]), 0, 'without a base the list is only checked against the files');
  assert.equal(main(['--root', repo, '--base', base]), 1, 'a line the base did not list fails');
});
