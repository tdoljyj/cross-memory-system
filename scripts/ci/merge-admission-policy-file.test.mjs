// Merge Admission v0.1: the repository's own policy file and the workflows
// that pass the state, as a pull request head has them. Run by the ci-suites
// admission-self-tests suite on every pull request head, NOT by the admission job's self-test on the
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
import { RECOMMENDED_POLICY_TEXT } from "./merge-admission-policy.fixtures.mjs";
import { SUITE_COMMANDS } from "./ci-required-selection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("policy file: the repository's file loads, and since step 2 it is the recommended table (version 2)", () => {
  const loaded = readPolicy(ROOT);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.policy.version, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.policy)), JSON.parse(JSON.stringify(loadPolicy(RECOMMENDED_POLICY_TEXT).policy)));
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
  // Step 2: a pull request that is no longer open is not judged.
  assert.match(admission, /^ {6}github\.event\.action != 'closed' &&\n {6}github\.event\.pull_request\.state == 'open' &&\n/m);
  // Step 2 (§4.2): turning auto-merge on or off re-judges the pull request.
  assert.match(admission, /^ {4}types: \[opened, synchronize, reopened, edited, ready_for_review, closed, auto_merge_enabled, auto_merge_disabled\]$/m);
  const selfTests = (name) => read(name).split("\n").filter((line) => line.includes("node --test scripts/ci/clued-work-admission.test.mjs"));
  // The admission job (default branch, before every admission): content-independent tests only.
  const [admissionLine, ...more] = selfTests("clued-work-admission.yml");
  assert.deepEqual(more, []);
  assert.ok(admissionLine.includes("scripts/ci/merge-admission-policy.test.mjs"));
  assert.ok(!admissionLine.includes("merge-admission-policy-file.test.mjs"), "the file's own test never runs before admission");
  // ci-suites admission-self-tests (each pull request head): the file's test too.
  const suite = SUITE_COMMANDS["admission-self-tests"][0].argv;
  assert.ok(suite.includes("scripts/ci/merge-admission-policy.test.mjs") && suite.includes("scripts/ci/merge-admission-policy-file.test.mjs"));
});
