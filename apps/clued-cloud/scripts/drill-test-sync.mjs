// Drill test project sync (Task 87d330d0; design FABLE-drill-test-project-sync-20261124, the ruling at its end).
//
//   node scripts/drill-test-sync.mjs --applied <production-applied.json> (--kit <first-install-kit.json> | --scope <scope>)
//        [--server <drill-server.json>] [--rebuild]          the database password: standard input
//
// Brings the hosted test project clued-auth-test to production's applied
// migration list: the same schema_migrations rows, in production's order, each
// applied from the text production ran (scripts/production-schema-chain.mjs).
// The migration directory in file-name order is not production's database, so
// it is never the target. It runs on the drill host, before a drill boots a
// guest (drill-vm.ps1); no workflow runs it.
//
//   1. production's list: the file the release workflow exports with
//      supabase/production-schema/applied.sql (read-only; names, md5, order);
//   2. the test project's own schema_migrations;
//   3. the test list is a prefix of production's: the missing rows are applied
//      one by one, each in one transaction with its schema_migrations row.
//      Anything else is diverged: nothing is applied. --rebuild first drops
//      the application objects (the snapshot's schemas, the roles the
//      migrations create, the history rows) and starts from empty; auth stays;
//   4. fixtures: one ci-admission parking spot per account, and the project the
//      first-install kit's scope names (the drill's token is issued for it).
//
// Nothing is left in the database to say how the sync went: the host has the
// answer, the last line of standard output (RESULT_CONTRACT) and, when it is
// not a success, one of the codes below.
//
// The connection is built from constants. What reaches it from outside is the
// password (standard input, never an environment variable or an argument) and
// the session pooler's host name (drill-server.json poolerHost, a public
// value); neither can name another project: the tenant is the user name's
// suffix, which is fixed here. The password is never printed or written.
// Production is never connected to from here.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// node-postgres, bundled into a tracked file (scripts/generate-drill-pg.mjs): the drill host runs this from a checkout that
// installed nothing, so everything it imports is a node: module or a file of the repository.
import drillPg from './generated/drill-pg.mjs';
import { applyTransform, matchTransform } from './migration-ledger.mjs';
import { productionChain, readRepository, readSnapshot } from './production-schema-chain.mjs';
import { SCHEMA_STATEMENT, prepareReplay } from './production-schema-drift.mjs';

export const PRODUCTION_REF = 'ccxsikzwxlolxqlosril';
export const DRILL_TEST_REF = 'uscrdifznmlvczcekqpw';
export const RESULT_CONTRACT = 'clued.drill-test-sync.result/1';
export const APPLIED_CONTRACT = 'clued.production-applied.v1';
// Supabase's session pooler (IPv4; the direct address is IPv6 only).
const POOLER_HOST = /^aws-[0-9]+-[a-z]+(?:-[a-z]+)+-[0-9]+\.pooler\.supabase\.com$/;

// What the host reads when the sync is not a success (the ruling's table). One more than the table: the pooler's
// host name is not in drill-server.json yet, or is not one (named after DRILL_SERVER_PUBLISHABLE_KEY_NOT_SET).
export const CODES = Object.freeze(['DRILL_SERVER_PRODUCTION_LIST_MISSING', 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING',
  'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED', 'DRILL_SERVER_DIVERGED', 'DRILL_SERVER_SYNC_FAILED', 'DRILL_SERVER_UNREACHABLE',
  'DRILL_SERVER_POOLER_HOST_NOT_SET']);
export class SyncError extends Error {
  // `code`: one of CODES; DRILL_SERVER_SYNC_FAILED is followed by ":" and the row's file or the stage that failed.
  constructor(code, detail = '', options) {
    super(detail === '' ? code : `${code} ${detail}`, options);
    this.code = code;
    this.detail = detail;
  }
}

// The drill's server file (work/independent-ci-resident-v1/drill/drill-server.json), the one place the drill's
// server is named. Read here: the pooler's host name, and that the file names this project and no other.
export const DRILL_SERVER_FILE = fileURLToPath(new URL('../../../work/independent-ci-resident-v1/drill/drill-server.json', import.meta.url));
export async function readPoolerHost(file = DRILL_SERVER_FILE) {
  let server = null;
  try { server = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { server = null; }
  if (server === null || typeof server !== 'object' || Array.isArray(server) || server.supabaseUrl !== `https://${DRILL_TEST_REF}.supabase.co`
      || typeof server.poolerHost !== 'string' || !POOLER_HOST.test(server.poolerHost)) throw new SyncError('DRILL_SERVER_POOLER_HOST_NOT_SET');
  return server.poolerHost;
}

// The scope the drill's token is asked for: the first-install kit's record.scope (the host's holders request reads
// the same field), or the value given. Never a constant here.
const SCOPE = /^(?:global|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export function checkedScope(scope) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) throw new Error('drill_test_scope_invalid');
  return scope;
}
export async function readKitScope(file) {
  let kit = null;
  try { kit = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { kit = null; }
  return checkedScope(kit?.record?.scope);
}

// A configuration object, not a URL: nothing in the password is ever parsed as
// routing, and node-postgres reads no PG* variable for a field given here.
export function connectionConfig({ password, host } = {}) {
  if (typeof host !== 'string' || !POOLER_HOST.test(host)) throw new SyncError('DRILL_SERVER_POOLER_HOST_NOT_SET');
  if (typeof password !== 'string' || password === '') throw new SyncError('DRILL_SERVER_DATABASE_CREDENTIAL_MISSING');
  const config = { host, port: 5432, user: `postgres.${DRILL_TEST_REF}`, database: 'postgres', password, connectionTimeoutMillis: 15_000,
    // As the production URLs' sslmode=no-verify: encrypted, the pooler's certificate is not from a public authority.
    ssl: { rejectUnauthorized: false } };
  const { password: omitted, ...routing } = config;
  if (JSON.stringify(routing).includes(PRODUCTION_REF) || DRILL_TEST_REF === PRODUCTION_REF) throw new Error('drill_test_target_is_production');
  return config;
}

const byVersion = (a, b) => a.version.localeCompare(b.version);
const sameRow = (a, b) => a.version === b.version && a.name === b.name && a.statements_md5 === b.statements_md5;

// Pure. behind: the test list is a prefix of production's (missing: what to
// apply, in order). stale: the test list already holds every production row
// and more (an older list arriving late): nothing changes. diverged: any other
// difference, with the first differing place.
export function planSync({ production, test }) {
  if (!Array.isArray(production) || production.length === 0) throw new Error('production_applied_missing');
  const want = [...production].sort(byVersion);
  const have = [...test].sort(byVersion);
  for (let index = 0; index < Math.min(want.length, have.length); index += 1) {
    if (!sameRow(want[index], have[index])) return { state: 'diverged', missing: [], at: { index, production: want[index], test: have[index] } };
  }
  if (have.length > want.length) return { state: 'stale', missing: [] };
  return have.length === want.length ? { state: 'in-sync', missing: [] } : { state: 'behind', missing: want.slice(have.length) };
}

// Substitutions that stand in for something only the embedded replay lacks
// (catalog.json replay_substitutions: pg_cron). A hosted project has the
// extension, so there the row runs as production ran it.
const EMBEDDED_ONLY_SUBSTITUTION = /^create\s+extension\b/i;
// The other way round: what only a hosted platform has (PLAN-drill-test-platform-acl-20261124). A rule applies to
// every row whose text holds `find`, exactly once in that row (prepareReplay). Only the executed text changes: the
// recorded text and its md5 stay production's. Not in catalog.json, whose substitutions also reach the embedded
// drift check.
export const HOSTED_ONLY_SUBSTITUTIONS = Object.freeze([Object.freeze({
  find: `pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,SELECT,UPDATE') else false end)`,
  // Still refused: USAGE or UPDATE on any sequence, an ACL entry of the role itself, SELECT on any sequence but
  // one that is in the cron schema, owned by a superuser (nothing the application made or can grant on) and in a
  // schema the role cannot enter. The schema is matched by membership and the owner by existence: a comparison
  // with to_regnamespace('cron') is NULL where there is no such schema and would let every SELECT through.
  replace: `(pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,UPDATE')
 or exists(select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee='clued_worker_gateway'::regrole)
 or (pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'SELECT')
     and not (c.relnamespace in (select n.oid from pg_catalog.pg_namespace n where n.nspname='cron')
              and exists(select 1 from pg_catalog.pg_roles r where r.oid=c.relowner and r.rolsuper)
              and not pg_catalog.has_schema_privilege('clued_worker_gateway',c.relnamespace,'USAGE')))) else false end)`,
  reason: 'A platform image newer than production\'s (17.11.0.003 against 17.6.1.155) gives PUBLIC SELECT on pg_cron\'s own sequences, '
    + 'granted by supabase_admin: postgres cannot revoke it, and the worker gateway rows refuse any privilege on any sequence.',
})]);
const withoutComments = (text) => text.replace(/--[^\n]*/g, ' ');
const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;
const PLATFORM_ROLE = /^(?:postgres|anon|authenticated|authenticator|service_role|dashboard_user|pgbouncer|pg_.*|supabase_.*)$/;

// Production's list as steps: `statements` is the text production stores for
// the row (its md5 is the row's), `run` the text to execute (null for a
// data-only row that cannot run on an empty database), `roles` the roles the
// whole history creates, `prehistory` what ran before the first recorded row.
export function resolveSteps({ applied, repository, snapshot, platform = 'hosted' }) {
  if (!Array.isArray(applied) || applied.length === 0) throw new Error('production_applied_missing');
  if (!['hosted', 'embedded'].includes(platform)) throw new Error('platform_invalid');
  const chain = productionChain({ applied, ...repository });
  const errors = [...chain.errors];
  const skipped = new Map((snapshot.replay_skip ?? []).map((entry) => [entry.file, entry.reason]));
  for (const [file] of skipped) {
    const step = chain.applied.find((candidate) => candidate.file === file);
    if (step && SCHEMA_STATEMENT.test(withoutComments(step.text))) errors.push(`snapshot_replay_skip_not_data_only:${file}`);
  }
  const substitutions = new Map();
  for (const entry of snapshot.replay_substitutions ?? []) {
    if (platform === 'hosted' && EMBEDDED_ONLY_SUBSTITUTION.test(entry.find)) continue;
    substitutions.set(entry.file, [...(substitutions.get(entry.file) ?? []), entry]);
  }
  if (platform === 'hosted') {
    for (const rule of HOSTED_ONLY_SUBSTITUTIONS) {
      for (const step of chain.applied) {
        if (step.text.includes(rule.find)) substitutions.set(step.file, [...(substitutions.get(step.file) ?? []), { file: step.file, ...rule }]);
      }
    }
  }
  const rows = new Map(applied.map((row) => [row.version, row]));
  const steps = chain.applied.map((step) => {
    const row = rows.get(step.version);
    const transform = matchTransform(step.text, row.statements_md5);
    if (!transform) { errors.push(`chain_source_md5:${step.version}_${step.name}`); return null; }
    const [replay] = skipped.has(step.file) ? [{ text: null }] : prepareReplay([step], { skipped: new Map(), substitutions, errors });
    return { version: step.version, name: step.name, file: step.file, statements: applyTransform(step.text, transform),
      statements_md5: row.statements_md5, run: replay.text };
  });
  const prehistory = (snapshot.prehistory ?? []).map((file) => {
    const text = file.startsWith('migrations/') ? repository.migrations[file.slice('migrations/'.length)] : undefined;
    if (typeof text !== 'string') errors.push(`snapshot_prehistory_missing:${file}`);
    return { file, text };
  });
  if (errors.length > 0) throw new Error(`production_chain_unresolved: ${[...new Set(errors)].join(', ')}`);
  const roles = new Set();
  for (const step of [...prehistory, ...steps.map((s) => ({ text: s.statements }))]) {
    for (const match of withoutComments(step.text).matchAll(/\bcreate\s+role\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1/gi)) roles.add(match[2].toLowerCase());
  }
  for (const role of roles) if (!ROLE_NAME.test(role) || PLATFORM_ROLE.test(role)) throw new Error(`migration_role_refused:${role}`);
  const schemas = snapshot.schemas ?? [];
  if (!schemas.includes('public') || schemas.some((schema) => !ROLE_NAME.test(schema) || /^(?:auth|storage|extensions|cron|vault|realtime|pg_.*|supabase_.*|information_schema)$/.test(schema))) {
    throw new Error('snapshot_schemas_invalid');
  }
  return { steps, prehistory, roles: [...roles].sort(), schemas: [...schemas].sort() };
}

const HISTORY_TABLE = `create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);`;

export async function readTestHistory(client) {
  const present = (await client.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as present`)).rows[0].present;
  if (!present) return [];
  return (await client.query(`select version, name, md5(array_to_string(statements, '')) as statements_md5
    from supabase_migrations.schema_migrations order by version`)).rows;
}

async function transaction(client, body) {
  await client.query('begin');
  try {
    const value = await body();
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

const quoted = (name) => `"${name.replaceAll('"', '""')}"`;

// Drops what the migrations made: every object of the application schemas
// (public keeps its schema and so the platform's default privileges; objects an
// extension owns stay), the cron jobs, the roles and the history rows. auth,
// storage and the extensions are never touched. Runs inside the caller's
// transaction.
export async function clearApplication(client, { schemas, roles }) {
  await client.query(`select set_config('clued.drill_sync_schemas', $1, true)`, [schemas.join(',')]);
  await client.query(`do $clear$
declare target text[] := string_to_array(current_setting('clued.drill_sync_schemas'), ','); item record;
begin
  set local search_path = '';
  -- An event trigger of an application function would fire on every drop below.
  for item in select e.evtname from pg_catalog.pg_event_trigger e join pg_catalog.pg_proc p on p.oid = e.evtfoid
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = any(target) loop
    execute format('drop event trigger if exists %I', item.evtname);
  end loop;
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobname) from cron.job where jobname is not null;
  end if;
  for item in select unnest(target) as name loop
    if item.name <> 'public' then execute format('drop schema if exists %I cascade', item.name); end if;
  end loop;
  for item in select c.oid::regclass::text as name, c.relkind from pg_catalog.pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'r', 'p', 'f', 'S')
        and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype in ('e', 'i', 'a'))
      order by array_position(array['v', 'm', 'f', 'r', 'p', 'S']::"char"[], c.relkind) loop
    execute format('drop %s if exists %s cascade', case item.relkind when 'v' then 'view' when 'm' then 'materialized view'
      when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end, item.name);
  end loop;
  for item in select p.oid::regprocedure::text as name from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') loop
    execute format('drop routine if exists %s cascade', item.name);
  end loop;
  for item in select t.oid::regtype::text as name, t.typtype from pg_catalog.pg_type t
      where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd', 'r', 'c')
        and (t.typtype <> 'c' or exists (select 1 from pg_catalog.pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
        and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_type'::regclass and d.objid = t.oid and d.deptype = 'e') loop
    execute format('drop %s if exists %s cascade', case item.typtype when 'd' then 'domain' else 'type' end, item.name);
  end loop;
end $clear$`);
  const left = (await client.query(`select kind || ' ' || name as object from (
      select 'relation' as kind, c.oid::regclass::text as name, 'pg_catalog.pg_class'::regclass as classid, c.oid from pg_catalog.pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'r', 'p', 'f', 'S')
      union all select 'routine', p.oid::regprocedure::text, 'pg_catalog.pg_proc'::regclass, p.oid from pg_catalog.pg_proc p
        where p.pronamespace = 'public'::regnamespace) o
    where not exists (select 1 from pg_catalog.pg_depend d where d.classid = o.classid and d.objid = o.oid and d.deptype = 'e')
    order by 1 limit 20`)).rows.map((row) => row.object);
  if (left.length > 0) throw new Error(`clear_incomplete: ${left.join(', ')}`);
  const newer = roles.length > 0 && Number((await client.query('show server_version_num')).rows[0].server_version_num) >= 160000;
  for (const role of roles) {
    if (!ROLE_NAME.test(role) || PLATFORM_ROLE.test(role)) throw new Error(`migration_role_refused:${role}`);
    const present = (await client.query('select 1 from pg_catalog.pg_roles where rolname = $1', [role])).rows.length === 1;
    if (!present) continue;
    // drop owned needs the role's privileges. The hosted postgres holds these roles with admin but without inherit
    // (granted by supabase_admin), and answered "permission denied to drop objects"; admin lets it grant itself inherit.
    if (newer) await client.query(`grant ${quoted(role)} to current_user with inherit true`);
    await client.query(`drop owned by ${quoted(role)} cascade`);
    await client.query(`drop role ${quoted(role)}`);
  }
  await client.query(HISTORY_TABLE);
  await client.query('delete from supabase_migrations.schema_migrations');
}

// One row: its text and its schema_migrations row in one transaction, the
// stored text checked against production's md5 before the commit. The text is
// sent as it is (as the drift check replays production's rows), so a row that
// carries its own transaction control still runs; migrate mode's plpgsql
// EXECUTE would refuse it.
export async function applyStep(client, step, before = []) {
  try {
    await transaction(client, async () => {
      for (const earlier of before) await client.query(earlier.text);
      if (step.run !== null) await client.query(step.run);
      const stored = (await client.query(`insert into supabase_migrations.schema_migrations(version, name, statements)
        values ($1, $2, $3) returning md5(array_to_string(statements, '')) as md5`, [step.version, step.name, [step.statements]])).rows[0].md5;
      if (stored !== step.statements_md5) throw new Error('recorded text differs from production');
    });
  } catch (error) {
    // The database's DETAIL (a migration's bounded diagnostic) names what the message alone does not.
    throw new SyncError(`DRILL_SERVER_SYNC_FAILED:${step.file}`, error.detail ? `${error.message} ${error.detail}` : error.message, { cause: error });
  }
}

const PARKING_LABEL = 'drill-parking';
const result = (name) => `with answer as materialized (select public.${name}($1::jsonb) as v)
  select v->>'status' as status, v->>'error_code' as error_code, v->>'binding_id' as binding_id,
    v->>'confirmation_token' as confirmation_token, v->>'view_digest' as view_digest from answer`;

// One ci-admission parking spot for an account, made the way its Owner would
// make it: a read-only headless Binding, then the role with purpose parking,
// each through the product's two-step functions under a login session's
// claims. The Binding's token is generated by the server and never selected
// here; only its verifier is stored. Nobody holds it and a parking spot admits
// nobody, so this is not a credential.
async function seedParking(client, userId) {
  const claims = { sub: userId, role: 'authenticated', session_id: randomUUID(), aal: 'aal1',
    amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
  // One transaction per call, as one HTTP request each: the product refuses a confirmation consumed in the
  // request that issued it (confirmation_token_same_request).
  const call = (name, input, expected) => transaction(client, async () => {
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [userId, JSON.stringify(claims)]);
    const answer = (await client.query(result(name), [JSON.stringify(input)])).rows[0];
    if (answer.status !== expected) throw new Error(`fixture_failed:${name}:${answer.error_code ?? answer.status}`);
    return answer;
  });
  const proof = (answer) => ({ confirmation_token: answer.confirmation_token, view_digest: answer.view_digest });
  const binding = await call('clued_headless_binding_issue_v1', proof(await call('clued_headless_binding_confirmation_issue_v1',
    { label: PARKING_LABEL, days: 90, selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] }, 'issued')), 'committed');
  await call('clued_binding_role_set_v1', proof(await call('clued_binding_role_confirmation_issue_v1',
    { binding_id: binding.binding_id, role: 'ci-admission', enabled: true, purpose: 'parking' }, 'issued')), 'committed');
}

// The project the kit's scope names, owned by the account that will issue the drill's token: a token for
// project:<id> cannot be issued, and no token is answered for that scope, unless the account owns a project with
// exactly that id (resource_action_not_authorized otherwise, an "all contexts" token included). The product's
// functions generate a project's id, so this one row is written directly, under the product's writer guard. A
// project's id is its primary key: it belongs to one account, the one that signed up first (`users` is in that
// order); every other account gets its parking spot and nothing else. `account` tells the host which one to sign
// in with: the first character of its e-mail address and the domain, never the whole address.
const masked = (email) => (typeof email === 'string' && /^[^@]+@[^@]+$/.test(email) ? `${[...email][0]}***@${email.split('@')[1]}` : null);
async function seedProject(client, scope, users) {
  if (!scope.startsWith('project:')) return { project: null, project_account: null };
  const id = scope.slice('project:'.length);
  const holder = (await client.query('select user_id from public.clued_projects where id = $1', [id])).rows[0]?.user_id ?? null;
  if (holder !== null) {
    const owner = users.find((user) => user.id === holder);
    if (!owner) throw new Error('fixture_project_owner_unknown');
    return { project: 'present', project_account: masked(owner.email) };
  }
  const [owner] = users;
  if (!owner) return { project: null, project_account: null };
  await transaction(client, async () => {
    await client.query('select clued_private.authorization_writer_guard_v2($1)', [owner.id]);
    await client.query(`insert into public.clued_projects(id, user_id, name, normalized_name, context_key)
      values ($1, $2, 'drill', 'drill', $3)`, [id, owner.id, scope]);
  });
  return { project: 'seeded', project_account: masked(owner.email) };
}

// Every account of the test project keeps ci-admission marked by a parking
// spot. Without one the server admits every Binding to the role
// (binding_role_admits_v1) and the drill guest's probe reads "held".
export async function seedFixtures(client, { scope }) {
  checkedScope(scope);
  const users = (await client.query(`select u.id, u.email, exists (select 1 from clued_private.binding_roles_v1 r
      where r.user_id = u.id and r.role = 'ci-admission' and r.purpose = 'parking' and r.revoked_at is null) as parked
    from auth.users u where u.deleted_at is null order by u.created_at, u.id`)).rows;
  let seeded = 0;
  for (const user of users) {
    if (user.parked) continue;
    await seedParking(client, user.id);
    seeded += 1;
  }
  return { users: users.length, seeded, ...await seedProject(client, scope, users) };
}

export async function syncDatabase(client, { applied, repository, snapshot, scope, rebuild = false, platform = 'hosted', log = () => {} }) {
  checkedScope(scope);
  const production = [...applied].sort(byVersion);
  // Resolved before anything changes: a list this commit cannot resolve to texts changes nothing.
  const { steps, prehistory, roles, schemas } = resolveSteps({ applied: production, repository, snapshot, platform });
  if (rebuild) {
    log(`rebuild: dropping the application objects of ${schemas.join(', ')} and the roles ${roles.join(', ')}`);
    await transaction(client, () => clearApplication(client, { schemas, roles }));
  }
  const plan = planSync({ production, test: await readTestHistory(client) });
  if (plan.state === 'diverged') return { state: 'diverged', applied: [], at: plan.at };
  if (plan.state === 'stale') return { state: 'stale', applied: [] };
  await client.query(HISTORY_TABLE);
  const stepOf = new Map(steps.map((step) => [step.version, step]));
  const fromEmpty = plan.missing.length === production.length;
  const done = [];
  for (const [index, row] of plan.missing.entries()) {
    const step = stepOf.get(row.version);
    await applyStep(client, step, fromEmpty && index === 0 ? prehistory : []);
    done.push(`${step.version}_${step.name}`);
    await log(`applied ${step.version}_${step.name}${step.run === null ? ' (data-only row: recorded, not run)' : ''}`);
  }
  const fixtures = await seedFixtures(client, { scope });
  return { state: 'in-sync', applied: done, fixtures };
}

// The exported list: the row applied.sql returns ({"applied": [...]}), the
// release workflow's file ({contract, applied, ...}) or the bare array.
export function parseApplied(text) {
  const value = JSON.parse(text);
  const applied = Array.isArray(value) ? value : value?.applied;
  if (!Array.isArray(applied) || applied.length === 0 || applied.some((row) => typeof row?.version !== 'string' || !/^\d{14}$/.test(row.version) ||
      typeof row.name !== 'string' || !/^[0-9a-f]{32}$/.test(row.statements_md5 ?? ''))) throw new Error('production_applied_invalid');
  return applied.map(({ version, name, statements_md5, statements_length }) => ({ version, name, statements_md5, statements_length }));
}

// A wrong password is 28P01 (28000: a login refused outright).
const REFUSED = new Set(['28P01', '28000']);

async function readStandardInput(stream = process.stdin) {
  if (stream.isTTY) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  // One line: the line end the sender added is not part of the password.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

// Three attempts. A refused password is not tried again: it will not become right.
export async function connected(pg, config, { attempts = 3, pause = () => new Promise((resolve) => { setTimeout(resolve, 2_000); }) } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client(config);
    client.on?.('error', () => {});
    try { await client.connect(); return client; } catch (error) {
      await client.end?.().catch(() => {});
      if (REFUSED.has(error?.code)) throw new SyncError('DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED', '', { cause: error });
      last = error;
      if (attempt < attempts) await pause();
    }
  }
  throw new SyncError('DRILL_SERVER_UNREACHABLE', String(last?.code ?? last?.message ?? ''), { cause: last });
}

const option = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? '' : undefined);
const USAGE = 'usage: node scripts/drill-test-sync.mjs --applied <production-applied.json> (--kit <first-install-kit.json> | --scope <scope>) [--server <drill-server.json>] [--rebuild] < password';

// Returns the result the host reads; throws SyncError (a code) or, for a wrong call, a plain Error.
export async function runSync(argv, { stdin = readStandardInput, tool = async () => drillPg, connect = connected, say = () => {} } = {}) {
  const appliedFile = option(argv, '--applied');
  const given = [option(argv, '--kit'), option(argv, '--scope')];
  if (!appliedFile || given.filter((value) => value !== undefined).length !== 1 || given.includes('')) throw new Error(USAGE);
  const scope = given[0] !== undefined ? await readKitScope(given[0]) : checkedScope(given[1]);
  // Everything that can be refused without the password is refused before it is read.
  const pg = await tool();
  let applied;
  try { applied = parseApplied(await readFile(appliedFile, 'utf8')); } catch (error) {
    throw new SyncError('DRILL_SERVER_PRODUCTION_LIST_MISSING', error?.code === 'ENOENT' ? 'no file' : 'not a list', { cause: error });
  }
  const host = await readPoolerHost(option(argv, '--server') ?? DRILL_SERVER_FILE);
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  const password = await stdin();
  const client = await connect(pg, connectionConfig({ password, host }));
  const last = [...applied].sort(byVersion).at(-1);
  try {
    // The tenant is the user name's suffix; the database behind it reports only these.
    const who = (await client.query('select current_user as login, current_database() as database')).rows[0];
    if (who.login !== 'postgres' || who.database !== 'postgres' || client.user !== `postgres.${DRILL_TEST_REF}`) throw new SyncError('DRILL_SERVER_SYNC_FAILED:login', 'not the test project');
    const outcome = await syncDatabase(client, { applied, repository, snapshot, scope, rebuild: argv.includes('--rebuild'), platform: 'hosted', log: say });
    if (outcome.state === 'diverged') {
      throw new SyncError('DRILL_SERVER_DIVERGED', `row ${outcome.at.index + 1}: production ${outcome.at.production.version}_${outcome.at.production.name}, `
        + `test project ${outcome.at.test.version}_${outcome.at.test.name}`);
    }
    return { contract: RESULT_CONTRACT, state: outcome.state, production_last: { version: last.version, name: last.name },
      production_rows: applied.length, applied: outcome.applied.length, fixtures: outcome.fixtures ?? null };
  } catch (error) {
    if (error instanceof SyncError && !error.code.startsWith('DRILL_SERVER_SYNC_FAILED:')) throw error;
    // The message may quote the server; never the password.
    const clean = (text) => String(text ?? '').split(password).join('***');
    if (error instanceof SyncError) throw new SyncError(error.code, clean(error.detail), { cause: error });
    // Not a row: the rebuild's clearing, the list's texts, the fixtures.
    const stage = /^production_chain_unresolved/.test(error?.message ?? '') ? 'production-list-texts' : /^fixture_/.test(error?.message ?? '') ? 'fixtures' : 'database';
    throw new SyncError(`DRILL_SERVER_SYNC_FAILED:${stage}`, clean(error?.message), { cause: error });
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(argv) {
  try {
    console.log(JSON.stringify(await runSync(argv, { say: (line) => console.log(`drill-test-sync: ${line}`) })));
    return 0;
  } catch (error) {
    console.error(`drill-test-sync: ${error.message}`);
    if (!(error instanceof SyncError)) return 2;
    console.log(JSON.stringify({ contract: RESULT_CONTRACT, state: 'failed', code: error.code }));
    return 1;
  }
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  process.exitCode = await main(process.argv.slice(2));
}
