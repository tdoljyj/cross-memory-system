// The CI-script tests (scripts/ci and scripts/ci/self-hosted) that neither
// another application unit test imports nor the admission self-tests list, run
// through the established quality unit entry like local-dev-tools.test.mjs
// (defect ddc94356): no required suite ran them on every change, and only this
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
// The admission self-tests run in their own suite whenever anything they read
// changes (ci-required-selection.test.mjs holds their triggers to their
// imports), keep their own known failures, and print GitHub annotations, so
// they are not run again here. Other suite-listed tests, such as the selection
// test, check the whole repository but run only when a few files change: they
// stay here.
for (const command of SUITE_COMMANDS['admission-self-tests']) {
  for (const arg of command.argv) if (arg.endsWith('.test.mjs')) covered.add(path.resolve(ROOT, command.cwd, arg));
}

const files = ['scripts/ci', 'scripts/ci/self-hosted']
  .flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(ROOT, dir, name)))
  .filter((file) => !covered.has(file))
  .sort();

for (const file of files) await import(pathToFileURL(file).href);
