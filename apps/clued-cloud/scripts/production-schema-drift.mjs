// Production-schema drift check (Task 2a5fdb66; design in
// work/ci-required-tests-v1/DESIGN.md).
//
//   node scripts/production-schema-drift.mjs check [--report <file>]
//   node scripts/production-schema-drift.mjs import --catalog <file> --applied <file>
//
// check needs no credential and no network. It boots two throwaway embedded
// PostgreSQL clusters:
//   1. production chain: the committed snapshot's applied rows, replayed in
//      production's order with the texts production ran. Its catalog
//      fingerprint (supabase/production-schema/catalog.sql) must equal the
//      snapshot's, apart from reviewed known_deviations. Then every pending
//      migration is applied the way the release workflow's migrate mode does
//      it (one plpgsql EXECUTE per file, in file-name order).
//   2. repository chain: every migration file in file-name order, as the
//      database tests do. Objects only this chain has (for example the
//      never-applied P5 column public.clued_agent_bindings.expires_at) are
//      what tests can see and production cannot. A pending migration that
//      names such a table and column fails the check unless the file says
//      `-- production-schema: allow <schema>.<table>.<column>` (a reviewed
//      statement that the reference is intended, for example a migration that
//      adds that column to production).
// import turns the output of catalog.sql and applied.sql (run read-only
// against production by whoever refreshes the snapshot) into catalog.json.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  SNAPSHOT_CONTRACT, catalogSqlPath, productionChain, readRepository, readSnapshot, repositoryChain, snapshotPath,
} from './production-schema-chain.mjs';

// Supabase platform objects the migrations assume and a plain PostgreSQL
// lacks, in the shape the database tests already use. Default privileges
// mirror production's pg_default_acl entries for public as read on
// 2026-10-31: supabase_admin's platform defaults; postgres's tables grant
// service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, its sequences and
// functions entries name only the owner. anon and authenticated hold the four
// table privileges until 20261007120000_db_security_hygiene revokes them, as
// it did in production.
export const PLATFORM_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator nologin noinherit;
create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
create table auth.sessions(id uuid primary key, user_id uuid not null references auth.users(id), not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth, extensions to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;
create schema cron;
create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true,
  database text default current_database(), username text default current_user);
create function cron.schedule(text, text, text) returns bigint language sql as $$insert into cron.job(jobname, schedule, command)
  values($1, $2, $3) on conflict(jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true returning jobid$$;
create function cron.unschedule(text) returns boolean language sql as $$delete from cron.job where jobname = $1 returning true$$;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);
grant usage on schema public to anon, authenticated, service_role;
create role supabase_admin nologin;
alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres;
alter default privileges in schema public grant all on functions to postgres;
`;

// How the release workflow's migrate mode runs a file (clued-cloud-production-release.yml):
// one plpgsql EXECUTE inside its own transaction, so transaction control or a
// trailing SELECT ... INTO fails here as it would there.
export const MIGRATE_MODE_SQL = `do $apply$ begin execute current_setting('clued.migration_text'); end $apply$`;

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

export async function withCluster(label, body) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, `clued-schema-${label}-`));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: createHash('sha256').update(directory).digest('hex'),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${String(message)}\n`); },
  });
  let client;
  try {
    await server.initialise();
    await server.start();
    client = server.getPgClient();
    await client.connect();
    await client.query(PLATFORM_SQL);
    return await body(client);
  } finally {
    await client?.end().catch(() => {});
    await server.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const failureMessage = (error) => `${error.message}${error.detail ? ` (detail: ${String(error.detail).slice(0, 2000)})` : ''}`;

async function applyPlain(client, step) {
  try {
    await client.query(step.text);
  } catch (error) {
    throw new Error(failureMessage(error), { cause: error });
  }
}

async function applyMigrateMode(client, step) {
  try {
    await client.query('begin');
    await client.query("select set_config('clued.migration_text', $1, true)", [step.text]);
    await client.query(MIGRATE_MODE_SQL);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw new Error(failureMessage(error), { cause: error });
  }
}

export async function readCatalog(client, sql) {
  const results = await client.query(sql);
  const last = Array.isArray(results) ? results.at(-1) : results;
  return last.rows[0].catalog;
}

const objectKey = ([kind, key]) => `${kind} ${key}`;

// An ACL that grants nothing to the compared roles is the same fact as no ACL
// row: a sequence whose grants were revoked keeps a non-null relacl holding
// only its owner, a never-granted one has relacl null.
const meaningful = ([kind, , value]) => !(kind === 'acl' && Array.isArray(value) && value.length === 0);

export function indexObjects(objects) {
  return new Map(objects.filter(meaningful).map((entry) => [objectKey(entry), JSON.stringify(entry[2])]));
}

// A known deviation names one exact fingerprint key ("<kind> <key>"; no
// wildcards) and says why production differs from its replay.
export function deviationMatcher(deviations = []) {
  const exact = new Set();
  for (const entry of deviations) {
    if (typeof entry?.key !== 'string' || !/^[a-z_]+ \S/.test(entry.key) || entry.key.includes('*') ||
        typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`known_deviation_invalid:${entry?.key}`);
    }
    exact.add(entry.key);
  }
  return Object.assign((key) => exact.has(key), { keys: exact });
}

// Differences between two fingerprints, as sorted key lists. A known
// deviation that matches no actual difference is stale and reported, so the
// list only ever names real, reviewed differences.
export function compareFingerprints(expected, actual, ignored = () => false) {
  const want = indexObjects(expected);
  const have = indexObjects(actual);
  const diff = { only_expected: [], only_actual: [], changed: [], ignored: 0, stale_deviations: [] };
  const used = new Set();
  for (const [key, value] of want) {
    const differs = !have.has(key) || have.get(key) !== value;
    if (ignored(key)) { if (differs) { diff.ignored += 1; used.add(key); } continue; }
    if (!have.has(key)) diff.only_expected.push(key);
    else if (have.get(key) !== value) diff.changed.push({ key, expected: JSON.parse(value), actual: JSON.parse(have.get(key)) });
  }
  for (const key of have.keys()) {
    if (want.has(key)) continue;
    if (ignored(key)) { diff.ignored += 1; used.add(key); continue; }
    diff.only_actual.push(key);
  }
  diff.stale_deviations = [...(ignored.keys ?? [])].filter((key) => !used.has(key)).sort();
  diff.only_expected.sort();
  diff.only_actual.sort();
  diff.changed.sort((a, b) => a.key.localeCompare(b.key));
  return diff;
}

// A replay-skip row must be data only: no statement that creates, changes or
// grants schema.
export const SCHEMA_STATEMENT = /\b(?:create|alter|drop|grant|revoke|comment\s+on|security\s+label|reassign|truncate)\b/i;

export const diffIsEmpty = (diff) => diff.only_expected.length === 0 && diff.only_actual.length === 0 && diff.changed.length === 0;

// Columns and functions the repository chain has and the production chain
// does not: what database tests can use and production cannot.
export function repositoryOnlyObjects(production, repository) {
  const have = indexObjects(production);
  return repository
    .filter(([kind]) => kind === 'column' || kind === 'function')
    .filter((entry) => !have.has(objectKey(entry)))
    .map(([kind, key]) => ({ kind, key }));
}

const ALLOW_PATTERN = /^\s*--\s*production-schema:\s*allow\s+(\S+)\s*$/gm;

const IDENT = '[a-z_][a-z0-9_]*';
const NOT_ALIASES = new Set(['where', 'on', 'set', 'join', 'left', 'right', 'inner', 'full', 'cross', 'using', 'returning',
  'values', 'select', 'and', 'or', 'order', 'group', 'limit', 'for', 'as', 'with', 'union', 'having', 'default', 'not',
  'is', 'in', 'then', 'else', 'end', 'loop', 'into', 'from', 'when', 'natural', 'lateral', 'only', 'window', 'offset']);

// Which relations each name stands for in one migration text: the relation's
// own name, plpgsql variables declared as a row of it ("b public.t;" or
// "b public.t%rowtype;") and FROM/JOIN/UPDATE/INTO aliases. A name bound to
// several relations in one file keeps all of them.
export function relationAliases(text, relations) {
  const known = new Map();
  for (const relation of relations) {
    const [schema, name] = relation.split('.');
    for (const spelling of [name, relation]) known.set(spelling, [...(known.get(spelling) ?? []), `${schema}.${name}`]);
  }
  const bound = new Map();
  const bind = (alias, spelling) => {
    if (NOT_ALIASES.has(alias)) return;
    for (const relation of known.get(spelling) ?? []) bound.set(alias, new Set([...(bound.get(alias) ?? []), relation]));
  };
  for (const spelling of known.keys()) bind(spelling, spelling);
  const name = `((?:${IDENT}\\.)?${IDENT})`;
  for (const match of text.matchAll(new RegExp(`\\b(${IDENT})\\s+${name}(?:%rowtype)?\\s*;`, 'g'))) bind(match[1], match[2]);
  for (const match of text.matchAll(new RegExp(`\\b(?:from|join|update|into)\\s+(?:only\\s+)?${name}\\s+(?:as\\s+)?(${IDENT})`, 'g'))) {
    bind(match[2], match[1]);
  }
  return bound;
}

// A pending migration that reads a column only the repository chain has,
// through the table or a name bound to it (`b.expires_at` after
// `b public.clued_agent_bindings;`), relies on schema production lacks: the
// function compiles in production and fails when it runs. That is exactly
// how 20261023092957_ci_scheduling_stage1_v1 shipped. A name also bound to a
// relation whose production column has that name is not a finding. Comments
// are ignored; `-- production-schema: allow <schema>.<table>.<column>` is the
// reviewed escape hatch. Repository-only functions are reported, not gated.
export function pendingReferenceFindings(pending, repositoryOnly, productionObjects) {
  const productionColumns = new Set(productionObjects.filter(([kind]) => kind === 'column').map(([, key]) => key));
  const relations = [...new Set([
    ...productionObjects.filter(([kind]) => kind === 'relation').map(([, key]) => key),
    ...repositoryOnly.filter((object) => object.kind === 'column').map((object) => object.key.split('.').slice(0, 2).join('.')),
  ])];
  const findings = [];
  for (const step of pending) {
    const allowed = new Set([...step.text.matchAll(ALLOW_PATTERN)].map((match) => match[1].toLowerCase()));
    const text = step.text.toLowerCase().replace(/--[^\n]*/g, ' ');
    const aliases = relationAliases(text, relations);
    for (const object of repositoryOnly) {
      if (object.kind !== 'column') continue;
      const [schema, table, column] = object.key.split('.');
      const relation = `${schema}.${table}`;
      if (allowed.has(object.key) || !text.includes(column)) continue;
      for (const [alias, targets] of aliases) {
        if (!targets.has(relation)) continue;
        const elsewhere = [...targets].some((other) => other !== relation && productionColumns.has(`${other}.${column}`));
        if (elsewhere) continue;
        const escaped = alias.replace('.', '\\.');
        const match = text.match(new RegExp(`(?<![a-z0-9_.])${escaped}\\.${column}\\b`));
        if (match) {
          findings.push({ file: step.file, ...object, via: alias,
            context: text.slice(Math.max(0, match.index - 60), match.index + 60).replace(/\s+/g, ' ').trim() });
          break;
        }
      }
    }
  }
  return findings;
}

// The steps as the replay runs them: data-only rows left out, substitutions
// applied (each must find its text exactly once). Snapshot rows and ledger
// rows newer than the snapshot go through the same lists.
export function prepareReplay(steps, { skipped, substitutions, errors }) {
  return steps.filter((candidate) => !skipped.has(candidate.file)).map((step) => {
    let text = step.text;
    for (const entry of substitutions.get(step.file) ?? []) {
      if (text.split(entry.find).length !== 2) errors.push(`snapshot_replay_substitution_not_unique:${step.file}`);
      else text = text.replace(entry.find, () => entry.replace);
    }
    return { ...step, text };
  });
}

export async function runCheck({ repository, snapshot, catalogSql, log = () => {} }) {
  const report = { contract: 'clued.production-schema-drift-report.v1', status: 'FAIL', errors: [] };
  if (snapshot?.contract !== SNAPSHOT_CONTRACT || !Array.isArray(snapshot.objects) || !Array.isArray(snapshot.applied)) {
    report.errors.push('snapshot_contract_invalid');
    return report;
  }
  if (snapshot.catalog_sql_sha256 !== createHash('sha256').update(catalogSql).digest('hex')) {
    report.errors.push('snapshot_catalog_sql_changed');
    return report;
  }
  report.snapshot = { captured_at: snapshot.captured_at, applied: snapshot.applied.length,
    applied_through: snapshot.applied.at(-1)?.version };
  const chain = productionChain({ applied: snapshot.applied, ...repository });
  report.errors.push(...chain.errors);
  report.pending = chain.pending.map((step) => step.file);
  if (chain.errors.length > 0) return report;
  let ignored;
  try {
    ignored = deviationMatcher(snapshot.known_deviations);
  } catch (error) {
    report.errors.push(error.message);
    return report;
  }

  const prehistory = [];
  for (const file of snapshot.prehistory ?? []) {
    const name = typeof file === 'string' && file.startsWith('migrations/') ? file.slice('migrations/'.length) : null;
    if (name === null || typeof repository.migrations[name] !== 'string') report.errors.push(`snapshot_prehistory_missing:${file}`);
    else prehistory.push({ file, text: repository.migrations[name] });
  }
  // Rows that only change data (a backfill guarded by production row counts)
  // cannot run on an empty database and change no schema; each is listed in
  // the snapshot with its reason, and a listed file production never ran is
  // an error so the list cannot go stale silently.
  const skipped = new Map();
  for (const entry of snapshot.replay_skip ?? []) {
    if (typeof entry?.file !== 'string' || typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      report.errors.push('snapshot_replay_skip_invalid');
    } else skipped.set(entry.file, entry.reason);
  }
  for (const file of skipped.keys()) {
    // Ledger rows newer than the snapshot (chain.ahead) use the same lists.
    const step = [...chain.applied, ...chain.ahead].find((candidate) => candidate.file === file);
    if (!step) report.errors.push(`snapshot_replay_skip_not_applied:${file}`);
    else if (SCHEMA_STATEMENT.test(step.text.replace(/--[^\n]*/g, ' '))) report.errors.push(`snapshot_replay_skip_not_data_only:${file}`);
  }
  // A replay substitution replaces one exact text, found exactly once, in one
  // applied row, where the row cannot run on an empty database but its schema
  // effect does not depend on the replacement (a value computed from
  // production rows, an extension the replay stands in for).
  const substitutions = new Map();
  for (const entry of snapshot.replay_substitutions ?? []) {
    if (typeof entry?.file !== 'string' || typeof entry?.find !== 'string' || entry.find === '' ||
        typeof entry?.replace !== 'string' || typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      report.errors.push('snapshot_replay_substitution_invalid');
    } else substitutions.set(entry.file, [...(substitutions.get(entry.file) ?? []), entry]);
  }
  const replayed = prepareReplay(chain.applied, { skipped, substitutions, errors: report.errors });
  const ahead = prepareReplay(chain.ahead, { skipped, substitutions, errors: report.errors });
  for (const file of substitutions.keys()) {
    if (![...chain.applied, ...chain.ahead].some((step) => step.file === file)) report.errors.push(`snapshot_replay_substitution_not_applied:${file}`);
  }
  if (report.errors.length > 0) return report;

  log(`production chain: replaying ${prehistory.length} prehistory files and ${replayed.length} applied rows (${skipped.size} data-only rows skipped)`);
  const productionAfter = await withCluster('production', async (client) => {
    for (const step of [...prehistory, ...replayed]) {
      try {
        await applyPlain(client, step);
      } catch (error) {
        report.errors.push(`production_chain_failed:${step.file}`);
        report.production_failure = { file: step.file, message: error.message };
        return null;
      }
    }
    const replay = (await readCatalog(client, catalogSql)).objects;
    report.drift = compareFingerprints(snapshot.objects, replay, ignored);
    if (!diffIsEmpty(report.drift)) report.errors.push('production_schema_drift');
    for (const key of report.drift.stale_deviations) report.errors.push(`known_deviation_stale:${key}`);
    // Ledger rows newer than the snapshot: production ran them after the
    // snapshot was taken, so they come after the comparison.
    report.ledger_ahead = chain.ahead.map((step) => step.file);
    if (ahead.length) log(`production chain: replaying ${ahead.length} ledger rows newer than the snapshot`);
    for (const step of ahead) {
      try {
        await applyPlain(client, step);
      } catch (error) {
        report.errors.push(`production_chain_failed:${step.file}`);
        report.production_failure = { file: step.file, message: error.message };
        return null;
      }
    }
    log(`production chain: applying ${chain.pending.length} pending migrations in migrate mode`);
    for (const step of chain.pending) {
      try {
        await applyMigrateMode(client, step);
      } catch (error) {
        report.errors.push(`pending_migration_failed:${step.file}`);
        report.pending_failure = { file: step.file, message: error.message };
        return null;
      }
    }
    return (await readCatalog(client, catalogSql)).objects;
  });

  log(`repository chain: applying ${Object.keys(repository.migrations).length} files in file-name order`);
  const repositoryAfter = await withCluster('repository', async (client) => {
    for (const step of repositoryChain(repository)) {
      try {
        await applyPlain(client, step);
      } catch (error) {
        report.errors.push(`repository_chain_failed:${step.file}`);
        report.repository_failure = { file: step.file, message: error.message };
        return null;
      }
    }
    return (await readCatalog(client, catalogSql)).objects;
  });

  // For each drift finding: does production match what the repository chain
  // builds? "yes" usually means production got a change outside its recorded
  // history that a repository file also makes; "no" means neither chain
  // explains production.
  if (repositoryAfter && report.drift) {
    const repositoryIndex = indexObjects(repositoryAfter);
    const productionIndex = indexObjects(snapshot.objects);
    const matches = (key) => repositoryIndex.get(key) === productionIndex.get(key);
    report.drift.repository_matches_production = [
      ...report.drift.only_expected, ...report.drift.only_actual, ...report.drift.changed.map((change) => change.key),
    ].filter(matches).sort();
  }
  if (productionAfter && repositoryAfter) {
    report.repository_only = repositoryOnlyObjects(productionAfter, repositoryAfter);
    report.pending_references = pendingReferenceFindings(chain.pending, report.repository_only, productionAfter);
    if (report.pending_references.length > 0) report.errors.push('pending_migration_uses_repository_only_schema');
  }
  report.errors = [...new Set(report.errors)];
  report.status = report.errors.length === 0 ? 'PASS' : 'FAIL';
  return report;
}

// Snapshot from the two read-only query results. Both files hold the single
// row the query returns ({"catalog": ...} and {"applied": ...}), or the bare
// value. The previous snapshot's known_deviations are kept: they are reviewed
// statements, not data, and each refresh PR shows whether they still apply.
export function buildSnapshot({ catalog, applied, catalogSql, capturedAt, previous }) {
  const catalogValue = catalog?.catalog ?? catalog;
  const appliedValue = applied?.applied ?? applied;
  if (!Array.isArray(catalogValue?.objects) || !Array.isArray(appliedValue)) throw new Error('import_input_invalid');
  return {
    contract: SNAPSHOT_CONTRACT,
    database_project: 'clued-prod',
    captured_at: capturedAt,
    catalog_sql_sha256: createHash('sha256').update(catalogSql).digest('hex'),
    schemas: catalogValue.schemas,
    prehistory: previous?.prehistory ?? [],
    replay_skip: previous?.replay_skip ?? [],
    replay_substitutions: previous?.replay_substitutions ?? [],
    known_deviations: previous?.known_deviations ?? [],
    applied: appliedValue.map(({ version, name, statements_md5, statements_length }) => ({ version, name, statements_md5, statements_length })),
    objects: catalogValue.objects,
  };
}

// One object per line keeps refresh diffs reviewable.
export function serializeSnapshot(snapshot) {
  const { applied, objects, ...head } = snapshot;
  const lines = (items) => items.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  const headText = JSON.stringify(head, null, 2).slice(0, -2);
  return `${headText},\n  "applied": [\n${lines(applied)}\n  ],\n  "objects": [\n${lines(objects)}\n  ]\n}\n`;
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv) {
  const [command, ...args] = argv;
  const catalogSql = await readFile(catalogSqlPath, 'utf8');
  if (command === 'import') {
    const catalogFile = argument(args, '--catalog');
    const appliedFile = argument(args, '--applied');
    if (!catalogFile || !appliedFile) throw new Error('usage: import --catalog <file> --applied <file>');
    const previous = await readSnapshot().catch(() => null);
    const snapshot = buildSnapshot({
      catalog: JSON.parse(await readFile(catalogFile, 'utf8')),
      applied: JSON.parse(await readFile(appliedFile, 'utf8')),
      catalogSql, capturedAt: argument(args, '--captured-at') ?? new Date().toISOString(), previous,
    });
    await writeFile(snapshotPath, serializeSnapshot(snapshot));
    console.log(`wrote ${path.relative(process.cwd(), snapshotPath)}: ${snapshot.applied.length} applied rows, ${snapshot.objects.length} objects`);
    return 0;
  }
  if (command !== 'check') {
    console.error('usage: node scripts/production-schema-drift.mjs <check [--report <file>]|import --catalog <file> --applied <file>>');
    return 2;
  }
  const report = await runCheck({
    repository: await readRepository(), snapshot: await readSnapshot(), catalogSql,
    log: (line) => console.error(`production-schema: ${line}`),
  });
  const reportFile = argument(args, '--report');
  if (reportFile) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);
  return report.status === 'PASS' ? 0 : 1;
}

export function printSummary(report, write = (line) => console.log(line)) {
  write(`production-schema drift: ${report.status}`);
  if (report.snapshot) write(`snapshot: ${report.snapshot.applied} applied rows through ${report.snapshot.applied_through}, captured ${report.snapshot.captured_at}`);
  if (report.ledger_ahead?.length) write(`ledger rows newer than the snapshot, replayed after the comparison (${report.ledger_ahead.length}): ${report.ledger_ahead.join(', ')}; refresh the snapshot`);
  if (report.pending) write(`pending migrations (${report.pending.length}): ${report.pending.join(', ') || 'none'}`);
  for (const error of report.errors) write(`error: ${error}`);
  const drift = report.drift;
  if (drift) {
    for (const key of drift.only_expected.slice(0, 50)) write(`drift: only in production: ${key}`);
    for (const key of drift.only_actual.slice(0, 50)) write(`drift: only in the replay: ${key}`);
    for (const change of drift.changed.slice(0, 50)) write(`drift: differs: ${change.key} production=${JSON.stringify(change.expected)} replay=${JSON.stringify(change.actual)}`);
  }
  if (report.production_failure) write(`production chain failed: ${report.production_failure.file}: ${report.production_failure.message}`);
  if (report.pending_failure) write(`pending migration failed: ${report.pending_failure.file}: ${report.pending_failure.message}`);
  if (report.repository_failure) write(`repository chain failed: ${report.repository_failure.file}: ${report.repository_failure.message}`);
  for (const finding of report.pending_references ?? []) {
    write(`pending migration ${finding.file} reads ${finding.key} through "${finding.via}" (${finding.context}); only the repository chain has that column, production lacks it`);
  }
  if (report.repository_only) write(`repository-only columns and functions (tests see them, production does not): ${report.repository_only.length}`);
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`production-schema: ${error.message}`);
    process.exitCode = 1;
  }
}
