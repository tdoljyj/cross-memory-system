// Drill test project sync (Task 87d330d0; design FABLE-drill-test-project-sync-20261124 §1, §2).
//
//   node scripts/drill-test-sync.mjs --applied <production-applied.json> [--rebuild]
//
// Brings the hosted test project clued-auth-test to production's applied
// migration list: the same schema_migrations rows, in production's order, each
// applied from the text production ran (scripts/production-schema-chain.mjs).
// The migration directory in file-name order is not production's database, so
// it is never the target.
//
//   1. production's list: the file the release workflow exports with
//      supabase/production-schema/applied.sql (read-only; names, md5, order);
//   2. the test project's own schema_migrations;
//   3. the test list is a prefix of production's: the missing rows are applied
//      one by one, each in one transaction with its schema_migrations row.
//      Anything else is `diverged`: nothing is applied. --rebuild first drops
//      the application objects (the snapshot's schemas, the roles the
//      migrations create, the history rows) and starts from empty; auth stays;
//   4. fixtures (one ci-admission parking spot per account) and the receipt
//      public.clued_drill_sync_receipt_v1(), which the drill host reads before
//      it starts a guest. The receipt does not exist while rows are applied.
//
// The connection is built from constants. The only input that reaches it is
// the password (environment clued-drill-test) and the session pooler's host
// name; neither can name another project: the tenant is the user name's
// suffix, which is fixed here. The password is never printed, written or put
// into the receipt. Production is never connected to from here.
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { applyTransform, matchTransform } from './migration-ledger.mjs';
import { productionChain, readRepository, readSnapshot } from './production-schema-chain.mjs';
import { SCHEMA_STATEMENT, prepareReplay } from './production-schema-drift.mjs';

export const PRODUCTION_REF = 'ccxsikzwxlolxqlosril';
export const DRILL_TEST_REF = 'uscrdifznmlvczcekqpw';
export const RECEIPT_CONTRACT = 'clued.drill-test-sync-receipt.v1';
export const APPLIED_CONTRACT = 'clued.production-applied.v1';
// Supabase's session pooler (IPv4; GitHub-hosted machines have no IPv6 route to the direct address).
const POOLER_HOST = /^aws-[0-9]+-[a-z]+(?:-[a-z]+)+-[0-9]+\.pooler\.supabase\.com$/;

// A configuration object, not a URL: nothing in the password is ever parsed as
// routing, and node-postgres reads no PG* variable for a field given here.
export function connectionConfig({ password, host } = {}) {
  if (typeof host !== 'string' || !POOLER_HOST.test(host)) throw new Error('drill_test_pooler_host_invalid');
  if (typeof password !== 'string' || password === '') throw new Error('drill_test_database_password_missing');
  const config = { host, port: 5432, user: `postgres.${DRILL_TEST_REF}`, database: 'postgres', password,
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
  for (const role of roles) {
    if (!ROLE_NAME.test(role) || PLATFORM_ROLE.test(role)) throw new Error(`migration_role_refused:${role}`);
    const present = (await client.query('select 1 from pg_catalog.pg_roles where rolname = $1', [role])).rows.length === 1;
    if (!present) continue;
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
    throw new Error(`apply_failed:${step.version}_${step.name}: ${error.message}`, { cause: error });
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

// Every account of the test project keeps ci-admission marked by a parking
// spot. Without one the server admits every Binding to the role
// (binding_role_admits_v1) and the drill guest's probe reads "held".
export async function seedFixtures(client) {
  const users = (await client.query(`select u.id, exists (select 1 from clued_private.binding_roles_v1 r
      where r.user_id = u.id and r.role = 'ci-admission' and r.purpose = 'parking' and r.revoked_at is null) as parked
    from auth.users u where u.deleted_at is null order by u.id`)).rows;
  let seeded = 0;
  for (const user of users) {
    if (user.parked) continue;
    await seedParking(client, user.id);
    seeded += 1;
  }
  return { users: users.length, seeded };
}

// The receipt is a function whose body is a constant: anon can call it through
// the REST API, nothing can be read through it but what is written here.
export async function writeReceipt(client, receipt) {
  const json = JSON.stringify(receipt);
  const tag = `$receipt_${randomBytes(8).toString('hex')}$`;
  await client.query(`create or replace function public.clued_drill_sync_receipt_v1() returns jsonb
    language sql immutable set search_path = '' as ${tag}select '${json.replaceAll("'", "''")}'::jsonb${tag};
    revoke all on function public.clued_drill_sync_receipt_v1() from public;
    grant execute on function public.clued_drill_sync_receipt_v1() to anon, authenticated, service_role;
    notify pgrst, 'reload schema';`);
  return receipt;
}

export async function syncDatabase(client, { applied, repository, snapshot, rebuild = false, platform = 'hosted', meta = {}, log = () => {} }) {
  const production = [...applied].sort(byVersion);
  // Resolved before anything changes: a list this commit cannot resolve to texts changes nothing.
  const { steps, prehistory, roles, schemas } = resolveSteps({ applied: production, repository, snapshot, platform });
  const stamp = { source_commit: meta.sourceCommit ?? null, run_id: meta.runId ?? null, at: meta.at ?? new Date().toISOString() };
  const receipt = (state, facts = {}) => ({ contract: RECEIPT_CONTRACT, state, ...facts, ...stamp });
  if (rebuild) {
    log(`rebuild: dropping the application objects of ${schemas.join(', ')} and the roles ${roles.join(', ')}`);
    await transaction(client, () => clearApplication(client, { schemas, roles }));
  }
  const plan = planSync({ production, test: await readTestHistory(client) });
  if (plan.state === 'diverged') {
    await writeReceipt(client, receipt('diverged'));
    return { state: 'diverged', applied: [], at: plan.at };
  }
  if (plan.state === 'stale') return { state: 'stale', applied: [] };
  await client.query(HISTORY_TABLE);
  // While rows are applied there is no receipt (the drill host reads "no-receipt"), not one that says
  // "syncing": production's own history refuses an anon-callable public.clued_* function it does not know
  // (20261011011706_worker_gateway_closeout_v1, unknown_anon_function_acl), and a later row may check again.
  if (plan.missing.length > 0) await client.query(`drop function if exists public.clued_drill_sync_receipt_v1(); notify pgrst, 'reload schema'`);
  const stepOf = new Map(steps.map((step) => [step.version, step]));
  const fromEmpty = plan.missing.length === production.length;
  const done = [];
  for (const [index, row] of plan.missing.entries()) {
    const step = stepOf.get(row.version);
    await applyStep(client, step, fromEmpty && index === 0 ? prehistory : []);
    done.push(`${step.version}_${step.name}`);
    await log(`applied ${step.version}_${step.name}${step.run === null ? ' (data-only row: recorded, not run)' : ''}`);
  }
  const fixtures = await seedFixtures(client);
  const last = production.at(-1);
  const written = await writeReceipt(client, receipt('in-sync',
    { production_last: { version: last.version, name: last.name }, production_rows: production.length }));
  return { state: 'in-sync', applied: done, fixtures, receipt: written };
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

async function main(argv, env) {
  const appliedFile = argv[argv.indexOf('--applied') + 1];
  if (!argv.includes('--applied') || !appliedFile) throw new Error('usage: node scripts/drill-test-sync.mjs --applied <production-applied.json> [--rebuild]');
  const applied = parseApplied(await readFile(appliedFile, 'utf8'));
  const repository = await readRepository();
  const snapshot = await readSnapshot();
  const { default: pg } = await import('pg');
  const client = new pg.Client(connectionConfig({ password: env.CLUED_DRILL_TEST_DATABASE_PASSWORD, host: env.CLUED_DRILL_TEST_POOLER_HOST }));
  const say = (line) => console.log(`drill-test-sync: ${line}`);
  await client.connect();
  try {
    // The tenant is the user name's suffix; the database behind it reports only these.
    const who = (await client.query('select current_user as login, current_database() as database')).rows[0];
    if (who.login !== 'postgres' || who.database !== 'postgres' || client.user !== `postgres.${DRILL_TEST_REF}`) throw new Error('drill_test_login_unexpected');
    const outcome = await syncDatabase(client, { applied, repository, snapshot, rebuild: argv.includes('--rebuild'), platform: 'hosted',
      meta: { sourceCommit: env.GITHUB_SHA ?? null, runId: env.GITHUB_RUN_ID ?? null }, log: say });
    const last = applied.at(-1);
    const lines = [`state: ${outcome.state}`, `production list: ${applied.length} rows through ${last.version}_${last.name}`, `applied now: ${outcome.applied.length}`];
    if (outcome.fixtures) lines.push(`accounts: ${outcome.fixtures.users}, parking spots added: ${outcome.fixtures.seeded}`);
    if (outcome.at) lines.push(`first difference at row ${outcome.at.index + 1}: production ${outcome.at.production.version}_${outcome.at.production.name}, test project ${outcome.at.test.version}_${outcome.at.test.name}; run again with rebuild`);
    for (const line of lines) say(line);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `## Drill test project sync\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
    return outcome.state === 'diverged' ? 1 : 0;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`drill-test-sync: ${error.message}`);
    process.exitCode = 1;
  }
}
