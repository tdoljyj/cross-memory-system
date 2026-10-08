// Merge Admission v0.1 (development/contracts/execution-admission/
// MergeAdmission.v0.1.md, accepted in Owner Decision d130195e), §3, §4 and §6:
// the merge admission policy that clued-work-admission.mjs reads instead of
// holding its own branch constants.
//
// Every pull request into the default branch falls into one of three layers
// by the paths it changes (§3): `protected` (CORE_PROTECTED_PATHS, the policy
// file itself and whatever the policy adds), `docs` (narrative text no job
// executes) and `code` (everything else). A pull request takes the strictest
// layer of all its paths. One global state (§4), the Owner's repository
// variable CLUED_MERGE_ADMISSION_STATE, picks the row of the table:
//
//   normal      the policy file's `rules.normal` rows (unset means normal)
//   efficiency  the policy file's `rules.efficiency` rows
//   frozen      every layer is judged as the protected layer, auto-merge is
//               forbidden and only the Owner merges
//
// Invariants (§6), held by the code below and its tests, not by the file:
//   I1  the protected layer is never relaxed: its rules are PROTECTED_BASELINE,
//       a constant, and the file can only name it ("<baseline>");
//   I2  protected paths can only be added to, never removed;
//   I3  an unknown state, a missing or malformed policy file: frozen;
//   I4  the required checks and their sources do not change with the policy;
//   I5  GitHub's strict "up to date" rule is not the policy's to turn off.
//
// Step 1 of the migration (§13): the repository's policy file is the
// compatibility table, under which every pull request is judged exactly as
// before. The policy is read from the default branch's checkout only (the
// admission run's), so a pull request that edits it does not change its own
// verdict.
//
// No dependencies: Node 20+ fs and path only.

import fs from "node:fs";
import path from "node:path";

export const POLICY_PATH = "config/merge-admission-policy.json";
export const POLICY_SCHEMA = "clued.merge-admission-policy/1";
export const STATE_VARIABLE = "CLUED_MERGE_ADMISSION_STATE";
export const STATES = Object.freeze(["normal", "frozen", "efficiency"]);
// Strictest first: a pull request takes the first layer any of its paths has.
export const LAYERS = Object.freeze(["protected", "code", "docs"]);
export const BASELINE = "<baseline>";
export const HARD_CAP_DEFAULT_MINUTES = 120;
export const HARD_CAP_RANGE_MINUTES = Object.freeze([60, 180]);

// The protected layer's paths (WorkClaimAdmission v0.1 §4.6, "Owner review").
// A pull request that changes one of them is admitted only with the Owner's
// grant on its exact head commit.
export const CORE_PROTECTED_PATHS = Object.freeze([
  // Every workflow, and what the jobs holding secrets run: the CI and release
  // scripts (including the admission job's own self-tests and this policy),
  // the runner check, the release scripts and the dependencies they load, the
  // Worker deploy configuration, and where admission asks Clued.
  ".github/**",
  "scripts/ci/**",
  "scripts/runner/**",
  "apps/clued-cloud/scripts/**",
  "apps/clued-cloud/package.json",
  "apps/clued-cloud/package-lock.json",
  "apps/clued-cloud/wrangler*.jsonc",
  "apps/clued-cloud/app/supabase-public-config.ts",
  // Re-review 9, MINOR-2: checkout attributes can re-encode or filter what
  // every later job runs (working-tree-encoding, filters), and submodules
  // bring in code from elsewhere.
  ".gitattributes",
  "**/.gitattributes",
  ".gitmodules",
  // Re-review 11, NIT: npm configuration decides where the dependencies
  // that run with production credentials come from.
  ".npmrc",
  "**/.npmrc",
]);

// Each column's values, strictest first (§5.1).
export const STRICTNESS = Object.freeze({
  work_claim: Object.freeze(["enforce", "advise"]),
  owner_grant: Object.freeze(["required", "none"]),
  up_to_date: Object.freeze(["check_and_strict", "strict_only"]),
  merge_slot: Object.freeze(["required", "advise"]),
  reruns_per_head: Object.freeze([0, 1, 2, 3]),
  auto_merge: Object.freeze(["forbidden", "allowed"]),
  merge_actor: Object.freeze(["owner_only", "any"]),
});
// The columns a policy row names; merge_actor is only frozen's.
export const ROW_COLUMNS = Object.freeze(["work_claim", "owner_grant", "up_to_date", "merge_slot", "reruns_per_head", "auto_merge"]);

// The protected layer's rules in every state (§5.2, I1). Step 1 keeps
// reruns_per_head at 0, today's "no re-runs"; step 2 raises it to 1 together
// with the gate that honors it.
export const PROTECTED_BASELINE = Object.freeze({
  work_claim: "enforce",
  owner_grant: "required",
  up_to_date: "check_and_strict",
  merge_slot: "required",
  reruns_per_head: 0,
  auto_merge: "allowed",
  merge_actor: "any",
});
const FROZEN_RULES = Object.freeze({ ...PROTECTED_BASELINE, auto_merge: "forbidden", merge_actor: "owner_only" });
const FROZEN_ROW = Object.freeze({ all_layers_as: "protected", merge_actor: "owner_only", auto_merge: "forbidden" });

// Glob semantics of GitHub path filters: `**` crosses directories (`**/` also
// matches none), `*` and `?` stay within one.
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1; // `**/` also matches zero directories
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

// True when value is as strict as, or stricter than, than (STRICTNESS order).
export function atLeastAsStrict(column, value, than) {
  const order = STRICTNESS[column];
  if (!order) return false;
  const a = order.indexOf(value);
  const b = order.indexOf(than);
  return a >= 0 && b >= 0 && a <= b;
}

// Only plain characters of a value from the file or a variable reach a summary.
function plain(value) {
  return String(value).replace(/[^A-Za-z0-9._/*:!<>() -]/g, "?").slice(0, 120);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const GLOB = /^!?[^\s\u0000-\u001f\u007f]{1,200}$/;
// Review NIT-3: globToRegExp turns each `*` run into a backtracking group, so a
// pattern with many of them can make one match take minutes and time the
// admission job out. Two runs keep a match at most quadratic in the path.
export const MAX_WILDCARD_RUNS = 2;
export const MAX_PATTERNS_PER_LAYER = 100;
const wildcardRuns = (pattern) => (pattern.match(/\*+/g) ?? []).length;

function unknownKeys(object, allowed, where, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key ${plain(key)}`);
  }
}

function checkPaths(value, where, errors, { negation, catchAll }) {
  if (!isObject(value)) {
    errors.push(`${where}: must be an object with paths`);
    return [];
  }
  unknownKeys(value, ["paths"], where, errors);
  const paths = value.paths;
  if (!Array.isArray(paths)) {
    errors.push(`${where}.paths: must be an array`);
    return [];
  }
  if (paths.length > MAX_PATTERNS_PER_LAYER) errors.push(`${where}.paths: more than ${MAX_PATTERNS_PER_LAYER} patterns`);
  for (const pattern of paths) {
    if (typeof pattern !== "string" || !GLOB.test(pattern) || pattern === "!") {
      errors.push(`${where}.paths: ${plain(pattern)} is not a path pattern`);
    } else if (wildcardRuns(pattern) > MAX_WILDCARD_RUNS) {
      errors.push(`${where}.paths: ${plain(pattern)} has more than ${MAX_WILDCARD_RUNS} wildcards`);
    } else if (pattern.startsWith("!") && !negation) {
      // I2: the protected layer can only grow; the fallback layer has no next one.
      errors.push(`${where}.paths: ${plain(pattern)} excludes a path, which this layer cannot`);
    }
  }
  if (catchAll && !paths.includes("**")) errors.push(`${where}.paths: must contain "**" (the fallback layer)`);
  return paths.filter((pattern) => typeof pattern === "string");
}

function checkRow(row, where, errors) {
  if (!isObject(row)) {
    errors.push(`${where}: must be a rule row`);
    return null;
  }
  unknownKeys(row, ROW_COLUMNS, where, errors);
  for (const column of ROW_COLUMNS) {
    if (!Object.hasOwn(row, column)) errors.push(`${where}.${column}: missing`);
    else if (!STRICTNESS[column].includes(row[column])) errors.push(`${where}.${column}: ${plain(JSON.stringify(row[column]))} is not one of ${STRICTNESS[column].join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ROW_COLUMNS.map((column) => [column, row[column]])));
}

// Parses and checks the policy file. Any error makes the whole policy unusable
// (the caller then judges as frozen, I3); { policy: null, errors } then.
export function loadPolicy(text) {
  const errors = [];
  let doc;
  try {
    // Review NIT-1: an editor's byte order mark is not a reason to freeze.
    doc = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch (error) {
    return { policy: null, errors: [`${POLICY_PATH} is not JSON: ${plain(error instanceof Error ? error.message : error)}`] };
  }
  if (!isObject(doc)) return { policy: null, errors: [`${POLICY_PATH} is not a JSON object`] };
  unknownKeys(doc, ["schema", "version", "about", "state_variable", "merge_slot_hard_cap_minutes", "layers", "rules"], "policy", errors);
  if (doc.schema !== POLICY_SCHEMA) errors.push(`policy.schema: must be ${POLICY_SCHEMA}`);
  if (!Number.isInteger(doc.version) || doc.version < 1) errors.push("policy.version: must be a positive integer");
  if (Object.hasOwn(doc, "about") && typeof doc.about !== "string") errors.push("policy.about: must be a string");
  if (doc.state_variable !== STATE_VARIABLE) errors.push(`policy.state_variable: must be ${STATE_VARIABLE}`);
  let hardCap = HARD_CAP_DEFAULT_MINUTES;
  if (Object.hasOwn(doc, "merge_slot_hard_cap_minutes")) {
    const [min, max] = HARD_CAP_RANGE_MINUTES;
    hardCap = doc.merge_slot_hard_cap_minutes;
    if (!Number.isInteger(hardCap) || hardCap < min || hardCap > max) errors.push(`policy.merge_slot_hard_cap_minutes: must be an integer from ${min} to ${max}`);
  }
  const layers = {};
  if (!isObject(doc.layers)) {
    errors.push("policy.layers: must be an object");
  } else {
    unknownKeys(doc.layers, LAYERS, "policy.layers", errors);
    layers.protected = checkPaths(doc.layers.protected, "policy.layers.protected", errors, { negation: false, catchAll: false });
    layers.docs = checkPaths(doc.layers.docs, "policy.layers.docs", errors, { negation: true, catchAll: false });
    layers.code = checkPaths(doc.layers.code, "policy.layers.code", errors, { negation: false, catchAll: true });
  }
  const rules = {};
  if (!isObject(doc.rules)) {
    errors.push("policy.rules: must be an object");
  } else {
    unknownKeys(doc.rules, STATES, "policy.rules", errors);
    for (const state of ["normal", "efficiency"]) {
      const table = doc.rules[state];
      const where = `policy.rules.${state}`;
      if (!isObject(table)) {
        errors.push(`${where}: must be an object`);
        continue;
      }
      unknownKeys(table, LAYERS, where, errors);
      // I1: the protected layer's rules are not the file's to set.
      if (table.protected !== BASELINE) errors.push(`${where}.protected: must be "${BASELINE}"`);
      rules[state] = Object.freeze({ code: checkRow(table.code, `${where}.code`, errors), docs: checkRow(table.docs, `${where}.docs`, errors) });
    }
    const frozen = doc.rules.frozen;
    if (!isObject(frozen) || Object.keys(frozen).length !== Object.keys(FROZEN_ROW).length
      || Object.entries(FROZEN_ROW).some(([key, value]) => frozen[key] !== value)) {
      errors.push(`policy.rules.frozen: must be exactly ${JSON.stringify(FROZEN_ROW)}`);
    }
  }
  if (errors.length) return { policy: null, errors };
  return {
    policy: Object.freeze({
      schema: doc.schema,
      version: doc.version,
      state_variable: doc.state_variable,
      merge_slot_hard_cap_minutes: hardCap,
      layers: Object.freeze({
        protected: Object.freeze([...layers.protected]),
        docs: Object.freeze([...layers.docs]),
        code: Object.freeze([...layers.code]),
      }),
      rules: Object.freeze({ ...rules, frozen: FROZEN_ROW }),
    }),
    errors: [],
  };
}

// The policy file of a checkout (the default branch's, in the admission run).
export function readPolicy(workspace, readFile = fs.readFileSync) {
  if (!workspace) return { policy: null, errors: [`GITHUB_WORKSPACE is not set; cannot read ${POLICY_PATH}`] };
  let text;
  try {
    text = readFile(path.join(workspace, POLICY_PATH), "utf8");
  } catch (error) {
    return { policy: null, errors: [`${POLICY_PATH} cannot be read: ${plain(error && error.code ? error.code : error)}`] };
  }
  return loadPolicy(text);
}

// The Owner's state variable (§4). Unset or empty is normal; anything that is
// not exactly one of the three states (surrounding blanks aside) is frozen.
export function resolveState(env) {
  const value = String((env && env[STATE_VARIABLE]) ?? "").trim();
  if (!value) return { state: "normal", source: "default" };
  if (STATES.includes(value)) return { state: value, source: STATE_VARIABLE };
  return { state: "frozen", source: STATE_VARIABLE, error: `${STATE_VARIABLE}=${plain(value)} is not one of ${STATES.join(", ")}` };
}

// State and policy together. Any error in either judges as frozen (I3).
export function resolveMode({ env, workspace, readFile = fs.readFileSync }) {
  const requested = resolveState(env);
  const loaded = readPolicy(workspace, readFile);
  const errors = [...(requested.error ? [requested.error] : []), ...loaded.errors];
  return {
    state: errors.length ? "frozen" : requested.state,
    requested: requested.state,
    source: requested.source,
    policy: loaded.policy,
    policy_version: loaded.policy ? loaded.policy.version : null,
    errors,
  };
}

// CORE_PROTECTED_PATHS, the policy file, and the policy's additions (I2).
export function effectiveProtectedPaths(policy) {
  const extra = policy && policy.layers ? policy.layers.protected : [];
  return [...new Set([...CORE_PROTECTED_PATHS, POLICY_PATH, ...extra])];
}

function matcher(patterns) {
  const include = patterns.filter((p) => !p.startsWith("!")).map(globToRegExp);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => globToRegExp(p.slice(1)));
  return (file) => include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file));
}

// The layer of each path: protected first, then docs, and code for the rest.
export function layerMatcher(policy) {
  const protectedPath = matcher(effectiveProtectedPaths(policy));
  const docsPath = policy && policy.layers ? matcher(policy.layers.docs) : () => false;
  return (file) => (protectedPath(file) ? "protected" : docsPath(file) ? "docs" : "code");
}

// A pull request's layer: the strictest of its paths' (§3.2). `unknown` (a
// compare too long to list) is protected; no paths at all is code.
export function layerOf(paths, policy, { unknown = false } = {}) {
  if (unknown) return "protected";
  if (!paths || paths.length === 0) return "code";
  const of = layerMatcher(policy);
  let best = LAYERS.length - 1;
  for (const file of paths) {
    best = Math.min(best, LAYERS.indexOf(of(file)));
    if (best === 0) break;
  }
  return LAYERS[best];
}

// The rules one pull request is judged by (§5). The first two branches are the
// guarantees: frozen judges every layer as protected, and the protected layer
// never reads the file (I1). A missing row fails closed as frozen (I3).
export function effectiveRules(policy, state, layer) {
  if (state === "frozen" || !STATES.includes(state)) return FROZEN_RULES;
  if (layer === "protected" || !LAYERS.includes(layer)) return PROTECTED_BASELINE;
  const row = policy && policy.rules && policy.rules[state] ? policy.rules[state][layer] : null;
  if (!row) return FROZEN_RULES;
  return Object.freeze({ ...row, merge_actor: "any" });
}

// How a check title shows the mode (§10): "normal · code · reruns 0".
export function modeLabel(state, layer, rules) {
  return `${state} · ${layer} · reruns ${rules.reruns_per_head}`;
}
