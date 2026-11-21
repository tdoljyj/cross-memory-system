import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every test file that sets postgresFlags must take them from EPHEMERAL_POSTGRES_FLAGS (cluster-cleanup.mjs),
// so a hand-written list cannot quietly bring back durable settings for a throwaway cluster.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join('/');
// Frozen evidence and historical snapshots are copies of past runs; they are not edited.
const SKIP_DIRS = new Set(['node_modules', '.git', 'development', 'artifacts', 'history', 'evidence', 'readable']);
const SOURCE_FILE = /\.(mjs|js|ts)$/;
const TESTS_DIRECTORY = 'apps/clued-cloud/tests/';
const REFERENCE = /postgresFlags\s*:\s*(?:\[\s*\.\.\.EPHEMERAL_POSTGRES_FLAGS\b|EPHEMERAL_POSTGRES_FLAGS\b)/g;
const IMPORT = /import\s*\{[^}]*\bEPHEMERAL_POSTGRES_FLAGS\b[^}]*\}\s*from/;

async function testFiles(directory, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await testFiles(full, found);
    } else if (SOURCE_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test('every test file that sets postgresFlags takes them from EPHEMERAL_POSTGRES_FLAGS', async () => {
  const offenders = [];
  for (const file of await testFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === self || !(rel.startsWith(TESTS_DIRECTORY) || /\.test\.(mjs|js|ts)$/.test(rel))) continue;
    const source = await fs.readFile(file, 'utf8');
    const mentions = source.match(/postgresFlags/g)?.length ?? 0;
    if (mentions === 0) continue;
    const referenced = source.match(REFERENCE)?.length ?? 0;
    if (referenced !== mentions || !IMPORT.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});
