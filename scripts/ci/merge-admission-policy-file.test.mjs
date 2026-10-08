// Merge Admission v0.1: the repository's own policy file and the workflows
// that pass the state, as a pull request head has them. Run by clued-components
// on every pull request head, NOT by the admission job's self-test on the
// default branch: a later, Owner-approved change to these files must not fail
// the admission of every pull request (review MAJOR-1, the deadlock of Owner
// Decision 22c20e14). The admission run itself refuses a pull request whose
// policy file would not load (policyFileFindings).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPolicy, POLICY_PATH, readPolicy, STATE_VARIABLE } from "./merge-admission-policy.mjs";
import { COMPATIBILITY_POLICY_TEXT } from "./merge-admission-policy.fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("policy file: the repository's file loads, and in step 1 it is the compatibility table", () => {
  const loaded = readPolicy(ROOT);
  assert.deepEqual(loaded.errors, []);
  // Step 2 replaces the file with the recommended table and this expectation with it.
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.policy)), JSON.parse(JSON.stringify(loadPolicy(COMPATIBILITY_POLICY_TEXT).policy)));
  const text = fs.readFileSync(path.join(ROOT, POLICY_PATH), "utf8");
  assert.ok(!text.startsWith("\uFEFF"), "no byte order mark");
});

test("workflows: the admission and re-verification jobs read the state variable; the self-tests are split as intended", () => {
  const read = (name) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
  const admission = read("clued-work-admission.yml");
  const admit = admission.slice(admission.indexOf("id: admit"), admission.indexOf("--mode required"));
  assert.ok(admit.includes(`${STATE_VARIABLE}: \${{ vars.${STATE_VARIABLE} }}`));
  const post = admission.slice(admission.indexOf("- name: Post the result as the clued-admission App"), admission.indexOf("--mode app-check"));
  assert.ok(post.includes("ADMISSION_MODE: ${{ steps.admit.outputs.admission_mode }}"));
  assert.ok(read("clued-work-admission-reverify.yml").includes(`${STATE_VARIABLE}: \${{ vars.${STATE_VARIABLE} }}`));
  const selfTests = (name) => read(name).split("\n").filter((line) => line.includes("node --test scripts/ci/clued-work-admission.test.mjs"));
  // The admission job (default branch, before every admission): content-independent tests only.
  const [admissionLine, ...more] = selfTests("clued-work-admission.yml");
  assert.deepEqual(more, []);
  assert.ok(admissionLine.includes("scripts/ci/merge-admission-policy.test.mjs"));
  assert.ok(!admissionLine.includes("merge-admission-policy-file.test.mjs"), "the file's own test never runs before admission");
  // clued-components (each pull request head, both jobs): the file's test too.
  const components = selfTests("clued-components.yml");
  assert.equal(components.length, 2);
  for (const line of components) {
    assert.ok(line.includes("scripts/ci/merge-admission-policy.test.mjs") && line.includes("scripts/ci/merge-admission-policy-file.test.mjs"), line.trim());
  }
});
