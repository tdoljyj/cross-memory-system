// The drill host's sync runs from a checkout that never installed anything (task 87d330d0, design
// FABLE-drill-sync-deps-20261124 §4.2, §5). A fresh worktree has the files the repository tracks and no
// node_modules: scripts/drill-test-sync.mjs, and everything it imports, has to run from those alone. Its
// database client is node-postgres bundled into scripts/generated/drill-pg.mjs (scripts/generate-drill-pg.mjs).
//
// Run here, in the suite every change selects, so a change to the application's scripts alone is held to it
// too (the drill's own fresh-checkout test, work/independent-ci-resident-v1/test/drill-fresh-checkout.test.mjs,
// runs only when the resident suite is selected). Offline: no database, no network; the run stops at the
// pooler host, which comes after the client is loaded and before the password is read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const scripts = path.join(app, 'scripts');
const RESULT = 'clued.drill-test-sync.result/1';

// The tracked files under the given repository paths, copied byte for byte (uncommitted edits included) to `into`.
function trackedCopy(into, paths) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...paths], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0, `git ls-files ${paths.join(' ')}`);
  for (const file of files) {
    const from = path.join(repository, file);
    if (!existsSync(from)) continue; // deleted in the working tree: a fresh checkout of it would not have it either
    mkdirSync(path.dirname(path.join(into, file)), { recursive: true });
    copyFileSync(from, path.join(into, file));
  }
  return files.length;
}

// No node_modules inside the copy, none in any directory above it, no ~/.node_modules or ~/.node_libraries (Node looks there:
// a package there would make the run pass here and fail on the drill host).
function assertNoDependencies(root) {
  const inside = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') inside.push(path.join(dir, entry.name)); else walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  assert.deepEqual(inside, [], 'the copy holds only tracked files');
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    assert.equal(existsSync(path.join(dir, 'node_modules')), false,
      `${path.join(dir, 'node_modules')} is above the copy: Node would look there; run with TEMP somewhere without one`);
    if (path.dirname(dir) === dir) break;
  }
  for (const name of ['.node_modules', '.node_libraries']) {
    assert.equal(existsSync(path.join(os.homedir(), name)), false, `${path.join(os.homedir(), name)}: Node's require looks there`);
  }
}

test('the sync script runs from the tracked files alone: it loads its client and stops at the pooler host, before the password', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'drill-sync-standalone-'));
  try {
    const fresh = path.join(root, 'fresh');
    trackedCopy(fresh, ['apps/clued-cloud/scripts', 'apps/clued-cloud/supabase']);
    assertNoDependencies(fresh);
    const kit = path.join(root, 'kit.json');
    writeFileSync(kit, JSON.stringify({ record: { scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f', repository: 'tdoljyj/cross-memory-system' } }));
    const applied = path.join(root, 'production-applied.json');
    writeFileSync(applied, JSON.stringify({ contract: 'clued.production-applied.v1', applied: [{ version: '20260101000000', name: 'first', statements_md5: '0'.repeat(32) }] }));
    const server = path.join(root, 'drill-server.json');
    writeFileSync(server, JSON.stringify({ contract: 'clued.drill.server/1', project: 'clued-auth-test', supabaseUrl: 'https://uscrdifznmlvczcekqpw.supabase.co', poolerHost: null }));
    const run = spawnSync(process.execPath, [path.join(fresh, 'apps', 'clued-cloud', 'scripts', 'drill-test-sync.mjs'), '--applied', applied, '--kit', kit, '--server', server],
      { cwd: root, input: 'x', encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    const last = run.stdout.split(/\r?\n/).filter((line) => line.trim()).at(-1) ?? '';
    let answer = null;
    try { answer = JSON.parse(last); } catch { answer = last; }
    assert.deepEqual(answer, { contract: RESULT, state: 'failed', code: 'DRILL_SERVER_POOLER_HOST_NOT_SET' }, run.stdout + run.stderr);
    assert.equal(run.status, 1, run.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Static imports, export-from and side-effect imports; loaded on demand: import() and require() (the generated module's
// CommonJS: require, or esbuild's __require) with a literal name. A Node module, with node: or without, is no package.
const STATIC = /^[ \t]*(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC = [/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /(?:\b|__)require\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
const notPackage = (name) => name.startsWith('./') || name.startsWith('../') || isBuiltin(name);
function importClosure(start) {
  const files = new Map();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    if (files.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    const statics = [...source.matchAll(STATIC)].map((match) => match[1]);
    const dynamics = DYNAMIC.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
    files.set(file, { source, statics, dynamics });
    for (const name of statics) if (name.startsWith('.')) queue.push(path.resolve(path.dirname(file), name));
  }
  return files;
}

test('what the sync script imports is node: modules and repository files; no package outside them, now or loaded later', () => {
  const start = path.join(scripts, 'drill-test-sync.mjs');
  const closure = importClosure(start);
  assert.ok(closure.has(path.join(scripts, 'generated', 'drill-pg.mjs')), 'the client is the generated module');
  for (const [file, { statics }] of closure) {
    for (const name of statics) assert.ok(notPackage(name), `${path.relative(app, file)} imports ${name}: the drill host has no node_modules`);
  }
  assert.doesNotMatch(closure.get(start).source, /\bimport\s*\(/, 'the sync script loads nothing on demand');
  // The packages the closure loads on demand, each where the sync never goes (pg: the ledger's own database check; the
  // embedded PostgreSQL: the drift check; pg-native: the lazy pg.native getter). Another one is a package the drill host
  // would not have: look before adding it here.
  const onDemand = [...closure].flatMap(([file, { dynamics }]) => dynamics.filter((name) => !notPackage(name))
    .map((name) => `${path.relative(scripts, file).split(path.sep).join('/')} ${name}`)).sort();
  assert.deepEqual(onDemand, ['generated/drill-pg.mjs pg-native', 'migration-ledger.mjs pg', 'production-schema-drift.mjs embedded-postgres']);
});

test('the generated client is node-postgres as package-lock.json pins it, regenerated byte for byte', async () => {
  const { renderDrillPgModule } = await import('../scripts/generate-drill-pg.mjs');
  const committed = readFileSync(path.join(scripts, 'generated', 'drill-pg.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, (await renderDrillPgModule()).replace(/\r\n/g, '\n'), 'out of date: run node scripts/generate-drill-pg.mjs in apps/clued-cloud');
  const lock = JSON.parse(readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
  assert.match(committed, new RegExp(`^// Generated by scripts/generate-drill-pg\\.mjs from pg ${lock.packages['node_modules/pg'].version.replace(/\./g, '\\.')};`, 'm'));
});
