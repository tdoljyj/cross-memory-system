// Merge Admission v0.1 §6: the invariants of the merge admission policy and
// the table-driven verdicts of clued-work-admission.mjs under it. No network:
// GitHub and Clued are a scripted fetch, the policy files fixed tables
// (merge-admission-policy.fixtures.mjs). Nothing here reads the repository's
// policy file, so the admission job can run it on the default branch whatever
// that file says (review MAJOR-1); merge-admission-policy-file.test.mjs checks
// the file itself on pull request heads.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BASELINE,
  CORE_PROTECTED_PATHS,
  effectiveProtectedPaths,
  effectiveRules,
  globToRegExp,
  HARD_CAP_DEFAULT_MINUTES,
  layerOf,
  LAYERS,
  loadPolicy,
  MAX_PATTERNS_PER_LAYER,
  modeLabel,
  parseModeLabel,
  POLICY_PATH,
  PROTECTED_BASELINE,
  resolveMode,
  resolveState,
  ROW_COLUMNS,
  STATE_VARIABLE,
  STATES,
  STRICTNESS,
  atLeastAsStrict,
} from "./merge-admission-policy.mjs";
import {
  COMPATIBILITY_POLICY_TEXT,
  DOCS_PATHS,
  fixedPolicy,
  LOOSEST_POLICY_TEXT,
  LOOSEST_ROW,
  RECOMMENDED_POLICY_TEXT,
  row,
} from "./merge-admission-policy.fixtures.mjs";
import {
  ADMISSION_APP_ID,
  appCheck,
  evaluate,
  main,
  mergeSlotCheck,
  PROTECTED_PATHS,
  PUBLIC_CONFIG_SOURCE,
  renderSummary,
} from "./clued-work-admission.mjs";

// The contract's §3.1 list, written out once more so that a change to the
// constant is a change to this test too.
const CONTRACT_CORE = [".github/**", "scripts/ci/**", "scripts/runner/**", "apps/clued-cloud/scripts/**",
  "apps/clued-cloud/package.json", "apps/clued-cloud/package-lock.json", "apps/clued-cloud/wrangler*.jsonc",
  "apps/clued-cloud/app/supabase-public-config.ts", ".gitattributes", "**/.gitattributes", ".gitmodules", ".npmrc", "**/.npmrc"];

const TABLES = { compat: COMPATIBILITY_POLICY_TEXT, recommended: RECOMMENDED_POLICY_TEXT, loosest: LOOSEST_POLICY_TEXT };

// A path that each glob of CORE_PROTECTED_PATHS matches.
const sampleOf = (glob) => glob.replace(/\*\*\//g, "a/b/").replace(/\*\*/g, "a/b").replace(/\*/g, "x");

// ---------------------------------------------------------------------------
// The constants and the fixed tables.

test("policy: the fixed tables load, and the compatibility table is step 1's", () => {
  for (const [name, text] of Object.entries(TABLES)) assert.deepEqual(loadPolicy(text).errors, [], name);
  const { policy } = loadPolicy(COMPATIBILITY_POLICY_TEXT);
  assert.equal(policy.merge_slot_hard_cap_minutes, HARD_CAP_DEFAULT_MINUTES);
  assert.deepEqual([...policy.layers.docs], [...DOCS_PATHS]);
  assert.deepEqual([...policy.layers.code], ["**"]);
  // §13 step 1: three layers enforce the claim and require the merge slot, no
  // re-runs, and an Owner Grant and the base tip only for the protected layer.
  for (const state of ["normal", "efficiency"]) {
    for (const layer of ["code", "docs"]) assert.deepEqual({ ...policy.rules[state][layer] }, row(), `${state}.${layer}`);
  }
  assert.deepEqual({ ...PROTECTED_BASELINE }, { ...row({ owner_grant: "required", up_to_date: "check_and_strict", reruns_per_head: 1 }), merge_actor: "any" });
});

test("policy: CORE_PROTECTED_PATHS is the contract's list; PROTECTED_PATHS adds the policy file", () => {
  assert.deepEqual([...CORE_PROTECTED_PATHS], CONTRACT_CORE);
  assert.ok(Object.isFrozen(CORE_PROTECTED_PATHS) && Object.isFrozen(PROTECTED_BASELINE) && Object.isFrozen(STRICTNESS));
  assert.ok(CORE_PROTECTED_PATHS.includes(PUBLIC_CONFIG_SOURCE));
  assert.deepEqual([...PROTECTED_PATHS], [...CONTRACT_CORE, POLICY_PATH]);
  assert.deepEqual(effectiveProtectedPaths(null), [...CONTRACT_CORE, POLICY_PATH]);
  // The policy file is protected because it is named, not by accident of a glob.
  assert.ok(!CONTRACT_CORE.some((glob) => globToRegExp(glob).test(POLICY_PATH)));
  assert.equal(layerOf([POLICY_PATH], null), "protected");
});

// ---------------------------------------------------------------------------
// I1: the protected layer is never relaxed.

test("I1: in every state, and when the state or the file is bad, the protected layer is at least the baseline", () => {
  const states = [...STATES, "<unknown>", "<missing file>"];
  for (const [name, text] of Object.entries(TABLES)) {
    for (const requested of states) {
      const env = { [STATE_VARIABLE]: requested === "<unknown>" ? "relaxed" : requested === "<missing file>" ? "" : requested };
      const readFile = requested === "<missing file>" ? () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } : () => text;
      const mode = resolveMode({ env, workspace: "/w", readFile });
      for (const layer of LAYERS) {
        const rules = effectiveRules(mode.policy, mode.state, layer);
        const columns = layer === "protected" || mode.state === "frozen" ? Object.keys(STRICTNESS) : [];
        for (const column of columns) {
          assert.ok(atLeastAsStrict(column, rules[column], PROTECTED_BASELINE[column]), `${name}/${requested}/${layer}/${column}=${rules[column]}`);
        }
      }
      if (requested === "<unknown>" || requested === "<missing file>") assert.equal(mode.state, "frozen", `${name}/${requested}`);
    }
  }
});

test("I1: effectiveRules returns the baseline for the protected layer whatever the file says, and frozen for every layer", () => {
  const { policy } = loadPolicy(LOOSEST_POLICY_TEXT);
  for (const state of ["normal", "efficiency"]) {
    assert.equal(effectiveRules(policy, state, "protected"), PROTECTED_BASELINE);
    assert.deepEqual({ ...effectiveRules(policy, state, "code") }, { ...LOOSEST_ROW, merge_actor: "any" });
  }
  for (const layer of LAYERS) {
    assert.deepEqual({ ...effectiveRules(policy, "frozen", layer) }, { ...PROTECTED_BASELINE, auto_merge: "forbidden", merge_actor: "owner_only" });
  }
  // Fail closed: an unknown state or layer, or no policy, is never looser.
  assert.equal(effectiveRules(policy, "relaxed", "code").merge_actor, "owner_only");
  assert.equal(effectiveRules(policy, "normal", "vendor"), PROTECTED_BASELINE);
  assert.equal(effectiveRules(null, "normal", "code").merge_actor, "owner_only");
  // The file may not set the protected layer's rules.
  const rewritten = JSON.parse(LOOSEST_POLICY_TEXT);
  rewritten.rules.normal.protected = LOOSEST_ROW;
  assert.match(loadPolicy(JSON.stringify(rewritten)).errors.join("\n"), /policy\.rules\.normal\.protected: must be "<baseline>"/);
  assert.equal(BASELINE, "<baseline>");
});

// ---------------------------------------------------------------------------
// I2: protected paths can only be added to.

test("I2: every core protected path, the policy file and the policy's additions are protected under any policy", () => {
  const adversarial = JSON.parse(LOOSEST_POLICY_TEXT);
  adversarial.layers.docs.paths = [...CONTRACT_CORE, POLICY_PATH, "docs/**"];
  const policies = { none: null, compatibility: loadPolicy(COMPATIBILITY_POLICY_TEXT).policy, adversarial: loadPolicy(JSON.stringify(adversarial)).policy };
  assert.ok(policies.adversarial, "a docs layer that names protected paths is valid, and loses to the protected layer");
  for (const [name, policy] of Object.entries(policies)) {
    for (const glob of CONTRACT_CORE) {
      const sample = sampleOf(glob);
      assert.ok(globToRegExp(glob).test(sample), `${glob} -> ${sample}`);
      assert.equal(layerOf([sample], policy), "protected", `${name}: ${sample}`);
      assert.equal(layerOf(["docs/readme.md", sample], policy), "protected", `${name}: with docs, ${sample}`);
    }
    assert.equal(layerOf([POLICY_PATH], policy), "protected", `${name}: the policy file`);
  }
  // Additions count; exclusions cannot be written where they would remove one.
  const added = JSON.parse(COMPATIBILITY_POLICY_TEXT);
  added.layers.protected.paths = ["kernel/**"];
  assert.equal(layerOf(["kernel/x.py"], loadPolicy(JSON.stringify(added)).policy), "protected");
  for (const [where, paths] of [["protected", ["!scripts/ci/**"]], ["code", ["**", "!.github/**"]]]) {
    const broken = JSON.parse(COMPATIBILITY_POLICY_TEXT);
    broken.layers[where].paths = paths;
    assert.match(loadPolicy(JSON.stringify(broken)).errors.join("\n"), new RegExp(`policy\\.layers\\.${where}\\.paths: .* excludes a path`), where);
  }
});

test("layers: docs, the agent contract's exception, root Markdown, mixed pull requests and an unknown compare", () => {
  const { policy } = loadPolicy(COMPATIBILITY_POLICY_TEXT);
  for (const [paths, layer] of [
    [["docs/a/b.md"], "docs"], [["README.md"], "docs"], [["development/contracts/x/Y.v0.1.md"], "docs"],
    [["development/contracts/x/schema.json"], "code"], [["skills/clued/SKILL.md"], "docs"],
    [["protocol/agent/agent-contract.md"], "code"], [["skills/clued/references/agent-contract.md"], "docs"], [["apps/clued-cloud/README.md"], "code"],
    [["docs/a.md", "kernel/x.py"], "code"], [["docs/a.md", "kernel/x.py", ".github/workflows/x.yml"], "protected"],
    [["apps/clued-cloud/supabase/migrations/1_x.sql"], "code"], [[], "code"],
  ]) {
    assert.equal(layerOf(paths, policy), layer, JSON.stringify(paths));
  }
  assert.equal(layerOf(["docs/a.md"], policy, { unknown: true }), "protected");
  // Without a usable policy there is no docs layer.
  assert.equal(layerOf(["docs/a.md"], null), "code");
});

// ---------------------------------------------------------------------------
// I3: fail closed.

test("I3: a state value that is not exactly one of the three, a missing, unreadable or malformed policy is frozen", () => {
  assert.deepEqual(resolveState({}), { state: "normal", source: "default" });
  assert.deepEqual(resolveState({ [STATE_VARIABLE]: "  " }), { state: "normal", source: "default" });
  for (const value of STATES) assert.deepEqual(resolveState({ [STATE_VARIABLE]: ` ${value} ` }), { state: value, source: STATE_VARIABLE });
  for (const value of ["Normal", "EFFICIENCY", "off", "normal,efficiency", "0", "true", "nörmal", "__proto__"]) {
    const resolved = resolveState({ [STATE_VARIABLE]: value });
    assert.equal(resolved.state, "frozen", value);
    assert.match(resolved.error, /is not one of normal, frozen, efficiency/);
  }
  const base = JSON.parse(COMPATIBILITY_POLICY_TEXT);
  const mutate = (fn) => { const doc = structuredClone(base); fn(doc); return JSON.stringify(doc); };
  const broken = {
    "not json": "{",
    "an array": "[]",
    "wrong schema": mutate((d) => { d.schema = "clued.merge-admission-policy/2"; }),
    "no version": mutate((d) => { delete d.version; }),
    "other state variable": mutate((d) => { d.state_variable = "CLUED_WORK_ADMISSION_ENFORCE"; }),
    "hard cap below range": mutate((d) => { d.merge_slot_hard_cap_minutes = 30; }),
    "hard cap not an integer": mutate((d) => { d.merge_slot_hard_cap_minutes = 120.5; }),
    "unknown top-level key": mutate((d) => { d.bypass = true; }),
    "a prototype key": '{"__proto__": {"x": 1}}',
    "unknown layer": mutate((d) => { d.layers.vendor = { paths: [] }; }),
    "a path with whitespace": mutate((d) => { d.layers.docs.paths.push("docs/a b.md"); }),
    "three wildcards": mutate((d) => { d.layers.docs.paths.push("**/a*/b*.md"); }),
    "one long run of stars": mutate((d) => { d.layers.docs.paths.push(`${"*".repeat(24)}b`); }),
    "three stars": mutate((d) => { d.layers.protected.paths.push("kernel/***"); }),
    "too many patterns": mutate((d) => { d.layers.protected.paths = Array.from({ length: MAX_PATTERNS_PER_LAYER + 1 }, (_, i) => `kernel/${i}/**`); }),
    "no catch-all code layer": mutate((d) => { d.layers.code.paths = ["apps/**"]; }),
    "a missing column": mutate((d) => { delete d.rules.normal.code.merge_slot; }),
    "an unknown column": mutate((d) => { d.rules.normal.docs.reviewers = 0; }),
    "a value out of its column": mutate((d) => { d.rules.efficiency.code.reruns_per_head = 4; }),
    "merge_actor in a row": mutate((d) => { d.rules.normal.code.merge_actor = "any"; }),
    "a looser frozen": mutate((d) => { d.rules.frozen.auto_merge = "allowed"; }),
    "a fourth state": mutate((d) => { d.rules.release = d.rules.normal; }),
    "a missing state": mutate((d) => { delete d.rules.efficiency; }),
    "baseline rewritten": mutate((d) => { d.rules.efficiency.protected = d.rules.efficiency.code; }),
  };
  for (const [name, text] of Object.entries(broken)) {
    const loaded = loadPolicy(text);
    assert.equal(loaded.policy, null, name);
    assert.ok(loaded.errors.length > 0, name);
    const mode = resolveMode({ env: { [STATE_VARIABLE]: "efficiency" }, workspace: "/w", readFile: () => text });
    assert.equal(mode.state, "frozen", name);
    assert.equal(mode.requested, "efficiency", name);
  }
  // Left out: the hard cap is 120. A byte order mark is not an error (review NIT-1).
  assert.equal(loadPolicy(mutate((d) => { delete d.merge_slot_hard_cap_minutes; })).policy.merge_slot_hard_cap_minutes, 120);
  assert.deepEqual(loadPolicy(`\uFEFF${COMPATIBILITY_POLICY_TEXT}`).errors, []);
  const missing = resolveMode({ env: {}, workspace: "/w", readFile: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  assert.deepEqual([missing.state, missing.errors], ["frozen", [`${POLICY_PATH} cannot be read: ENOENT`]]);
  assert.match(resolveMode({ env: {}, workspace: undefined }).errors[0], /GITHUB_WORKSPACE is not set/);
  assert.deepEqual(ROW_COLUMNS, ["work_claim", "owner_grant", "up_to_date", "merge_slot", "reruns_per_head", "auto_merge"]);
});

// ---------------------------------------------------------------------------
// The verdict matrix (§6): (table, state, layer, scenario) -> verdict, through
// evaluate() with a scripted GitHub and Clued. "A+" admitted with a passing
// kooyumi-merge-slot check, "A-" admitted with a failing one, "R:<reason>" not
// admitted for that first reason. Adding a column or a state adds rows here.

const API = "https://api.test";
const CLUED = "https://clued.test";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TIP = "7".repeat(40);
const EARLIER = "e".repeat(40);
const MERGED = "f".repeat(40);
const MERGE_BASE = "9".repeat(40);
const CLAIM = "0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
const SLOT = "merge:o/r:main";
const CLAIM_BASE = "c".repeat(40);
const LAYER_FILE = { protected: "scripts/ci/tool.mjs", code: "apps/clued-cloud/worker/x.ts", docs: "docs/notes/x.md" };

const SCENARIOS = {
  ok: {},
  claim_missing: { bindingMissing: true, trailer: false },
  claim_expired: { verdict: "REJECTED", reasons: ["claim_expired"] },
  write_set_not_covering: { verdict: "REJECTED", reasons: ["paths_outside_write_set"] },
  no_grant: { grant: false },
  // The head only merged main into an earlier head that the Owner approved
  // (Owner Decision a0d93cd0): no grant on the head itself.
  grant_carried: { grant: false, carried: true },
  not_up_to_date: { upToDate: false },
  slot_not_held: { slotHeld: false },
  auto_merge_on: { autoMerge: { merge_method: "squash" } },
};

// Native relation is independently scripted; explanatory PR prose is never authority.
const bindingReply = (input, claim, missing = false) => ({
  status: 'ok', binding_status: missing ? 'unbound' : 'bound', reason: null,
  repository: 'o/r', pr_number: 9, pr_ref: 'o/r#9', head_sha: input.head_sha,
  base_sha: input.base_sha, target_branch: input.target_branch, scope: 'global',
  task_id: missing ? null : claim.task_id, claim: missing ? null : claim,
  auto_bound: false, receipt_id: null,
  head_authorization_id: missing ? null : '00000000-0000-4000-8000-000000000902',
});

const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

function scriptFor(layer, scenario, { policyFileAtHead = null } = {}) {
  const s = { trailer: true, verdict: "ADMITTED", reasons: [], upToDate: true, grant: true, carried: false, slotHeld: true, autoMerge: null, ...scenario };
  const files = s.files ?? [{ filename: LAYER_FILE[layer], status: "modified" }];
  const calls = [];
  const pull = { number: 9, body: s.trailer ? `Why\n\nClued-Work-Claim: ${CLAIM}` : "Why", changed_files: files.length, auto_merge: s.autoMerge,
    head: { sha: HEAD, repo: { full_name: "o/r" } }, base: { sha: BASE, ref: "main" } };
  const claim = { claim_id: CLAIM, task_id: "00000000-0000-4000-8000-000000000901", context_key: "global", execution_epoch: 1, lease_version: 1, execution_handover_pending: false, status: "ACTIVE", fence: 1, expires_at: "2026-10-08T05:00:00Z", write_set: files.map((f) => f.filename),
    trigger_refs: s.slotHeld ? [SLOT] : [], merge_slot_until: "2026-10-08T03:00:00Z",
    ...(s.claimBaseStatus ? { base_commit: CLAIM_BASE } : {}) };
  const commits = { [HEAD]: s.carried ? [EARLIER, MERGED] : [BASE], [EARLIER]: [BASE] };
  const routes = [
    ["GET", `${API}/repos/o/r/pulls/9/files`, () => files],
    ["GET", `${API}/repos/o/r/pulls/9`, () => pull],
    ["GET", `${API}/repos/o/r/branches/main`, () => ({ name: "main", commit: { sha: TIP } })],
    ["GET", `${API}/repos/o/r/compare/${TIP}...${HEAD}`, () => ({ status: s.upToDate ? "ahead" : "diverged", files: files.map((f) => ({ filename: f.filename })) })],
    // The claim's base_commit against the pull request's base: 200, 404 (unknown) or 500.
    ["GET", `${API}/repos/o/r/compare/${CLAIM_BASE}...${BASE}`, () => (s.claimBaseStatus === 200 ? { status: "ahead", files: [] }
      : s.claimBaseStatus === 404 ? null : { failWith: s.claimBaseStatus })],
    ["GET", `${API}/repos/o/r/contents/${POLICY_PATH}`, () => (policyFileAtHead === null ? null : { content: Buffer.from(policyFileAtHead).toString("base64"), encoding: "base64" })],
    // The carry-over walk (carriedApprovalSource).
    ["GET", `${API}/repos/o/r/compare/${MERGED}...${TIP}`, () => ({ status: "identical", files: [] })],
    ["GET", `${API}/repos/o/r/compare/${EARLIER}...${HEAD}`, () => ({ status: "ahead", files: [{ filename: "merged-from-main.txt" }] })],
    ["GET", `${API}/repos/o/r/compare/${TIP}...${EARLIER}`, () => ({ status: "diverged", files: files.map((f) => ({ filename: f.filename })), merge_base_commit: { sha: MERGE_BASE } })],
    ["GET", `${API}/repos/o/r/compare/${MERGE_BASE}...${TIP}`, () => ({ status: "ahead", files: [{ filename: "main-only.txt" }] })],
    ["GET", `${API}/repos/o/r/commits/${EARLIER}/check-runs`, () => ({ check_runs: [{ id: 1, name: s.historicalCheckName ?? "kooyumi-admission-verified", head_sha: EARLIER,
      status: "completed", conclusion: "success", app: { id: s.historicalCheckApp ?? ADMISSION_APP_ID } }] })],
    ["GET", `${API}/repos/o/r/commits/${HEAD}`, () => ({ sha: HEAD, commit: { message: "x" }, parents: commits[HEAD].map((sha) => ({ sha })) })],
    ["GET", `${API}/repos/o/r/commits/${EARLIER}`, () => ({ sha: EARLIER, commit: { message: "x" }, parents: commits[EARLIER].map((sha) => ({ sha })) })],
    ["POST", `${CLUED}/rest/v1/rpc/clued_work_verify_v1`, (body) => body.p_input.action === "resolve_pr_claim"
      ? bindingReply(body.p_input, claim, s.bindingMissing) : ({ status: "ok", verdict: s.verdict, reasons: s.reasons,
      paths_outside_write_set: s.reasons.includes("paths_outside_write_set") ? [files[0].filename] : [], verified_at: "2026-10-08T02:30:00Z", claim })],
    ["POST", `${CLUED}/rest/v1/rpc/clued_owner_grant_admission_door_v1`, (body) => {
      const granted = body.p_input.resources[0] === `repo:o/r/${EARLIER}` ? s.carried : s.grant;
      return { status: "ok", admitted: granted, grant: granted ? { grant_id: "g-1" } : null, owner_request: granted ? null : { confirm_path: "/owner/confirm/1" } };
    }],
  ];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: target, body });
    const route = routes.find(([m, prefix]) => m === method && (target === prefix || target.startsWith(`${prefix}?`)));
    if (!route) return { ok: false, status: 599, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    const answer = route[2](body);
    if (answer === null || (answer && answer.failWith)) {
      const status = answer === null ? 404 : answer.failWith;
      return { ok: false, status, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    }
    return json(answer);
  };
  return { pull, fetchImpl, calls };
}

const matrixEnv = (state, extra = {}) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "ghs_test", GITHUB_API_URL: API, GITHUB_RUN_ID: "9001",
  CLUED_SUPABASE_URL: CLUED, CLUED_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", CLUED_CONTEXT_READ_TOKEN: "clued_bnd_test",
  [STATE_VARIABLE]: state, ...extra });

async function judge({ table = COMPATIBILITY_POLICY_TEXT, state, layer, scenario, env = {}, readPolicyFile = fixedPolicy(table), policyFileAtHead }) {
  const { pull, fetchImpl, calls } = scriptFor(layer, typeof scenario === "string" ? SCENARIOS[scenario] : scenario, { policyFileAtHead });
  const outcome = await evaluate({ env: matrixEnv(state, env), event: { pull_request: pull }, eventName: "pull_request", fetchImpl,
    workspace: "/w", withSummary: false, readPolicyFile });
  const slot = mergeSlotCheck({ admitted: outcome.admitted, state: outcome.merge_slot ? outcome.merge_slot.state : "unknown",
    ref: SLOT, branch: "main", mode: outcome.admission_mode && outcome.admission_mode.label });
  const cell = outcome.admitted ? (slot.success ? "A+" : "A-") : `R:${(outcome.reasons[0] ?? outcome.verdict ?? "").split(/[:( ]/)[0]}`;
  return { cell, outcome, calls };
}

const CELLS = ["normal.protected", "normal.code", "normal.docs", "efficiency.protected", "efficiency.code", "efficiency.docs",
  "frozen.protected", "frozen.code", "frozen.docs"];
const R = (reason) => `R:${reason}`;
const all = (value) => CELLS.map(() => value);
const byLayer = (protectedCell, otherCell, frozenCell) => [protectedCell, otherCell, otherCell, protectedCell, otherCell, otherCell,
  frozenCell, frozenCell, frozenCell];

// Step 1's compatibility table: code and docs judge as before in normal and
// efficiency alike; frozen judges every layer as protected, with no carry-over.
const COMPAT_EXPECTED = {
  ok: all("A+"),
  claim_missing: all(R("pr_task_binding_unbound")),
  claim_expired: all(R("claim_expired")),
  write_set_not_covering: all(R("paths_outside_write_set")),
  no_grant: byLayer(R("owner_review_required"), "A+", R("owner_review_required")),
  grant_carried: byLayer("A+", "A+", R("owner_review_required")),
  not_up_to_date: byLayer(R("protected_change_not_up_to_date"), "A+", R("protected_change_not_up_to_date")),
  slot_not_held: all("A-"),
  auto_merge_on: byLayer("A+", "A+", "A-"),
};
// The recommended table: efficiency advises the claim and the merge slot for
// code and docs; normal is as strict as the compatibility table.
const efficiencyRelaxed = (strict) => [strict, strict, strict, strict, "A+", "A+", strict, strict, strict];
const RECOMMENDED_EXPECTED = {
  ...COMPAT_EXPECTED,
  claim_missing: efficiencyRelaxed(R("pr_task_binding_unbound")),
  claim_expired: efficiencyRelaxed(R("claim_expired")),
  write_set_not_covering: efficiencyRelaxed(R("paths_outside_write_set")),
  slot_not_held: efficiencyRelaxed("A-"),
};
// Every column at its loosest in both states: code and docs pass everything
// but frozen; the protected layer is the compatibility table's.
const looseEverywhere = (strict, frozen = strict) => [strict, "A+", "A+", strict, "A+", "A+", frozen, frozen, frozen];
const LOOSEST_EXPECTED = {
  ok: all("A+"),
  claim_missing: looseEverywhere(R("pr_task_binding_unbound")),
  claim_expired: looseEverywhere(R("claim_expired")),
  write_set_not_covering: looseEverywhere(R("paths_outside_write_set")),
  no_grant: looseEverywhere(R("owner_review_required")),
  grant_carried: looseEverywhere("A+", R("owner_review_required")),
  not_up_to_date: looseEverywhere(R("protected_change_not_up_to_date")),
  slot_not_held: looseEverywhere("A-"),
  auto_merge_on: looseEverywhere("A+", "A-"),
};
const EXPECTED = { compat: COMPAT_EXPECTED, recommended: RECOMMENDED_EXPECTED, loosest: LOOSEST_EXPECTED };

const results = {};
async function matrixOf(table) {
  if (results[table]) return results[table];
  const grid = {};
  for (const scenario of Object.keys(SCENARIOS)) {
    grid[scenario] = [];
    for (const cell of CELLS) {
      const [state, layer] = cell.split(".");
      const { cell: got, outcome } = await judge({ table: TABLES[table], state, layer, scenario });
      assert.deepEqual([outcome.admission_mode.state, outcome.admission_mode.layer], [state, layer], `${table}/${scenario}/${cell}`);
      grid[scenario].push(got);
    }
  }
  results[table] = grid;
  return grid;
}

for (const table of Object.keys(TABLES)) {
  test(`matrix (${table} table): every state, layer and scenario gives the fixture's verdict`, async () => {
    const grid = await matrixOf(table);
    assert.deepEqual(Object.keys(EXPECTED[table]).sort(), Object.keys(SCENARIOS).sort());
    for (const [scenario, expected] of Object.entries(EXPECTED[table])) {
      assert.deepEqual(Object.fromEntries(CELLS.map((cell, i) => [cell, grid[scenario][i]])),
        Object.fromEntries(CELLS.map((cell, i) => [cell, expected[i]])), `${table}/${scenario}`);
    }
  });
}

test("conservation (I1 as behavior): the protected layer's verdict is the same in normal and efficiency, under every table", async () => {
  const reference = await matrixOf("compat");
  for (const table of Object.keys(TABLES)) {
    const grid = await matrixOf(table);
    for (const scenario of Object.keys(SCENARIOS)) {
      const at = (cell) => grid[scenario][CELLS.indexOf(cell)];
      assert.equal(at("normal.protected"), at("efficiency.protected"), `${table}/${scenario}`);
      assert.equal(at("normal.protected"), reference[scenario][CELLS.indexOf("normal.protected")], `${table}/${scenario} vs compat`);
      assert.equal(at("frozen.protected"), reference[scenario][CELLS.indexOf("frozen.protected")], `${table}/${scenario} frozen vs compat`);
    }
  }
});

// ---------------------------------------------------------------------------
// What the matrix's cells mean, one by one.

test("policy claim requirement follows Native binding independently of explanatory prose", async () => {
  const bound = await judge({ state: "normal", layer: "code", scenario: { trailer: false } });
  assert.equal(bound.outcome.admitted, true);
  const unbound = await judge({ state: "normal", layer: "code", scenario: { bindingMissing: true, trailer: true } });
  assert.deepEqual([unbound.outcome.admitted, unbound.outcome.reasons], [false, ["pr_task_binding_unbound"]]);
});

test("advise: an unbound PR is advised after Native resolution without a full CI verification or merge slot", async () => {
  const { outcome, calls } = await judge({ table: RECOMMENDED_POLICY_TEXT, state: "efficiency", layer: "code", scenario: "claim_missing" });
  assert.equal(outcome.verdict, "ADMITTED");
  assert.ok(outcome.notices.some((notice) => notice.startsWith("claim_advisory_missing:")));
  assert.equal(calls.filter((call) => call.url.endsWith("/clued_work_verify_v1")).length, 1);
  assert.equal(calls.find((call) => call.url.endsWith("/clued_work_verify_v1")).body.p_input.action, "resolve_pr_claim");
  assert.deepEqual([outcome.merge_slot.state, outcome.merge_slot.observed], ["not_required", "missing"]);
  assert.match(mergeSlotCheck({ admitted: true, state: "not_required", mode: outcome.admission_mode.label }).title, /^not_required\(code, efficiency\)$/);
  // A claim that does not admit the pull request: its reasons become notices.
  const expired = await judge({ table: RECOMMENDED_POLICY_TEXT, state: "efficiency", layer: "docs", scenario: "claim_expired" });
  assert.deepEqual([expired.outcome.verdict, expired.outcome.claim_verdict, expired.outcome.reasons], ["ADMITTED", "REJECTED", []]);
  assert.ok(expired.outcome.notices.includes("claim_advisory:claim_expired"));
});

test("advise: a claim base that cannot be compared is a notice; enforced, it is an error or claim_base_unknown as before", async () => {
  for (const [state, status, expect] of [
    ["efficiency", 500, { admitted: true, notice: /^claim_advisory_unverified: the claim's base_commit could not be compared \(GitHub API .* returned 500\)$/ }],
    ["efficiency", 404, { admitted: true, notice: new RegExp(`^claim_advisory:claim_base_unknown:${CLAIM_BASE}$`) }],
    ["efficiency", 200, { admitted: true }],
    ["normal", 404, { admitted: false, reason: new RegExp(`^claim_base_unknown:${CLAIM_BASE}$`) }],
  ]) {
    const { outcome } = await judge({ table: RECOMMENDED_POLICY_TEXT, state, layer: "code", scenario: { claimBaseStatus: status } });
    assert.equal(outcome.admitted, expect.admitted, `${state}/${status}`);
    if (expect.notice) assert.ok(outcome.notices.some((notice) => expect.notice.test(notice)), `${state}/${status}: ${outcome.notices.join(" | ")}`);
    if (expect.reason) assert.match(outcome.reasons[0], expect.reason);
  }
  await assert.rejects(judge({ table: RECOMMENDED_POLICY_TEXT, state: "normal", layer: "code", scenario: { claimBaseStatus: 500 } }), /returned 500/);
});

test("display-name migration preserves historical Owner Grant revalidation without accepting a foreign App", async () => {
  for (const historicalCheckName of ["clued-admission-verified", "kooyumi-admission-verified"]) {
    const { outcome, calls } = await judge({ state: "normal", layer: "protected",
      scenario: { ...SCENARIOS.grant_carried, historicalCheckName } });
    assert.equal(outcome.admitted, true, historicalCheckName);
    assert.ok(calls.some(call => call.body?.p_input?.resources?.[0] === `repo:o/r/${EARLIER}`), "live original Grant revalidation remains required");
    const foreign = await judge({ state: "normal", layer: "protected",
      scenario: { ...SCENARIOS.grant_carried, historicalCheckName, historicalCheckApp: 15368 } });
    assert.equal(foreign.outcome.admitted, false, historicalCheckName);
  }
});

test("frozen: every head needs its own Owner Grant, never carried over, and auto-merge fails the merge slot", async () => {
  const { outcome, calls } = await judge({ state: "frozen", layer: "code", scenario: "ok" });
  const door = calls.filter((call) => call.url.endsWith("/clued_owner_grant_admission_door_v1"));
  assert.equal(door.length, 1, "asked once, for the head, with no carry-over lookup");
  assert.deepEqual(door[0].body.p_input.resources, [`repo:o/r/${HEAD}`]);
  assert.match(door[0].body.p_input.note, /merge admission is frozen, so this code-layer change of 1 path\(s\) needs an Owner Grant too/);
  assert.equal(calls.filter((call) => call.url === `${API}/repos/o/r/commits/${HEAD}`).length, 0, "no carry-over walk");
  assert.ok(outcome.notices.some((notice) => notice.startsWith("owner_review_granted:g-1 (state_frozen:code)")));
  // Review MINOR-1: the protected layer's approval does not carry over either.
  const carried = await judge({ state: "normal", layer: "protected", scenario: "grant_carried" });
  assert.ok(carried.outcome.notices.some((notice) => notice.startsWith(`owner_review_carried:g-1 from ${EARLIER}`)));
  const frozenCarried = await judge({ state: "frozen", layer: "protected", scenario: "grant_carried" });
  assert.equal(frozenCarried.calls.filter((call) => call.url === `${API}/repos/o/r/commits/${HEAD}`).length, 0, "no carry-over walk in frozen");
  assert.match(frozenCarried.outcome.reasons[0], /^owner_review_required \(protected_path:scripts\/ci\/tool\.mjs\)/);
  // Review NIT-4: a frozen head that does not contain the tip says a new grant is needed.
  const behind = await judge({ state: "frozen", layer: "docs", scenario: "not_up_to_date" });
  assert.match(behind.outcome.reasons[0], /\(merge main into the branch first; state_frozen:docs; merge admission is frozen, so the new head needs its own Owner Grant\)$/);
  const auto = await judge({ state: "frozen", layer: "docs", scenario: "auto_merge_on" });
  assert.deepEqual([auto.outcome.admitted, auto.outcome.merge_slot.state], [true, "auto_merge_forbidden"]);
  const check = mergeSlotCheck({ admitted: true, state: "auto_merge_forbidden" });
  assert.deepEqual([check.success, check.title], [false, "Auto-merge is not allowed while merge admission is frozen"]);
});

test("fail closed: an unknown state or a broken policy file judges a code change as frozen", async () => {
  const unknown = await judge({ state: "relaxed", layer: "code", scenario: "no_grant" });
  assert.equal(unknown.cell, R("owner_review_required"));
  assert.deepEqual([unknown.outcome.admission_mode.state, unknown.outcome.admission_mode.requested], ["frozen", "frozen"]);
  const broken = await judge({ state: "normal", layer: "docs", scenario: "no_grant", readPolicyFile: () => "{" });
  assert.equal(broken.cell, R("owner_review_required"));
  assert.match(renderSummary(broken.outcome), /fail closed to frozen: config\/merge-admission-policy\.json is not JSON/);
  const none = await judge({ state: "", layer: "code", scenario: "no_grant", readPolicyFile: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  assert.equal(none.cell, R("owner_review_required"));
});

test("policy file: a pull request whose head's policy would not load, or that removes it, is refused (review MAJOR-1)", async () => {
  const change = (status, extra = {}) => ({ files: [{ filename: POLICY_PATH, status, ...extra }] });
  const valid = await judge({ state: "normal", layer: "protected", scenario: change("modified"), policyFileAtHead: RECOMMENDED_POLICY_TEXT });
  assert.equal(valid.cell, "A+");
  assert.equal(valid.outcome.admission_mode.layer, "protected");
  // A copy of the file elsewhere removes nothing (review 2, NIT).
  const copied = await judge({ state: "normal", layer: "protected", scenario: change("copied", { filename: "config/copy.json", previous_filename: POLICY_PATH }) });
  assert.deepEqual([copied.cell, copied.outcome.reasons], ["A+", []]);
  for (const [name, scenario, head, reason] of [
    ["invalid", change("modified"), "{", /^policy_file_invalid:config\/merge-admission-policy\.json is not JSON/],
    ["a looser frozen", change("modified"), COMPATIBILITY_POLICY_TEXT.replace('"auto_merge": "forbidden"', '"auto_merge": "allowed"'),
      /^policy_file_invalid:policy\.rules\.frozen: must be exactly/],
    ["missing at the head", change("modified"), null, /^policy_file_invalid:missing at the head$/],
    ["removed", change("removed"), null, /^policy_file_removed:config\/merge-admission-policy\.json$/],
    ["renamed away", change("renamed", { filename: "config/old-policy.json", previous_filename: POLICY_PATH }), null, /^policy_file_removed:/],
    ["a new schema before its loader", change("modified"), COMPATIBILITY_POLICY_TEXT.replace("merge-admission-policy/1", "merge-admission-policy/2"),
      /^policy_file_invalid:policy\.schema: must be clued\.merge-admission-policy\/1$/],
  ]) {
    const { outcome, calls } = await judge({ state: "normal", layer: "protected", scenario, policyFileAtHead: head });
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"], name);
    assert.match(outcome.reasons.find((reason) => reason.startsWith("policy_file_")), reason, name);
    const verify = calls.find((call) => call.url.endsWith("/clued_work_verify_v1") && call.body.p_input.action !== "resolve_pr_claim");
    assert.equal(verify.body.p_input.head_sha, undefined, `${name}: verified read-only, so the claim is not bound`);
  }
});

test("the retired switches (Merge Admission step 6): CLUED_WORK_ADMISSION_ENFORCE and CLUED_OWNER_REVIEW_ENFORCE change nothing in any state", async () => {
  // Only the policy advises (efficiency, code and docs); the two repository
  // variables are no longer read, whether unset, "false" or "true".
  for (const off of [{ CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_OWNER_REVIEW_ENFORCE: "" },
    { CLUED_WORK_ADMISSION_ENFORCE: "false", CLUED_OWNER_REVIEW_ENFORCE: "false" },
    { CLUED_WORK_ADMISSION_ENFORCE: "true", CLUED_OWNER_REVIEW_ENFORCE: "true" }]) {
    for (const state of STATES) {
      for (const layer of LAYERS) {
        for (const scenario of ["claim_missing", "no_grant", "not_up_to_date", "slot_not_held"]) {
          const plain = await judge({ state, layer, scenario });
          const retired = await judge({ state, layer, scenario, env: off });
          const where = `${JSON.stringify(off)} ${state}.${layer} ${scenario}`;
          assert.deepEqual([retired.cell, retired.outcome.enforced, retired.outcome.advisory], [plain.cell, true, undefined], where);
          assert.equal(retired.outcome.admission_mode.legacy_advisory, undefined, where);
          assert.ok(!/legacy-advisory|advisory \(|NOT_ENFORCED/.test(renderSummary(retired.outcome)), where);
        }
      }
    }
  }
  const off = { CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_OWNER_REVIEW_ENFORCE: "" };
  const claim = await judge({ state: "normal", layer: "protected", scenario: "claim_missing", env: off });
  assert.deepEqual([claim.cell, claim.outcome.verdict], [R("pr_task_binding_unbound"), "REJECTED"]);
  const review = await judge({ state: "normal", layer: "protected", scenario: "no_grant", env: off });
  assert.deepEqual([review.cell, review.outcome.owner_review.kind], [R("owner_review_required"), "pending"]);
});

// ---------------------------------------------------------------------------
// Visibility (§10).

test("parseModeLabel: the gate reads back exactly the labels the admission run writes, and nothing else", () => {
  for (const state of STATES) {
    for (const layer of LAYERS) {
      for (const reruns of STRICTNESS.reruns_per_head) {
        const label = modeLabel(state, layer, row({ reruns_per_head: reruns }));
        for (const verdict of ["ADMITTED", "REJECTED", "RE-VERIFIED: REJECTED"]) {
          assert.deepEqual(parseModeLabel(`${verdict} [${label}]`), { state, layer, reruns_per_head: reruns }, `${verdict} [${label}]`);
        }
      }
    }
  }
  assert.deepEqual(parseModeLabel("ADMITTED [normal · code · reruns 1]  "), { state: "normal", layer: "code", reruns_per_head: 1 });
  for (const title of [null, undefined, "", "ADMITTED", "ERROR", "ADMITTED [normal · code · reruns 4]", "ADMITTED [normal · vendor · reruns 1]",
    "ADMITTED [relaxed · code · reruns 1]", "ADMITTED [normal - code - reruns 1]", "ADMITTED [normal · code · reruns 1] trailing",
    "ADMITTED [normal · code · reruns -1]", "ADMITTED (normal · code · reruns 1)", "ADMITTED [Normal · code · reruns 1]"]) {
    assert.equal(parseModeLabel(title), null, String(title));
  }
});

test("visibility: the summary leads with the mode and its rules; the outputs and the App check's title carry the label", async () => {
  const { outcome } = await judge({ state: "", layer: "docs", scenario: "ok" });
  assert.equal(outcome.admission_mode.label, "normal · docs · reruns 0");
  assert.equal(modeLabel("normal", "docs", row()), "normal · docs · reruns 0");
  const summary = renderSummary(outcome);
  assert.match(summary, /^## kooyumi-work-admission\n\n\*\*Mode:\*\* `normal` · layer `docs` · source `default` · policy v1\n\*\*Verdict:\*\* `ADMITTED`/);
  assert.match(summary, /\| work_claim \| owner_grant \| up_to_date \| merge_slot \| reruns_per_head \| auto_merge \| merge_actor \|\n\| --- \| --- \| --- \| --- \| --- \| --- \| --- \|\n\| enforce \| none \| strict_only \| required \| 0 \| allowed \| any \|/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-admission-main-"));
  const eventPath = path.join(dir, "event.json");
  const output = (name) => path.join(dir, name);
  const { pull, fetchImpl } = scriptFor("protected", SCENARIOS.ok);
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: pull }));
  const base = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_WORKSPACE: "/w" };
  const options = { readPolicyFile: fixedPolicy() };
  let code = await main(["--mode", "required"], { ...matrixEnv("efficiency"), ...base, GITHUB_OUTPUT: output("o1") }, fetchImpl, options);
  assert.equal(code, 0);
  assert.ok(fs.readFileSync(output("o1"), "utf8").split("\n").includes("admission_mode=efficiency · protected · reruns 1"));
  // Review MINOR-2: a run that fails still reports its mode; frozen is enforced
  // whatever CLUED_WORK_ADMISSION_ENFORCE says.
  code = await main(["--mode", "required"], { ...matrixEnv("frozen", { CLUED_WORK_ADMISSION_ENFORCE: "", GITHUB_TOKEN: "" }), ...base,
    GITHUB_OUTPUT: output("o2"), GITHUB_STEP_SUMMARY: output("s2") }, fetchImpl, options);
  assert.equal(code, 1);
  assert.match(fs.readFileSync(output("o2"), "utf8"), /^enforced=true$/m);
  assert.match(fs.readFileSync(output("s2"), "utf8"), /\*\*Mode:\*\* `frozen` · source `CLUED_MERGE_ADMISSION_STATE`/);

  const posts = [];
  const publicationInputs = [];
  const appFetch = async (url, init = {}) => {
    const target = String(url);
    if (init.method === "POST" && target.endsWith("/check-runs")) posts.push(JSON.parse(init.body));
    let body, status = 200;
    if (target.includes("/rest/v1/rpc/clued_work_verify_v1")) {
      const input = JSON.parse(init.body).p_input;
      if (input.action === 'resolve_pr_claim') body = bindingReply(input, {
        claim_id: CLAIM, task_id: '00000000-0000-4000-8000-000000000901', context_key: 'global',
        fence: 1, execution_epoch: 1, lease_version: 1, status: 'ACTIVE',
        expires_at: '2099-01-01T00:00:00Z', execution_handover_pending: false,
      });
      else { publicationInputs.push(input); body = { status: "ok", publication_required: false }; }
    } else if (target.endsWith("/pulls/9")) {
      body = { number: 9, state: "open", head: { sha: HEAD }, base: { sha: BASE, ref: "main" }, changed_files: 1,
        body: `Clued-Work-Claim: ${CLAIM}` };
    } else if (target.includes("/pulls/9/files?")) body = [{ filename: "docs/change.md", status: "modified" }];
    else if (target.endsWith("/installation")) body = { id: 99 };
    else if (target.endsWith("/access_tokens")) { body = { token: "ghs_app" }; status = 201; }
    else if (init.method === "POST" && target.endsWith("/check-runs")) { body = { id: posts.length }; status = 201; }
    else throw new Error(`Unexpected publication fixture request: ${target}`);
    return { ok: true, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } };
  };
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const appEnv = { GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: API, GITHUB_RUN_ID: "77", GITHUB_TOKEN: "synthetic-gh",
    CLUED_CONTEXT_READ_TOKEN: "synthetic-clued", CLUED_SUPABASE_URL: "https://supabase.test", CLUED_SUPABASE_PUBLISHABLE_KEY: "synthetic-public",
    CLUED_ADMISSION_APP_ID: "1", CLUED_ADMISSION_APP_PRIVATE_KEY: pem,
    ADMISSION_HEAD_SHA: HEAD, ADMISSION_PR_NUMBER: "9" };
  await appCheck({ env: { ...appEnv, ADMISSION_OUTCOME: "success", ADMISSION_VERDICT: "ADMITTED", ADMISSION_MODE: "normal · code · reruns 0",
    ADMISSION_MERGE_SLOT: "not_required" }, fetchImpl: appFetch, now: () => 1_800_000_000_000 });
  assert.deepEqual(posts.map((post) => [post.name, post.output.title]), [
    ["kooyumi-admission-verified", "ADMITTED [normal · code · reruns 0]"],
    ["kooyumi-merge-slot", "not_required(code, normal)"],
  ]);
  assert.equal(publicationInputs.length, 2);
  assert.ok(publicationInputs.every(input => input.action === "publication_begin" && input.head_sha === HEAD && input.pr_ref === "o/r#9"));
  // Without a mode (an admission step from before this change, or one that
  // stopped before it), the title is the verdict alone.
  posts.length = 0;
  await appCheck({ env: { ...appEnv, ADMISSION_OUTCOME: "failure", ADMISSION_VERDICT: "ERROR" }, fetchImpl: appFetch, now: () => 1_800_000_000_000 });
  assert.equal(posts[0].output.title, "ERROR");
  fs.rmSync(dir, { recursive: true, force: true });
});
