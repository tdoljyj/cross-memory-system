// The CI-script tests (scripts/ci and scripts/ci/self-hosted) that neither
// another application test imports nor a required suite command lists, run
// through the established quality unit entry like local-dev-tools.test.mjs
// (defect ddc94356): no required suite ran them, and on every change only this
// one can, since they read files from across the repository and several load
// yaml from this application's install. New files join without an edit.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyTests, importSpecifiers } from '../scripts/select-tests.mjs';
import { SUITE_COMMANDS } from '../../../scripts/ci/ci-required-selection.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS, '..', '..', '..');
const SELF = fileURLToPath(import.meta.url);

// Only the unit tests count: the required suite runs those, not the database ones.
const covered = new Set();
for (const file of classifyTests(TESTS).unit) {
  if (file === SELF) continue;
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) covered.add(path.resolve(TESTS, specifier));
}
for (const command of Object.values(SUITE_COMMANDS).flat()) {
  for (const arg of command.argv) if (arg.endsWith('.test.mjs')) covered.add(path.resolve(ROOT, command.cwd, arg));
}

const files = ['scripts/ci', 'scripts/ci/self-hosted']
  .flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(ROOT, dir, name)))
  .filter((file) => !covered.has(file))
  .sort();

for (const file of files) await import(pathToFileURL(file).href);
