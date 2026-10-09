import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Since migration 20261009050000 a Binding without a v12 authorization works only when
// clued_private.raw_binding_grants_v1 names it (P0-4 step 7b, Clued Task 9a4d6d2c). A test or fixture that inserts
// Bindings straight into public.clued_agent_bindings therefore either calls allowRawTestBindings
// (tests/raw-binding-grants-fixture.mjs), writes raw_binding_grants_v1 itself, or says why it needs neither in a
// `raw-binding-grants:` comment. The test-only trigger never reaches non-test code.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSERT = /insert\s+into\s+(?:public\.)?clued_agent_bindings\b/i;

async function files(dir, pattern) {
  const out = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(rel, pattern));
    else if (pattern.test(entry.name)) out.push(rel);
  }
  return out;
}

test('every test that inserts raw Bindings grants them or says why not', async () => {
  const candidates = [
    ...await files('tests', /\.mjs$/),
    ...await files('evals', /\.mjs$/),
    ...await files('supabase/tests', /\.sql$/),
  ];
  const missing = [];
  let inserting = 0;
  for (const file of candidates) {
    const src = await fs.readFile(path.join(root, file), 'utf8');
    if (!INSERT.test(src)) continue;
    inserting += 1;
    if (!/allowRawTestBindings|raw_binding_grants_v1|raw-binding-grants: \S/.test(src)) missing.push(file);
  }
  assert.ok(inserting > 50, `found ${inserting} files inserting Bindings; the scan is broken`);
  assert.deepEqual(missing, [], 'call allowRawTestBindings(client) after applying the migrations');
});

test('the test-only grant trigger stays out of migrations and the Worker', async () => {
  for (const file of [...await files('supabase/migrations', /\.sql$/), ...await files('worker', /\.(ts|mjs)$/)]) {
    const src = await fs.readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /test_raw_binding_grant_v1|allowRawTestBindings/, file);
  }
});
