import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// S2c Integration Runtime PR-1 (IntegrationRuntime v0.1.8 §14.1): registries and the pure
// derivation functions. Covers the pure-function / property layer of G-A3 and G-A7
// (T-A3-1…6, T-A7-3…9 function layer, P1, P2, P3, P5), T-A7-10 and T-S-1/2/3.
//
// Sample counts. §13.2 P2 (c) states two separate obligations, and both are met verbatim:
//   CI      — 250,000 fixed-seed random facts, the default of this file, run by the required check
//             migration-verify (suite production-schema in scripts/ci/ci-required-selection.mjs);
//   nightly — 2,000,000, run by CLUED_INTEGRATION_RUNTIME_PROPERTY_FULL=1, which
//             .github/workflows/clued-integration-runtime-nightly.yml sets once a day.
// The seed is mulberry32(20260924) (§13.0) and is printed with every failing sample.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20260926000000_integration_runtime_registry_derivation.sql';
const FULL = process.env.CLUED_INTEGRATION_RUNTIME_PROPERTY_FULL === '1';
const RANDOM_SAMPLES = FULL ? 2_000_000 : 250_000;
const SEED = 20260924;
const CHUNK = 5000;
const golden = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/integration-runtime/golden-vectors.v1.json'), 'utf8'));
const hash = () => crypto.randomBytes(32).toString('hex');

const STATES = ['INSTALL_PENDING', 'INSTALLED', 'AUTH_PENDING', 'VERIFYING', 'ACTIVE', 'DEGRADED', 'BLOCKED',
  'REAUTH_REQUIRED', 'INCOMPATIBLE', 'REVOKED'];
const AT_LEAST_BLOCKED = ['REVOKED', 'INCOMPATIBLE', 'REAUTH_REQUIRED', 'AUTH_PENDING', 'BLOCKED'];
const CODES = ['C1_SCHEMA_INVALID', 'C2_COMPLETE_BUT_UNCLAIMED', 'C3_INCOMPLETE_BUT_CLAIM_STATE', 'C4_CLAIM_STORE_MISSING',
  'C5_CLAIM_STORE_UNEXPECTED', 'C6_SUPERSEDED_LIFECYCLE_MISMATCH', 'C7_CONNECTION_CARDINALITY',
  'C8_AUTH_WITHOUT_EVER_AUTHORIZED', 'C9_CONTRACT_UNKNOWN', 'C10_AUTHZ_WITHOUT_AUTHN'];
const ALL = ['audit.read', 'context.read', 'context.write', 'development_history.read', 'evidence.write', 'project.read',
  'project.write'];
const PURE = ['integration_capabilities_valid_v1(text[])', 'integration_ceiling_valid_v1(jsonb)',
  'integration_version_cmp_v1(text,text)', 'integration_timestamp_valid_v1(text)',
  'integration_facts_validate_v1(jsonb)',
  'integration_candidate_v1(jsonb,boolean,boolean,boolean)', 'integration_predicates_v1(jsonb)',
  'integration_select_state_v1(jsonb)', 'integration_derive_v1(jsonb)'];
const TABLES = ['integration_binding_domains_v1', 'integration_capability_vocabulary_v1',
  'integration_compatibility_rules_v1', 'integration_host_surfaces_v1', 'integration_hosts_v1', 'integration_policy_v1',
  'integration_providers_v1', 'integration_scope_capability_map_v1'];

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Deep merge: objects merge, arrays and scalars replace, and the tagged union
// resource_action_scope_facts is replaced whole. Copy-on-write (shares untouched values), so
// callers clone before mutating.
function merge(target, patch) {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) && key !== 'resource_action_scope_facts' ? merge(out[key], value) : value;
  }
  return out;
}
function vectorFacts(vector) {
  if ('facts' in vector) return clone(vector.facts);
  const facts = clone(merge(golden.base, vector.patch ?? {}));
  for (const dotted of vector.remove ?? []) {
    const keys = dotted.split('.');
    const parent = keys.slice(0, -1).reduce((node, key) => node[key], facts);
    delete parent[keys.at(-1)];
  }
  return facts;
}

// §13.2 P3: an equivalent document with shuffled keys and reversed set elements.
function permuted(value, rng) {
  if (Array.isArray(value)) return value.map((item) => permuted(item, rng)).reverse();
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  for (let i = keys.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return Object.fromEntries(keys.map((key) => [key, permuted(value[key], rng)]));
}

// §13.2 P2 semantic oracle (v0.1.8 review MINOR-3). An independent re-derivation of the whole
// validation / predicate / Candidate / state / Operability layer straight from the facts document,
// written from the specification text (§7.1, §7.2, §7.3, §8.3, §8.4, §9.1, §9.2, §9.4) and never
// from the SQL output, so a mutation of any single factor in the migration diverges here.
// validateOracle runs on every sample, valid or not; oracle runs on the samples validateOracle and
// the migration agree are valid (§8/§9 are defined only on valid documents).
//
// Caveat (v0.1.8 review NIT-3): this is a transcription of the specification's pseudocode, in the
// specification's own order, not an independently derived model. It therefore shares the SQL's
// reading of every place where the specification is ambiguous — notably the C4 / C5 mapping and the
// two C1 tightenings that ERRATA-001 settles, and the three that ERRATA-002 settles. It is evidence
// that the SQL implements the reading the authors intended, not evidence that the reading is right;
// only the golden vectors and the errata carry that.
const SCOPE_OF = { 'context.read': 'context:read', 'project.read': 'context:read',
  'development_history.read': 'context:read', 'context.write': 'context:write',
  'project.write': 'context:write', 'evidence.write': 'context:write', 'audit.read': 'audit:read' };
const has = (list, value) => Array.isArray(list) && list.includes(value);

// ---- §7.1 / §7.2 / §7.3 validation oracle -----------------------------------------------------
// The expected reason-code set, recomputed from the facts document alone. The §7.1 schema (exact
// key sets, enumerations, capability sets, masks, lexical instants) and the §7.3 rules C1 … C10,
// plus the ERRATA-001 tightenings (connection_store as the C7 carrier, claim_store alone driving
// C4 / C5, the revocation-pair and non-null-mask C1 rules) and the ERRATA-002 ones (integer
// spellings, which JSON.stringify cannot express from a JavaScript number, so they are exercised by
// the raw-text vectors in the §7.1 lexical test instead).
const VOCAB = ALL;
const OAUTH_SCOPES = ['context:read', 'context:write', 'audit:read'];
const KEY_SETS = {
  '': ['schema', 'derivation_contract', 'as_of', 'policy', 'capability_universe', 'identity_state',
    'identity_completeness', 'identity_claim_state', 'claim_store', 'connection_store', 'authentication_state',
    'authorization_state', 'reauth_marks_open', 'oauth_scope_facts', 'resource_action_scope_facts', 'environment_state',
    'qualification_state', 'compatibility_state', 'revocation_state', 'revocation_source', 'host_state', 'adapter_state',
    'lifecycle_facts', 'installation_facts', 'canonical_runtime_verification_facts'],
  policy: ['policy_version', 'incomplete_identity_ordinary_runtime', 'qualification_not_evaluated', 'preclusion_rule'],
  environment_state: ['value', 'mask'],
  qualification_state: ['value', 'mask'],
  compatibility_state: ['value', 'mask'],
  host_state: ['value', 'mask', 'surface_ceiling', 'declared'],
  adapter_state: ['value', 'mask'],
  lifecycle_facts: ['ordinary_runtime', 'historical', 'recovery_policy', 'first_authorization_required'],
  installation_facts: ['install_status', 'ever_authorized'],
  canonical_runtime_verification_facts: ['status', 'verification_id', 'valid_until'],
};
const ENUMS = {
  identity_state: ['VALID', 'INVALID'],
  identity_completeness: ['COMPLETE', 'INCOMPLETE'],
  identity_claim_state: ['INCOMPLETE_UNCLAIMED', 'CURRENT_CLAIM_HOLDER', 'CLAIM_CONFLICT', 'PENDING_RECONCILE', 'SUPERSEDED'],
  claim_store: ['CONSISTENT', 'MISSING_CURRENT_ROW', 'UNEXPECTED_CURRENT_ROW', 'KEY_MISMATCH'],
  connection_store: ['CONSISTENT', 'MULTIPLE_CURRENT', 'FOREIGN_BINDING', 'OWNER_ROW_MISSING', 'OWNER_MISMATCH'],
  authentication_state: ['NONE', 'USABLE', 'EXPIRED', 'INVALIDATED'],
  authorization_state: ['NOT_GRANTED', 'GRANTED', 'GRANTED_LEGACY', 'EXPIRED', 'REVOKED_CONNECTION'],
  revocation_state: ['NOT_REVOKED', 'REVOKED'],
  revocation_source: ['NONE', 'INTEGRATION', 'CONNECTION_USER_REVOKE'],
  'resource_action_scope_facts.mode': ['ENTRIES', 'LEGACY_UNRESTRICTED', 'NONE'],
  'environment_state.value': ['AVAILABLE', 'RESTRICTED', 'BLOCKED'],
  'qualification_state.value': ['NOT_EVALUATED', 'QUALIFIED', 'CONDITIONAL', 'SUSPENDED'],
  'compatibility_state.value': ['COMPATIBLE', 'DEGRADED', 'HARD_INCOMPATIBLE'],
  'host_state.value': ['AVAILABLE', 'DEGRADED', 'HARD_UNAVAILABLE'],
  'adapter_state.value': ['OK', 'DEGRADED', 'BLOCKED'],
  'lifecycle_facts.ordinary_runtime': ['PERMITTED', 'PAUSED_BY_OWNER', 'PAUSED_BY_POLICY'],
  'lifecycle_facts.historical': ['NONE', 'SUPERSEDED'],
  'lifecycle_facts.recovery_policy': ['PERMITS_REAUTH', 'FORBIDS_REAUTH'],
  'installation_facts.install_status': ['PENDING', 'COMPLETED'],
  'canonical_runtime_verification_facts.status': ['NONE', 'VALID', 'EXPIRED', 'FAILED', 'INVALIDATED'],
  'policy.incomplete_identity_ordinary_runtime': ['PERMIT', 'DENY'],
  'policy.qualification_not_evaluated': ['NON_BLOCKING', 'BLOCKING'],
  'policy.preclusion_rule': ['ALL_BLOCKING_PREDICATES'],
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// §7.1 instants: the lexical shape the migration pins, then the calendar and the offset range
// PostgreSQL's cast enforces. Hour 24 and second 60 are excluded because PostgreSQL rolls them over
// to a different instant, so the document would not denote the instant it spells and valid_until
// is inside facts_sha256; authority ERRATA-002 item 3 (Owner Decisions
// 25edd152-0d95-4cf7-b3eb-0ff32aed74d0, and 37e0f626-f9f7-43c1-b899-4d7584b952ab for its wording).
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(2[0-3]|[01]\d):(\d{2}):([0-5]\d)(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
function instantValid(text) {
  const m = typeof text === 'string' ? INSTANT_RE.exec(text) : null;
  if (!m) return false;
  const [year, month, day, , minute] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4], Number(m[5])];
  if (year < 1 || month < 1 || month > 12 || minute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return false;
  if (m[8] !== 'Z' && (Number(m[8].slice(1, 3)) > 15 || Number(m[8].slice(4, 6)) > 59)) return false;
  return true;
}
// jsonb reading helpers. `absent` stands for both a missing key and SQL NULL, so the three-valued
// comparisons below reproduce the SQL's NULL propagation exactly.
const dig = (node, dotted) => dotted.split('.').reduce((v, k) => (v === null || typeof v !== 'object' ? undefined : v[k]), node);
const present = (node, key) => Object.prototype.hasOwnProperty.call(node, key) && node[key] !== undefined;
const isJsonObject = (v) => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
// jsonb `->>`: text for any scalar, NULL for a JSON null or an absent key (objects/arrays render,
// but no rule below compares one).
const txt = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const eq = (a, b) => (a === null ? null : a === b);
const xor = (a, b) => (a === null || b === null ? false : a !== b);
const subset = (v, names) => Array.isArray(v) && v.every((e) => typeof e === 'string' && names.includes(e));
function validateOracle(f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return ['C1_SCHEMA_INVALID'];
  let c1 = false;
  let c9 = false;
  // exact key sets of the document and of every nested object
  for (const [name, keys] of Object.entries(KEY_SETS)) {
    const v = name === '' ? f : f[name];
    if (!isJsonObject(v) || !keys.every((k) => present(v, k)) || Object.keys(v).some((k) => !keys.includes(k))) c1 = true;
  }
  // enumerations
  for (const [name, values] of Object.entries(ENUMS)) {
    const v = dig(f, name);
    if (typeof v !== 'string' || !values.includes(v)) c1 = true;
  }
  // booleans
  if (typeof dig(f, 'lifecycle_facts.first_authorization_required') !== 'boolean'
    || typeof dig(f, 'installation_facts.ever_authorized') !== 'boolean') c1 = true;
  // reauth_marks_open: a non-negative integer (ERRATA-002: the integer spelling only)
  const marks = f.reauth_marks_open;
  if (typeof marks !== 'number' || !Number.isInteger(marks) || marks < 0) c1 = true;
  // as_of, and the canonical runtime verification reference: uuid / instant or JSON null
  if (typeof f.as_of !== 'string' || !instantValid(f.as_of)) c1 = true;
  const vid = dig(f, 'canonical_runtime_verification_facts.verification_id');
  if (!(vid === null || (typeof vid === 'string' && UUID_RE.test(vid)))) c1 = true;
  const until = dig(f, 'canonical_runtime_verification_facts.valid_until');
  if (!(until === null || (typeof until === 'string' && instantValid(until)))) c1 = true;
  // capability sets, and the OAuth scope set
  for (const name of ['capability_universe', 'host_state.surface_ceiling', 'host_state.declared']) {
    if (!subset(dig(f, name), VOCAB)) c1 = true;
  }
  if (!subset(f.oauth_scope_facts, OAUTH_SCOPES)) c1 = true;
  // resource/action scope facts: {mode: ENTRIES, capabilities} | {mode: LEGACY_UNRESTRICTED} | {mode: NONE}
  const ras = f.resource_action_scope_facts;
  if (!isJsonObject(ras)) c1 = true;
  else if (txt(ras.mode) === 'ENTRIES') {
    if (!present(ras, 'mode') || !present(ras, 'capabilities')
      || Object.keys(ras).some((k) => k !== 'mode' && k !== 'capabilities') || !subset(ras.capabilities, VOCAB)) c1 = true;
  } else if (Object.keys(ras).some((k) => k !== 'mode')) c1 = true;
  // masks: a capability array exactly for RESTRICTED / CONDITIONAL / DEGRADED, JSON null otherwise
  for (const name of ['environment_state', 'qualification_state', 'compatibility_state', 'host_state', 'adapter_state']) {
    const mask = dig(f, `${name}.mask`);
    if (['RESTRICTED', 'CONDITIONAL', 'DEGRADED'].includes(txt(dig(f, `${name}.value`)))) {
      if (!subset(mask, VOCAB)) c1 = true;
    } else if (mask !== null) c1 = true;
  }
  // revocation_state and revocation_source are one truth class (§7.2): REVOKED ⇔ source ≠ NONE
  if (eq(txt(f.revocation_state), 'REVOKED') !== (txt(f.revocation_source) !== 'NONE')) c1 = true;
  // C9: schema / derivation contract / policy version unknown (a non-string / non-integer is C1)
  if (typeof f.schema === 'string') { if (f.schema !== 'clued.integration-facts.v1') c9 = true; } else c1 = true;
  if (typeof f.derivation_contract === 'string') {
    if (f.derivation_contract !== 'clued.integration-derivation.v1') c9 = true;
  } else c1 = true;
  const version = dig(f, 'policy.policy_version');
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) {
    if (version !== 1) c9 = true;
  } else c1 = true;

  const ic = txt(f.identity_completeness);
  const cs = txt(f.identity_claim_state);
  const store = txt(f.claim_store);
  const hist = txt(dig(f, 'lifecycle_facts.historical'));
  const authn = txt(f.authentication_state);
  const authz = txt(f.authorization_state);
  const codes = [];
  if (c1) codes.push('C1_SCHEMA_INVALID');
  if (eq(ic, 'COMPLETE') && eq(cs, 'INCOMPLETE_UNCLAIMED')) codes.push('C2_COMPLETE_BUT_UNCLAIMED');
  if (eq(ic, 'INCOMPLETE') && eq(cs, 'INCOMPLETE_UNCLAIMED') === false) codes.push('C3_INCOMPLETE_BUT_CLAIM_STATE');
  // ERRATA-001: a claim_store value other than CONSISTENT is always C4 or C5, independently of
  // identity_claim_state
  if (['MISSING_CURRENT_ROW', 'KEY_MISMATCH'].includes(store)) codes.push('C4_CLAIM_STORE_MISSING');
  if (store === 'UNEXPECTED_CURRENT_ROW') codes.push('C5_CLAIM_STORE_UNEXPECTED');
  if (xor(eq(cs, 'SUPERSEDED'), eq(hist, 'SUPERSEDED'))) codes.push('C6_SUPERSEDED_LIFECYCLE_MISMATCH');
  if (['MULTIPLE_CURRENT', 'FOREIGN_BINDING', 'OWNER_ROW_MISSING', 'OWNER_MISMATCH'].includes(txt(f.connection_store))) {
    codes.push('C7_CONNECTION_CARDINALITY');
  }
  if (eq(authn, 'USABLE') && ['GRANTED', 'GRANTED_LEGACY'].includes(authz)
    && dig(f, 'installation_facts.ever_authorized') === false) codes.push('C8_AUTH_WITHOUT_EVER_AUTHORIZED');
  if (c9) codes.push('C9_CONTRACT_UNKNOWN');
  if (xor(eq(authn, 'NONE'), eq(authz, 'NOT_GRANTED'))) codes.push('C10_AUTHZ_WITHOUT_AUTHN');
  return codes;
}

function oracle(f) {
  const complete = f.identity_completeness === 'COMPLETE';
  const cs = f.identity_claim_state;
  const claim_block = ['CLAIM_CONFLICT', 'PENDING_RECONCILE', 'SUPERSEDED'].includes(cs)
    || (complete && cs !== 'CURRENT_CLAIM_HOLDER');
  const claim_permits = !claim_block && (complete ? cs === 'CURRENT_CLAIM_HOLDER'
    : f.policy.incomplete_identity_ordinary_runtime === 'PERMIT');
  const authn_ok = f.authentication_state === 'USABLE';
  const authz_ok = ['GRANTED', 'GRANTED_LEGACY'].includes(f.authorization_state) && f.reauth_marks_open === 0;
  const auth_ok = authn_ok && authz_ok;
  const installed = f.installation_facts.install_status === 'COMPLETED';
  const ever_authorized = f.installation_facts.ever_authorized === true;
  const credential_lost = ever_authorized && !auth_ok;
  const lifecycle_ok = f.lifecycle_facts.ordinary_runtime === 'PERMITTED' && f.lifecycle_facts.historical === 'NONE';
  const reauth_recoverable = f.lifecycle_facts.recovery_policy === 'PERMITS_REAUTH'
    && f.lifecycle_facts.historical === 'NONE';
  const env = f.environment_state; const qual = f.qualification_state; const comp = f.compatibility_state;
  const host = f.host_state; const adapter = f.adapter_state; const ras = f.resource_action_scope_facts;
  const qualification_blocks = qual.value === 'SUSPENDED'
    || (qual.value === 'NOT_EVALUATED' && f.policy.qualification_not_evaluated === 'BLOCKING');
  // §9.2 whole-set ("→ ∅") factors
  const empty_set = f.identity_state !== 'VALID' || !claim_permits || !authn_ok || !authz_ok
    || f.revocation_state !== 'NOT_REVOKED' || f.lifecycle_facts.ordinary_runtime === 'PAUSED_BY_POLICY'
    || ras.mode === 'NONE' || env.value === 'BLOCKED' || host.value === 'HARD_UNAVAILABLE'
    || adapter.value === 'BLOCKED' || qualification_blocks || comp.value === 'HARD_INCOMPATIBLE';
  // §9.1 / §9.2 per-capability factors; ALL is the vocabulary in byte order, so the result is sorted
  const cand = empty_set ? [] : ALL.filter((c) => has(f.capability_universe, c)
    && has(f.oauth_scope_facts, SCOPE_OF[c])
    && (ras.mode === 'LEGACY_UNRESTRICTED' || has(ras.capabilities, c))
    && (env.value === 'AVAILABLE' || has(env.mask, c))
    && has(host.surface_ceiling, c) && has(host.declared, c)
    && (host.value === 'AVAILABLE' || has(host.mask, c))
    && (adapter.value === 'OK' || has(adapter.mask, c))
    && (qual.value !== 'CONDITIONAL' || has(qual.mask, c))
    && (comp.value === 'COMPATIBLE' || has(comp.mask, c)));
  const blocking = [];
  if (claim_block) blocking.push('B1_identity_claim');
  if (f.identity_state === 'INVALID') blocking.push('B2_identity_invalid');
  if (!lifecycle_ok) blocking.push('B3_lifecycle');
  if (qualification_blocks) blocking.push('B4_qualification');
  if (host.value === 'HARD_UNAVAILABLE') blocking.push('B5_host');
  if (adapter.value === 'BLOCKED') blocking.push('B6_adapter');
  if (env.value === 'BLOCKED') blocking.push('B7_environment');
  if (installed && auth_ok && cand.length === 0) blocking.push('B8_candidate_empty');   // OQ-1 phase
  if (credential_lost && !reauth_recoverable) blocking.push('B9_unrecoverable_auth');
  const blocked = blocking.length > 0;
  const verification_eligible = installed && auth_ok && !claim_block && !blocked && lifecycle_ok
    && host.value !== 'HARD_UNAVAILABLE' && adapter.value !== 'BLOCKED';
  const crv_valid = f.canonical_runtime_verification_facts.status === 'VALID';
  const degradation = [];
  if (adapter.value === 'DEGRADED') degradation.push('adapter_state');
  if (comp.value === 'DEGRADED') degradation.push('compatibility_state');
  if (env.value === 'RESTRICTED') degradation.push('environment_state');
  if (host.value === 'DEGRADED') degradation.push('host_state');
  if (qual.value === 'CONDITIONAL') degradation.push('qualification_state');
  const degraded = degradation.length > 0;
  const first_authorization_required = f.lifecycle_facts.first_authorization_required === true;
  const state = f.revocation_state === 'REVOKED' ? 'REVOKED'
    : comp.value === 'HARD_INCOMPATIBLE' ? 'INCOMPATIBLE'
      : credential_lost && reauth_recoverable ? 'REAUTH_REQUIRED'
        : installed && first_authorization_required && !ever_authorized ? 'AUTH_PENDING'
          : verification_eligible && !crv_valid ? 'VERIFYING'
            : blocked ? 'BLOCKED'
              : installed && cand.length > 0 && lifecycle_ok && crv_valid && degraded ? 'DEGRADED'
                : installed && cand.length > 0 && lifecycle_ok && crv_valid ? 'ACTIVE'
                  : installed ? 'INSTALLED' : 'INSTALL_PENDING';
  const operable = cand.length > 0 && lifecycle_ok && crv_valid && ['ACTIVE', 'DEGRADED'].includes(state);
  return { predicates: { identity_claim_blocks_ordinary_runtime: claim_block,
    verification_precluded_by_blocking_fact: blocked, verification_eligible, credential_lost,
    reauth_recoverable, complete, claim_permits, authn_ok, authz_ok, auth_ok, installed, ever_authorized,
    first_authorization_required, lifecycle_ok, revoked: f.revocation_state === 'REVOKED',
    hard_incompatible: comp.value === 'HARD_INCOMPATIBLE', blocked, crv_valid, degraded,
    candidate_empty: cand.length === 0 },
  blocking, degradation, cand, state, operable, effective: operable ? cand : [] };
}

// §13.2 P2: each truth class (dimension) with its value domain, expressed as patches on a base.
const crv = (status) => ({ canonical_runtime_verification_facts: status === 'NONE'
  ? { status, verification_id: null, valid_until: null }
  : { status, verification_id: '00000000-0000-4000-8000-000000000002', valid_until: '2026-10-24T12:00:00Z' } });
const masked = (cls, value, masks) => masks.map((mask) => ({ [cls]: { value, mask } }));
const DIMENSIONS = [
  ['identity_state', ['VALID', 'INVALID'].map((v) => ({ identity_state: v }))],
  ['identity_completeness', ['COMPLETE', 'INCOMPLETE'].map((v) => ({ identity_completeness: v }))],
  ['identity_claim_state', ['CURRENT_CLAIM_HOLDER', 'INCOMPLETE_UNCLAIMED', 'CLAIM_CONFLICT', 'PENDING_RECONCILE',
    'SUPERSEDED'].map((v) => ({ identity_claim_state: v }))],
  ['claim_store', ['CONSISTENT', 'MISSING_CURRENT_ROW', 'UNEXPECTED_CURRENT_ROW', 'KEY_MISMATCH'].map((v) => ({ claim_store: v }))],
  ['connection_store', ['CONSISTENT', 'MULTIPLE_CURRENT', 'FOREIGN_BINDING', 'OWNER_ROW_MISSING', 'OWNER_MISMATCH']
    .map((v) => ({ connection_store: v }))],
  ['authentication_state', ['USABLE', 'NONE', 'EXPIRED', 'INVALIDATED'].map((v) => ({ authentication_state: v }))],
  ['authorization_state', ['GRANTED', 'NOT_GRANTED', 'GRANTED_LEGACY', 'EXPIRED', 'REVOKED_CONNECTION']
    .map((v) => ({ authorization_state: v }))],
  ['reauth_marks_open', [0, 1, 2].map((v) => ({ reauth_marks_open: v }))],
  ['oauth_scope_facts', [['context:read', 'context:write'], [], ['context:read'], ['context:write'], ['audit:read'],
    ['audit:read', 'context:read'], ['audit:read', 'context:write'], ['audit:read', 'context:read', 'context:write']]
    .map((v) => ({ oauth_scope_facts: v }))],
  ['resource_action_scope_facts', [{ mode: 'ENTRIES', capabilities: ['context.read', 'context.write', 'project.read'] },
    { mode: 'NONE' }, { mode: 'LEGACY_UNRESTRICTED' }, { mode: 'ENTRIES', capabilities: [] },
    { mode: 'ENTRIES', capabilities: ['context.read'] }, { mode: 'ENTRIES', capabilities: ALL }]
    .map((v) => ({ resource_action_scope_facts: v }))],
  ['environment_state', [{ environment_state: { value: 'AVAILABLE', mask: null } },
    ...masked('environment_state', 'RESTRICTED', [[], ['context.read'], ALL]),
    { environment_state: { value: 'BLOCKED', mask: null } }]],
  ['qualification_state', [{ qualification_state: { value: 'NOT_EVALUATED', mask: null } },
    { qualification_state: { value: 'QUALIFIED', mask: null } },
    ...masked('qualification_state', 'CONDITIONAL', [[], ['project.read'], ALL]),
    { qualification_state: { value: 'SUSPENDED', mask: null } }]],
  ['compatibility_state', [{ compatibility_state: { value: 'COMPATIBLE', mask: null } },
    ...masked('compatibility_state', 'DEGRADED', [[], ['context.read', 'context.write'], ALL]),
    { compatibility_state: { value: 'HARD_INCOMPATIBLE', mask: null } }]],
  ['revocation', [['NOT_REVOKED', 'NONE'], ['REVOKED', 'INTEGRATION'], ['REVOKED', 'CONNECTION_USER_REVOKE']]
    .map(([state, source]) => ({ revocation_state: state, revocation_source: source }))],
  ['host_state.value', [{ host_state: { value: 'AVAILABLE', mask: null } },
    { host_state: { value: 'DEGRADED', mask: ['context.read'] } }, { host_state: { value: 'DEGRADED', mask: ALL } },
    { host_state: { value: 'HARD_UNAVAILABLE', mask: null } }]],
  ['host_state.declared', [ALL, [], ['audit.read', 'context.read']].map((v) => ({ host_state: { declared: v } }))],
  ['host_state.surface_ceiling', [ALL, ['context.write']].map((v) => ({ host_state: { surface_ceiling: v } }))],
  ['adapter_state', [{ adapter_state: { value: 'OK', mask: null } }, ...masked('adapter_state', 'DEGRADED', [[], ['context.read'], ALL]),
    { adapter_state: { value: 'BLOCKED', mask: null } }]],
  ['lifecycle_facts.ordinary_runtime', ['PERMITTED', 'PAUSED_BY_OWNER', 'PAUSED_BY_POLICY']
    .map((v) => ({ lifecycle_facts: { ordinary_runtime: v } }))],
  ['lifecycle_facts.historical', ['NONE', 'SUPERSEDED'].map((v) => ({ lifecycle_facts: { historical: v } }))],
  ['lifecycle_facts.recovery_policy', ['PERMITS_REAUTH', 'FORBIDS_REAUTH'].map((v) => ({ lifecycle_facts: { recovery_policy: v } }))],
  ['lifecycle_facts.first_authorization_required', [true, false]
    .map((v) => ({ lifecycle_facts: { first_authorization_required: v } }))],
  ['installation_facts.install_status', ['COMPLETED', 'PENDING'].map((v) => ({ installation_facts: { install_status: v } }))],
  ['installation_facts.ever_authorized', [true, false].map((v) => ({ installation_facts: { ever_authorized: v } }))],
  ['canonical_runtime_verification_facts', ['VALID', 'NONE', 'EXPIRED', 'FAILED', 'INVALIDATED'].map(crv)],
  ['policy.incomplete_identity_ordinary_runtime', ['PERMIT', 'DENY']
    .map((v) => ({ policy: { incomplete_identity_ordinary_runtime: v } }))],
  ['policy.qualification_not_evaluated', ['NON_BLOCKING', 'BLOCKING']
    .map((v) => ({ policy: { qualification_not_evaluated: v } }))],
  ['capability_universe', [ALL, [], ['audit.read', 'context.read']].map((v) => ({ capability_universe: v }))],
];
const KEEP = { claim_store: 0.85, connection_store: 0.85, 'lifecycle_facts.historical': 0.85, identity_completeness: 0.75 };
// Schema-level corruptions mixed into the random layer (4 %), so C1 / C9 are exercised too.
// The list is generated from the same tables validateOracle and the migration validate against,
// instead of being hand-written. What that buys, stated exactly: every §7.1 rule of the validator
// has at least one sample that breaks it and nothing else, with four allow-listed exceptions that
// no sample built from a JavaScript object can reach — the as_of and valid_until instant rules and
// the reauth_marks_open / policy.policy_version integer spellings, which the raw-text vectors of
// the "§7.1 lexical validation" subtest cover instead. That claim is not a comment: the RULE-SOLE
// assertion below enumerates the validator's branches and fails naming any that no sample isolates,
// and SOLE_EXEMPT is the allow-list it consults. An earlier version of this comment claimed the
// mask rules were covered when the mask vocabulary had no distinguishing sample at all; the
// assertion exists so that the claim cannot go stale again (Owner Decision
// c79a6278-4cfa-478a-aa04-e98ff379c17a).
//
// The list, per family: one out-of-domain string and one one-element array per ENUMS entry; one
// deleted required key and one unknown key per KEY_SETS entry; four mask directions per state
// object (a non-null mask on an unmasked value, a JSON null mask on a masked one, a mask outside
// the capability vocabulary and a mask spelled as a bare name rather than an array); and one per
// §7.1 rule that is neither an enumeration nor a KEY_SETS entry — the three capability sets and
// the OAuth scope set, in both the vocabulary and the array-type direction, the six directions of
// the resource_action_scope_facts tagged union (an exact key set of §7.1 that KEY_SETS cannot
// express, because which keys are exact depends on mode, plus the union not being an object and
// its `mode` tag missing — PR #340 third delta review MINOR-1), the two booleans, the
// verification_id reference, the reauth_marks_open domain and type, the two
// contract-string types, the policy_version type and the revocation pair. Authorities: the v0.1.8
// second delta review's MINOR-2, generate the list from the tables; the PR #340 review's MAJOR-1,
// the value shapes had no distinguishing sample; the PR #340 second delta review's MAJOR-1 and
// Owner Decision c79a6278 for the mask vocabulary and for the four families the RULE-SOLE
// assertion then found with it (the array-typed enumeration, capability-set, OAuth-scope,
// mask-array and policy_version-type directions, all of which jsonb containment accepts on its own
// because a jsonb scalar is contained in an array that has it as an element).
//
// Measured over the CI count (250,000 random samples at SEED 20260924, 10,010 of them corrupted):
// 56…92 samples per shape corruption (mean 73.8) and 644…674 per C9 carrier. No base drawn from
// DIMENSIONS violates a C1 rule — that is asserted, not assumed, for every centre, every patch and
// every pre-corruption random base — so every one of those samples distinguishes the rule its
// corruption breaks. The narrower figure, samples whose base carried no reason code at all, is
// 16…39 per shape corruption (mean 26.4). Random-layer C1 is 8,047 and C9 1,963; the random layer
// is 34.4 % valid and the 265,246 P2 samples are 36.5 % valid, so the §8 / §9 layers keep the same
// positive coverage. RULE-SOLE sees 8…674 isolating samples per validator rule.
//
// A corruption is a single independent defect on most bases, but not on all; 28 of the 109 are not
// always singular, re-measured with the generator below:
//   - the five JSON-null mask corruptions never are, by construction: a JSON null mask on a masked
//     value fails both the array-type and the vocabulary test of the same `if`. That is exactly why
//     the other two mask directions exist — a JSON null isolates neither disjunct.
//   - the ten required-key deletions are singular except when the deleted key is itself a nested
//     object (root: 59 %) or when the state object's value and mask are read by the mask rule as a
//     pair (environment 76 %, qualification 87 %, compatibility 88 %, host 94 %, adapter 86 %).
//   - sixteen of the 46 enumeration corruptions break a second C1 rule on part of their bases:
//     revocation_state (64 % / 75 % singular for the out-of-domain and array directions) and
//     revocation_source (35 % / 22 %) break the revocation pair, the five *_state.value ones
//     (62…87 %) break the mask rule whenever the base carried a non-null mask, and
//     resource_action_scope_facts.mode (16 % / 14 %) moves the union out of its ENTRIES branch
//     while the capabilities key is still there.
//   - deleting the union's `mode` tag (11 %) is singular only on a NONE or LEGACY_UNRESTRICTED
//     base, where it leaves `{}`; on an ENTRIES base the leftover `capabilities` key also breaks
//     the non-ENTRIES exactness rule.
// Coverage is unaffected — each of the 28 isolates its own rule on the bases where it is singular,
// and RULE-SOLE is what checks that, rule by rule, rather than this paragraph.
const setDotted = (facts, dotted, value) => {
  const keys = dotted.split('.');
  const node = keys.slice(0, -1).reduce((v, k) => (v[k] ??= {}), facts);
  node[keys[keys.length - 1]] = value;
};
const MASKED_VALUES = ['RESTRICTED', 'CONDITIONAL', 'DEGRADED'];
const STATE_OBJECTS = ['environment_state', 'qualification_state', 'compatibility_state', 'host_state', 'adapter_state'];
const CAPABILITY_SETS = ['capability_universe', 'host_state.surface_ceiling', 'host_state.declared'];
const SHAPE_CORRUPTIONS = [
  // every enumeration of §7.1: a string outside its domain, and the base's own value wrapped in a
  // one-element array. The second is the only input that isolates the type half of the enumeration
  // rule: jsonb containment accepts an array whose elements are all in the domain, so
  // `not (v <@ domain)` passes and only `jsonb_typeof(v) is distinct from 'string'` rejects it.
  ...Object.keys(ENUMS).map((name) => (f) => setDotted(f, name, '__OUT_OF_DOMAIN__')),
  ...Object.keys(ENUMS).map((name) => (f) => setDotted(f, name, [dig(f, name)])),
  // every exact key set of §7.1: one required key deleted, and one unknown key added
  ...Object.entries(KEY_SETS).flatMap(([name, keys]) => [
    (f, rng) => { delete (name === '' ? f : f[name])[keys[Math.floor(rng() * keys.length)]]; },
    (f) => { (name === '' ? f : f[name]).unexpected_key = null; },
  ]),
  // every state object: a non-null mask on a value that must not carry one (ERRATA-001), and the
  // opposite direction, a JSON null mask on a value that must carry one (§7.1)
  ...STATE_OBJECTS.flatMap((name) => {
    const masked = ENUMS[`${name}.value`].filter((v) => MASKED_VALUES.includes(v));
    const unmasked = ENUMS[`${name}.value`].filter((v) => !MASKED_VALUES.includes(v));
    return [
      (f, rng) => { f[name] = { ...f[name], value: unmasked[Math.floor(rng() * unmasked.length)], mask: ['context.read'] }; },
      (f, rng) => { f[name] = { ...f[name], value: masked[Math.floor(rng() * masked.length)], mask: null }; },
      // the mask's own vocabulary, and its array type — neither of which the two directions above
      // reach: a JSON null mask fails both the type and the containment test at once, so it
      // isolates neither, while a bare vocabulary name is contained but is not an array
      (f, rng) => { f[name] = { ...f[name], value: masked[Math.floor(rng() * masked.length)], mask: ['admin.write'] }; },
      (f, rng) => { f[name] = { ...f[name], value: masked[Math.floor(rng() * masked.length)], mask: 'context.read' }; },
    ];
  }),
  // ---- the §7.1 value shapes: the rules no table above drives (PR #340 review MAJOR-1) --------
  // every capability set of §7.1: an element outside the capability vocabulary, and a single
  // vocabulary name spelled as a bare string instead of a one-element array. The second isolates
  // the array-type half of the rule, which containment alone accepts: a jsonb scalar is contained
  // in an array that has it as an element.
  ...CAPABILITY_SETS.map((name) => (f) => setDotted(f, name, [...(dig(f, name) ?? []), 'admin.write'])),
  ...CAPABILITY_SETS.map((name) => (f) => setDotted(f, name, 'context.read')),
  // the OAuth scope set, whose vocabulary is the three v12 scopes and not the capability names
  (f) => { f.oauth_scope_facts = [...f.oauth_scope_facts, 'admin:write']; },
  (f) => { f.oauth_scope_facts = 'context:read'; },
  // resource_action_scope_facts, the tagged union: exactness in the ENTRIES branch and in the
  // other two, the capability vocabulary of the ENTRIES member, and that member missing
  (f) => { f.resource_action_scope_facts = { mode: 'ENTRIES', capabilities: [], unexpected_key: null }; },
  (f) => { f.resource_action_scope_facts = { mode: 'NONE', unexpected_key: null }; },
  (f) => { f.resource_action_scope_facts = { mode: 'ENTRIES', capabilities: ['admin.write'] }; },
  (f) => { f.resource_action_scope_facts = { mode: 'ENTRIES' }; },
  // …the union not being an object at all, and the tag itself missing, which on a NONE or
  // LEGACY_UNRESTRICTED base leaves `{}` — an object no other corruption produces (MINOR-1)
  (f) => { f.resource_action_scope_facts = 'NONE'; },
  (f) => { delete f.resource_action_scope_facts.mode; },
  // the two booleans and the uuid reference: a value of the wrong JSON type, which the string
  // spellings 'true' / 'false' / a non-uuid make visible without changing anything else
  (f) => { f.lifecycle_facts.first_authorization_required = 'true'; },
  (f) => { f.installation_facts.ever_authorized = 'false'; },
  (f) => { f.canonical_runtime_verification_facts.verification_id = 'not-a-uuid'; },
  // reauth_marks_open: outside its non-negative domain, and not a number at all. ERRATA-002
  // item 1's integer *spelling* rule is not reachable from here, because JSON.stringify emits 0.0
  // as 0; it is covered by the raw-text cases below instead.
  (f) => { f.reauth_marks_open = -1; },
  (f) => { f.reauth_marks_open = '0'; },
  // the two contract strings and the policy version: a non-string / non-number is C1, not the C9
  // an unknown value of the right type would give. `policy_version: '1'` also isolates the number
  // half of its rule, which the ^[0-9]+$ test on the jsonb text form accepts on its own.
  (f) => { f.schema = 1; },
  (f) => { f.derivation_contract = null; },
  (f) => { setDotted(f, 'policy.policy_version', '1'); },
  // the revocation pair (§7.2, ERRATA-001)
  (f) => { f.revocation_source = f.revocation_state === 'REVOKED' ? 'NONE' : 'INTEGRATION'; },
];
// C9_CONTRACT_UNKNOWN's three carriers: a well-formed but unknown schema, derivation contract or
// policy version. They are the only way any layer of this file reaches C9.
const C9_CORRUPTIONS = [['schema', 'clued.integration-facts.v2'],
  ['derivation_contract', 'clued.integration-derivation.v2'], ['policy.policy_version', 2]]
  .map(([name, value]) => (f) => setDotted(f, name, value));
// The share of random samples that carry a corruption. It rose from 2 % to 2.5 % as the shape list
// grew from 59 members to 69, and to 4 % as it grew to 109, so that samples per corruption stay
// where they were instead of thinning as the list grows; the cost is valid samples.
const CORRUPTION_RATE = 0.04;
// PR #340 review MINOR-1: draw the family first and the member second. A flat uniform draw over
// one list made every code's share a function of the list's length, so growing the shape list from
// 8 to 59 members cut random-layer C9 from 567 to 235 without anyone deciding to. C9 has exactly
// three carriers in the whole schema and no other layer of this file reaches it, so its family is
// drawn with a fixed 1/5 probability and the shape family with 4/5; within a family the draw stays
// uniform, so the shape corruptions remain equally likely to each other. Both draws come from the
// sampler's rng, so the layer is still a pure function of SEED. Editing SHAPE_CORRUPTIONS now
// moves only the shape counts; C9_FAMILY_SHARE is the only thing that moves C9.
const C9_FAMILY_SHARE = 1 / 5;
const pickCorruption = (rng) => {
  const family = rng() < C9_FAMILY_SHARE ? C9_CORRUPTIONS : SHAPE_CORRUPTIONS;
  return family[Math.floor(rng() * family.length)];
};

// ---- the validator's rules, one predicate per independently-mutable branch ---------------------
// Owner Decision c79a6278-4cfa-478a-aa04-e98ff379c17a. Three consecutive reviews each found the
// same shape of surviving fail-open mutant: a §7.1 / §7.3 rule that every layer of this file
// happened to break only together with another rule, so deleting it changed no output. The two
// assertions built on this list turn that review catch into a test obligation:
//
//   1. RULE-MIRROR — on every sample, `C1_RULES.some(fire)` equals whether validateOracle reported
//      C1, and the same for C9. The mirror is sound (a predicate fires only where the SQL sets its
//      flag), and complete over the sampled corpus: on no sample does the oracle report the code
//      with no predicate firing. So it is a second, branch-resolved reading of the same validator.
//      Completeness is a measured property of the corpus, not a structural one — a document shape
//      that no layer of this file produces can still set the flag with nothing firing, and PR #340
//      third delta review MINOR-1 found one (`resource_action_scope_facts: {}`), now closed by the
//      `ras:mode:presence` predicate and the corruption that deletes the tag. The omissions below
//      are therefore argued from the SQL text one by one, not inferred from the assertion passing.
//   2. RULE-SOLE — every predicate has at least one sample where it is the ONLY predicate of its
//      reason code that fires. That sample is what distinguishes the branch: delete the branch and
//      the sample's code set changes. A predicate with no such sample is a mutation-testing blind
//      spot, and the assertion names it.
//
// The scope of that obligation is integration_facts_validate_v1 and nothing else — one function of
// the nine in PURE. Every other *validator* reached from this file
// (integration_ceiling_valid_v1, integration_timestamp_valid_v1, integration_version_cmp_v1,
// integration_capabilities_valid_v1), integration_derive_v1's canonicalizer, and the registry
// CHECK constraints generally have hand-written example tables only, with no coverage obligation
// and no mirror, so the
// mutation-survivor class this list closes is NOT closed for them. PR #340's third and fourth
// delta reviews found live fail-open mutants across those surfaces — the ceiling's resource_id
// length and type disjuncts and its actions element type, the timestamp's fractional-second
// bound, derive_v1's canonicalizer de-duplication, and at least three registry CHECKs (among
// them the capability_ceiling CHECK on integration_host_surfaces_v1, its surface regex, and the
// hosts.host regex) — so this
// enumeration is a sample of what is uncovered, not an inventory of it. The ceiling and timestamp
// cases are fixed by targeted rows in their own subtests below; extending an obligation like this
// one to the remaining functions is carried to S2c PR-2 by Owner Decision
// 0402d831-fa57-4a31-86e4-44467b85a796.
//
// Where the line is drawn. A predicate is emitted for one piece of SQL text whose deletion can
// change the function's output — a single disjunct of a single `if`, instantiated once per entry of
// the array or constant that drives its loop (the loop bodies are data-driven, and an entry of
// `v_keys` / `v_enums` is as mutable as the disjunct that reads it). Deliberately NOT emitted,
// because deleting the text cannot change any output — an equivalent mutant, not a blind spot:
//   - `jsonb_typeof(v) is distinct from 'object'` in the exact-key-set loop. For a present
//     non-object, `not (v ?& v_keys)` is already true (a jsonb scalar has no keys) or, for an
//     array, `(v - v_keys) <> '{}'::jsonb` is (deleting elements from an array cannot give `{}`).
//     For an absent nested object the root's own missing-key disjunct fires.
//   - `not (v ?& array['mode','capabilities'])` in the ENTRIES branch of resource_action_scope_facts.
//     It can only fire when `capabilities` is absent, which the `jsonb_typeof(v->'capabilities') is
//     distinct from 'array'` disjunct of the same `if` also rejects.
//   - the type half of the `as_of` rule as a separate predicate: for any non-string `as_of`, the
//     `#>> '{}'` text form of the same `if` is either a non-instant or SQL NULL, and
//     integration_timestamp_valid_v1 rejects both, so deleting `jsonb_typeof(v) is distinct from
//     'string'` cannot change an output.
// That list is short, and `reauth_marks_open` is NOT on it. An earlier version of this comment
// named the type half of its rule here as well (PR #340 third delta review MINOR-3); both halves
// of that claim were wrong. The predicate IS emitted below as `reauth_marks_open:type`, and
// deleting `jsonb_typeof(v) is distinct from 'number'` is a fail-open mutant, not an equivalent
// one: on `reauth_marks_open: null` the `#>> '{}'` form is SQL NULL, so `!~ '^[0-9]+$'` evaluates
// to NULL and does not fire, and on `reauth_marks_open: '0'` the text form is `0`, which the
// regex accepts. The second of those two is the shape list's `reauth_marks_open = '0'` corruption,
// and it is what isolates this predicate for RULE-SOLE.
// The required-key family is emitted as ONE `presence:*` predicate per object, not as two branches
// per key, and the type halves of the rules that read a key are written to ignore an absent value.
// That is the same judgement in the other direction: a missing key is rejected twice over, by the
// `?&` disjunct and by the type check of whichever rule reads that key (every key of every object
// has such a rule), so no single deletion of either fails open and no sample can isolate one from
// the other. Modelling the pair as one predicate keeps RULE-SOLE meaningful — a key deletion does
// isolate the pair from every other rule — instead of demanding a sample that cannot exist. It is
// also why an earlier decomposition saw ~50 `keyset:*:missing` and `enum:*:type` predicates fire
// without ever being sole.
// the mirror runs on every sample, so every dotted path is split once, here, and never per call
const at = (node, path) => path.reduce((v, k) => (v === null || typeof v !== 'object' ? undefined : v[k]), node);
const jtype = (v) => (v === undefined ? undefined
  : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
// `jsonb_typeof(v) is distinct from t`, with an absent value standing for SQL NULL
const typeIsNot = (v, t) => jtype(v) !== t;
// `not (v <@ names)` as the SQL evaluates it: NULL propagates, so `if` does not fire; a jsonb scalar
// IS contained in an array that has it as an element, and an array is contained element-wise
const notContained = (v, names) => {
  if (v === undefined) return false;
  if (typeof v === 'string') return !names.includes(v);
  if (Array.isArray(v)) return !v.every((e) => typeof e === 'string' && names.includes(e));
  return true;
};
const here = (v) => v !== undefined;
const C1_RULES = [
  // the exact key sets of §7.1: a required key absent (exempt, see above) and an unknown key present
  ...Object.entries(KEY_SETS).flatMap(([name, keys]) => {
    const node = (f) => (name === '' ? f : f[name]);
    const label = name || '(root)';
    return [
      [`presence:${label}`, (f) => { const v = node(f); return !isJsonObject(v) || !keys.every((k) => present(v, k)); }],
      [`keyset:${label}:unexpected`, (f) => { const v = node(f); return isJsonObject(v) && Object.keys(v).some((k) => !keys.includes(k)); }],
    ];
  }),
  // the enumerations of §7.1: not a string, and outside the domain
  ...Object.entries(ENUMS).flatMap(([name, values]) => {
    const path = name.split('.');
    return [
      [`enum:${name}:type`, (f) => { const v = at(f, path); return here(v) && typeIsNot(v, 'string'); }],
      [`enum:${name}:domain`, (f) => notContained(at(f, path), values)],
    ];
  }),
  // the two booleans
  ...['lifecycle_facts.first_authorization_required', 'installation_facts.ever_authorized'].map((name) => {
    const path = name.split('.');
    return [`bool:${name}`, (f) => { const v = at(f, path); return here(v) && typeIsNot(v, 'boolean'); }];
  }),
  // reauth_marks_open: a number, spelled as a non-negative integer (ERRATA-002 item 1)
  ['reauth_marks_open:type', (f) => here(f.reauth_marks_open) && typeIsNot(f.reauth_marks_open, 'number')],
  ['reauth_marks_open:integer', (f) => typeof f.reauth_marks_open === 'number' && !/^[0-9]+$/.test(String(f.reauth_marks_open))],
  // as_of and the two canonical-runtime-verification references
  ['as_of:instant', (f) => here(f.as_of) && !(typeof f.as_of === 'string' && instantValid(f.as_of))],
  ['crv:verification_id', (f) => { const v = f.canonical_runtime_verification_facts?.verification_id;
    return here(v) && !(v === null || (typeof v === 'string' && UUID_RE.test(v))); }],
  ['crv:valid_until', (f) => { const v = f.canonical_runtime_verification_facts?.valid_until;
    return here(v) && !(v === null || (typeof v === 'string' && instantValid(v))); }],
  // the three capability sets and the OAuth scope set: an array, of vocabulary names
  ...CAPABILITY_SETS.flatMap((name) => {
    const path = name.split('.');
    return [
      [`capabilities:${name}:type`, (f) => { const v = at(f, path); return here(v) && typeIsNot(v, 'array'); }],
      [`capabilities:${name}:vocabulary`, (f) => notContained(at(f, path), VOCAB)],
    ];
  }),
  ['oauth_scope_facts:type', (f) => here(f.oauth_scope_facts) && typeIsNot(f.oauth_scope_facts, 'array')],
  ['oauth_scope_facts:vocabulary', (f) => notContained(f.oauth_scope_facts, OAUTH_SCOPES)],
  // resource_action_scope_facts, the tagged union
  ['ras:type', (f) => here(f.resource_action_scope_facts) && typeIsNot(f.resource_action_scope_facts, 'object')],
  // `mode` absent from the union. PR #340 third delta review MINOR-1: this is the one required key
  // in the schema that no `presence:*` predicate covered, because resource_action_scope_facts is
  // not a KEY_SETS entry (which keys are exact depends on mode) and `enum:…:mode:type` is written
  // to ignore an absent value. The SQL still rejects it — the enum loop reads a SQL NULL, which is
  // `distinct from 'string'` — so `resource_action_scope_facts: {}` was a live mirror
  // counterexample: C1 from both SQL and validateOracle with no predicate firing.
  ['ras:mode:presence', (f) => { const v = f.resource_action_scope_facts; return isJsonObject(v) && !present(v, 'mode'); }],
  ['ras:ENTRIES:unexpected', (f) => { const v = f.resource_action_scope_facts;
    return isJsonObject(v) && txt(v.mode) === 'ENTRIES' && Object.keys(v).some((k) => k !== 'mode' && k !== 'capabilities'); }],
  ['ras:ENTRIES:capabilities:type', (f) => { const v = f.resource_action_scope_facts;
    return isJsonObject(v) && txt(v.mode) === 'ENTRIES' && typeIsNot(v.capabilities, 'array'); }],
  ['ras:ENTRIES:capabilities:vocabulary', (f) => { const v = f.resource_action_scope_facts;
    return isJsonObject(v) && txt(v.mode) === 'ENTRIES' && notContained(v.capabilities, VOCAB); }],
  ['ras:other:unexpected', (f) => { const v = f.resource_action_scope_facts;
    return isJsonObject(v) && txt(v.mode) !== 'ENTRIES' && Object.keys(v).some((k) => k !== 'mode'); }],
  // the masks (§5.6, ERRATA-001): an array exactly for RESTRICTED / CONDITIONAL / DEGRADED, of
  // vocabulary names, and JSON null for every other value
  ...STATE_OBJECTS.flatMap((name) => {
    const mask = (f) => f[name]?.mask;
    const isMasked = (f) => MASKED_VALUES.includes(txt(f[name]?.value));
    return [
      [`mask:${name}:array`, (f) => isMasked(f) && here(mask(f)) && typeIsNot(mask(f), 'array')],
      [`mask:${name}:vocabulary`, (f) => isMasked(f) && notContained(mask(f), VOCAB)],
      [`mask:${name}:null`, (f) => !isMasked(f) && here(mask(f)) && mask(f) !== null],
    ];
  }),
  // the revocation pair (§7.2, ERRATA-001)
  ['revocation:pair', (f) => eq(txt(f.revocation_state), 'REVOKED') !== (txt(f.revocation_source) !== 'NONE')],
  // the C9 carriers: a value of the wrong type is C1, not C9
  ['schema:type', (f) => here(f.schema) && typeof f.schema !== 'string'],
  ['derivation_contract:type', (f) => here(f.derivation_contract) && typeof f.derivation_contract !== 'string'],
  ['policy_version:type', (f) => { const v = f.policy?.policy_version; return here(v) && typeIsNot(v, 'number'); }],
  ['policy_version:integer', (f) => { const v = f.policy?.policy_version;
    return typeof v === 'number' && !/^[0-9]+$/.test(String(v)); }],
];
const C9_RULES = [
  ['c9:schema', (f) => typeof f.schema === 'string' && f.schema !== 'clued.integration-facts.v1'],
  ['c9:derivation_contract', (f) => typeof f.derivation_contract === 'string'
    && f.derivation_contract !== 'clued.integration-derivation.v1'],
  ['c9:policy_version', (f) => { const v = f.policy?.policy_version;
    return typeof v === 'number' && /^[0-9]+$/.test(String(v)) && v !== 1; }],
];
// Predicates exempt from RULE-SOLE, each with the reason and, where the rule is reachable but not
// from a JavaScript object, the committed vector that covers it instead. Nothing is listed here
// merely for having no sample: an unreachable rule with no named vector is a coverage gap.
const SOLE_EXEMPT = new Map([
  ['as_of:instant', 'JSON.stringify cannot emit an invalid instant from a Date-free JS value that '
    + 'the generator builds; covered by the "§7.1 lexical validation" vectors as_of 2026-13-99T99:99:99Z '
    + 'and 2026-09-24T24:00:00Z'],
  ['crv:valid_until', 'as as_of:instant; covered by the same subtest\'s valid_until vectors '
    + '2026-02-31T00:00:00Z and 2026-09-24T12:00:60Z'],
  ['policy_version:integer', 'ERRATA-002 item 1 is a rule about the jsonb text form, and '
    + 'JSON.stringify emits 1.0 as 1; covered by the raw-text vector "policy_version":1.0 in the '
    + '"§7.1 lexical validation" subtest'],
]);

// ---- branch-coverage obligations for the rest of the validator surface (S2c PR-2) -------------
// Owner Decision 0402d831-fa57-4a31-86e4-44467b85a796 carries the obligation above — a
// branch-resolved mirror plus a sole-cause sample per branch — from integration_facts_validate_v1
// to the surface PR #340's third and fourth delta reviews found live fail-open mutants in. The
// granularity rule is the one stated above: one predicate per piece of SQL text whose deletion can
// change an output, with everything deliberately not emitted argued as an equivalent mutant in
// EQUIVALENTS, and everything real but unreachable from the generator allow-listed with the
// committed vector that covers it instead.
//
// Two obligations are added here, because these functions are not all "reject if any rule fires":
//   ACCEPT-COVER — every accepting branch (an early `return true`, or one arm of a function that
//     returns more than a boolean) is taken by at least one sample. A reject-only mirror says
//     nothing about a branch that exists in order to accept: deleting the ceiling's
//     LEGACY_UNRESTRICTED short-circuit turns an accept into a reject, and no reject rule fires.
//   VALUE — where the result is not a boolean (integration_version_cmp_v1) the accepted samples are
//     compared against an independent oracle, so the segment comparison is covered and not only the
//     reject half.
//
// A regex is one piece of text in the same sense a disjunct is: its atoms and bounds are
// independently mutable, and PR #340's fourth delta review found exactly that mutant — widening
// `(\.[0-9]{1,6})?` to `{1,9}` passed 41/41. So one predicate is emitted per atom of the instant
// grammar, not one for the whole match.
const CEILING_SCOPES = ['audit:read', 'context:read', 'context:write'];
const CEILING_ACTIONS = ['audit', 'close', 'feedback_submit', 'read', 'restore', 'write'];
const RESOURCE_KINDS = ['scope', 'context'];
const ENVIRONMENTS = ['canonical', 'test', 'preview', 'production'];
// every name compared below is ASCII, where the C collation the SQL pins and JavaScript's
// UTF-16 code-unit order agree; the ceiling subtest asserts that on the database for the two
// vocabularies that are actually sorted (scopes and actions), so this is checked, not assumed
const sortedUnique = (list) => [...new Set(list)].sort();
const isCanonicalList = (list) => JSON.stringify(list) === JSON.stringify(sortedUnique(list));

// ---- integration_capabilities_valid_v1(text[]) ----
// `select p_capabilities is not null and array_position(p_capabilities, null) is null
//    and p_capabilities <@ array[…7 names…]`
const CAPABILITIES_RULES = [
  ['capabilities:null', (v) => v === null],
  ['capabilities:vocabulary', (v) => Array.isArray(v) && !v.every((e) => e !== null && ALL.includes(e))],
];

// ---- integration_timestamp_valid_v1(text) ----
// The lexical shape is pinned first and the guarded cast runs second, so the predicates split the
// same way: one per atom of the regex, then one for the cast. A sample is built by mutating exactly
// one field of a well-formed instant, which is what isolates each atom for ACCEPT/SOLE.
const LOOSE_INSTANT = /^([0-9]*)-([0-9]*)-([0-9]*)T([0-9]*):([0-9]*):([0-9]*)(\.[0-9]*)?(.*)$/;
const OFFSET_RE = /^(Z|[+-][0-9]{2}:[0-9]{2})$/;
const daysInMonth = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
// what PostgreSQL's timestamptz cast rejects among strings the regex already accepts: an
// out-of-range month or day, a minute of 60…99, and an offset outside ±15:59 (probed on the
// database by the subtest, not assumed here)
function instantCastFails(text) {
  const m = LOOSE_INSTANT.exec(text);
  if (!m) return false;
  const [, y, mo, d, , mi, , , offset] = m;
  if (Number(mo) < 1 || Number(mo) > 12) return true;
  if (Number(d) < 1 || Number(d) > daysInMonth(Number(y), Number(mo))) return true;
  if (Number(mi) > 59) return true;
  if (offset !== 'Z') {
    const [oh, om] = offset.slice(1).split(':').map(Number);
    if (oh > 15 || om > 59 || (oh === 15 && om > 59)) return true;
  }
  return false;
}
const field = (text, i) => { const m = LOOSE_INSTANT.exec(text); return m ? m[i] : null; };
// every rule below is written to fire only when the string reaches its atom: the shape rule owns
// everything the loose grammar cannot split, and each field rule reads its own capture group
const INSTANT_RULES = [
  ['instant:null', (v) => v === null],
  ['instant:shape', (v) => typeof v === 'string' && !LOOSE_INSTANT.test(v)],
  ['instant:year', (v) => field(v, 1) !== null && field(v, 1).length !== 4],
  ['instant:month', (v) => field(v, 2) !== null && field(v, 2).length !== 2],
  ['instant:day', (v) => field(v, 3) !== null && field(v, 3).length !== 2],
  ['instant:hour', (v) => { const h = field(v, 4); return h !== null && !/^(2[0-3]|[01][0-9])$/.test(h); }],
  ['instant:minute', (v) => { const x = field(v, 5); return x !== null && x.length !== 2; }],
  ['instant:second', (v) => { const s = field(v, 6); return s !== null && !/^[0-5][0-9]$/.test(s); }],
  // the bound PR #340's fourth delta review mutated: `{1,6}` widened to `{1,9}` passed the suite,
  // and PostgreSQL rounds a 7th digit, so the document would not denote the instant it spells
  ['instant:fraction', (v) => { const f = field(v, 7); return f !== null && f !== undefined
    && !/^\.[0-9]{1,6}$/.test(f); }],
  ['instant:offset', (v) => { const o = field(v, 8); return o !== null && o !== undefined && !OFFSET_RE.test(o); }],
  ['instant:cast', (v) => typeof v === 'string' && instantCastFails(v)],
];

// ---- integration_ceiling_valid_v1(jsonb) ----
const CEILING_ENTRY_KEYS = ['actions', 'environment', 'resource_id', 'resource_kind'];
const entries = (c) => (isJsonObject(c) ? c.entries : undefined);
const entryList = (c) => (Array.isArray(entries(c)) ? entries(c) : []);
const legacy = (c) => entries(c) === 'LEGACY_UNRESTRICTED';
const someEntry = (c, fire) => entryList(c).some((e) => fire(e));
const CEILING_RULES = [
  ['ceiling:type', (c) => !isJsonObject(c)],
  ['ceiling:keyset', (c) => isJsonObject(c)
    && JSON.stringify(Object.keys(c).sort()) !== JSON.stringify(['entries', 'scopes'])],
  ['ceiling:scopes:type', (c) => isJsonObject(c) && 'scopes' in c && !Array.isArray(c.scopes)],
  ['ceiling:scopes:vocabulary', (c) => isJsonObject(c) && Array.isArray(c.scopes)
    && !c.scopes.every((e) => typeof e === 'string' && CEILING_SCOPES.includes(e))],
  ['ceiling:scopes:canonical', (c) => isJsonObject(c) && Array.isArray(c.scopes)
    && c.scopes.every((e) => typeof e === 'string') && !isCanonicalList(c.scopes)],
  ['ceiling:entries:type', (c) => isJsonObject(c) && 'entries' in c && !legacy(c) && !Array.isArray(c.entries)],
  ['ceiling:entry:type', (c) => someEntry(c, (e) => !isJsonObject(e))],
  ['ceiling:entry:keyset', (c) => someEntry(c, (e) => isJsonObject(e)
    && JSON.stringify(Object.keys(e).sort()) !== JSON.stringify(CEILING_ENTRY_KEYS))],
  ['ceiling:resource_kind:type', (c) => someEntry(c, (e) => isJsonObject(e) && 'resource_kind' in e
    && typeof e.resource_kind !== 'string')],
  ['ceiling:resource_kind:domain', (c) => someEntry(c, (e) => isJsonObject(e)
    && typeof e.resource_kind === 'string' && !RESOURCE_KINDS.includes(e.resource_kind))],
  ['ceiling:resource_id:type', (c) => someEntry(c, (e) => isJsonObject(e) && 'resource_id' in e
    && typeof e.resource_id !== 'string')],
  ['ceiling:resource_id:length', (c) => someEntry(c, (e) => isJsonObject(e)
    && typeof e.resource_id === 'string' && (e.resource_id.length < 1 || e.resource_id.length > 255))],
  ['ceiling:environment:type', (c) => someEntry(c, (e) => isJsonObject(e) && 'environment' in e
    && typeof e.environment !== 'string')],
  ['ceiling:environment:domain', (c) => someEntry(c, (e) => isJsonObject(e)
    && typeof e.environment === 'string' && !ENVIRONMENTS.includes(e.environment))],
  ['ceiling:actions:type', (c) => someEntry(c, (e) => isJsonObject(e) && 'actions' in e && !Array.isArray(e.actions))],
  ['ceiling:actions:empty', (c) => someEntry(c, (e) => isJsonObject(e) && Array.isArray(e.actions)
    && e.actions.length === 0)],
  ['ceiling:actions:element', (c) => someEntry(c, (e) => isJsonObject(e) && Array.isArray(e.actions)
    && e.actions.some((a) => typeof a !== 'string'))],
  ['ceiling:actions:domain', (c) => someEntry(c, (e) => isJsonObject(e) && Array.isArray(e.actions)
    && e.actions.some((a) => typeof a === 'string' && !CEILING_ACTIONS.includes(a)))],
  ['ceiling:actions:canonical', (c) => someEntry(c, (e) => isJsonObject(e) && Array.isArray(e.actions)
    && e.actions.length > 0 && e.actions.every((a) => typeof a === 'string') && !isCanonicalList(e.actions))],
  ['ceiling:entry:unique', (c) => { const keys = entryList(c).filter(isJsonObject)
    .map((e) => JSON.stringify([e.resource_kind, e.resource_id, e.environment]));
  return new Set(keys).size !== keys.length; }],
];
// the accepting branch: `if v_entries = '"LEGACY_UNRESTRICTED"' then return true`. Deleting it
// makes every legacy ceiling fail the `jsonb_typeof(v_entries) <> 'array'` test one line down, so
// it is a real branch that no reject rule can witness (§5.2, §10.3 v0.1.2 NIT-2).
const CEILING_ACCEPTS = [
  ['ceiling:accept:legacy', (c) => legacy(c)],
  ['ceiling:accept:entries', (c) => Array.isArray(entries(c)) && entries(c).length > 0],
  ['ceiling:accept:empty-entries', (c) => Array.isArray(entries(c)) && entries(c).length === 0],
];

// ---- integration_version_cmp_v1(text, text) ----
const DOTTED = /^[0-9]+(\.[0-9]+)*$/;
const CMP_RULES = [
  ['cmp:left:null', ([a]) => a === null],
  ['cmp:right:null', ([, b]) => b === null],
  ['cmp:left:shape', ([a]) => typeof a === 'string' && !DOTTED.test(a)],
  ['cmp:right:shape', ([, b]) => typeof b === 'string' && !DOTTED.test(b)],
];
// the comparison itself, recomputed independently: segment by segment as numbers, a missing
// trailing segment read as 0 (the `coalesce(v_left[i], '0')` the loop pads with)
function cmpOracle([a, b]) {
  if (CMP_RULES.some(([, fire]) => fire([a, b]))) return null;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = BigInt(left[i] ?? '0');
    const y = BigInt(right[i] ?? '0');
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
const CMP_ACCEPTS = [
  ['cmp:accept:less', (p) => cmpOracle(p) === -1],
  ['cmp:accept:greater', (p) => cmpOracle(p) === 1],
  ['cmp:accept:equal', (p) => cmpOracle(p) === 0],
  // the `coalesce(…, '0')` padding: equal only because the shorter side is read as zeroes
  ['cmp:accept:pad', (p) => cmpOracle(p) === 0 && p[0].split('.').length !== p[1].split('.').length],
];

// Branches deliberately not emitted, each because deleting the text cannot change an output. Every
// entry was checked against the database by the "equivalent mutants" subtest below, which asserts
// the fact the argument rests on rather than restating the argument.
const EQUIVALENTS = [
  ['capabilities:null-element', 'array_position(p_capabilities, null) is null — the containment '
    + 'disjunct of the same `and` already rejects an array with a NULL element: '
    + "array['context.read', null] <@ the vocabulary is false, not NULL"],
  ['instant:null-input', 'p_text is null — deleting it leaves the regex test as SQL NULL, so the '
    + '`if` does not fire, the cast of NULL yields NULL without raising, and the function returns '
    + '`v_parsed is not null` = false, the same answer'],
  ['ceiling:null-input', 'p_ceiling is null — deleting it leaves jsonb_typeof(NULL) NULL so the '
    + '`if` does not fire, and jsonb_object_keys over NULL aggregates to NULL, which `is distinct '
    + "from array['entries','scopes']` rejects on the next line"],
  ['ceiling:scopes:element-type', 'the `exists (… jsonb_typeof(e) <> \'string\')` disjunct — a '
    + 'non-string element is also rejected by the scope containment, because its `#>>` text form '
    + 'is never one of the three scope names (only a JSON string can spell one), and '
    + 'array[NULL] <@ … is false'],
];

// ---- samples for the branch-coverage obligations ----------------------------------------------
// Each sample is `{ v, sqlNull }`: `sqlNull` is a SQL NULL argument, everything else is the JSON
// value itself, so a JSON null and a SQL NULL stay distinguishable (they are different inputs to
// integration_ceiling_valid_v1, and the first is not reachable through `$1::jsonb` otherwise).
const arg = (v) => ({ v });
const NULL_ARG = { v: null, sqlNull: true };
function* capabilitySamples() {
  yield NULL_ARG;
  for (const v of [[], ALL, [...ALL].reverse(), ['context.read', 'context.read']]) yield arg(v);
  for (const c of ALL) yield arg([c]);
  for (const v of [['admin.write'], ['context.read', 'admin.write'], ['context:read'], ['Context.Read'],
    [''], ['context.read '], [null], ['context.read', null], [null, null]]) yield arg(v);
}
function* instantSamples() {
  yield NULL_ARG;
  for (const v of ['2026-09-24T12:00:00Z', '2026-09-24T12:00:00.1Z', '2026-09-24T12:00:00.123456+08:00',
    '2028-02-29T00:00:00Z', '2026-12-31T23:59:59-05:00', '2026-01-01T00:00:00+00:00',
    '2026-09-24T00:00:00Z', '2026-09-24T23:59:59Z', '2026-09-24T12:00:00-15:59']) yield arg(v);
  // one mutated field per rule, from the same base, so each sample isolates one atom
  for (const v of ['', 'x', '2026-09-24 12:00:00Z', '2026-09-24T12:00Z', ' 2026-09-24T12:00:00Z',
    '2026-09-24T12:00:00Zx', '026-09-24T12:00:00Z', '20261-09-24T12:00:00Z', '2026-9-24T12:00:00Z',
    '2026-091-24T12:00:00Z', '2026-09-4T12:00:00Z', '2026-09-241T12:00:00Z', '2026-09-24T1:00:00Z',
    '2026-09-24T24:00:00Z', '2026-09-24T25:00:00Z', '2026-09-24T99:00:00Z', '2026-09-24T12:0:00Z',
    '2026-09-24T12:000:00Z', '2026-09-24T12:00:60Z', '2026-09-24T12:00:99Z', '2026-09-24T12:00:0Z',
    '2026-09-24T12:00:00.1234567Z', '2026-09-24T12:00:00.Z', '2026-09-24T12:00:00', '2026-09-24T12:00:00z',
    '2026-09-24T12:00:00+0800', '2026-09-24T12:00:00+08:00:00', '2026-09-24T12:00:00UTC',
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-09-00T00:00:00Z',
    '2026-09-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-09-24T12:60:00Z', '2026-09-24T12:99:00Z',
    '2026-09-24T12:00:00+16:00', '2026-09-24T12:00:00+08:60']) yield arg(v);
}
const ENTRY = { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] };
const withEntry = (patch) => ({ scopes: [], entries: [{ ...ENTRY, ...patch }] });
function* ceilingSamples() {
  yield NULL_ARG;
  for (const v of [null, [], 'LEGACY_UNRESTRICTED', 1, true]) yield arg(v);
  // accepted shapes
  for (const v of [{ scopes: [], entries: [] }, { scopes: [], entries: 'LEGACY_UNRESTRICTED' },
    { scopes: CEILING_SCOPES, entries: 'LEGACY_UNRESTRICTED' }, { scopes: ['context:read'], entries: [ENTRY] },
    { scopes: CEILING_SCOPES, entries: [ENTRY, { ...ENTRY, environment: 'production' },
      { ...ENTRY, resource_kind: 'context', resource_id: 'a'.repeat(255) }] },
    withEntry({ actions: CEILING_ACTIONS })]) yield arg(v);
  // key set and top-level shape
  for (const v of [{ scopes: [] }, { entries: [] }, {}, { scopes: [], entries: [], other: 1 },
    { scopes: [], Entries: [] }]) yield arg(v);
  // scopes
  for (const v of [{ scopes: 'context:read', entries: [] }, { scopes: {}, entries: [] },
    { scopes: ['canonical:read'], entries: [] }, { scopes: ['context:read', 'audit:read'], entries: [] },
    { scopes: ['context:read', 'context:read'], entries: [] }, { scopes: [1], entries: [] },
    { scopes: [null], entries: [] }, { scopes: ['Context:read'], entries: [] }]) yield arg(v);
  // entries container
  for (const v of [{ scopes: [], entries: 'UNRESTRICTED' }, { scopes: [], entries: {} },
    { scopes: [], entries: 1 }, { scopes: [], entries: null }, { scopes: [], entries: [1] },
    { scopes: [], entries: [null] }, { scopes: [], entries: [[]] }]) yield arg(v);
  // one mutated entry field per rule
  for (const patch of [{ resource_kind: 'project' }, { resource_kind: 1 }, { resource_kind: null },
    { resource_id: '' }, { resource_id: 'a'.repeat(256) }, { resource_id: 123 }, { resource_id: null },
    { environment: 'staging' }, { environment: 7 }, { environment: null },
    { actions: 'read' }, { actions: {} }, { actions: [] }, { actions: ['delete'] },
    { actions: [null] }, { actions: [1] }, { actions: ['write', 'read'] }, { actions: ['read', 'read'] },
    { extra: 1 }]) yield arg(withEntry(patch));
  for (const v of [{ scopes: [], entries: [{ resource_kind: 'scope', resource_id: 'g', environment: 'test' }] },
    { scopes: [], entries: [ENTRY, { ...ENTRY, actions: ['read'] }] },
    { scopes: [], entries: [ENTRY, { ...ENTRY, environment: 'test' }] }]) yield arg(v);
}
function* cmpSamples() {
  for (const p of [['1.2', '1.10'], ['1.10', '1.2'], ['1.2.0', '1.2'], ['1.2', '1.2.0.0'], ['2', '1.9.9'],
    ['01.2', '1.2'], ['0.9.9', '1'], ['1.0.0.1', '1'], ['1', '1'], ['0', '0'], ['1.0', '1'],
    ['99999999999999999999.1', '99999999999999999999.2'], ['99999999999999999999.2', '99999999999999999999.1'],
    ['1.2-beta', '1.2'], ['1.2', 'v1.2'], ['', '1'], ['1', ''], ['1..2', '1'], ['1.', '1'], ['.1', '1'],
    [null, '1'], ['1', null], [null, null], [' 1', '1'], ['1', '1 '], ['1', '1.2.3.4.5.6']]) yield { v: p };
}

// ---- the runner ------------------------------------------------------------------------------
// One pass per function: MIRROR (the mirror rejects exactly when the SQL does), SOLE (each rule is
// the only one firing on some sample), ACCEPT-COVER (each accepting branch is taken by an accepted
// sample), and, where the result is not a boolean, VALUE (the SQL equals an independent oracle).
// A SQL NULL argument reaches the rules as JavaScript null: no rule table below distinguishes it
// from a JSON null, because no function does either (see EQUIVALENTS).
async function runObligation(spec) {
  const fired = new Map(spec.rules.map(([id]) => [id, 0]));
  const sole = new Map(spec.rules.map(([id]) => [id, 0]));
  const accepted = new Map((spec.accepts ?? []).map(([id]) => [id, 0]));
  const disagreements = { mirror: 0, value: 0, examples: [] };
  const samples = [...spec.samples()];
  for (let i = 0; i < samples.length; i += CHUNK) {
    const chunk = samples.slice(i, i + CHUNK);
    const rows = await spec.evaluate(chunk);
    assert.equal(rows.length, chunk.length, `${spec.id}: the database returned a short result`);
    chunk.forEach((sample, j) => {
      const input = sample.sqlNull ? null : sample.v;
      const result = spec.read(rows[j]);
      const firing = spec.rules.filter(([, fire]) => fire(input)).map(([id]) => id);
      for (const id of firing) fired.set(id, fired.get(id) + 1);
      if (firing.length === 1) sole.set(firing[0], sole.get(firing[0]) + 1);
      const rejected = spec.rejected(result);
      if (rejected !== (firing.length > 0)) {
        disagreements.mirror += 1;
        if (disagreements.examples.length < 8) disagreements.examples.push({ kind: 'MIRROR', input, sql: result, firing });
      }
      if (!rejected) for (const [id, take] of spec.accepts ?? []) if (take(input)) accepted.set(id, accepted.get(id) + 1);
      if (spec.value && !Object.is(spec.value(input), result)) {
        disagreements.value += 1;
        if (disagreements.examples.length < 8) {
          disagreements.examples.push({ kind: 'VALUE', input, sql: result, oracle: spec.value(input) });
        }
      }
    });
  }
  return { id: spec.id, fired, sole, accepted, disagreements, count: samples.length, spec };
}
function assertObligation(t, report) {
  const { spec, disagreements: d } = report;
  assert.equal(d.mirror, 0, `${report.id} MIRROR: the rule mirror and the SQL disagree on ${d.mirror} `
    + `sample(s): ${JSON.stringify(d.examples.filter((e) => e.kind === 'MIRROR'), null, 1)}`);
  assert.equal(d.value, 0, `${report.id} VALUE: the SQL and the oracle disagree on ${d.value} `
    + `sample(s): ${JSON.stringify(d.examples.filter((e) => e.kind === 'VALUE'), null, 1)}`);
  const never = [...report.fired].filter(([, n]) => n === 0).map(([id]) => id);
  assert.deepEqual(never, [], `${report.id}: ${never.join(', ')} never fires — a rule no sample `
    + 'reaches is not mirrored by anything');
  const exempt = spec.exempt ?? new Map();
  const blind = [...report.sole].filter(([id, n]) => n === 0 && !exempt.has(id)).map(([id]) => id);
  assert.deepEqual(blind, [], `${report.id} SOLE: no sample isolates ${blind.join(', ')} — add a case `
    + 'that breaks only that rule, or allow-list it naming the vector that covers it instead');
  const stale = [...report.sole].filter(([id, n]) => n > 0 && exempt.has(id)).map(([id]) => id);
  assert.deepEqual(stale, [], `${report.id}: the SOLE allow-list is stale for ${stale.join(', ')}`);
  const unknown = [...exempt.keys()].filter((id) => !report.sole.has(id));
  assert.deepEqual(unknown, [], `${report.id}: the SOLE allow-list names ${unknown.join(', ')}, not a rule id`);
  const untaken = [...report.accepted].filter(([, n]) => n === 0).map(([id]) => id);
  assert.deepEqual(untaken, [], `${report.id} ACCEPT-COVER: no accepted sample takes ${untaken.join(', ')}`);
  const counts = [...report.sole].filter(([id]) => !exempt.has(id)).map(([, n]) => n);
  t.diagnostic(`${report.id}: ${report.count} samples, ${report.fired.size} rules, `
    + `${counts.length} isolated (${Math.min(...counts)}\u2026${Math.max(...counts)} each), `
    + `${report.accepted.size} accepting branches, ${exempt.size} allow-listed`);
}


// Three centres for the single-factor and pairwise layers: the healthy ACTIVE base, a fresh, not yet
// authorized installation, and a DEGRADED raw Binding with an incomplete identity (the S2c norm, §6.2).
const CENTRES = [golden.base, merge(golden.base, { authentication_state: 'NONE', authorization_state: 'NOT_GRANTED',
  oauth_scope_facts: [], resource_action_scope_facts: { mode: 'NONE' }, installation_facts: { ever_authorized: false },
  ...crv('NONE') }), merge(golden.base, { identity_completeness: 'INCOMPLETE', identity_claim_state: 'INCOMPLETE_UNCLAIMED',
  authorization_state: 'GRANTED_LEGACY', resource_action_scope_facts: { mode: 'LEGACY_UNRESTRICTED' },
  host_state: { value: 'DEGRADED', mask: ['context.read', 'context.write'] } })];

function* p2Samples() {
  for (const centre of CENTRES) {
    for (const [, values] of DIMENSIONS) for (const patch of values) {
      const facts = merge(centre, patch);
      yield { layer: 'single', facts, base: facts };
    }
  }
  for (const centre of CENTRES) {
    for (let i = 0; i < DIMENSIONS.length; i += 1) {
      for (let j = i + 1; j < DIMENSIONS.length; j += 1) {
        for (const a of DIMENSIONS[i][1]) for (const b of DIMENSIONS[j][1]) {
          const facts = merge(merge(centre, a), b);
          yield { layer: 'pairwise', facts, base: facts };
        }
      }
    }
  }
  const rng = mulberry32(SEED);
  for (let n = 0; n < RANDOM_SAMPLES; n += 1) {
    let facts = golden.base;
    for (const [name, values] of DIMENSIONS) {
      // keep the base value with probability KEEP (0.5 by default), otherwise draw uniformly from
      // the whole domain; integrity classes keep more often so that more samples are valid
      if (rng() >= (KEEP[name] ?? 0.5)) facts = merge(facts, values[Math.floor(rng() * values.length)]);
    }
    const base = facts;
    if (rng() < CORRUPTION_RATE) {
      facts = clone(facts);
      pickCorruption(rng)(facts, rng);
    }
    // `base` is the uncorrupted draw, which the sweep asserts is free of C1 (Owner Decision
    // c79a6278): the samples-per-corruption argument above rests on every base being schema-valid,
    // and a future DIMENSIONS edit that broke it would otherwise go unnoticed.
    yield { layer: 'random', index: n, facts, base };
  }
}

test('S2c PR-1: integration registries and pure derivation', { timeout: 3_600_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-derivation-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  const connect = async () => {
    const client = server.getPgClient();
    clients.push(client);
    await client.connect();
    return client;
  };
  try {
    await server.initialise();
    await server.start();
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(MIGRATION));
    const apply = async (name) => {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    };
    for (const name of migrations.filter((name) => name < MIGRATION)) await apply(name);

    // T-S-3 snapshot: definition hash of every function, column definitions, constraints,
    // triggers, RLS flags, policies, relation / function / schema ACLs and default ACLs.
    const snapshot = async () => (await admin.query(`select jsonb_build_object(
      'functions', (select jsonb_object_agg(p.oid::regprocedure::text,
          md5(case when p.prokind = 'a' then p.oid::regprocedure::text else pg_get_functiondef(p.oid) end)
          || ':' || coalesce(p.proacl::text, '') || ':' || pg_get_userbyid(p.proowner))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'),
      'relations', (select jsonb_object_agg(c.oid::regclass::text, jsonb_build_object('kind', c.relkind,
          'acl', coalesce(c.relacl::text, ''), 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
          'owner', pg_get_userbyid(c.relowner),
          -- v0.1.8 review NIT-4: views and materialized views are snapshotted by definition too
          'viewdef', (case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end),
          'columns', (select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
              coalesce(pg_get_expr(d.adbin, d.adrelid), ''), coalesce(a.attacl::text, '')) order by a.attnum)
            from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
          'constraints', (select jsonb_object_agg(co.conname, pg_get_constraintdef(co.oid))
            from pg_constraint co where co.conrelid = c.oid),
          'indexes', (select jsonb_object_agg(i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid))
            from pg_index i where i.indrelid = c.oid),
          'triggers', (select jsonb_object_agg(tg.tgname, pg_get_triggerdef(tg.oid))
            from pg_trigger tg where tg.tgrelid = c.oid and not tg.tgisinternal)))
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'),
      'policies', (select jsonb_object_agg(schemaname || '.' || tablename || '.' || policyname,
          jsonb_build_array(permissive, roles, cmd, qual, with_check)) from pg_policies),
      'schemas', (select jsonb_object_agg(nspname, coalesce(nspacl::text, '') || ':' || pg_get_userbyid(nspowner))
        from pg_namespace),
      'default_acl', (select coalesce(jsonb_agg(jsonb_build_array(defaclrole, defaclnamespace, defaclobjtype,
          defaclacl::text) order by defaclrole, defaclnamespace, defaclobjtype), '[]') from pg_default_acl),
      'roles', (select jsonb_object_agg(rolname, jsonb_build_array(rolsuper, rolinherit, rolcanlogin, rolbypassrls))
        from pg_roles)) s`)).rows[0].s;
    const before = await snapshot();
    await apply(MIGRATION);
    const after = await snapshot();
    for (const name of migrations.filter((name) => name > MIGRATION)) await apply(name);

    await t.test('T-S-3 applying the migration leaves every existing object unchanged', () => {
      for (const kind of ['functions', 'relations', 'policies', 'schemas']) {
        for (const [key, value] of Object.entries(before[kind] ?? {})) {
          assert.deepEqual(after[kind]?.[key], value, `${kind} ${key} changed`);
        }
      }
      assert.deepEqual(after.default_acl, before.default_acl);
      assert.deepEqual(after.roles, before.roles);
      const addedFunctions = Object.keys(after.functions).filter((key) => !(key in before.functions)).sort();
      assert.deepEqual(addedFunctions, PURE.map((fn) => `clued_private.${fn}`).sort());
      const addedRelations = Object.keys(after.relations).filter((key) => !(key in before.relations));
      assert.ok(addedRelations.length > 0);
      for (const key of addedRelations) assert.match(key, /^clued_private\.integration_[a-z_]+_v1(_pkey)?$/, key);
      assert.deepEqual(addedRelations.filter((key) => !key.endsWith('_pkey')).sort(),
        TABLES.map((table) => `clued_private.${table}`).sort());
      assert.deepEqual(Object.keys(after.policies ?? {}).filter((key) => !(key in (before.policies ?? {}))), []);
    });

    await t.test('T-S-1 every new table has RLS on and no privilege for public, anon, authenticated, service_role', async () => {
      const { rows } = await admin.query(`select c.relname, c.relkind, c.relrowsecurity,
          coalesce((select array_agg(distinct a.grantee::regrole::text) from aclexplode(c.relacl) a
            where a.grantee <> c.relowner and a.grantee <> 0), '{}') grantees,
          exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0) public_grant,
          (select count(*) from pg_policies p where p.schemaname = 'clued_private' and p.tablename = c.relname) policies,
          bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger')) any_privilege
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
        where n.nspname = 'clued_private' and c.relname like 'integration\\_%' and c.relkind in ('r', 'S', 'v', 'm', 'p')
          -- PR-1's own objects; later S2c PRs add tables that their own test files cover (PR-2: integration-runtime-identity-db)
          and (c.relkind <> 'r' or c.relname = any($1))
        group by c.oid, c.relname, c.relkind, c.relrowsecurity, c.relacl, c.relowner order by c.relname`, [TABLES]);
      assert.deepEqual(rows.filter((r) => r.relkind === 'r').map((r) => r.relname), TABLES);
      assert.deepEqual(rows.filter((r) => r.relkind !== 'r'), [], 'PR-1 creates no sequence or view');
      for (const row of rows) {
        assert.equal(row.relrowsecurity, true, row.relname);
        assert.deepEqual(row.grantees, [], row.relname);
        assert.equal(row.public_grant, false, row.relname);
        assert.equal(Number(row.policies), 0, row.relname);
        assert.equal(row.any_privilege, false, row.relname);
      }
      // READY profiles are PR-3, not PR-1; no public view (§5.14)
      assert.equal('clued_private.integration_ready_profiles_v1' in after.relations, false);
      assert.equal(Number((await admin.query(`select count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like '%integration%'`)).rows[0].n), 0);
    });

    await t.test('T-S-2 no clued_private.integration_* function is executable by public, anon, authenticated, service_role', async () => {
      const { rows } = await admin.query(`select p.oid::regprocedure::text fn, p.proacl is null default_acl,
          exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) public_grant,
          bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) any_role
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
        where n.nspname = 'clued_private' and p.oid::regprocedure::text = any($1)
        group by p.oid, p.proacl order by 1`, [PURE.map((fn) => `clued_private.${fn}`)]);
      assert.deepEqual(rows.map((r) => r.fn), PURE.map((fn) => `clued_private.${fn}`).sort());
      for (const row of rows) {
        assert.equal(row.default_acl, false, `${row.fn} keeps the default PUBLIC EXECUTE`);
        assert.equal(row.public_grant, false, row.fn);
        assert.equal(row.any_role, false, row.fn);
      }
      // PR-1 creates no Integration public RPC (§5.13, OQ-21); PR-2's public RPCs are covered by its own T-S-2
    });

    await t.test('registries: v1 seeds (§5.1) and scope map v1 (§9.1)', async () => {
      const q = async (sql) => (await admin.query(sql)).rows;
      assert.deepEqual(await q(`select host, tenant_dimension, account_dimension, tenant_evidence_kinds, account_evidence_kinds,
          first_authorization_required, registry_version from clued_private.integration_hosts_v1 order by host`),
        ['anthropic.claude', 'generic.mcp', 'openai.chatgpt'].map((host) => ({ host, tenant_dimension: 'REQUIRED',
          account_dimension: 'REQUIRED', tenant_evidence_kinds: [], account_evidence_kinds: [],
          first_authorization_required: true, registry_version: 1 })));
      const surfaces = await q(`select host, surface, capability_ceiling, host_features from clued_private.integration_host_surfaces_v1
        order by host, surface`);
      assert.deepEqual(surfaces.map((s) => `${s.host}/${s.surface}`), ['anthropic.claude/chat', 'anthropic.claude/claude_code',
        'anthropic.claude/cowork', 'generic.mcp/default', 'openai.chatgpt/codex', 'openai.chatgpt/desktop',
        'openai.chatgpt/mobile', 'openai.chatgpt/web']);
      for (const s of surfaces) {
        assert.deepEqual([...s.capability_ceiling].sort(), ALL);
        const hostNative = ['cowork', 'claude_code'].includes(s.surface);
        assert.deepEqual(s.host_features, { mcp_tools: true, oauth: true, skills: s.host !== 'generic.mcp',
          hooks: hostNative, subagents: hostNative }, `${s.host}/${s.surface}`);
      }
      assert.deepEqual(await q(`select provider, connection_dimension, connection_source, host_native
          from clued_private.integration_providers_v1 order by provider`), [
        { provider: 'clued.binding.v1', connection_dimension: 'REQUIRED', connection_source: 'BINDING_ID', host_native: false },
        { provider: 'clued.oauth.v12', connection_dimension: 'REQUIRED', connection_source: 'OAUTH_V12_CLIENT_ID_SHA256', host_native: false }]);
      assert.deepEqual(await q(`select domain, max_current_holders from clued_private.integration_binding_domains_v1`),
        [{ domain: 'clued.default.v1', max_current_holders: 1 }]);
      assert.deepEqual((await q(`select capability from clued_private.integration_capability_vocabulary_v1
        where vocabulary_version = 1 order by capability collate "C"`)).map((r) => r.capability), ALL);
      assert.deepEqual(await q(`select policy_version, incomplete_identity_ordinary_runtime, qualification_not_evaluated,
          default_recovery_policy, canonical_verification_ttl::text ttl, installation_request_ttl::text request_ttl,
          preclusion_rule from clued_private.integration_policy_v1`), [{ policy_version: 1,
        incomplete_identity_ordinary_runtime: 'PERMIT', qualification_not_evaluated: 'NON_BLOCKING',
        default_recovery_policy: 'PERMITS_REAUTH', ttl: '30 days', request_ttl: '00:30:00', preclusion_rule: 'ALL_BLOCKING_PREDICATES' }]);
      // the policy block of the golden base is policy v1
      const policy = (await q(`select incomplete_identity_ordinary_runtime, qualification_not_evaluated, preclusion_rule
        from clued_private.integration_policy_v1 where policy_version = 1`))[0];
      assert.deepEqual({ policy_version: 1, ...policy }, golden.base.policy);
      assert.equal(Number((await q(`select count(*) n from clued_private.integration_compatibility_rules_v1`))[0].n), 0);
      // scope map v1 rows; integration_candidate_v1 carries the same map as a constant
      const map = await q(`select oauth_scope, resource_action, array_agg(capability order by capability collate "C") caps
        from clued_private.integration_scope_capability_map_v1 where map_version = 1 group by 1, 2 order by 1`);
      assert.deepEqual(map, [
        { oauth_scope: 'audit:read', resource_action: 'audit', caps: ['audit.read'] },
        { oauth_scope: 'context:read', resource_action: 'read', caps: ['context.read', 'development_history.read', 'project.read'] },
        { oauth_scope: 'context:write', resource_action: 'write', caps: ['context.write', 'evidence.write', 'project.write'] }]);
      for (const row of map) {
        const facts = merge(golden.base, { oauth_scope_facts: [row.oauth_scope], resource_action_scope_facts: { mode: 'LEGACY_UNRESTRICTED' },
          authorization_state: 'GRANTED_LEGACY' });
        const cand = (await admin.query(`select clued_private.integration_candidate_v1($1, true, true, true) c`, [facts])).rows[0].c;
        assert.deepEqual(cand, row.caps, row.oauth_scope);
      }
      // registries are written only by migrations: no role can write them
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await admin.query(`select has_table_privilege($1, 'clued_private.integration_policy_v1', 'insert') ok`,
          [role])).rows[0].ok, false);
      }
    });

    await t.test('compatibility rules: constraints (§5.1 v0.1.1 MINOR-8, v0.1.2 NIT-3)', async () => {
      await admin.query(`insert into clued_private.integration_hosts_v1(host, tenant_dimension, account_dimension,
        first_authorization_required, registry_version, capability_snapshot_ref)
        values ('test.complete', 'NOT_APPLICABLE', 'NOT_APPLICABLE', true, 1, 'test')`);
      const insert = (values) => admin.query(`insert into clued_private.integration_compatibility_rules_v1(host, adapter_family,
        min_adapter_version, min_package_version, below_minimum, degraded_mask, registry_version)
        values ('test.complete', $1, $2, $3, $4, $5, $6)`, values);
      await insert(['fam-a', '1.2.0', null, 'HARD_INCOMPATIBLE', null, 1]);
      await insert(['fam-b', null, '2.0', 'DEGRADED', ['context.read'], 1]);
      await insert(['fam-b', '1', '2.0.1.7', 'DEGRADED', [], 2]);
      for (const [values, label] of [
        [['fam-c', '1.0', null, 'DEGRADED', null, 1], 'DEGRADED needs a mask'],
        [['fam-c', '1.0', null, 'HARD_INCOMPATIBLE', ['context.read'], 1], 'HARD_INCOMPATIBLE takes no mask'],
        [['fam-c', null, null, 'HARD_INCOMPATIBLE', null, 1], 'a rule constrains at least one version'],
        [['fam-c', '1.0', null, 'DEGRADED', ['admin.write'], 1], 'mask names are vocabulary names'],
        [['fam-c', '1.0-beta', null, 'HARD_INCOMPATIBLE', null, 1], 'dotted numeric'],
        [['fam-c', '1.2.3.4.5', null, 'HARD_INCOMPATIBLE', null, 1], 'at most four segments'],
        [['fam-c', '1.0', null, 'SOFT', null, 1], 'below_minimum domain'],
        [['fam-c', '1.0', null, 'HARD_INCOMPATIBLE', null, 0], 'registry_version >= 1'],
      ]) {
        await assert.rejects(insert(values), (error) => error.code === '23514', label);
      }
      await assert.rejects(insert(['fam-a', '1.0', null, 'HARD_INCOMPATIBLE', null, 1]), (error) => error.code === '23505');
      await assert.rejects(admin.query(`insert into clued_private.integration_compatibility_rules_v1(host, adapter_family,
        min_adapter_version, below_minimum, registry_version) values ('no.such.host', 'f', '1', 'HARD_INCOMPATIBLE', 1)`),
      (error) => error.code === '23503');
      await admin.query(`delete from clued_private.integration_compatibility_rules_v1`);
      await admin.query(`delete from clued_private.integration_hosts_v1 where host = 'test.complete'`);
    });

    await t.test('integration_version_cmp_v1 compares dotted numeric versions, null otherwise (§5.1)', async () => {
      const cmp = async (a, b) => (await admin.query('select clued_private.integration_version_cmp_v1($1, $2) c', [a, b])).rows[0].c;
      for (const [a, b, expected] of [
        ['1.2', '1.10', -1], ['1.10', '1.2', 1], ['1.2.0', '1.2', 0], ['1.2', '1.2.0.0', 0], ['2', '1.9.9', 1],
        ['01.2', '1.2', 0], ['0.9.9', '1', -1], ['1.0.0.1', '1', 1], ['99999999999999999999.1', '99999999999999999999.2', -1],
        ['1.2-beta', '1.2', null], ['1.2', 'v1.2', null], ['', '1', null], ['1..2', '1', null], ['1.', '1', null],
        [null, '1', null], ['1', null, null], [' 1', '1', null],
      ]) assert.equal(await cmp(a, b), expected, `${a} vs ${b}`);
      const row = (await admin.query(`select provolatile, prosecdef from pg_proc
        where oid = 'clued_private.integration_version_cmp_v1(text,text)'::regprocedure`)).rows[0];
      assert.deepEqual(row, { provolatile: 'i', prosecdef: false });
    });

    await t.test('integration_capabilities_valid_v1 uses the vocabulary constant list (§5.1)', async () => {
      const valid = async (value) => (await admin.query('select clued_private.integration_capabilities_valid_v1($1::text[]) v',
        [value])).rows[0].v;
      assert.equal(await valid(ALL), true);
      assert.equal(await valid([]), true);
      assert.equal(await valid(['context.read', 'context.read']), true);
      assert.equal(await valid(null), false);
      assert.equal(await valid(['context.read', null]), false);
      assert.equal(await valid(['admin.write']), false);
      assert.equal(await valid(['context:read']), false);
      assert.equal(await valid(['Context.Read']), false);
      const vocabulary = (await admin.query(`select pg_get_constraintdef(oid) d from pg_constraint
        where conrelid = 'clued_private.integration_capability_vocabulary_v1'::regclass and contype = 'c'`)).rows[0].d;
      for (const capability of ALL) assert.match(vocabulary, new RegExp(`'${capability.replace('.', '\\.')}'`));
    });

    await t.test('integration_ceiling_valid_v1 enforces the authorization ceiling shape (§5.2, §10.3 NIT-2)', async () => {
      const valid = async (value) => (await admin.query('select clued_private.integration_ceiling_valid_v1($1) v',
        [value === undefined ? null : JSON.stringify(value)])).rows[0].v;
      const entry = { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write'] };
      for (const [value, expected, label] of [
        [{ scopes: ['audit:read', 'context:read'], entries: 'LEGACY_UNRESTRICTED' }, true, 'legacy'],
        [{ scopes: [], entries: [] }, true, 'empty'],
        [{ scopes: ['context:read', 'context:write'], entries: [entry,
          { resource_kind: 'context', resource_id: crypto.randomUUID(), environment: 'production', actions: ['read'] }] }, true, 'entries'],
        [{ scopes: ['context:read', 'audit:read'], entries: [] }, false, 'unsorted scopes'],
        [{ scopes: ['context:read', 'context:read'], entries: [] }, false, 'duplicate scope'],
        [{ scopes: ['canonical:read'], entries: [] }, false, 'unknown scope'],
        [{ scopes: [1], entries: [] }, false, 'scope not a string'],
        [{ scopes: [], entries: 'UNRESTRICTED' }, false, 'unknown entries string'],
        [{ scopes: [], entries: [{ ...entry, actions: [] }] }, false, 'empty actions'],
        [{ scopes: [], entries: [{ ...entry, actions: ['delete'] }] }, false, 'unknown action'],
        [{ scopes: [], entries: [{ ...entry, actions: ['write', 'read'] }] }, false, 'unsorted actions'],
        [{ scopes: [], entries: [{ ...entry, actions: ['read', 'read'] }] }, false, 'duplicate action'],
        [{ scopes: [], entries: [{ ...entry, actions: ['audit', 'close', 'feedback_submit', 'read', 'restore', 'write'] }] },
          true, 'all six actions sorted'],
        [{ scopes: [], entries: [{ ...entry, resource_kind: 'project' }] }, false, 'resource_kind'],
        [{ scopes: [], entries: [{ ...entry, environment: 'staging' }] }, false, 'environment'],
        [{ scopes: [], entries: [{ ...entry, resource_id: '' }] }, false, 'empty resource_id'],
        // PR #340 third delta review MAJOR-3: the lower bound alone left the other two disjuncts of
        // the same `if` fail-open — widening the length test to `1 and 100000` and deleting the
        // `jsonb_typeof(...) <> 'string'` disjunct both passed the whole suite. §5.2 / §10.11
        // compare ceilings as canonical jsonb, so an over-long or numeric resource_id would put a
        // shape the rest of the contract does not expect into ceiling_before / ceiling_after.
        [{ scopes: [], entries: [{ ...entry, resource_id: 'a'.repeat(255) }] }, true, '255-char resource_id'],
        [{ scopes: [], entries: [{ ...entry, resource_id: 'a'.repeat(256) }] }, false, '256-char resource_id'],
        [{ scopes: [], entries: [{ ...entry, resource_id: 123 }] }, false, 'resource_id not a string'],
        // PR #340 fourth delta review MAJOR-A: the same shape one `if` further down. Deleting the
        // `jsonb_typeof(e) <> 'string'` disjunct from the actions element check passed the whole
        // suite, because `(e #>> '{}')` on a JSON null is SQL NULL and `NULL not in (...)` is NULL,
        // so the `exists` never fires. The two below are equivalent mutants today, for different
        // reasons: a non-string scope element is still rejected by the scope-vocabulary
        // containment (`array[null] <@ ...` is false, the same disjunct the `scopes: [1]` row
        // above already exercises), and a null resource_kind still fails the final key-uniqueness
        // check (a NULL key counts in cardinality but not in count(distinct ...)). Neither closes
        // anything new; both are pinned anyway, because each is equivalent only by accident.
        [{ scopes: [], entries: [{ ...entry, actions: [null] }] }, false, 'actions element not a string'],
        [{ scopes: [null], entries: [] }, false, 'scopes element null'],
        [{ scopes: [], entries: [{ ...entry, resource_kind: null }] }, false, 'resource_kind null'],
        [{ scopes: [], entries: [{ ...entry, extra: 1 }] }, false, 'extra entry key'],
        [{ scopes: [], entries: [entry, { ...entry, actions: ['read'] }] }, false, 'duplicate entry key'],
        [{ scopes: [], entries: [], other: 1 }, false, 'extra key'],
        [{ scopes: [] }, false, 'missing entries'],
        [[], false, 'not an object'],
        [undefined, false, 'null'],
      ]) assert.equal(await valid(value), expected, label);
    });

    // ---- branch coverage for the rest of the validator surface (Owner Decision 0402d831) -------
    // MIRROR already catches a deleted accepting branch — the SQL would start rejecting a sample no
    // rule fires on — but only if the corpus reaches that branch, which is what ACCEPT-COVER makes
    // an obligation rather than a hope.
    const jsonbChunk = (chunk) => [chunk.map((s) => (s.sqlNull ? null : JSON.stringify(s.v)))];
    const OBLIGATIONS = [
      { id: 'integration_capabilities_valid_v1', rules: CAPABILITIES_RULES, samples: capabilitySamples,
        read: (row) => row.r, rejected: (r) => r === false,
        evaluate: async (chunk) => (await admin.query(`select clued_private.integration_capabilities_valid_v1(
            case when v is null then null else array(select jsonb_array_elements_text(v)) end) r
          from unnest($1::jsonb[]) with ordinality t(v, i) order by i`, jsonbChunk(chunk))).rows },
      { id: 'integration_timestamp_valid_v1', rules: INSTANT_RULES, samples: instantSamples,
        read: (row) => row.r, rejected: (r) => r === false,
        evaluate: async (chunk) => (await admin.query(`select clued_private.integration_timestamp_valid_v1(
            case when v is null then null else v #>> '{}' end) r
          from unnest($1::jsonb[]) with ordinality t(v, i) order by i`, jsonbChunk(chunk))).rows },
      { id: 'integration_ceiling_valid_v1', rules: CEILING_RULES, accepts: CEILING_ACCEPTS,
        samples: ceilingSamples, read: (row) => row.r, rejected: (r) => r === false,
        evaluate: async (chunk) => (await admin.query(`select clued_private.integration_ceiling_valid_v1(v) r
          from unnest($1::jsonb[]) with ordinality t(v, i) order by i`, jsonbChunk(chunk))).rows },
      { id: 'integration_version_cmp_v1', rules: CMP_RULES, accepts: CMP_ACCEPTS, samples: cmpSamples,
        value: cmpOracle, read: (row) => (row.r === null ? null : Number(row.r)), rejected: (r) => r === null,
        evaluate: async (chunk) => (await admin.query(`select clued_private.integration_version_cmp_v1(a, b) r
          from unnest($1::text[], $2::text[]) with ordinality t(a, b, i) order by i`,
        [chunk.map((s) => s.v[0]), chunk.map((s) => s.v[1])])).rows },
    ];
    for (const spec of OBLIGATIONS) {
      const report = await runObligation(spec);
      await t.test(`branch coverage: ${spec.id} (S2c PR-2)`, () => assertObligation(t, report));
    }

    await t.test('the branches left out of those mirrors are equivalent mutants, on this database', async () => {
      // EQUIVALENTS is an argument about SQL semantics, so the facts it rests on are asserted here
      // rather than left as prose. Each row names the entry it supports.
      const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
      // capabilities:null-element — the containment, not the guard, is what rejects a NULL element
      assert.equal((await one(`select (array['context.read', null]::text[]
        operator(pg_catalog.<@) array['context.read','context.write','audit.read','project.read',
          'project.write','evidence.write','development_history.read']::text[]) r`)).r, false);
      // instant:null-input — a SQL NULL reaches the cast and returns false without raising
      assert.equal((await one(`select clued_private.integration_timestamp_valid_v1(null) r`)).r, false);
      assert.equal((await one(`select (null::timestamptz is not null) r`)).r, false);
      // ceiling:null-input — jsonb_object_keys over a SQL NULL aggregates to NULL, which the key-set
      // test rejects; and the type disjunct is NOT equivalent, because jsonb_object_keys raises on
      // a non-object, which is why it stays a rule
      assert.equal((await one(`select clued_private.integration_ceiling_valid_v1(null) r`)).r, false);
      assert.equal((await one(`select (select array_agg(k) from jsonb_object_keys(null::jsonb) k) is null r`)).r, true);
      await assert.rejects(admin.query(`select 1 from jsonb_object_keys('[]'::jsonb)`),
        (error) => error.code === '22023', 'jsonb_object_keys raises on a non-object');
      // ceiling:scopes:element-type — the vocabulary containment rejects a non-string element too
      for (const scopes of [[1], [null], [true], [['context:read']]]) {
        assert.equal((await one(`select (array(select jsonb_array_elements_text($1::jsonb))
          operator(pg_catalog.<@) array['context:read','context:write','audit:read']::text[]) r`,
        [JSON.stringify(scopes)])).r, false, JSON.stringify(scopes));
      }
      // …and EQUIVALENTS stays live data rather than a comment: every entry is checked above and
      // every check above belongs to an entry, so adding one without a check fails here.
      assert.deepEqual(EQUIVALENTS.map(([id]) => id).sort(), ['capabilities:null-element',
        'ceiling:null-input', 'ceiling:scopes:element-type', 'instant:null-input']);
      for (const [id, reason] of EQUIVALENTS) assert.ok(reason.length > 40, `${id} has no argument`);
      t.diagnostic(`EQUIVALENTS: ${EQUIVALENTS.length} branches argued and checked`);
    });

    await t.test('the C collation the ceiling pins agrees with the order the mirror compares against', async () => {
      // sortedUnique() sorts in JavaScript; the SQL sorts `collate "C"`. Both vocabularies are
      // ASCII, so they agree — asserted here rather than assumed, because a future vocabulary
      // entry outside ASCII would silently split the two orders.
      for (const [label, names] of [['scopes', CEILING_SCOPES], ['actions', CEILING_ACTIONS], ['capabilities', ALL]]) {
        const { rows } = await admin.query(`select array(select e from unnest($1::text[]) e order by e collate "C") s`,
          [[...names].reverse()]);
        assert.deepEqual(rows[0].s, sortedUnique(names), label);
      }
    });

    await t.test('integration_derive_v1 canonicalizes every set: de-duplicated, sorted, both paths', async () => {
      const sha = async (facts) => (await admin.query('select clued_private.integration_derive_v1($1::jsonb) d',
        [JSON.stringify(facts)])).rows[0].d.facts_sha256;
      const canonical = await sha(golden.base);
      // the known-names path: the sorted constant list is filtered, so duplicates and order vanish
      assert.equal(await sha(merge(golden.base, { capability_universe: [...ALL].reverse() })), canonical, 'sorted');
      assert.equal(await sha(merge(golden.base, { capability_universe: [...ALL, 'context.read'] })), canonical, 'de-duplicated');
      assert.equal(await sha(merge(golden.base, { oauth_scope_facts: [...golden.base.oauth_scope_facts].reverse() })),
        canonical, 'oauth scopes use the same path with their own constant list');
      // …and it really is the sorted, de-duplicated set, not merely a stable one
      const derived = (await admin.query('select clued_private.integration_derive_v1($1::jsonb) d',
        [JSON.stringify(merge(golden.base, { capability_universe: [...ALL, 'context.read'].reverse() }))])).rows[0].d;
      assert.equal(derived.facts_sha256, canonical);
      // the unknown-names path: a set the constant list does not contain is sorted and de-duplicated
      // by the jsonb_agg branch instead. Such a document is C1, but facts_sha256 is computed first
      // (§7.1 rule 1 applies to every document, valid or not).
      const odd = (universe) => merge(golden.base, { capability_universe: universe });
      const a = await sha(odd(['zz.unknown', 'context.read']));
      assert.equal(await sha(odd(['context.read', 'zz.unknown'])), a, 'unknown-name sets are sorted');
      assert.equal(await sha(odd(['zz.unknown', 'context.read', 'zz.unknown'])), a, 'and de-duplicated');
      assert.notEqual(a, canonical);
      // mixed jsonb types in one set exercise the `jsonb_typeof(e)` first sort key of that branch
      const mixed = await sha(odd(['context.read', 1, null, true]));
      assert.equal(await sha(odd([true, null, 1, 'context.read'])), mixed, 'ordered by type, then text');
      // the `jsonb_typeof(v_set) = 'array'` guard: a non-array set is left alone, not rewritten
      const scalar = await sha(odd('context.read'));
      assert.equal(await sha(odd('context.read')), scalar);
      assert.notEqual(scalar, canonical);
    });

    await t.test('every registry CHECK constraint has a row that violates only it', async () => {
      // PR #340's fourth delta review named at least three registry CHECKs with no negative case at
      // all. Rather than add three rows, the obligation is made total: the negative cases are
      // matched against the constraints that exist, so a CHECK added later without a case fails
      // here instead of shipping uncovered (Owner Decision 0402d831).
      const { rows: constraints } = await admin.query(`select co.conname, cl.relname from pg_constraint co
        join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
        where n.nspname = 'clued_private' and cl.relname = any($1) and co.contype = 'c'
        order by cl.relname, co.conname`, [TABLES]);
      assert.ok(constraints.length > 0);
      await admin.query(`insert into clued_private.integration_hosts_v1(host, tenant_dimension, account_dimension,
        first_authorization_required, registry_version, capability_snapshot_ref)
        values ('test.checks', 'NOT_APPLICABLE', 'NOT_APPLICABLE', true, 1, 'test')`);
      const host = (patch) => ({ table: 'integration_hosts_v1', row: { host: 'test.ok', tenant_dimension: 'REQUIRED',
        account_dimension: 'REQUIRED', first_authorization_required: true, registry_version: 1,
        capability_snapshot_ref: 'test', ...patch } });
      const surface = (patch) => ({ table: 'integration_host_surfaces_v1', row: { host: 'test.checks',
        surface: 'ok', capability_ceiling: ['context.read'], host_features: '{}', registry_version: 1, ...patch } });
      const provider = (patch) => ({ table: 'integration_providers_v1', row: { provider: 'test.ok',
        connection_dimension: 'REQUIRED', connection_source: 'BINDING_ID', host_native: false,
        registry_version: 1, ...patch } });
      const rule = (patch) => ({ table: 'integration_compatibility_rules_v1', row: { host: 'test.checks',
        adapter_family: 'fam', min_adapter_version: '1.0', min_package_version: null,
        below_minimum: 'HARD_INCOMPATIBLE', degraded_mask: null, registry_version: 1, ...patch } });
      const cases = [
        ['hosts.host regex', host({ host: 'A.bad' })],
        ['hosts.host too short', host({ host: 'ab' })],
        ['hosts.tenant_dimension', host({ tenant_dimension: 'MAYBE' })],
        ['hosts.account_dimension', host({ account_dimension: 'MAYBE' })],
        ['hosts.registry_version', host({ registry_version: 0 })],
        ['surfaces.surface regex', surface({ surface: 'Bad' })],
        ['surfaces.capability_ceiling', surface({ capability_ceiling: ['admin.write'] })],
        ['surfaces.registry_version', surface({ registry_version: 0 })],
        ['providers.provider regex', provider({ provider: 'A' })],
        ['providers.connection_dimension', provider({ connection_dimension: 'MAYBE' })],
        ['providers.connection_source', provider({ connection_source: 'MAGIC' })],
        ['providers.registry_version', provider({ registry_version: 0 })],
        ['binding_domains.max_current_holders', { table: 'integration_binding_domains_v1',
          row: { domain: 'test.ok', max_current_holders: 2, registry_version: 1 } }],
        ['vocabulary.capability', { table: 'integration_capability_vocabulary_v1',
          row: { capability: 'admin.write', vocabulary_version: 1 } }],
        ['scope_map.oauth_scope', { table: 'integration_scope_capability_map_v1',
          row: { map_version: 2, oauth_scope: 'admin:read', resource_action: 'read', capability: 'context.read' } }],
        ['scope_map.resource_action', { table: 'integration_scope_capability_map_v1',
          row: { map_version: 2, oauth_scope: 'context:read', resource_action: 'delete', capability: 'context.read' } }],
        ['policy.incomplete_identity_ordinary_runtime', { table: 'integration_policy_v1',
          row: { policy_version: 2, incomplete_identity_ordinary_runtime: 'MAYBE',
            qualification_not_evaluated: 'NON_BLOCKING', default_recovery_policy: 'PERMITS_REAUTH',
            canonical_verification_ttl: '30 days', installation_request_ttl: '30 minutes',
            preclusion_rule: 'ALL_BLOCKING_PREDICATES' } }],
        ['policy.qualification_not_evaluated', { table: 'integration_policy_v1',
          row: { policy_version: 2, incomplete_identity_ordinary_runtime: 'PERMIT',
            qualification_not_evaluated: 'MAYBE', default_recovery_policy: 'PERMITS_REAUTH',
            canonical_verification_ttl: '30 days', installation_request_ttl: '30 minutes',
            preclusion_rule: 'ALL_BLOCKING_PREDICATES' } }],
        ['policy.default_recovery_policy', { table: 'integration_policy_v1',
          row: { policy_version: 2, incomplete_identity_ordinary_runtime: 'PERMIT',
            qualification_not_evaluated: 'NON_BLOCKING', default_recovery_policy: 'MAYBE',
            canonical_verification_ttl: '30 days', installation_request_ttl: '30 minutes',
            preclusion_rule: 'ALL_BLOCKING_PREDICATES' } }],
        ['policy.preclusion_rule', { table: 'integration_policy_v1',
          row: { policy_version: 2, incomplete_identity_ordinary_runtime: 'PERMIT',
            qualification_not_evaluated: 'NON_BLOCKING', default_recovery_policy: 'PERMITS_REAUTH',
            canonical_verification_ttl: '30 days', installation_request_ttl: '30 minutes',
            preclusion_rule: 'SOME_BLOCKING' } }],
        ['rules.adapter_family length', rule({ adapter_family: '' })],
        ['rules.min_adapter_version regex', rule({ min_adapter_version: '1.0-beta' })],
        ['rules.min_package_version regex', rule({ min_adapter_version: null, min_package_version: '1.0-beta' })],
        ['rules.below_minimum', rule({ below_minimum: 'SOFT' })],
        ['rules.registry_version', rule({ registry_version: 0 })],
        ['rules.DEGRADED needs a mask', rule({ below_minimum: 'DEGRADED' })],
        ['rules.at least one version', rule({ min_adapter_version: null })],
        ['rules.mask vocabulary', rule({ below_minimum: 'DEGRADED', degraded_mask: ['admin.write'] })],
      ];
      const covered = new Map();
      for (const [label, { table, row }] of cases) {
        const keys = Object.keys(row);
        const sql = `insert into clued_private.${table}(${keys.join(', ')}) values (${
          keys.map((_, i) => `$${i + 1}`).join(', ')})`;
        let error = null;
        await admin.query(sql, keys.map((k) => row[k])).catch((e) => { error = e; });
        assert.ok(error, `${label} was accepted`);
        assert.equal(error.code, '23514', `${label}: ${error.message}`);
        assert.ok(error.constraint, `${label} names no constraint`);
        if (!covered.has(error.constraint)) covered.set(error.constraint, label);
      }
      await admin.query(`delete from clued_private.integration_hosts_v1 where host = 'test.checks'`);
      const missing = constraints.filter((c) => !covered.has(c.conname))
        .map((c) => `${c.relname}.${c.conname}`);
      assert.deepEqual(missing, [], `${missing.length} registry CHECK constraint(s) have no negative `
        + `case that violates only them: ${missing.join(', ')}`);
      const unknown = [...covered.keys()].filter((name) => !constraints.some((c) => c.conname === name));
      assert.deepEqual(unknown, [], `a negative case violated ${unknown.join(', ')}, which is not a `
        + 'registry CHECK — the case is testing something other than what it names');
      t.diagnostic(`registry CHECKs: ${constraints.length} constraints, ${cases.length} negative cases`);
    });

    await t.test('§7.1 lexical validation: timestamps are real instants, integers are integers (NIT-1, NIT-2)', async () => {
      const valid = async (value) => (await admin.query('select clued_private.integration_timestamp_valid_v1($1) v',
        [value])).rows[0].v;
      for (const [value, expected] of [
        ['2026-09-24T12:00:00Z', true], ['2026-09-24T12:00:00.123456+08:00', true],
        ['2028-02-29T00:00:00Z', true], ['2026-02-29T00:00:00Z', false], ['2026-12-31T23:59:59-05:00', true],
        ['2026-13-99T99:99:99Z', false], ['2026-02-30T00:00:00Z', false], ['2026-00-10T00:00:00Z', false],
        ['2026-09-24T25:00:00Z', false], ['2026-09-24T12:60:00Z', false], ['2026-09-24T12:00:61Z', false],
        ['2026-09-24T12:00:00', false], ['2026-09-24 12:00:00Z', false], ['now', false], [null, false],
        // the fractional second is bounded at six digits, which is the same denotation argument as
        // hour 24 and second 60 (PR #340 third delta review MAJOR-2): PostgreSQL does not reject a
        // seven-or-more-digit fraction, it ROUNDS it to microseconds, so .1234567Z is hashed as
        // spelled but read back as .123457 — a spelling that does not denote the instant it
        // spells, inside facts_sha256 by way of valid_until. Widening the regex to {1,9} is a
        // live fail-open
        // mutant that nothing else in this file kills.
        ['2026-09-24T12:00:00.1234567Z', false], ['2026-09-24T12:00:00.123456789Z', false],
        ['2026-09-24T12:00:00.123456Z', true], ['2026-09-24T12:00:00.1Z', true],
      ]) assert.equal(await valid(value), expected, String(value));
      // …and the rounding is real, not assumed: the cast accepts the seven-digit spelling and
      // re-points it to a different microsecond instant
      assert.equal((await admin.query(`select pg_catalog.to_char($1::pg_catalog.timestamptz at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US') t`, ['2026-09-24T12:00:00.1234567Z'])).rows[0].t, '2026-09-24T12:00:00.123457');
      // ERRATA-002 item 3 (Owner Decisions 25edd152-0d95-4cf7-b3eb-0ff32aed74d0 and
      // 37e0f626-f9f7-43c1-b899-4d7584b952ab): PostgreSQL silently rolls the end-of-day hour 24 and
      // the leap second 60 over to a different instant, so the document would not denote the
      // instant it spells and valid_until is inside facts_sha256. Both are rejected.
      const utc = async (value) => (await admin.query(
        `select to_char($1::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') t`, [value])).rows[0].t;
      for (const value of ['2026-09-24T12:00:60Z', '2026-09-24T24:00:00Z']) {
        assert.notEqual(await utc(value), value.replace('Z', ''), `${value} rolls over in PostgreSQL`);
        assert.equal(await valid(value), false, value);
      }
      // …and every accepted Z-spelling round trips to the very instant it spells. PR #340 second
      // delta review NIT-1: asserted over a swept range, not at five sampled values, because
      // ERRATA-002 item 3's Evidence paragraph quantifies over "every accepted Z spelling".
      await admin.query(`create function pg_temp.cast_ok(t text) returns boolean language plpgsql as $fn$
        begin perform t::pg_catalog.timestamptz; return true; exception when others then return false; end $fn$`);
      const sweep = async (values) => (await admin.query(
        `select v, pg_temp.cast_ok(v) cast_ok, clued_private.integration_timestamp_valid_v1(v) ok,
           case when pg_temp.cast_ok(v) then pg_catalog.to_char(v::pg_catalog.timestamptz at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS') end utc
         from pg_catalog.unnest($1::text[]) v`, [values])).rows;
      const pad = (n) => String(n).padStart(2, '0');
      const zSpellings = [];
      for (let h = 0; h < 24; h += 1) {
        for (const m of [0, 1, 30, 59]) for (const sec of [0, 1, 30, 59]) {
          zSpellings.push(`2026-09-24T${pad(h)}:${pad(m)}:${pad(sec)}Z`);
        }
      }
      assert.equal(zSpellings.length, 384);
      for (const row of await sweep(zSpellings)) {
        assert.equal(row.ok, true, row.v);
        assert.equal(row.utc, row.v.slice(0, -1), `${row.v} round trip`);
      }
      // PR #340 second delta review MINOR-1: ERRATA-002 item 3 counts "exactly 25 classes newly
      // rejected". That does not follow from the two regexes alone — by regex inspection the newly
      // refused set is every hour 24…99 and every second 60…99, hundreds of classes. It collapses
      // to 25 only given PostgreSQL's cast acceptance set, so the cast half is asserted here over
      // the hour and second ranges the count quantifies over, not at a handful of points. The old
      // lexical rule was this regex; the shipped one narrows only its hour and second alternations.
      const OLD_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
      const grid = [];
      for (let h = 0; h < 100; h += 1) {
        for (const m of [0, 1, 30, 59, 60, 99]) for (const sec of [0, 1, 30, 59, 60, 61, 99]) {
          grid.push(`2026-09-24T${pad(h)}:${pad(m)}:${pad(sec)}Z`);
        }
      }
      for (let m = 0; m < 60; m += 1) grid.push(`2026-09-24T24:${pad(m)}:00Z`);
      const rejected = new Set();
      for (const row of await sweep(grid)) {
        const oldAccepts = OLD_RE.test(row.v) && row.cast_ok;
        assert.ok(!row.ok || oldAccepts, `${row.v}: the shipped rule accepts what the old one refused`);
        if (oldAccepts && !row.ok) rejected.add(`${row.v.slice(11, 13)}/${row.v.slice(17, 19)}`);
      }
      // exactly the 25 (hour, second) classes ERRATA-002 item 3 names: h=00…23 with s=60, and h=24
      // with s=00 — every other out-of-range field is a hard error in the cast, not a re-pointing
      assert.deepEqual([...rejected].sort(),
        [...Array.from({ length: 24 }, (unused, h) => `${pad(h)}/60`), '24/00'].sort());
      assert.equal(rejected.size, 25);
      // …and h=24 is accepted by the cast at minute 00 only, which is why it is one class and not 60
      for (const row of await sweep(Array.from({ length: 60 }, (unused, m) => `2026-09-24T24:${pad(m)}:00Z`))) {
        assert.equal(row.cast_ok, row.v === '2026-09-24T24:00:00Z', row.v);
      }
      // the offset range PostgreSQL enforces is unchanged by the tighter hour / second alternations
      for (const [value, expected] of [['2026-09-24T12:00:00+15:59', true], ['2026-09-24T12:00:00+16:00', false],
        ['2026-09-24T12:00:00+00:60', false], ['2026-09-24T24:00:00.000000Z', false], ['0000-01-01T00:00:00Z', false],
      ]) assert.equal(await valid(value), expected, String(value));
      // a facts document whose as_of or valid_until is well-shaped but not a real instant is C1
      const codes = async (facts) => (await admin.query('select clued_private.integration_facts_validate_v1($1::jsonb) c',
        [JSON.stringify(facts)])).rows[0].c;
      assert.deepEqual(await codes(golden.base), []);
      assert.deepEqual(await codes({ ...golden.base, as_of: '2026-13-99T99:99:99Z' }), ['C1_SCHEMA_INVALID']);
      assert.deepEqual(await codes(merge(golden.base, { canonical_runtime_verification_facts: {
        valid_until: '2026-02-31T00:00:00Z' } })), ['C1_SCHEMA_INVALID']);
      assert.deepEqual(await codes({ ...golden.base, as_of: '2026-09-24T24:00:00Z' }), ['C1_SCHEMA_INVALID']);
      assert.deepEqual(await codes(merge(golden.base, { canonical_runtime_verification_facts: {
        valid_until: '2026-09-24T12:00:60Z' } })), ['C1_SCHEMA_INVALID']);
      // NIT-2: jsonb keeps the input scale, so only the integer spelling is accepted
      const baseRaw = JSON.stringify(golden.base);
      for (const [raw, label] of [
        [baseRaw.replace('"reauth_marks_open":0,', '"reauth_marks_open":0.0,'), 'reauth_marks_open 0.0'],
        [baseRaw.replace('"reauth_marks_open":0,', '"reauth_marks_open":1.5,'), 'reauth_marks_open 1.5'],
        [baseRaw.replace('"reauth_marks_open":0,', '"reauth_marks_open":-1,'), 'reauth_marks_open -1'],
        [baseRaw.replace('"policy_version":1,', '"policy_version":1.0,'), 'policy_version 1.0'],
      ]) {
        assert.notEqual(raw, baseRaw, label);
        const c = (await admin.query('select clued_private.integration_facts_validate_v1($1::jsonb) c', [raw])).rows[0].c;
        assert.deepEqual(c, ['C1_SCHEMA_INVALID'], label);
      }
      // …and the integer spelling still hashes and derives as before
      assert.deepEqual(await codes(merge(golden.base, { reauth_marks_open: 2 })), []);
    });

    await t.test('P5 golden vectors (§13.2): at least 60 hand-checked vectors', async () => {
      assert.equal(golden.derivation_contract, 'clued.integration-derivation.v1');
      assert.ok(golden.vectors.length >= 60, `${golden.vectors.length} vectors`);
      const ids = new Set(golden.vectors.map((v) => v.id));
      assert.ok(ids.has('GV-SUPERSEDED-CREDENTIAL-LOST') && ids.has('GV-SUPERSEDED-CREDENTIAL-LOST-CONTROL'));
      const covered = { states: new Set(), blocking: new Set(), codes: new Set() };
      for (const vector of golden.vectors) {
        assert.ok(vector.basis?.includes('§'), `${vector.id} cites its basis`);
        const facts = vectorFacts(vector);
        const d = (await admin.query('select clued_private.integration_derive_v1($1::jsonb) d', [JSON.stringify(facts)])).rows[0].d;
        const e = vector.expect;
        const label = `${vector.id}: ${JSON.stringify(d)}`;
        assert.equal(d.valid, e.valid, label);
        assert.equal(d.derivation_contract, 'clued.integration-derivation.v1', label);
        assert.match(d.facts_sha256, /^[0-9a-f]{64}$/, label);
        assert.equal(d.integration_state, e.integration_state, label);
        assert.equal(d.integration_operable, e.integration_operable, label);
        assert.deepEqual(d.candidate_ordinary_capabilities, e.candidate_ordinary_capabilities, label);
        assert.deepEqual(d.effective_capabilities, e.effective_capabilities, label);
        if (e.valid) {
          assert.deepEqual(d.reason_codes, [], label);
          assert.deepEqual(d.predicates.blocking, e.blocking, label);
          assert.deepEqual(d.predicates.degradation, e.degradation, label);
          for (const [key, value] of Object.entries(e.predicates ?? {})) assert.equal(d.predicates[key], value, `${label} ${key}`);
          covered.states.add(d.integration_state);
          for (const code of d.predicates.blocking) covered.blocking.add(code);
        } else {
          assert.deepEqual(d.reason_codes, e.reason_codes, label);
          assert.equal(d.predicates, null, label);
          for (const code of d.reason_codes) covered.codes.add(code);
        }
      }
      assert.deepEqual([...covered.states].sort(), [...STATES].sort(), 'every state has a golden vector');
      assert.equal(covered.blocking.size, 9, 'every blocking predicate B1…B9 has a golden vector');
      assert.deepEqual([...covered.codes].sort(), [...CODES].sort(), 'every §7.3 code has a golden vector');
      const supersede = golden.vectors.find((v) => v.id === 'GV-SUPERSEDED-CREDENTIAL-LOST');
      assert.equal(supersede.expect.integration_state, 'BLOCKED');
      for (const code of ['B1_identity_claim', 'B3_lifecycle', 'B9_unrecoverable_auth']) assert.ok(supersede.expect.blocking.includes(code));
    });

    await t.test('T-A7-9 function layer: every §7.3 code fails closed with DERIVATION_INPUT_INVALID', async () => {
      const invalid = golden.vectors.filter((v) => !v.expect.valid);
      for (const code of CODES) assert.ok(invalid.some((v) => v.expect.reason_codes.includes(code)), code);
      for (const vector of invalid) {
        const facts = vectorFacts(vector);
        const { d, codes } = (await admin.query(`select clued_private.integration_derive_v1($1::jsonb) d,
          clued_private.integration_facts_validate_v1($1::jsonb) codes`, [JSON.stringify(facts)])).rows[0];
        assert.deepEqual(codes, vector.expect.reason_codes, vector.id);
        assert.equal(d.valid, false, vector.id);
        assert.equal(d.integration_state, null, vector.id);
        assert.equal(d.integration_operable, false, vector.id);
        assert.deepEqual(d.effective_capabilities, [], vector.id);
        assert.deepEqual(d.candidate_ordinary_capabilities, [], vector.id);
      }
      // a SQL NULL document and non-object documents are C1 as well
      for (const value of [null, '"facts"', '1', '[]', 'null']) {
        const d = (await admin.query('select clued_private.integration_derive_v1($1::jsonb) d', [value])).rows[0].d;
        assert.deepEqual([d.valid, d.reason_codes, d.integration_state], [false, ['C1_SCHEMA_INVALID'], null], String(value));
      }
      // The predicate vector itself is checked, key by key. PR #340 third delta review MAJOR-1: a
      // single negative vector proved only that the loop raises on whichever key is missing first,
      // so dropping any one key from the guard's array still left the suite green while a vector
      // missing that key fell through to a state (with 'degraded' dropped, a vector without it
      // returned INSTALLED, because SQL NULL does not fire `elsif degraded`). Every key is
      // therefore asserted on its own, in both directions the guard tests — absent, and present
      // but not a boolean — and against the `detail` that names the offending key.
      const VECTOR_KEYS = ['revoked', 'hard_incompatible', 'credential_lost', 'reauth_recoverable', 'installed',
        'first_authorization_required', 'ever_authorized', 'verification_eligible', 'crv_valid', 'blocked',
        'candidate_empty', 'lifecycle_ok', 'degraded'];
      const fullVector = Object.fromEntries(VECTOR_KEYS.map((key) => [key, false]));
      assert.equal((await admin.query('select clued_private.integration_select_state_v1($1::jsonb) s',
        [JSON.stringify(fullVector)])).rows[0].s, 'INSTALL_PENDING', 'the all-false vector is accepted');
      for (const key of VECTOR_KEYS) {
        for (const [vector, label] of [
          [Object.fromEntries(Object.entries(fullVector).filter(([k]) => k !== key)), 'missing'],
          [{ ...fullVector, [key]: 'false' }, 'not a boolean'],
        ]) {
          await assert.rejects(admin.query('select clued_private.integration_select_state_v1($1::jsonb)',
            [JSON.stringify(vector)]),
          (error) => error.code === '22023' && /integration_predicate_vector_invalid/.test(error.message)
            && error.detail === key, `${key} ${label}`);
        }
      }
      // …and every key the guard names is one integration_predicates_v1 really produces, so a
      // rename on one side cannot leave this list asserting against a key that no longer exists
      // (§8.4 reads a subset of the vector: the candidate list and the predicates §8.3 computes
      // only for other consumers are not part of it)
      const produced = (await admin.query('select clued_private.integration_predicates_v1($1::jsonb) v',
        [JSON.stringify(golden.base)])).rows[0].v;
      for (const key of VECTOR_KEYS) assert.equal(typeof produced[key], 'boolean', `predicates_v1 produces ${key}`);
    });

    await t.test('T-A7-10 derivation is read-only, immutable and reads no table', async () => {
      const columns = (await admin.query(`select table_schema || '.' || table_name || '.' || column_name c
        from information_schema.columns where column_name in ('integration_state', 'effective_capabilities',
          'integration_operable')`)).rows;
      assert.deepEqual(columns, []);
      for (const fn of PURE) {
        const row = (await admin.query(`select provolatile, prosecdef, proconfig from pg_proc where oid = $1::regprocedure`,
          [`clued_private.${fn}`])).rows[0];
        assert.deepEqual(row, { provolatile: 'i', prosecdef: false, proconfig: ['search_path=""'] }, fn);
      }
      const probe = `integration_pure_probe_${hash().slice(0, 8)}`;
      await admin.query(`create role ${probe} nologin`);
      const readable = (await admin.query(`select count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('clued_private', 'public', 'auth') and c.relkind in ('r', 'v', 'm', 'p', 'f')
          and has_table_privilege($1, c.oid, 'select')`, [probe])).rows[0].n;
      assert.equal(Number(readable), 0, 'the probe role has no table privilege');
      await admin.query(`grant usage on schema clued_private to ${probe};
        grant execute on function clued_private.integration_derive_v1(jsonb), clued_private.integration_facts_validate_v1(jsonb),
          clued_private.integration_predicates_v1(jsonb), clued_private.integration_select_state_v1(jsonb),
          clued_private.integration_timestamp_valid_v1(text),
          clued_private.integration_candidate_v1(jsonb, boolean, boolean, boolean) to ${probe}`);
      const probeClient = await connect();
      await probeClient.query(`set role ${probe}`);
      await assert.rejects(probeClient.query('select count(*) from clued_private.integration_policy_v1'),
        (error) => error.code === '42501');
      for (const vector of golden.vectors) {
        const facts = JSON.stringify(vectorFacts(vector));
        const asProbe = (await probeClient.query('select clued_private.integration_derive_v1($1::jsonb)::text d', [facts])).rows[0].d;
        const asAdmin = (await admin.query('select clued_private.integration_derive_v1($1::jsonb)::text d', [facts])).rows[0].d;
        assert.equal(asProbe, asAdmin, vector.id);
      }
      await probeClient.query('reset role');
      await admin.query(`revoke usage on schema clued_private from ${probe};
        revoke execute on all functions in schema clued_private from ${probe}; drop role ${probe}`);
    });

    await t.test('P1 predicate layer: exhaustive 2^22 vectors (T-A7-4, T-A7-6, T-A7-7, T-A7-8)', async () => {
      // T-A7-8 mutation: a copy of the authoritative selector with the VERIFYING / BLOCKED branches swapped
      const source = (await admin.query(`select prosrc from pg_proc
        where oid = 'clued_private.integration_select_state_v1(jsonb)'::regprocedure`)).rows[0].prosrc;
      const swap = (first, second) => {
        const lines = source.split('\n');
        const i = lines.findIndex((line) => line.includes(`-- branch:${first}`));
        const j = lines.findIndex((line) => line.includes(`-- branch:${second}`));
        assert.ok(i > 0 && j === i + 1, `${first} / ${second} are adjacent branches`);
        [lines[i], lines[j]] = [lines[j], lines[i]];
        const swapped = lines.join('\n');
        assert.notEqual(swapped, source);
        return swapped;
      };
      await admin.query(`create schema integration_mutation;
        create function integration_mutation.select_state_swapped(p_vector jsonb) returns text language plpgsql immutable
        set search_path='' as $mutant$${swap('VERIFYING', 'BLOCKED')}$mutant$;
        create function integration_mutation.select_state_control(p_vector jsonb) returns text language plpgsql immutable
        set search_path='' as $mutant$${swap('DEGRADED', 'ACTIVE')}$mutant$`);

      // Free bits (k = 22). eligible, blocked and reauth_recoverable are derived; vectors that
      // violate a predicate dependency of §8.3 / §7.3 are filtered out first.
      const { rows: [r] } = await admin.query(`
        with raw as (
          select g,
            (g >> 0) & 1 = 1 revoked, (g >> 1) & 1 = 1 hard, (g >> 2) & 1 = 1 credential_lost,
            (g >> 3) & 1 = 1 recovery_permits, (g >> 4) & 1 = 1 historical, (g >> 5) & 1 = 1 installed,
            (g >> 6) & 1 = 1 first_auth, (g >> 7) & 1 = 1 ever_auth, (g >> 8) & 1 = 1 auth_ok,
            (g >> 9) & 1 = 1 b1, (g >> 10) & 1 = 1 b2, (g >> 11) & 1 = 1 b3, (g >> 12) & 1 = 1 b4, (g >> 13) & 1 = 1 b5,
            (g >> 14) & 1 = 1 b6, (g >> 15) & 1 = 1 b7, (g >> 16) & 1 = 1 b8, (g >> 17) & 1 = 1 b9,
            (g >> 18) & 1 = 1 crv_valid, (g >> 19) & 1 = 1 cand_empty, (g >> 20) & 1 = 1 degraded,
            (g >> 21) & 1 = 1 lifecycle_ok
          from generate_series(0, (1 << 22) - 1) g),
        consistent as (
          select *, (b1 or b2 or b3 or b4 or b5 or b6 or b7 or b8 or b9) blocked,
            (recovery_permits and not historical) reauth_recoverable
          from raw
          where credential_lost = (ever_auth and not auth_ok)                          -- §8.3 credential_lost
            and b3 = not lifecycle_ok                                                   -- B3
            and b8 = (installed and auth_ok and cand_empty)                             -- B8
            and b9 = (credential_lost and not (recovery_permits and not historical))    -- B9
            and (not historical or (not lifecycle_ok and b1))                          -- C6: SUPERSEDED ⇔ historical
            and (not auth_ok or ever_auth)                                              -- C8
            and (not (not auth_ok or b1 or b2 or b4 or b5 or b6 or b7 or revoked or hard) or cand_empty)), -- §9.2 zero factors
        vec as (
          select *, (installed and auth_ok and not b1 and not blocked and lifecycle_ok and not b5 and not b6) eligible
          from consistent),
        res as (
          select *, clued_private.integration_select_state_v1(v) state, integration_mutation.select_state_swapped(v) mutant,
            integration_mutation.select_state_control(v) control
          from vec, lateral (select jsonb_build_object('revoked', revoked, 'hard_incompatible', hard,
            'credential_lost', credential_lost, 'reauth_recoverable', reauth_recoverable, 'installed', installed,
            'first_authorization_required', first_auth, 'ever_authorized', ever_auth, 'verification_eligible', eligible,
            'crv_valid', crv_valid, 'blocked', blocked, 'candidate_empty', cand_empty, 'lifecycle_ok', lifecycle_ok,
            'degraded', degraded) v) x),
        judged as (
          select *, case                                                                -- baseline §16.3 precedence
            when revoked then 'REVOKED' when hard then 'INCOMPATIBLE'
            when credential_lost and reauth_recoverable then 'REAUTH_REQUIRED'
            when installed and first_auth and not ever_auth then 'AUTH_PENDING'
            when eligible and not crv_valid then 'VERIFYING' when blocked then 'BLOCKED'
            when installed and not cand_empty and lifecycle_ok and crv_valid and degraded then 'DEGRADED'
            when installed and not cand_empty and lifecycle_ok and crv_valid then 'ACTIVE'
            when installed then 'INSTALLED' else 'INSTALL_PENDING' end expected,
            (not cand_empty and lifecycle_ok and crv_valid and state in ('ACTIVE', 'DEGRADED')) operable
          from res)
        select (select count(*) from raw) enumerated, count(*) consistent,
          count(distinct state) states,
          count(*) filter (where state is null or state <> all (array[${STATES.map((s) => `'${s}'`).join(',')}])) not_one_state,
          count(*) filter (where state is distinct from expected) wrong_precedence,
          count(*) filter (where eligible and not crv_valid and blocked) verifying_and_blocked,
          count(*) filter (where blocked and eligible) precluded_but_eligible,
          count(*) filter (where blocked and not crv_valid and (state = 'VERIFYING'
            or state <> all (array['REVOKED','INCOMPATIBLE','REAUTH_REQUIRED','AUTH_PENDING','BLOCKED']))) t_a7_6,
          count(*) filter (where state = 'VERIFYING' and not eligible) t_a7_7,
          count(*) filter (where mutant is distinct from state) t_a7_8,
          count(*) filter (where control is distinct from state) control_detected,
          count(*) filter (where state in ('ACTIVE', 'DEGRADED') and (cand_empty or blocked or not operable)) active_invalid,
          count(*) filter (where credential_lost and state <> all (array['REVOKED','INCOMPATIBLE','REAUTH_REQUIRED','BLOCKED'])) lost_state,
          count(*) filter (where state = 'INSTALLED' and not (installed and not auth_ok and not ever_auth and not first_auth
            and not blocked)) installed_reach,
          count(*) filter (where installed and auth_ok and not blocked and not revoked and not hard
            and state <> all (array['ACTIVE','DEGRADED','VERIFYING'])) healthy_phase
        from judged`);
      const counts = Object.fromEntries(Object.entries(r).map(([key, value]) => [key, Number(value)]));
      t.diagnostic(`P1 ${JSON.stringify(counts)}`);
      assert.equal(counts.enumerated, 2 ** 22);
      assert.ok(counts.consistent > 1000);
      assert.equal(counts.states, 10, 'all ten states are reached');
      // negative control: swapping two branches whose predicates do overlap (DEGRADED ⊂ ACTIVE) is detected
      assert.ok(counts.control_detected > 0, 'the mutation harness detects an order-dependent swap');
      for (const key of ['not_one_state', 'wrong_precedence', 'verifying_and_blocked', 'precluded_but_eligible', 't_a7_6',
        't_a7_7', 't_a7_8', 'active_invalid', 'lost_state', 'installed_reach', 'healthy_phase']) {
        assert.equal(counts[key], 0, key);
      }
    });

    // ---------------------------------------------------------------------------------------------
    // P2 fact layer + P3 determinism. Session A evaluates each sample, session B evaluates the
    // permuted equivalent document; both run concurrently.
    const sessionB = await connect();
    const stats = { total: 0, valid: 0, layers: {}, states: {}, codes: {} };
    const violations = {};
    const fail = (id, sample, detail) => {
      violations[id] ??= { count: 0, examples: [] };
      violations[id].count += 1;
      if (violations[id].examples.length < 3) {
        violations[id].examples.push({ seed: SEED, layer: sample.layer, index: sample.index, detail, facts: sample.facts });
      }
    };
    // offset 0 keeps the planner from inlining the lateral subquery, which would call derive once per output column
    const evaluate = (client, docs) => client.query(`select d->>'integration_state' state, (d->>'valid')::boolean valid,
        (d->>'integration_operable')::boolean operable, d->'candidate_ordinary_capabilities' cand,
        d->'effective_capabilities' effective, d->'reason_codes' codes, d->>'facts_sha256' sha,
        d->'predicates' predicates, md5(d::text) digest,
        case when (d->>'valid')::boolean then integration_mutation.select_state_swapped(d->'predicates') end mutant
      from jsonb_array_elements($1::jsonb) with ordinality x(f, n), lateral (select clued_private.integration_derive_v1(f) d offset 0) y
      order by n`, [docs]);
    const rng = mulberry32(SEED ^ 0x5eed);
    // ---- rule coverage (Owner Decision c79a6278-4cfa-478a-aa04-e98ff379c17a) -------------------
    // Two obligations on the branch-resolved mirror defined above, both riding on this one pass:
    // it agrees with validateOracle on C1 / C9 on every sample, and every predicate is the sole
    // cause of its reason code on at least one sample. Plus the assertion that the DIMENSIONS
    // bases are themselves schema-valid, which is what makes a corrupted sample distinguishing.
    const cover = { c1: { fired: C1_RULES.map(() => 0), sole: C1_RULES.map(() => 0) },
      c9: { fired: C9_RULES.map(() => 0), sole: C9_RULES.map(() => 0) }, disagreements: 0, baseInvalid: 0 };
    const COVER_PASSES = [[C1_RULES, 'C1_SCHEMA_INVALID', cover.c1], [C9_RULES, 'C9_CONTRACT_UNKNOWN', cover.c9]];
    const coverRules = (sample, expected) => {
      const baseCodes = sample.base === sample.facts ? expected : validateOracle(sample.base);
      if (baseCodes.includes('C1_SCHEMA_INVALID')) {
        cover.baseInvalid += 1;
        fail('P2-BASE-SCHEMA', sample, { baseCodes });
      }
      for (const [rules, code, acc] of COVER_PASSES) {
        let n = 0;
        let last = -1;
        for (let i = 0; i < rules.length; i += 1) {
          if (rules[i][1](sample.facts)) { n += 1; last = i; acc.fired[i] += 1; }
        }
        if (n === 1) acc.sole[last] += 1;
        if ((n > 0) !== expected.includes(code)) {
          cover.disagreements += 1;
          fail('P2-RULE-MIRROR', sample, { code, oracle: expected, fired: rules.filter((r) => r[1](sample.facts)).map((r) => r[0]) });
        }
      }
    };
    const check = (sample, a, b) => {
      stats.total += 1;
      stats.layers[sample.layer] = (stats.layers[sample.layer] ?? 0) + 1;
      const f = sample.facts;
      if (a.digest !== b.digest || a.sha !== b.sha) fail('T-A7-3', sample, { a, b });
      // ---- §7.3 validation oracle (v0.1.8 delta review MINOR-1): on every sample, valid or not ----
      const expected = validateOracle(f);
      coverRules(sample, expected);
      if (JSON.stringify(a.codes) !== JSON.stringify(expected)) {
        fail('P2-VALIDATE', sample, { derived: a.codes, oracle: expected });
      }
      if (a.valid !== (expected.length === 0)) fail('P2-VALIDATE', sample, { valid: a.valid, oracle: expected });
      if (!a.valid) {
        for (const code of a.codes) stats.codes[code] = (stats.codes[code] ?? 0) + 1;
        if (a.state !== null || a.operable || a.cand.length || a.effective.length || !a.codes.length || a.predicates !== null) {
          fail('T-A7-9', sample, a);
        }
        return;
      }
      stats.valid += 1;
      stats.states[a.state] = (stats.states[a.state] ?? 0) + 1;
      const p = a.predicates;
      if (!STATES.includes(a.state)) fail('T-A7-4', sample, a);
      if (a.cand.length === 0 && a.operable) fail('T-A3-1', sample, a);
      if (a.operable && (a.effective.length === 0 || JSON.stringify(a.effective) !== JSON.stringify(a.cand))) fail('T-A3-2', sample, a);
      if (!a.operable && a.effective.length !== 0) fail('T-A3-3', sample, a);
      if (['ACTIVE', 'DEGRADED'].includes(a.state) && a.effective.length === 0) fail('T-A3-4', sample, a);
      if (a.cand.length === 0 && p.crv_valid && ['ACTIVE', 'DEGRADED'].includes(a.state)) fail('T-A3-4', sample, a);
      if (a.state === 'BLOCKED' && (a.operable || a.effective.length !== 0)) fail('T-A3-5', sample, a);
      if (f.identity_completeness === 'COMPLETE' && f.identity_claim_state !== 'CURRENT_CLAIM_HOLDER' && a.cand.length !== 0) {
        fail('T-A3-6', sample, a);
      }
      const blockingFact = f.qualification_state.value === 'SUSPENDED' || f.host_state.value === 'HARD_UNAVAILABLE'
        || f.adapter_state.value === 'BLOCKED' || p.blocking.includes('B8_candidate_empty')
        || ['CLAIM_CONFLICT', 'PENDING_RECONCILE', 'SUPERSEDED'].includes(f.identity_claim_state);
      if (blockingFact && !AT_LEAST_BLOCKED.includes(a.state)) fail('T-A7-5', sample, a);
      if (a.cand.length === 0 && ['ACTIVE', 'DEGRADED'].includes(a.state)) fail('T-A7-5', sample, a);
      if (p.verification_precluded_by_blocking_fact && p.verification_eligible) fail('T-A7-6', sample, a);
      if (p.verification_precluded_by_blocking_fact && f.canonical_runtime_verification_facts.status !== 'VALID'
        && (a.state === 'VERIFYING' || !AT_LEAST_BLOCKED.includes(a.state))) fail('T-A7-6', sample, a);
      if (a.state === 'VERIFYING' && p.verification_eligible !== true) fail('T-A7-7', sample, a);
      if (a.mutant !== a.state) fail('T-A7-8', sample, a);

      // ---- semantic layer (the v0.1.8 review's MINOR-2 and MINOR-3, a semantic oracle) ----
      const o = oracle(f);
      for (const [key, value] of Object.entries(o.predicates)) {
        if (p[key] !== value) fail('P2-PREDICATES', sample, { key, derived: p[key], oracle: value });
      }
      if (JSON.stringify(p.blocking) !== JSON.stringify(o.blocking)) {
        fail('P2-BLOCKING', sample, { derived: p.blocking, oracle: o.blocking });
      }
      if (JSON.stringify(p.degradation) !== JSON.stringify(o.degradation)) {
        fail('P2-DEGRADATION', sample, { derived: p.degradation, oracle: o.degradation });
      }
      if (JSON.stringify(a.cand) !== JSON.stringify(o.cand)) {
        fail('P2-CANDIDATE', sample, { derived: a.cand, oracle: o.cand });
      }
      // B8 is phase-qualified (OQ-1): it needs `installed`, not only auth_ok ∧ cand = ∅
      const b8 = o.predicates.installed && o.predicates.auth_ok && o.cand.length === 0;
      if (p.blocking.includes('B8_candidate_empty') !== b8) fail('P2-B8', sample, { derived: p.blocking, b8 });
      // every Candidate capability is inside every mask that applies (§9.2)
      for (const [name, node, unmasked] of [['environment_state', f.environment_state, 'AVAILABLE'],
        ['qualification_state', f.qualification_state, null], ['compatibility_state', f.compatibility_state, 'COMPATIBLE'],
        ['host_state', f.host_state, 'AVAILABLE'], ['adapter_state', f.adapter_state, 'OK']]) {
        const masked = name === 'qualification_state' ? node.value === 'CONDITIONAL' : node.value !== unmasked;
        if (masked && Array.isArray(node.mask) && !a.cand.every((c) => node.mask.includes(c))) {
          fail('P2-MASKS', sample, { name, mask: node.mask, cand: a.cand });
        }
      }
      if (!a.cand.every((c) => f.host_state.surface_ceiling.includes(c) && f.host_state.declared.includes(c)
        && f.capability_universe.includes(c))) fail('P2-MASKS', sample, { cand: a.cand });
      // REAUTH_REQUIRED vs BLOCKED (§8.3 B9, §8.4 precedence)
      if (o.predicates.credential_lost && o.predicates.reauth_recoverable && f.revocation_state !== 'REVOKED'
        && f.compatibility_state.value !== 'HARD_INCOMPATIBLE' && a.state !== 'REAUTH_REQUIRED') {
        fail('P2-REAUTH', sample, a);
      }
      if (o.predicates.credential_lost && !o.predicates.reauth_recoverable
        && (!p.blocking.includes('B9_unrecoverable_auth')
          || !['REVOKED', 'INCOMPATIBLE', 'BLOCKED'].includes(a.state))) fail('P2-REAUTH', sample, a);
      if (a.state !== o.state) fail('P2-STATE', sample, { derived: a.state, oracle: o.state });
      if (a.operable !== o.operable) fail('P2-STATE', sample, { derived: a.operable, oracle: o.operable });
      if (JSON.stringify(a.effective) !== JSON.stringify(o.effective)) {
        fail('P2-STATE', sample, { derived: a.effective, oracle: o.effective });
      }
    };
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const original = JSON.stringify(batch.map((s) => s.facts));
      const variant = `[${batch.map((s) => JSON.stringify(permuted(s.facts, rng))).join(',')}]`;
      const [a, b] = await Promise.all([evaluate(admin, original), evaluate(sessionB, variant)]);
      batch.forEach((sample, i) => check(sample, a.rows[i], b.rows[i]));
      batch = [];
    };
    for (const sample of p2Samples()) {
      batch.push(sample);
      if (batch.length === CHUNK) await flush();
    }
    await flush();
    t.diagnostic(`P2 ${JSON.stringify(stats)}`);
    const report = (id) => {
      const v = violations[id];
      assert.equal(v?.count ?? 0, 0, v ? `${id}: ${v.count} violations, e.g. ${JSON.stringify(v.examples, null, 1)}` : id);
    };

    await t.test(`P2 coverage: single-factor, pairwise and ${RANDOM_SAMPLES.toLocaleString('en-US')} fixed-seed random facts`, () => {
      assert.ok(stats.layers.single >= 100, JSON.stringify(stats.layers));
      assert.ok(stats.layers.pairwise >= 10000, JSON.stringify(stats.layers));
      assert.equal(stats.layers.random, RANDOM_SAMPLES);
      assert.deepEqual(Object.keys(stats.states).sort(), [...STATES].sort(), 'every state is reached from facts');
      assert.deepEqual(Object.keys(stats.codes).sort(), [...CODES].sort(), 'every §7.3 code is reached from facts');
    });

    // ---- the rule-coverage obligations (Owner Decision c79a6278) -------------------------------
    await t.test('RULE-MIRROR: the branch-resolved rule mirror agrees with the validation oracle on C1 and C9', () => {
      report('P2-RULE-MIRROR');
      assert.equal(cover.disagreements, 0);
      const never = [...C1_RULES.map(([id], i) => [id, cover.c1.fired[i]]),
        ...C9_RULES.map(([id], i) => [id, cover.c9.fired[i]])].filter(([, n]) => n === 0).map(([id]) => id);
      t.diagnostic(`RULE-MIRROR ${C1_RULES.length} C1 + ${C9_RULES.length} C9 predicates, 0 disagreements over `
        + `${stats.total} samples; never fired: ${never.length ? never.join(', ') : 'none'}`);
    });
    await t.test('RULE-SOLE: every validator rule is the sole cause of its reason code on some sample', () => {
      const counts = [...C1_RULES.map(([id], i) => [id, cover.c1.sole[i]]), ...C9_RULES.map(([id], i) => [id, cover.c9.sole[i]])];
      // a predicate with no isolating sample is a mutation-testing blind spot: the branch could be
      // deleted without any sample's reason codes changing, which is how N7 and its three
      // predecessors survived. The allow-list is only for rules no JavaScript-object sample can
      // reach, and each entry names the committed vector that covers it instead.
      const blind = counts.filter(([id, n]) => n === 0 && !SOLE_EXEMPT.has(id)).map(([id]) => id);
      assert.deepEqual(blind, [], `no sample isolates ${blind.length} validator rule(s): ${blind.join(', ')}`
        + ' — add a corruption that breaks only that rule, or, if no sample can reach it, allow-list it'
        + ' in SOLE_EXEMPT naming the raw-text vector that covers it');
      // …and the allow-list stays honest: an entry that now has an isolating sample is stale
      const stale = counts.filter(([id, n]) => n > 0 && SOLE_EXEMPT.has(id)).map(([id]) => id);
      assert.deepEqual(stale, [], `SOLE_EXEMPT is stale: ${stale.join(', ')} now has an isolating sample`);
      // …and every allow-listed id still names a predicate. A typo'd or obsolete entry would
      // otherwise sit here silently forever, exempting nothing (PR #340 third delta review NIT-2).
      const unknown = [...SOLE_EXEMPT.keys()].filter((id) => !counts.some(([known]) => known === id));
      assert.deepEqual(unknown, [], `SOLE_EXEMPT names ${unknown.join(', ')}, which is not a predicate id`);
      const sole = counts.filter(([id]) => !SOLE_EXEMPT.has(id)).map(([, n]) => n);
      t.diagnostic(`RULE-SOLE ${sole.length} rules isolated, ${SOLE_EXEMPT.size} allow-listed; `
        + `${Math.min(...sole)}…${Math.max(...sole)} isolating samples each `
        + `(mean ${(sole.reduce((x, y) => x + y, 0) / sole.length).toFixed(1)})`);
    });
    await t.test('no base drawn from DIMENSIONS violates a C1 rule (single, pairwise and pre-corruption random)', () => {
      report('P2-BASE-SCHEMA');
      assert.equal(cover.baseInvalid, 0);
    });
    const properties = [
      ['T-A3-1', 'Candidate = ∅ ⇒ Operable = false'],
      ['T-A3-2', 'Operable ⇒ Effective = Candidate ≠ ∅'],
      ['T-A3-3', '¬Operable ⇒ Effective = ∅'],
      ['T-A3-4', 'ACTIVE / DEGRADED ⇒ Effective ≠ ∅; Candidate = ∅ with a valid verification is never ACTIVE / DEGRADED'],
      ['T-A3-5', 'BLOCKED ⇒ ¬Operable ∧ Effective = ∅'],
      ['T-A3-6', 'complete ∧ claim ≠ CURRENT_CLAIM_HOLDER ⇒ Candidate = ∅'],
      ['T-A7-3', 'P3: equivalent documents in two sessions give byte-identical results and facts_sha256'],
      ['T-A7-4', 'every valid document derives exactly one of the ten states'],
      ['T-A7-5', 'blocking facts land on BLOCKED or a higher-priority state, never ACTIVE / DEGRADED'],
      ['T-A7-6', 'precluded ∧ verification incomplete ⇒ not VERIFYING, BLOCKED or higher'],
      ['T-A7-7', 'VERIFYING ⇒ verification_eligible'],
      ['T-A7-8', 'the VERIFYING / BLOCKED-swapped selector agrees on every sample'],
      ['T-A7-9', 'invalid documents: no state, not operable, empty sets, reason codes present'],
      ['P2-VALIDATE', 'the §7.3 reason codes equal the set recomputed from the facts, on every sample (§7.1, §7.3)'],
      ['P2-PREDICATES', 'every predicate equals the value recomputed from the facts (§8.3)'],
      ['P2-BLOCKING', 'the B1…B9 list equals the list recomputed from the facts (§8.3)'],
      ['P2-B8', 'B8 ∈ blocking ⇔ installed ∧ auth_ok ∧ Candidate = ∅, recomputed from the facts (OQ-1)'],
      ['P2-DEGRADATION', 'the degradation source list equals the list recomputed from the facts (§8.3)'],
      ['P2-CANDIDATE', 'Candidate equals the set recomputed from the facts (§9.1, §9.2)'],
      ['P2-MASKS', 'Candidate ⊆ every applicable mask, ceiling, declaration and universe (§9.2)'],
      ['P2-REAUTH', 'credential_lost splits into REAUTH_REQUIRED and B9 / BLOCKED by reauth_recoverable'],
      ['P2-STATE', 'state, Operability and Effective equal the values recomputed from the facts (§8.4, §9.4)'],
    ];
    for (const [id, title] of properties) await t.test(`${id} (P2 facts layer) ${title}`, () => report(id));

    await t.test('T-A7-3 / P3: as_of does not enter facts_sha256; sets and keys are canonicalized', async () => {
      const base = golden.base;
      const other = { ...base, as_of: '2026-09-25T08:30:00.123456+08:00' };
      const shuffled = permuted(merge(base, { capability_universe: [...ALL, 'context.read'] }), mulberry32(SEED));
      const [x, y, z] = (await admin.query(`select clued_private.integration_derive_v1($1::jsonb)::text a,
        clued_private.integration_derive_v1($2::jsonb)::text b, clued_private.integration_derive_v1($3::jsonb)::text c`,
      [JSON.stringify(base), JSON.stringify(other), JSON.stringify(shuffled)])).rows.map((row) => [row.a, row.b, row.c])[0];
      assert.equal(x, y);
      assert.equal(x, z);
      const sha = (await admin.query(`select encode(sha256(convert_to((($1::jsonb) - 'as_of')::text, 'UTF8')), 'hex') s`,
        [JSON.stringify(base)])).rows[0].s;
      assert.equal(JSON.parse(x).facts_sha256, sha, 'facts_sha256 = sha256((facts − as_of)::text) of the canonical document');
      const changed = (await admin.query('select clued_private.integration_derive_v1($1::jsonb) d',
        [JSON.stringify(merge(base, { reauth_marks_open: 0, identity_state: 'INVALID' }))])).rows[0].d;
      assert.notEqual(changed.facts_sha256, JSON.parse(x).facts_sha256);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
