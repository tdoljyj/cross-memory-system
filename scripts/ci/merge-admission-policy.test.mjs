// Merge Admission v0.1 §6: the invariants of the merge admission policy and
// the table-driven verdicts of clued-work-admission.mjs under it. No network:
// GitHub and Clued are a scripted fetch, the policy files temporary
// directories. Run by the admission job's self-test and by clued-components.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  modeLabel,
  POLICY_PATH,
  PROTECTED_BASELINE,
  readPolicy,
  resolveMode,
  resolveState,
  ROW_COLUMNS,
  STATE_VARIABLE,
  STATES,
  STRICTNESS,
  atLeastAsStrict,
} from "./merge-admission-policy.mjs";
import {
  appCheck,
  evaluate,
  main,
  mergeSlotCheck,
  PROTECTED_PATHS,
  PUBLIC_CONFIG_SOURCE,
  renderSummary,
} from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_POLICY_TEXT = fs.readFileSync(path.join(ROOT, POLICY_PATH), "utf8");

// The contract's §3.1 list, written out once more so that a change to the
// constant is a change to this test too.
const CONTRACT_CORE = [".github/**", "scripts/ci/**", "scripts/runner/**", "apps/clued-cloud/scripts/**",
  "apps/clued-cloud/package.json", "apps/clued-cloud/package-lock.json", "apps/clued-cloud/wrangler*.jsonc",
  "apps/clued-cloud/app/supabase-public-config.ts", ".gitattributes", "**/.gitattributes", ".gitmodules", ".npmrc", "**/.npmrc"];

const row = (overrides = {}) => ({ work_claim: "enforce", owner_grant: "none", up_to_date: "strict_only", merge_slot: "required",
  reruns_per_head: 0, auto_merge: "allowed", ...overrides });
const DOCS_PATHS = ["docs/**", "development/contracts/**/*.md", "development/authority-index/**/*.md", "*.md", "skills/**/*.md",
  "!skills/clued/references/agent-contract.md"];
const policyText = ({ normal, efficiency, extra = {}, layers = {} }) => JSON.stringify({
  schema: "clued.merge-admission-policy/1",
  version: 1,
  state_variable: STATE_VARIABLE,
  merge_slot_hard_cap_minutes: 120,
  layers: { protected: { paths: [] }, docs: { paths: DOCS_PATHS }, code: { paths: ["**"] }, ...layers },
  rules: {
    normal: { protected: BASELINE, ...normal },
    efficiency: { protected: BASELINE, ...efficiency },
    frozen: { all_layers_as: "protected", merge_actor: "owner_only", auto_merge: "forbidden" },
  },
  ...extra,
});
// The recommended table of §5.2 and §5.3, which step 2 puts in the repository.
const RECOMMENDED_TEXT = policyText({
  normal: { code: row({ reruns_per_head: 1 }), docs: row({ reruns_per_head: 2 }) },
  efficiency: { code: row({ work_claim: "advise", merge_slot: "advise", reruns_per_head: 2 }),
    docs: row({ work_claim: "advise", merge_slot: "advise", reruns_per_head: 2 }) },
});
// Every column the file can set at its loosest, in both states.
const LOOSEST = row({ work_claim: "advise", owner_grant: "none", up_to_date: "strict_only", merge_slot: "advise", reruns_per_head: 3, auto_merge: "allowed" });
const LOOSEST_TEXT = policyText({ normal: { code: LOOSEST, docs: LOOSEST }, efficiency: { code: LOOSEST, docs: LOOSEST } });

const TABLES = { compat: REPO_POLICY_TEXT, recommended: RECOMMENDED_TEXT, loosest: LOOSEST_TEXT };

// A path that each glob of CORE_PROTECTED_PATHS matches.
const sampleOf = (glob) => glob.replace(/\*\*\//g, "a/b/").replace(/\*\*/g, "a/b").replace(/\*/g, "x");

// ---------------------------------------------------------------------------
// The repository's policy file and the constants.

test("policy: the repository's file is valid and is the step 1 compatibility table", () => {
  const { policy, errors } = loadPolicy(REPO_POLICY_TEXT);
  assert.deepEqual(errors, []);
  assert.equal(policy.merge_slot_hard_cap_minutes, HARD_CAP_DEFAULT_MINUTES);
  assert.deepEqual([...policy.layers.protected], []);
  assert.deepEqual([...policy.layers.docs], DOCS_PATHS);
  assert.deepEqual([...policy.layers.code], ["**"]);
  // §13 step 1: three layers enforce the claim and require the merge slot, no
  // re-runs, and an Owner Grant and the base tip only for the protected layer.
  for (const state of ["normal", "efficiency"]) {
    for (const layer of ["code", "docs"]) assert.deepEqual({ ...policy.rules[state][layer] }, row(), `${state}.${layer}`);
  }
  assert.deepEqual({ ...PROTECTED_BASELINE }, { ...row({ owner_grant: "required", up_to_date: "check_and_strict" }), merge_actor: "any" });
  assert.equal(readPolicy(ROOT).errors.length, 0);
});

test("policy: CORE_PROTECTED_PATHS is the contract's list, and the admission script's PROTECTED_PATHS is it", () => {
  assert.deepEqual([...CORE_PROTECTED_PATHS], CONTRACT_CORE);
  assert.ok(Object.isFrozen(CORE_PROTECTED_PATHS) && Object.isFrozen(PROTECTED_BASELINE) && Object.isFrozen(STRICTNESS));
  assert.equal(PROTECTED_PATHS, CORE_PROTECTED_PATHS);
  assert.ok(CORE_PROTECTED_PATHS.includes(PUBLIC_CONFIG_SOURCE));
  assert.deepEqual(effectiveProtectedPaths(null), [...CONTRACT_CORE, POLICY_PATH]);
  assert.ok(globToRegExp("scripts/ci/**").test(POLICY_PATH.replace("config/", "scripts/ci/")));
});

// ---------------------------------------------------------------------------
// I1: the protected layer is never relaxed.

test("I1: in every state, and when the state or the file is bad, the protected layer is at least the baseline", () => {
  const states = [...STATES, "<unknown>", "<missing file>"];
  for (const [name, text] of Object.entries(TABLES)) {
    for (const requested of states) {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "merge-admission-i1-"));
      if (requested !== "<missing file>") {
        fs.mkdirSync(path.join(workspace, "config"));
        fs.writeFileSync(path.join(workspace, POLICY_PATH), text);
      }
      const env = { [STATE_VARIABLE]: requested === "<unknown>" ? "relaxed" : requested === "<missing file>" ? "" : requested };
      const mode = resolveMode({ env, workspace });
      for (const layer of LAYERS) {
        const rules = effectiveRules(mode.policy, mode.state, layer);
        const columns = layer === "protected" || mode.state === "frozen" ? Object.keys(STRICTNESS) : [];
        for (const column of columns) {
          assert.ok(atLeastAsStrict(column, rules[column], PROTECTED_BASELINE[column]), `${name}/${requested}/${layer}/${column}=${rules[column]}`);
        }
      }
      if (requested === "<unknown>" || requested === "<missing file>") assert.equal(mode.state, "frozen", `${name}/${requested}`);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("I1: effectiveRules returns the baseline for the protected layer whatever the file says, and frozen for every layer", () => {
  const { policy } = loadPolicy(LOOSEST_TEXT);
  for (const state of ["normal", "efficiency"]) {
    assert.equal(effectiveRules(policy, state, "protected"), PROTECTED_BASELINE);
    assert.deepEqual({ ...effectiveRules(policy, state, "code") }, { ...LOOSEST, merge_actor: "any" });
  }
  for (const layer of LAYERS) {
    assert.deepEqual({ ...effectiveRules(policy, "frozen", layer) }, { ...PROTECTED_BASELINE, auto_merge: "forbidden", merge_actor: "owner_only" });
  }
  // Fail closed: an unknown state or layer, or no policy, is never looser.
  assert.equal(effectiveRules(policy, "relaxed", "code").merge_actor, "owner_only");
  assert.equal(effectiveRules(policy, "normal", "vendor"), PROTECTED_BASELINE);
  assert.equal(effectiveRules(null, "normal", "code").merge_actor, "owner_only");
  // The file may not set the protected layer's rules.
  const rewritten = JSON.parse(LOOSEST_TEXT);
  rewritten.rules.normal.protected = LOOSEST;
  assert.match(loadPolicy(JSON.stringify(rewritten)).errors.join("\n"), /policy\.rules\.normal\.protected: must be "<baseline>"/);
});

// ---------------------------------------------------------------------------
// I2: protected paths can only be added to.

test("I2: every core protected path, the policy file and the policy's additions are protected under any policy", () => {
  const adversarial = JSON.parse(LOOSEST_TEXT);
  adversarial.layers.docs.paths = [...CONTRACT_CORE, POLICY_PATH, "docs/**"];
  const policies = { none: null, repository: loadPolicy(REPO_POLICY_TEXT).policy, adversarial: loadPolicy(JSON.stringify(adversarial)).policy };
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
  const added = JSON.parse(REPO_POLICY_TEXT);
  added.layers.protected.paths = ["kernel/**"];
  assert.equal(layerOf(["kernel/x.py"], loadPolicy(JSON.stringify(added)).policy), "protected");
  for (const [where, paths] of [["protected", ["!scripts/ci/**"]], ["code", ["**", "!.github/**"]]]) {
    const broken = JSON.parse(REPO_POLICY_TEXT);
    broken.layers[where].paths = paths;
    assert.match(loadPolicy(JSON.stringify(broken)).errors.join("\n"), new RegExp(`policy\\.layers\\.${where}\\.paths: .* excludes a path`), where);
  }
});

test("layers: docs, the agent contract's exception, root Markdown, mixed pull requests and an unknown compare", () => {
  const { policy } = loadPolicy(REPO_POLICY_TEXT);
  for (const [paths, layer] of [
    [["docs/a/b.md"], "docs"], [["README.md"], "docs"], [["development/contracts/x/Y.v0.1.md"], "docs"],
    [["development/contracts/x/schema.json"], "code"], [["skills/clued/SKILL.md"], "docs"],
    [["skills/clued/references/agent-contract.md"], "code"], [["apps/clued-cloud/README.md"], "code"],
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

test("I3: an unknown state value, a missing, unreadable or malformed policy is frozen", () => {
  assert.deepEqual(resolveState({}), { state: "normal", source: "default" });
  assert.deepEqual(resolveState({ [STATE_VARIABLE]: "  " }), { state: "normal", source: "default" });
  for (const value of STATES) assert.deepEqual(resolveState({ [STATE_VARIABLE]: ` ${value.toUpperCase()} ` }), { state: value, source: STATE_VARIABLE });
  for (const value of ["off", "normal,efficiency", "0", "true", "nörmal"]) {
    const resolved = resolveState({ [STATE_VARIABLE]: value });
    assert.equal(resolved.state, "frozen", value);
    assert.match(resolved.error, /is not one of normal, frozen, efficiency/);
  }
  const base = JSON.parse(REPO_POLICY_TEXT);
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
    "unknown layer": mutate((d) => { d.layers.vendor = { paths: [] }; }),
    "a path with whitespace": mutate((d) => { d.layers.docs.paths.push("docs/a b.md"); }),
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
  // The hard cap may be left out: 120.
  assert.equal(loadPolicy(mutate((d) => { delete d.merge_slot_hard_cap_minutes; })).policy.merge_slot_hard_cap_minutes, 120);
  const missing = resolveMode({ env: {}, workspace: "/w", readFile: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
  assert.deepEqual([missing.state, missing.errors], ["frozen", [`${POLICY_PATH} cannot be read: ENOENT`]]);
  assert.match(resolveMode({ env: {}, workspace: undefined }).errors[0], /GITHUB_WORKSPACE is not set/);
  assert.deepEqual(ROW_COLUMNS, ["work_claim", "owner_grant", "up_to_date", "merge_slot", "reruns_per_head", "auto_merge"]);
});

// ---------------------------------------------------------------------------
// The verdict matrix (§6): (table, state, layer, scenario) -> verdict, through
// evaluate() with a scripted GitHub and Clued. "A+" admitted with a passing
// clued-merge-slot check, "A-" admitted with a failing one, "R:<reason>" not
// admitted for that first reason. Adding a column or a state adds rows here.

const API = "https://api.test";
const CLUED = "https://clued.test";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TIP = "7".repeat(40);
const CLAIM = "0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
const SLOT = "merge:o/r:main";
const LAYER_FILE = { protected: "scripts/ci/tool.mjs", code: "apps/clued-cloud/worker/x.ts", docs: "docs/notes/x.md" };

const SCENARIOS = {
  ok: {},
  claim_missing: { trailer: false },
  claim_expired: { verdict: "REJECTED", reasons: ["claim_expired"] },
  write_set_not_covering: { verdict: "REJECTED", reasons: ["paths_outside_write_set"] },
  no_grant: { grant: false },
  not_up_to_date: { upToDate: false },
  slot_not_held: { slotHeld: false },
  auto_merge_on: { autoMerge: { merge_method: "squash" } },
};

function scriptFor(layer, scenario) {
  const s = { trailer: true, verdict: "ADMITTED", reasons: [], upToDate: true, grant: true, slotHeld: true, autoMerge: null, ...scenario };
  const file = LAYER_FILE[layer];
  const calls = [];
  const pull = { number: 9, body: s.trailer ? `Why\n\nClued-Work-Claim: ${CLAIM}` : "Why", changed_files: 1, auto_merge: s.autoMerge,
    head: { sha: HEAD, repo: { full_name: "o/r" } }, base: { sha: BASE, ref: "main" } };
  const claim = { claim_id: CLAIM, task_id: "t-1", status: "ACTIVE", fence: 1, expires_at: "2026-10-08T05:00:00Z", write_set: [file],
    trigger_refs: s.slotHeld ? [SLOT] : [], merge_slot_until: "2026-10-08T03:00:00Z" };
  const routes = [
    ["GET", `${API}/repos/o/r/pulls/9/files`, () => [{ filename: file, status: "modified" }]],
    ["GET", `${API}/repos/o/r/pulls/9`, () => pull],
    ["GET", `${API}/repos/o/r/branches/main`, () => ({ name: "main", commit: { sha: TIP } })],
    ["GET", `${API}/repos/o/r/compare/${TIP}...${HEAD}`, () => ({ status: s.upToDate ? "ahead" : "diverged", files: [{ filename: file }] })],
    ["GET", `${API}/repos/o/r/commits/${HEAD}`, () => ({ sha: HEAD, commit: { message: "x" }, parents: [{ sha: BASE }] })],
    ["POST", `${CLUED}/rest/v1/rpc/clued_work_verify_v1`, () => ({ status: "ok", verdict: s.verdict, reasons: s.reasons,
      paths_outside_write_set: s.reasons.includes("paths_outside_write_set") ? [file] : [], verified_at: "2026-10-08T02:30:00Z", claim })],
    ["POST", `${CLUED}/rest/v1/rpc/clued_owner_grant_admission_door_v1`, () => ({ status: "ok", admitted: s.grant,
      grant: s.grant ? { grant_id: "g-1" } : null, owner_request: s.grant ? null : { confirm_path: "/owner/confirm/1" } })],
  ];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const target = String(url);
    calls.push({ method, url: target, body: init.body ? JSON.parse(init.body) : null });
    const route = routes.find(([m, prefix]) => m === method && (target === prefix || target.startsWith(`${prefix}?`)));
    if (!route) return { ok: false, status: 599, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    const body = route[2]();
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { pull, fetchImpl, calls };
}

function workspaceWith(text) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "merge-admission-matrix-"));
  if (text !== null) {
    fs.mkdirSync(path.join(workspace, "config"));
    fs.writeFileSync(path.join(workspace, POLICY_PATH), text);
  }
  return workspace;
}

const matrixEnv = (state, extra = {}) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "ghs_test", GITHUB_API_URL: API, GITHUB_RUN_ID: "9001",
  CLUED_SUPABASE_URL: CLUED, CLUED_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", CLUED_CONTEXT_READ_TOKEN: "clued_bnd_test",
  CLUED_WORK_ADMISSION_ENFORCE: "true", CLUED_OWNER_REVIEW_ENFORCE: "true", [STATE_VARIABLE]: state, ...extra });

async function judge({ workspace, state, layer, scenario, env = {} }) {
  const { pull, fetchImpl, calls } = scriptFor(layer, SCENARIOS[scenario]);
  const outcome = await evaluate({ env: matrixEnv(state, env), event: { pull_request: pull }, eventName: "pull_request", fetchImpl, workspace, withSummary: false });
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

// Step 1's compatibility table (the repository's file): code and docs judge as
// before in normal and efficiency alike; frozen judges them as protected.
const COMPAT_EXPECTED = {
  ok: all("A+"),
  claim_missing: all(R("claim_trailer_missing")),
  claim_expired: all(R("claim_expired")),
  write_set_not_covering: all(R("paths_outside_write_set")),
  no_grant: byLayer(R("owner_review_required"), "A+", R("owner_review_required")),
  not_up_to_date: byLayer(R("protected_change_not_up_to_date"), "A+", R("protected_change_not_up_to_date")),
  slot_not_held: all("A-"),
  auto_merge_on: byLayer("A+", "A+", "A-"),
};
// The recommended table: efficiency advises the claim and the merge slot for
// code and docs; normal is as strict as the compatibility table.
const efficiencyRelaxed = (strict) => [strict, strict, strict, strict, "A+", "A+", strict, strict, strict];
const RECOMMENDED_EXPECTED = {
  ...COMPAT_EXPECTED,
  claim_missing: efficiencyRelaxed(R("claim_trailer_missing")),
  claim_expired: efficiencyRelaxed(R("claim_expired")),
  write_set_not_covering: efficiencyRelaxed(R("paths_outside_write_set")),
  slot_not_held: efficiencyRelaxed("A-"),
};
// Every column at its loosest in both states: code and docs pass everything
// but frozen; the protected layer is the compatibility table's.
const looseEverywhere = (strict, frozen = strict) => [strict, "A+", "A+", strict, "A+", "A+", frozen, frozen, frozen];
const LOOSEST_EXPECTED = {
  ok: all("A+"),
  claim_missing: looseEverywhere(R("claim_trailer_missing")),
  claim_expired: looseEverywhere(R("claim_expired")),
  write_set_not_covering: looseEverywhere(R("paths_outside_write_set")),
  no_grant: looseEverywhere(R("owner_review_required")),
  not_up_to_date: looseEverywhere(R("protected_change_not_up_to_date")),
  slot_not_held: looseEverywhere("A-"),
  auto_merge_on: looseEverywhere("A+", "A-"),
};
const EXPECTED = { compat: COMPAT_EXPECTED, recommended: RECOMMENDED_EXPECTED, loosest: LOOSEST_EXPECTED };

const results = {};
async function matrixOf(table) {
  if (results[table]) return results[table];
  const workspace = workspaceWith(TABLES[table]);
  const grid = {};
  for (const scenario of Object.keys(SCENARIOS)) {
    grid[scenario] = [];
    for (const cell of CELLS) {
      const [state, layer] = cell.split(".");
      const { cell: got, outcome } = await judge({ workspace, state, layer, scenario });
      assert.deepEqual([outcome.admission_mode.state, outcome.admission_mode.layer], [state, layer], `${table}/${scenario}/${cell}`);
      grid[scenario].push(got);
    }
  }
  fs.rmSync(workspace, { recursive: true, force: true });
  results[table] = grid;
  return grid;
}

for (const table of Object.keys(TABLES)) {
  test(`matrix (${table} table): every state, layer and scenario gives the fixture's verdict`, async () => {
    const grid = await matrixOf(table);
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

test("advise: a missing claim is admitted with a notice, Clued is not asked, and the merge slot is not required", async () => {
  const workspace = workspaceWith(RECOMMENDED_TEXT);
  const { outcome, calls } = await judge({ workspace, state: "efficiency", layer: "code", scenario: "claim_missing" });
  assert.equal(outcome.verdict, "ADMITTED");
  assert.ok(outcome.notices.some((notice) => notice.startsWith("claim_advisory_missing:")));
  assert.equal(calls.some((call) => call.url.endsWith("/clued_work_verify_v1")), false);
  assert.deepEqual([outcome.merge_slot.state, outcome.merge_slot.observed], ["not_required", "missing"]);
  assert.match(mergeSlotCheck({ admitted: true, state: "not_required", mode: outcome.admission_mode.label }).title, /^not_required\(code, efficiency\)$/);
  // A claim that does not admit the pull request: its reasons become notices.
  const expired = await judge({ workspace, state: "efficiency", layer: "docs", scenario: "claim_expired" });
  assert.deepEqual([expired.outcome.verdict, expired.outcome.claim_verdict, expired.outcome.reasons], ["ADMITTED", "REJECTED", []]);
  assert.ok(expired.outcome.notices.includes("claim_advisory:claim_expired"));
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("frozen: a code change needs an Owner Grant on its exact head, never carried over, and auto-merge fails the merge slot", async () => {
  const workspace = workspaceWith(REPO_POLICY_TEXT);
  const { outcome, calls } = await judge({ workspace, state: "frozen", layer: "code", scenario: "ok" });
  const door = calls.filter((call) => call.url.endsWith("/clued_owner_grant_admission_door_v1"));
  assert.equal(door.length, 1, "asked once, for the head, with no carry-over lookup");
  assert.deepEqual(door[0].body.p_input.resources, [`repo:o/r/${HEAD}`]);
  assert.match(door[0].body.p_input.note, /merge admission is frozen, so this code-layer change of 1 path\(s\) needs an Owner Grant too/);
  assert.equal(calls.filter((call) => call.url === `${API}/repos/o/r/commits/${HEAD}`).length, 0, "no carry-over walk");
  assert.ok(outcome.notices.some((notice) => notice.startsWith("owner_review_granted:g-1 (state_frozen:code)")));
  const auto = await judge({ workspace, state: "frozen", layer: "docs", scenario: "auto_merge_on" });
  assert.deepEqual([auto.outcome.admitted, auto.outcome.merge_slot.state], [true, "auto_merge_forbidden"]);
  const check = mergeSlotCheck({ admitted: true, state: "auto_merge_forbidden" });
  assert.deepEqual([check.success, check.title], [false, "Auto-merge is not allowed while merge admission is frozen"]);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("fail closed: an unknown state or a broken policy file judges a code change as frozen", async () => {
  const good = workspaceWith(REPO_POLICY_TEXT);
  const unknown = await judge({ workspace: good, state: "relaxed", layer: "code", scenario: "no_grant" });
  assert.equal(unknown.cell, R("owner_review_required"));
  assert.deepEqual([unknown.outcome.admission_mode.state, unknown.outcome.admission_mode.requested], ["frozen", "frozen"]);
  const bad = workspaceWith("{");
  const broken = await judge({ workspace: bad, state: "normal", layer: "docs", scenario: "no_grant" });
  assert.equal(broken.cell, R("owner_review_required"));
  assert.match(renderSummary(broken.outcome), /fail closed to frozen: config\/merge-admission-policy\.json is not JSON/);
  const none = workspaceWith(null);
  assert.equal((await judge({ workspace: none, state: "", layer: "code", scenario: "no_grant" })).cell, R("owner_review_required"));
  for (const dir of [good, bad, none]) fs.rmSync(dir, { recursive: true, force: true });
});

test("the older switches: they keep their meaning in normal and efficiency, and frozen ignores them", async () => {
  const workspace = workspaceWith(REPO_POLICY_TEXT);
  const off = { CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_OWNER_REVIEW_ENFORCE: "" };
  const advisory = await judge({ workspace, state: "normal", layer: "protected", scenario: "claim_missing", env: off });
  assert.deepEqual([advisory.outcome.admitted, advisory.outcome.verdict, advisory.outcome.enforced], [true, "NOT_ENFORCED", false]);
  assert.deepEqual(advisory.outcome.admission_mode.legacy_advisory, ["CLUED_WORK_ADMISSION_ENFORCE", "CLUED_OWNER_REVIEW_ENFORCE"]);
  assert.match(renderSummary(advisory.outcome), /legacy-advisory\(CLUED_WORK_ADMISSION_ENFORCE\) · legacy-advisory\(CLUED_OWNER_REVIEW_ENFORCE\)/);
  const noReview = await judge({ workspace, state: "normal", layer: "protected", scenario: "no_grant", env: { CLUED_OWNER_REVIEW_ENFORCE: "" } });
  assert.deepEqual([noReview.cell, noReview.outcome.owner_review.kind], ["A+", "not_asked"]);
  const frozen = await judge({ workspace, state: "frozen", layer: "protected", scenario: "claim_missing", env: off });
  assert.deepEqual([frozen.cell, frozen.outcome.enforced, frozen.outcome.admission_mode.legacy_advisory], [R("claim_trailer_missing"), true, []]);
  const frozenReview = await judge({ workspace, state: "frozen", layer: "code", scenario: "no_grant", env: off });
  assert.equal(frozenReview.cell, R("owner_review_required"));
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Visibility (§10).

test("visibility: the summary leads with the mode and its rules; the outputs and the App check's title carry the label", async () => {
  const workspace = workspaceWith(REPO_POLICY_TEXT);
  const { outcome } = await judge({ workspace, state: "", layer: "docs", scenario: "ok" });
  assert.equal(outcome.admission_mode.label, "normal · docs · reruns 0");
  assert.equal(modeLabel("normal", "docs", PROTECTED_BASELINE), "normal · docs · reruns 0");
  const summary = renderSummary(outcome);
  assert.match(summary, /^## clued-work-admission\n\n\*\*Mode:\*\* `normal` · layer `docs` · source `default` · policy v1\n\*\*Verdict:\*\* `ADMITTED`/);
  assert.match(summary, /\| work_claim \| owner_grant \| up_to_date \| merge_slot \| reruns_per_head \| auto_merge \| merge_actor \|\n\| --- \| --- \| --- \| --- \| --- \| --- \| --- \|\n\| enforce \| none \| strict_only \| required \| 0 \| allowed \| any \|/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-admission-main-"));
  const eventPath = path.join(dir, "event.json");
  const output = path.join(dir, "output");
  const { pull, fetchImpl } = scriptFor("protected", SCENARIOS.ok);
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: pull }));
  const code = await main(["--mode", "required"], { ...matrixEnv("efficiency"), GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output }, fetchImpl);
  assert.equal(code, 0);
  assert.ok(fs.readFileSync(output, "utf8").split("\n").includes("admission_mode=efficiency · protected · reruns 0"));

  const posts = [];
  const appFetch = async (url, init = {}) => {
    const target = String(url);
    if (init.method === "POST" && target.endsWith("/check-runs")) posts.push(JSON.parse(init.body));
    const body = target.endsWith("/installation") ? { id: 99 } : target.endsWith("/access_tokens") ? { token: "ghs_app" } : { id: posts.length };
    return { ok: true, status: 201, json: async () => body };
  };
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await appCheck({ env: { GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: API, GITHUB_RUN_ID: "77", CLUED_ADMISSION_APP_ID: "1", CLUED_ADMISSION_APP_PRIVATE_KEY: pem,
    ADMISSION_HEAD_SHA: HEAD, ADMISSION_PR_NUMBER: "9", ADMISSION_OUTCOME: "success", ADMISSION_VERDICT: "ADMITTED",
    ADMISSION_MODE: "normal · code · reruns 0", ADMISSION_MERGE_SLOT: "not_required" }, fetchImpl: appFetch, now: () => 1_800_000_000_000 });
  assert.deepEqual(posts.map((post) => [post.name, post.output.title]), [
    ["clued-admission-verified", "ADMITTED [normal · code · reruns 0]"],
    ["clued-merge-slot", "not_required(code, normal)"],
  ]);
  // Without a mode (an admission step from before this change, or one that
  // stopped before it), the title is the verdict alone.
  posts.length = 0;
  await appCheck({ env: { GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: API, GITHUB_RUN_ID: "77", CLUED_ADMISSION_APP_ID: "1", CLUED_ADMISSION_APP_PRIVATE_KEY: pem,
    ADMISSION_HEAD_SHA: HEAD, ADMISSION_OUTCOME: "failure", ADMISSION_VERDICT: "ERROR" }, fetchImpl: appFetch, now: () => 1_800_000_000_000 });
  assert.equal(posts[0].output.title, "ERROR");
  for (const target of [dir, workspace]) fs.rmSync(target, { recursive: true, force: true });
});

test("workflows: the admission and re-verification jobs read the state variable, and the self-tests include this file", () => {
  const read = (name) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
  const admission = read("clued-work-admission.yml");
  const admit = admission.slice(admission.indexOf("id: admit"), admission.indexOf("--mode required"));
  assert.ok(admit.includes(`${STATE_VARIABLE}: \${{ vars.${STATE_VARIABLE} }}`));
  const post = admission.slice(admission.indexOf("- name: Post the result as the clued-admission App"), admission.indexOf("--mode app-check"));
  assert.ok(post.includes("ADMISSION_MODE: ${{ steps.admit.outputs.admission_mode }}"));
  assert.ok(read("clued-work-admission-reverify.yml").includes(`${STATE_VARIABLE}: \${{ vars.${STATE_VARIABLE} }}`));
  for (const [name, count] of [["clued-work-admission.yml", 1], ["clued-components.yml", 2]]) {
    const runs = read(name).split("\n").filter((line) => line.includes("node --test scripts/ci/clued-work-admission.test.mjs"));
    assert.equal(runs.length, count, name);
    for (const line of runs) assert.ok(line.includes("scripts/ci/merge-admission-policy.test.mjs"), `${name}: ${line.trim()}`);
  }
});
