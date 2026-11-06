// The CI-script tests (scripts/ci and scripts/ci/self-hosted) that neither
// another application unit test imports (directly or through another CI-script
// test) nor the admission self-tests list, run through the established quality
// unit entry like local-dev-tools.test.mjs (defect ddc94356): no required suite
// ran them on every change, and only this one can, since they read files from
// across the repository and several load yaml from this application's install.
// New files join without an edit.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSupabasePublicConfig } from '../app/supabase-public-config.ts';
import { classifyTests, importSpecifiers } from '../scripts/select-tests.mjs';
import { SUITE_COMMANDS } from '../../../scripts/ci/ci-required-selection.mjs';
import { PUBLIC_CONFIG_SOURCE, resolvePublicSupabaseConfig } from '../../../scripts/ci/clued-work-admission.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS, '..', '..', '..');
const SELF = fileURLToPath(import.meta.url);

// Only the unit tests count: the required suite runs those, not the database ones.
const covered = new Set();
for (const file of classifyTests(TESTS).unit) {
  if (file === SELF) continue;
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) covered.add(path.resolve(TESTS, specifier));
}
// The admission self-tests run in their own suite whenever their code changes
// (ci-required-selection.test.mjs holds its triggers to their imports), keep
// their own known failures, and print GitHub annotations, so they are not run
// again here. The one file they read outside those triggers (the application's
// public Supabase default) is checked below as both readers parse it and as
// the admission self-test checks it.
// Other suite-listed tests, such as the selection test, check the whole
// repository but run only when a few files change: they stay here.
for (const command of SUITE_COMMANDS['admission-self-tests']) {
  for (const arg of command.argv) if (arg.endsWith('.test.mjs')) covered.add(path.resolve(ROOT, command.cwd, arg));
}
// A covered test also runs the tests it imports (the Set visits what is added).
for (const file of covered) {
  if (!file.endsWith('.test.mjs') || !existsSync(file)) continue;
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
    if (specifier.startsWith('.')) covered.add(path.resolve(path.dirname(file), specifier));
  }
}

const files = ['scripts/ci', 'scripts/ci/self-hosted']
  .flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(ROOT, dir, name)))
  .filter((file) => !covered.has(file))
  .sort();

for (const file of files) await import(pathToFileURL(file).href);

// The admission script and the runner hook (and with them the admission
// self-tests) read the application's public Supabase default from its source
// text, each with its own pattern.
test('the admission script and the runner hook read the application public Supabase default', () => {
  const { url, key } = resolveSupabasePublicConfig({});
  assert.deepEqual(resolvePublicSupabaseConfig({}, ROOT), { url, key, source: PUBLIC_CONFIG_SOURCE });
  // The runner hook's size limit and pattern (scripts/runner/clued-runner-job-started.mjs, decideWithCurrentEpoch).
  const text = readFileSync(path.join(ROOT, PUBLIC_CONFIG_SOURCE), 'utf8');
  assert.ok(Buffer.from(text).toString('base64').length <= 32768);
  const runner = /return \{ url: "(https:\/\/[a-z0-9-]+\.supabase\.co)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(text);
  assert.deepEqual(runner?.slice(1), [url, key]);
  // The admission self-test's own check of the default (scripts/ci/clued-work-admission.test.mjs).
  assert.match(url, /^https:\/\/[a-z]+\.supabase\.co$/);
});
