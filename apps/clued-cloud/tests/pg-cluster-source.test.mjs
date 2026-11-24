import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only one file loads embedded PostgreSQL: pg-cluster-fixture.mjs, whose newCluster takes no port, so every
// cluster is started by startCluster in cluster-cleanup.mjs, which picks the port at start and picks again when the
// postmaster finds it taken (task 11092b8b). A test that picked a free port and then started the postmaster on it
// could lose the port in between and fail with a bare `undefined`. This check keeps that way of starting out:
//   1. the package name in quotes appears only in the files named below;
//   2. under apps/clued-cloud/tests only cluster-cleanup.mjs calls the library's initialise;
//   3. the port-picking hook of startCluster is named only where it is defined, unit-tested and reproduced.
// It does not import the fixture, so it stays a unit test in the clued-cloud suite.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const self = path.relative(repoRoot, fileURLToPath(import.meta.url)).split(path.sep).join('/');
// Frozen evidence and historical snapshots are copies of past runs; they are not edited.
const SKIP_DIRS = new Set(['node_modules', '.git', 'development', 'artifacts', 'history', 'evidence', 'readable']);
const SOURCE_FILE = /\.(mjs|js|ts)$/;
const TESTS_DIRECTORY = 'apps/clued-cloud/tests/';
const PACKAGE = 'embedded-postgres';
// Spelled in pieces so this file does not match rules 2 and 3.
const QUOTED_PACKAGE = new RegExp(`['"\`]${PACKAGE}`);
const INITIALISE_CALL = /\.initialise\(/;
const PICK_PORT = new RegExp(`\\b${['pick', 'Port'].join('')}\\b`);
const HOW_TO = '改用 newCluster({…不带 port}) 和 await startCluster(server)，见 apps/clued-cloud/tests/pg-cluster-fixture.mjs';

// Files that may name the package, each with its reason. Once one no longer names it, the check fails until the
// entry is removed, so the list only gets shorter.
const PACKAGE_ALLOWED = new Map([
  ['apps/clued-cloud/tests/pg-cluster-fixture.mjs', 'the one entry that loads the package'],
  ['apps/clued-cloud/scripts/select-tests.mjs', 'the test classifier names the package to find database tests'],
  [self, 'this check names the package in its rule'],
  ['scripts/ci/local-verify-concurrency.test.mjs', 'string samples for the classifier, starts nothing'],
  // To clear: the release-gate script still picks a port itself; a follow-up PR moves it onto the fixture.
  ['apps/clued-cloud/scripts/production-schema-drift.mjs', 'to clear: release-gate script, follow-up PR'],
  // To clear: phase-2 qualification tests that no required check has ever run (ci-uncovered-tests.json); task 700f2b68
  // decides whether each stays.
  ...[
    'authorized-record-list-preparation/record-list.test.mjs',
    'evidence-context-binding/source-binding-db.test.mjs',
    'minimum-context-compiler/compiler-db.test.mjs',
    'nonproduction-control-store/review-fixes.test.mjs',
    'nonproduction-control-store/runtime-successor/budget-reservation-successor/budget.test.mjs',
    'nonproduction-control-store/runtime-successor/control-objects-successor/control-objects.test.mjs',
    'nonproduction-control-store/runtime-successor/evidence.test.mjs',
    'nonproduction-control-store/runtime-successor/store.test.mjs',
    'nonproduction-control-store/store.test.mjs',
    'predispatch-nonpass-successor/tests/storage.test.mjs',
  ].map((file) => [`scripts/phase2-qualification/${file}`, 'to clear: never run by a required check, task 700f2b68']),
]);
const INITIALISE_ALLOWED = new Set(['apps/clued-cloud/tests/cluster-cleanup.mjs']);
const PICK_PORT_ALLOWED = new Set([
  'apps/clued-cloud/tests/cluster-cleanup.mjs',
  'apps/clued-cloud/tests/cluster-cleanup.test.mjs',
  'apps/clued-cloud/tests/work-claims-owner-grants-db.test.mjs',
]);

async function sourceFiles(directory, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await sourceFiles(full, found);
    } else if (SOURCE_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// Every breach of the three rules under `root`, one line each.
async function problems(root, { packageAllowed = PACKAGE_ALLOWED, initialiseAllowed = INITIALISE_ALLOWED, pickPortAllowed = PICK_PORT_ALLOWED } = {}) {
  const found = [];
  const named = new Set();
  for (const file of (await sourceFiles(root)).sort()) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const text = await fs.readFile(file, 'utf8');
    if (QUOTED_PACKAGE.test(text)) {
      named.add(relative);
      if (!packageAllowed.has(relative)) found.push(`${relative}: loads ${PACKAGE} itself; ${HOW_TO}`);
    }
    if (relative.startsWith(TESTS_DIRECTORY) && INITIALISE_CALL.test(text) && !initialiseAllowed.has(relative)) {
      found.push(`${relative}: calls initialise itself; ${HOW_TO}`);
    }
    if (PICK_PORT.test(text) && !pickPortAllowed.has(relative)) {
      found.push(`${relative}: picks the port itself; startCluster picks it, ${HOW_TO}`);
    }
  }
  for (const relative of packageAllowed.keys()) {
    if (!named.has(relative)) found.push(`${relative}: no longer names ${PACKAGE}; remove it from PACKAGE_ALLOWED in ${self}`);
  }
  return found;
}

test('only the fixture loads embedded PostgreSQL, only startCluster initialises and picks the port', async () => {
  assert.deepEqual(await problems(repoRoot), []);
});

// Samples in a temporary directory: each rule fails on its own breach, and the skipped directories are skipped.
test('unit: each rule names its breach', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-pg-cluster-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, text) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  };
  const quoted = `import EmbeddedPostgres from '${PACKAGE}';\n`;
  const allowed = { packageAllowed: new Map([['apps/clued-cloud/tests/pg-cluster-fixture.mjs', 'entry']]), initialiseAllowed: INITIALISE_ALLOWED, pickPortAllowed: PICK_PORT_ALLOWED };
  await write('apps/clued-cloud/tests/pg-cluster-fixture.mjs', quoted);
  await write('apps/clued-cloud/tests/cluster-cleanup.mjs', `await server${'.initialise'}();\nexport async function startCluster(s, { ${['pick', 'Port'].join('')} } = {}) {}\n`);
  await write('development/evidence/old-db.test.mjs', quoted);
  assert.deepEqual(await problems(root, allowed), [], 'the entry, the fixture and skipped directories pass');

  await write('apps/clued-cloud/tests/new-db.test.mjs', `const { default: Pg } = await import("${PACKAGE}");\n`);
  await write('apps/clued-cloud/tests/start-db.test.mjs', `await server${'.initialise'}(); await server.start();\n`);
  await write('scripts/ci/picker.mjs', `const ${['pick', 'Port'].join('')} = async () => 5432;\n`);
  await write('scripts/other/loader.ts', `const lib = require(\`${PACKAGE}\`);\n`);
  const found = await problems(root, allowed);
  assert.equal(found.length, 4, found.join('\n'));
  assert.match(found.find((line) => line.startsWith('apps/clued-cloud/tests/new-db.test.mjs')), /loads .* itself; 改用 newCluster/);
  assert.match(found.find((line) => line.startsWith('apps/clued-cloud/tests/start-db.test.mjs')), /calls initialise itself/);
  assert.match(found.find((line) => line.startsWith('scripts/ci/picker.mjs')), /picks the port itself/);
  assert.ok(found.some((line) => line.startsWith('scripts/other/loader.ts')), 'a template-quoted require is a load too');
});

test('unit: an allowed file that no longer names the package fails until its entry is removed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-pg-cluster-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'apps/clued-cloud/scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'apps/clued-cloud/scripts/production-schema-drift.mjs'), "import { newCluster } from '../tests/pg-cluster-fixture.mjs';\n");
  const found = await problems(root, { packageAllowed: new Map([['apps/clued-cloud/scripts/production-schema-drift.mjs', 'to clear']]) });
  assert.equal(found.length, 1);
  assert.match(found[0], /production-schema-drift\.mjs: no longer names .*remove it from PACKAGE_ALLOWED/);
});
