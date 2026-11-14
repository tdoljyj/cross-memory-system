// Policy tables for the merge admission self-tests (Merge Admission v0.1 §6).
// The admission job runs its self-tests from the default branch before every
// admission, so they must not depend on the repository's copy of
// config/merge-admission-policy.json: a later change to that file would fail
// them on main and refuse every pull request, the fix included (review
// MAJOR-1, the deadlock of Owner Decision 22c20e14). The tests judge against
// these fixed tables instead; merge-admission-policy-file.test.mjs, run on
// pull request heads only (ci-suites admission-self-tests), checks the repository's file.

import { BASELINE, STATE_VARIABLE } from "./merge-admission-policy.mjs";

export const DOCS_PATHS = Object.freeze(["docs/**", "development/contracts/**/*.md", "development/authority-index/**/*.md", "*.md",
  "skills/**/*.md"]);

// One rule row; the step 1 compatibility row unless overridden.
export const row = (overrides = {}) => ({ work_claim: "enforce", owner_grant: "none", up_to_date: "strict_only", merge_slot: "required",
  reruns_per_head: 0, auto_merge: "allowed", ...overrides });

export const policyText = ({ normal, efficiency, extra = {}, layers = {} }) => JSON.stringify({
  schema: "clued.merge-admission-policy/1",
  version: 1,
  state_variable: STATE_VARIABLE,
  merge_slot_hard_cap_minutes: 120,
  layers: { protected: { paths: [] }, docs: { paths: [...DOCS_PATHS] }, code: { paths: ["**"] }, ...layers },
  rules: {
    normal: { protected: BASELINE, ...normal },
    efficiency: { protected: BASELINE, ...efficiency },
    frozen: { all_layers_as: "protected", merge_actor: "owner_only", auto_merge: "forbidden" },
  },
  ...extra,
}, null, 2);

// §13 step 1: code and docs judge as before in normal and efficiency alike.
export const COMPATIBILITY_POLICY_TEXT = policyText({ normal: { code: row(), docs: row() }, efficiency: { code: row(), docs: row() } });

// §5.2 and §5.3, which step 2 puts in the repository as policy version 2.
export const RECOMMENDED_POLICY_TEXT = policyText({
  normal: { code: row({ reruns_per_head: 1 }), docs: row({ reruns_per_head: 2 }) },
  efficiency: { code: row({ work_claim: "advise", merge_slot: "advise", reruns_per_head: 2 }),
    docs: row({ work_claim: "advise", merge_slot: "advise", reruns_per_head: 2 }) },
  extra: { version: 2 },
});

// Every column the file can set at its loosest, in both states.
export const LOOSEST_ROW = Object.freeze(row({ work_claim: "advise", merge_slot: "advise", reruns_per_head: 3 }));
export const LOOSEST_POLICY_TEXT = policyText({ normal: { code: LOOSEST_ROW, docs: LOOSEST_ROW }, efficiency: { code: LOOSEST_ROW, docs: LOOSEST_ROW } });

// A readPolicyFile for evaluate(), reverify() and main() that returns one table.
export const fixedPolicy = (text = COMPATIBILITY_POLICY_TEXT) => () => text;
