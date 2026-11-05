// The "Admission self-tests on this head" step is written out in four places that
// nothing kept equal (defect fd06357f: a new test reached only the selection list):
// SUITE_COMMANDS['admission-self-tests'] of ci-required-selection.mjs, both jobs of
// .github/workflows/clued-components.yml and both entries of
// scripts/ci/clued-gated-proof-role-specs.json. They must list the same files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUITE_COMMANDS } from './ci-required-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const FIRST = 'scripts/ci/clued-work-admission.test.mjs';

const selection = SUITE_COMMANDS['admission-self-tests'][0].argv.slice(2);
const workflow = [...text('.github/workflows/clued-components.yml')
  .matchAll(/- name: Admission self-tests on this head\r?\n\s+run: node --test ([^\r\n]+)/g)].map((match) => match[1].split(' '));
const roleSpecs = [];
(function walk(value) {
  if (typeof value === 'string') {
    if (value.startsWith(`node --test ${FIRST}`)) roleSpecs.push(value.slice('node --test '.length).split(' '));
  } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
})(JSON.parse(text('scripts/ci/clued-gated-proof-role-specs.json')));

test('the admission self-test list is the same in the selection, the components workflow and the role specs', () => {
  assert.ok(selection.length > 0 && selection[0] === FIRST);
  assert.equal(workflow.length, 2, 'both jobs of clued-components.yml');
  assert.equal(roleSpecs.length, 2, 'both entries of the role specs');
  for (const list of [...workflow, ...roleSpecs]) assert.deepEqual(list, selection);
  for (const file of selection) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  assert.ok(selection.includes('scripts/ci/pr-repush-preflight.test.mjs'), 'the pre-push preflight is one of them');
});
