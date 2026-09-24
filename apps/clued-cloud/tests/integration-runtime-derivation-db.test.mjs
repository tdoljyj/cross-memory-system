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
// Sample counts (§13.2 P2 (c)): 150,000 fixed-seed random facts by default (the CI count, cut from
// 250,000 by v0.1.8 review MINOR-4 to keep a 2-vCPU runner inside the stated budget);
// CLUED_INTEGRATION_RUNTIME_PROPERTY_FULL=1 runs the nightly 2,000,000, which is the 250,000+
// figure of §13.2 P2 (c) and more. The seed is mulberry32(20260924) (§13.0) and is printed with
// every failing sample.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20260926000000_integration_runtime_registry_derivation.sql';
const FULL = process.env.CLUED_INTEGRATION_RUNTIME_PROPERTY_FULL === '1';
const RANDOM_SAMPLES = FULL ? 2_000_000 : 150_000;
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
// predicate / Candidate / state / Operability layer straight from the facts document, written from
// the specification text (§7.3, §8.3, §8.4, §9.1, §9.2, §9.4) and never from the SQL output, so a
// mutation of any single factor in the migration diverges here. It is applied only to documents the
// migration itself already judged valid; invalid documents stay with the T-A7-9 structural checks.
const SCOPE_OF = { 'context.read': 'context:read', 'project.read': 'context:read',
  'development_history.read': 'context:read', 'context.write': 'context:write',
  'project.write': 'context:write', 'evidence.write': 'context:write', 'audit.read': 'audit:read' };
const has = (list, value) => Array.isArray(list) && list.includes(value);
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
// Schema-level corruptions mixed into the random layer (1 %), so C1 / C9 are exercised too.
const CORRUPTIONS = [
  (f) => { delete f.host_state; },
  (f) => { f.ready_profile_verification_facts = { status: 'PASS' }; },
  (f) => { f.authentication_state = 'ACTIVE'; },
  (f) => { f.environment_state = { value: 'RESTRICTED', mask: null }; },
  (f) => { f.capability_universe = [...f.capability_universe, 'admin.write']; },
  (f) => { f.policy.policy_version = 2; },
  (f) => { f.derivation_contract = 'clued.integration-derivation.v2'; },
  (f) => { f.reauth_marks_open = -1; },
  (f) => { f.revocation_source = f.revocation_state === 'REVOKED' ? 'NONE' : 'INTEGRATION'; },
];
// Three centres for the single-factor and pairwise layers: the healthy ACTIVE base, a fresh, not yet
// authorized installation, and a DEGRADED raw Binding with an incomplete identity (the S2c norm, §6.2).
const CENTRES = [golden.base, merge(golden.base, { authentication_state: 'NONE', authorization_state: 'NOT_GRANTED',
  oauth_scope_facts: [], resource_action_scope_facts: { mode: 'NONE' }, installation_facts: { ever_authorized: false },
  ...crv('NONE') }), merge(golden.base, { identity_completeness: 'INCOMPLETE', identity_claim_state: 'INCOMPLETE_UNCLAIMED',
  authorization_state: 'GRANTED_LEGACY', resource_action_scope_facts: { mode: 'LEGACY_UNRESTRICTED' },
  host_state: { value: 'DEGRADED', mask: ['context.read', 'context.write'] } })];

function* p2Samples() {
  for (const centre of CENTRES) {
    for (const [, values] of DIMENSIONS) for (const patch of values) yield { layer: 'single', facts: merge(centre, patch) };
  }
  for (const centre of CENTRES) {
    for (let i = 0; i < DIMENSIONS.length; i += 1) {
      for (let j = i + 1; j < DIMENSIONS.length; j += 1) {
        for (const a of DIMENSIONS[i][1]) for (const b of DIMENSIONS[j][1]) {
          yield { layer: 'pairwise', facts: merge(merge(centre, a), b) };
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
    if (rng() < 0.01) {
      facts = clone(facts);
      CORRUPTIONS[Math.floor(rng() * CORRUPTIONS.length)](facts);
    }
    yield { layer: 'random', index: n, facts };
  }
}

test('S2c PR-1: integration registries and pure derivation', { timeout: 3_600_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-integration-derivation-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
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
        group by c.oid, c.relname, c.relkind, c.relrowsecurity, c.relacl, c.relowner order by c.relname`);
      assert.deepEqual(rows.filter((r) => r.relkind === 'r').map((r) => r.relname), TABLES);
      assert.deepEqual(rows.filter((r) => r.relkind !== 'r'), [], 'PR-1 creates no sequence or view');
      for (const row of rows) {
        assert.equal(row.relrowsecurity, true, row.relname);
        assert.deepEqual(row.grantees, [], row.relname);
        assert.equal(row.public_grant, false, row.relname);
        assert.equal(Number(row.policies), 0, row.relname);
        assert.equal(row.any_privilege, false, row.relname);
      }
      // READY profiles are PR-3; no public view (§5.14)
      assert.equal((await admin.query(`select to_regclass('clued_private.integration_ready_profiles_v1') r`)).rows[0].r, null);
      assert.equal(Number((await admin.query(`select count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like '%integration%'`)).rows[0].n), 0);
    });

    await t.test('T-S-2 no clued_private.integration_* function is executable by public, anon, authenticated, service_role', async () => {
      const { rows } = await admin.query(`select p.oid::regprocedure::text fn, p.proacl is null default_acl,
          exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) public_grant,
          bool_or(has_function_privilege(r.rolname, p.oid, 'execute')) any_role
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
        where n.nspname = 'clued_private' and p.proname like 'integration\\_%'
        group by p.oid, p.proacl order by 1`);
      assert.deepEqual(rows.map((r) => r.fn), PURE.map((fn) => `clued_private.${fn}`).sort());
      for (const row of rows) {
        assert.equal(row.default_acl, false, `${row.fn} keeps the default PUBLIC EXECUTE`);
        assert.equal(row.public_grant, false, row.fn);
        assert.equal(row.any_role, false, row.fn);
      }
      // PR-1 creates no Integration public RPC, so none can be granted (§5.13, OQ-21)
      assert.equal(Number((await admin.query(`select count(*) n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '%integration%'`)).rows[0].n), 0);
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
        [{ scopes: [], entries: [{ ...entry, extra: 1 }] }, false, 'extra entry key'],
        [{ scopes: [], entries: [entry, { ...entry, actions: ['read'] }] }, false, 'duplicate entry key'],
        [{ scopes: [], entries: [], other: 1 }, false, 'extra key'],
        [{ scopes: [] }, false, 'missing entries'],
        [[], false, 'not an object'],
        [undefined, false, 'null'],
      ]) assert.equal(await valid(value), expected, label);
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
      ]) assert.equal(await valid(value), expected, String(value));
      // a facts document whose as_of or valid_until is well-shaped but not a real instant is C1
      const codes = async (facts) => (await admin.query('select clued_private.integration_facts_validate_v1($1::jsonb) c',
        [JSON.stringify(facts)])).rows[0].c;
      assert.deepEqual(await codes(golden.base), []);
      assert.deepEqual(await codes({ ...golden.base, as_of: '2026-13-99T99:99:99Z' }), ['C1_SCHEMA_INVALID']);
      assert.deepEqual(await codes(merge(golden.base, { canonical_runtime_verification_facts: {
        valid_until: '2026-02-31T00:00:00Z' } })), ['C1_SCHEMA_INVALID']);
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
      // the predicate vector itself is checked: a missing key cannot fall through to a state
      await assert.rejects(admin.query(`select clued_private.integration_select_state_v1('{"revoked": false}')`),
        (error) => error.code === '22023' && /integration_predicate_vector_invalid/.test(error.message));
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
    const check = (sample, a, b) => {
      stats.total += 1;
      stats.layers[sample.layer] = (stats.layers[sample.layer] ?? 0) + 1;
      const f = sample.facts;
      if (a.digest !== b.digest || a.sha !== b.sha) fail('T-A7-3', sample, { a, b });
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

      // ---- semantic layer (v0.1.8 review MINOR-2 / MINOR-3): recomputed from the facts ----
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
    await server.stop();
  }
});
