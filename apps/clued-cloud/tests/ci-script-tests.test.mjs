// Every CI-script test (scripts/ci and scripts/ci/self-hosted) that no other
// application test already imports, run through the established quality unit
// entry like local-dev-tools.test.mjs (defect ddc94356): no other required
// suite runs them, they read files from across the repository and several
// load yaml from this application's install. New files join without an edit.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS, '..', '..', '..');
const SELF = path.basename(fileURLToPath(import.meta.url));

const imported = new Set();
for (const name of readdirSync(TESTS)) {
  if (!name.endsWith('.test.mjs') || name === SELF) continue;
  for (const match of readFileSync(path.join(TESTS, name), 'utf8').matchAll(/^import '\.\.\/\.\.\/\.\.\/(scripts\/ci\/[^']+\.test\.mjs)';$/gm)) {
    imported.add(match[1]);
  }
}

export const CI_SCRIPT_TESTS = ['scripts/ci', 'scripts/ci/self-hosted']
  .flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.test.mjs')).map((name) => `${dir}/${name}`))
  .filter((file) => !imported.has(file))
  .sort();

for (const file of CI_SCRIPT_TESTS) await import(pathToFileURL(path.join(ROOT, file)).href);
