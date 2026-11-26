import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { checkDatabaseMaintenance } from './database-io-maintenance-db.case.mjs';
import { checkWorkerDue } from './worker-due-db.case.mjs';

// Database permission hygiene, P0-4 (migration 20261007120000, Clued Task 9a4d6d2c, Owner Decision
// eed7154f; docs/maintenance/database-security.md). Two databases on one server: "plain" is what
// CI's db reset builds; "prodlike" first adds what only production has (postgres's default
// privileges in public, schema mtpe_m0 and the mtpe_m0_*_digest helpers). The migration must change
// exactly the privileges below and nothing else, keep every RPC the Worker and the app call
// executable by the role that calls it, and apply a second time through plpgsql EXECUTE (the
// production release workflow) without any change.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261007120000_db_security_hygiene.sql';

// public, anon and authenticated lose EXECUTE: no caller uses these.
const FULL_REVOKE = [
  'public.clued_development_oauth_call_v14(jsonb)',
  'public.clued_authorization_revoke_self_v12(text)',
  'public.clued_canonical_export(text, jsonb)',
  'public.clued_project_list(text, jsonb)',
  'public.clued_user_project_list(jsonb)',
];
const PROD_ONLY_FULL_REVOKE = ['public.mtpe_m0_structure_digest()', 'public.mtpe_m0_grants_digest()'];
// PUBLIC loses EXECUTE.
const PUBLIC_REVOKE = ['clued_private.legacy_inventory_complete(uuid)'];
const PROD_ONLY_PUBLIC_REVOKE = ['mtpe_m0.guard_condition6_d3_change()'];
// authenticated loses EXECUTE, anon keeps it: the Worker calls these as anon with a token hash.
const AUTHENTICATED_REVOKE = [
  'public.clued_integration_request_open_v1(text, jsonb)',
  'public.clued_integration_create_or_bind_v1(text, jsonb)',
  'public.clued_integration_identity_update_v1(text, jsonb)',
  'public.clued_integration_reconcile_request_v1(text, jsonb)',
  'public.clued_integration_status_v1(text, jsonb)',
  'public.clued_integration_declare_v1(text, jsonb)',
  'public.clued_integration_report_v1(text, jsonb)',
  'public.clued_integration_verify_v1(text, jsonb)',
  'public.clued_integration_revoke_self_v1(text, jsonb)',
  'public.clued_authorization_revoke_issuer_v12(text, uuid)',
  'public.clued_authorization_status_v12(text)',
  'public.clued_development_call_v14(text, jsonb)',
  'public.clued_mcp_audit_receipts(text, jsonb)',
  'public.clued_mcp_search_context(text, jsonb)',
];
// Kept although production does not use them: tests and SQL tests on a migrated database call them
// (docs/maintenance/database-security.md, "Kept").
const KEPT = {
  anon: ['public.clued_project_mutate(text, jsonb)', 'public.clued_storage_jobs_v2(text, jsonb)'],
  authenticated: ['public.clued_storage_recovery_oauth_start_v1(text, jsonb)',
    'public.clued_user_canonical_export(jsonb, text)', 'public.clued_user_project_mutate(jsonb, text)',
    'public.clued_work_claim_exemption_confirmation_issue_v1(jsonb)',
    'public.clued_work_claim_exemption_grant_v1(jsonb)'],
};
const API_ROLES = ['anon', 'authenticated'];

const hash = () => crypto.randomBytes(32).toString('hex');
const minus = (list, removed) => list.filter((entry) => !removed.includes(entry));


async function sourceFiles(directory, pattern) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'generated' && entry.name !== 'node_modules') files.push(...await sourceFiles(file, pattern));
    } else if (pattern.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

async function readSources(directory, pattern) {
  const files = await sourceFiles(path.join(root, directory), pattern);
  return (await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).join('\n');
}

// RPC names a source tree names: exact string literals, /rest/v1/rpc/<name> paths and the values of
// the *RpcByTool maps, minus MCP tool names (a tool name is not an RPC; clued_project_list the tool
// maps to clued_project_list_v2 the RPC).
function rpcNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/(["'`])(clued_[a-z0-9_]+)\1/g)) names.add(match[2]);
  for (const match of source.matchAll(/\bname:\s*["'](clued_[a-z0-9_]+)["']/g)) names.delete(match[1]);
  for (const match of source.matchAll(/\/rest\/v1\/rpc\/(clued_[a-z0-9_]+)/g)) names.add(match[1]);
  for (const block of source.matchAll(/[rR]pcByTool = \{([^}]*)\}/g)) {
    for (const match of block[1].matchAll(/:\s*["'](clued_[a-z0-9_]+)["']/g)) names.add(match[1]);
  }
  return names;
}

const SNAPSHOT = `select jsonb_build_object(
  'functions', (select jsonb_object_agg(n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
      (select coalesce(jsonb_agg(distinct g order by g), '[]'::jsonb) from (
        select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end g
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE') x))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'),
  'config', (select jsonb_object_agg(n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
      coalesce(p.proconfig::text, ''))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'),
  'relations', (select jsonb_object_agg(n.nspname || '.' || c.relname,
      (select coalesce(jsonb_agg(distinct g order by g), '[]'::jsonb) from (
        select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ':' || a.privilege_type g
          from aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a) x))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'),
  'public_relations', (select coalesce(jsonb_agg(n.nspname || '.' || c.relname order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')),
  'default_acl', (select coalesce(jsonb_object_agg(pg_get_userbyid(d.defaclrole) || '/' ||
      coalesce(d.defaclnamespace::regnamespace::text, '*') || '/' || d.defaclobjtype::text,
      (select coalesce(jsonb_agg(distinct g order by g), '[]'::jsonb) from (
        select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ':' || a.privilege_type g
          from aclexplode(d.defaclacl) a) x)), '{}'::jsonb)
    from pg_default_acl d)) s`;

test('database permission hygiene: exact privilege changes, Worker RPCs stay callable, idempotent',
  { timeout: 600000 }, async (t) => {
  // Migrations create cluster-wide roles, so each database gets its own server.
  const servers = [];
  const clients = [];
  const startDatabase = async (label) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `clued-db-security-hygiene-${label}-`));
    const server = newCluster({
      databaseDir: directory, user: 'postgres', password: hash(), 
      persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
      onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
    });
    servers.push({ server, directory });
    await startCluster(server);
    const db = server.getPgClient();
    clients.push(db);
    await db.connect();
    await bootstrap(db);
    return db;
  };
  const bootstrap = async (db) => db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
  try {
    const migrationText = await fs.readFile(path.join(root, 'supabase/migrations', MIGRATION), 'utf8');
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(MIGRATION));
    // Everything before the hygiene migration; later migrations are not part of what it changes.
    const earlier = migrations.filter((name) => name < MIGRATION);

    const apply = async (db, names) => {
      for (const name of names) {
        try { await db.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
        catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
      }
    };
    // The release workflow runs a migration as one string through plpgsql EXECUTE.
    const applyThroughExecute = async (db) => {
      await db.query(`create or replace function pg_temp.hygiene_apply(s text) returns void language plpgsql
        as $apply$ begin execute s; end $apply$`);
      await db.query('select pg_temp.hygiene_apply($1)', [migrationText]);
    };
    const snapshot = async (db) => (await db.query(SNAPSHOT)).rows[0].s;
    const canExecute = async (db, role, signature) =>
      (await db.query("select has_function_privilege($1, $2::regprocedure, 'execute') ok", [role, signature])).rows[0].ok;

    // ---- plain: what CI builds -----------------------------------------------------------------
    const plain = await startDatabase('plain');
    const versionNumber = Number((await plain.query("select current_setting('server_version_num') v")).rows[0].v);
    const tablePrivileges = ['TRUNCATE', 'REFERENCES', 'TRIGGER', ...(versionNumber >= 170000 ? ['MAINTAIN'] : [])];
    await apply(plain, earlier);
    const plainBefore = await snapshot(plain);
    await apply(plain, [MIGRATION]);
    const plainAfter = await snapshot(plain);

    // ---- prodlike: production's default privileges and production-only objects ---------------
    const prod = await startDatabase('prodlike');
    // clued-prod pg_default_acl, postgres in public, tables: anon, authenticated and service_role
    // hold TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on every table postgres creates there.
    await prod.query(`alter default privileges for role postgres in schema public
      grant ${tablePrivileges.join(', ')} on tables to anon, authenticated, service_role`);
    await apply(prod, earlier);
    // History-only production objects, created with the default (PUBLIC) EXECUTE as in production.
    await prod.query(`create schema mtpe_m0;
      create function mtpe_m0.guard_condition6_d3_change() returns trigger language plpgsql
        set search_path = pg_catalog, mtpe_m0 as $f$ begin return null; end $f$;
      create function public.mtpe_m0_structure_digest() returns text language sql stable as $f$
        select encode(sha256(convert_to(string_agg(n.nspname, e'\\n' order by n.nspname collate "C"), 'UTF8')), 'hex')
        from pg_namespace n where n.nspname in ('mtpe_m0', 'mtpe_m0_test') $f$;
      create function public.mtpe_m0_grants_digest() returns text language sql stable as $f$
        select encode(sha256(convert_to(coalesce(string_agg(table_name, e'\\n' order by table_name collate "C"), ''), 'UTF8')), 'hex')
        from information_schema.role_table_grants where table_schema in ('mtpe_m0', 'mtpe_m0_test') $f$;`);
    const prodBefore = await snapshot(prod);
    await applyThroughExecute(prod);
    const prodAfter = await snapshot(prod);

    await t.test('the migration text satisfies the release workflow apply step', () => {
      assert.ok(migrationText.endsWith('\n'), 'ends with a newline');
      assert.doesNotMatch(migrationText, /[\r\x01\x02]/, 'no carriage return, \\x01 or \\x02');
      assert.ok(!migrationText.split('\n').includes('\\.'), 'no line that is only \\.');
      const code = migrationText.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
      assert.doesNotMatch(code, /^\s*(begin|commit|rollback|savepoint|release|start\s+transaction|end)(\s+(work|transaction))?\s*;/im,
        'no transaction control');
      assert.doesNotMatch(code, /\bselect\b[^;]*\binto\b/i, 'no SELECT ... INTO');
    });

    const expectFunctions = (before, after, { prodOnly }) => {
      const full = [...FULL_REVOKE, ...(prodOnly ? PROD_ONLY_FULL_REVOKE : [])];
      const publicOnly = [...PUBLIC_REVOKE, ...(prodOnly ? PROD_ONLY_PUBLIC_REVOKE : [])];
      for (const signature of [...full, ...publicOnly, ...AUTHENTICATED_REVOKE]) {
        assert.ok(signature in before.functions, `${signature} exists before the migration`);
      }
      for (const signature of full) {
        assert.ok(before.functions[signature].some((grantee) => ['PUBLIC', ...API_ROLES].includes(grantee)),
          `${signature} was executable by an API role`);
      }
      for (const signature of publicOnly) assert.ok(before.functions[signature].includes('PUBLIC'), `${signature} had PUBLIC`);
      for (const signature of AUTHENTICATED_REVOKE) {
        assert.ok(before.functions[signature].includes('anon') && before.functions[signature].includes('authenticated'),
          `${signature} had anon and authenticated`);
      }
      assert.deepEqual(Object.keys(after.functions).sort(), Object.keys(before.functions).sort(), 'no function added or dropped');
      for (const [signature, grantees] of Object.entries(before.functions)) {
        const expected = full.includes(signature) ? minus(grantees, ['PUBLIC', ...API_ROLES])
          : publicOnly.includes(signature) ? minus(grantees, ['PUBLIC'])
            : AUTHENTICATED_REVOKE.includes(signature) ? minus(grantees, ['authenticated'])
              : grantees;
        assert.deepEqual(after.functions[signature], expected, `EXECUTE on ${signature}`);
      }
      const pinned = ['clued_private.authorization_scope_union_v12(jsonb)', ...(prodOnly ? PROD_ONLY_FULL_REVOKE : [])];
      for (const [signature, config] of Object.entries(before.config)) {
        assert.equal(after.config[signature], pinned.includes(signature) ? '{"search_path=\\"\\""}' : config, `config of ${signature}`);
      }
    };

    const expectRelations = (before, after) => {
      const removed = API_ROLES.flatMap((role) => tablePrivileges.map((privilege) => `${role}:${privilege}`));
      assert.deepEqual(Object.keys(after.relations).sort(), Object.keys(before.relations).sort(), 'no relation added or dropped');
      for (const [relation, entries] of Object.entries(before.relations)) {
        assert.deepEqual(after.relations[relation], before.public_relations.includes(relation) ? minus(entries, removed) : entries,
          `privileges on ${relation}`);
      }
      const key = 'postgres/public/r';
      for (const [entry, privileges] of Object.entries(before.default_acl)) {
        if (entry === key) continue;
        assert.deepEqual(after.default_acl[entry], privileges, `default privileges ${entry}`);
      }
      const remaining = minus(before.default_acl[key] ?? [], removed);
      assert.deepEqual(after.default_acl[key] ?? [], remaining, `default privileges ${key}`);
    };

    await t.test('plain database: only the listed EXECUTE grants, the search_path and table privileges change', () => {
      for (const signature of [...PROD_ONLY_FULL_REVOKE, ...PROD_ONLY_PUBLIC_REVOKE]) {
        assert.equal(signature in plainAfter.functions, false, `${signature} exists only in production`);
      }
      expectFunctions(plainBefore, plainAfter, { prodOnly: false });
      expectRelations(plainBefore, plainAfter);
    });

    await t.test('production-like database: production-only objects and default privileges are covered too', () => {
      expectFunctions(prodBefore, prodAfter, { prodOnly: true });
      expectRelations(prodBefore, prodAfter);
      // the emulation reached the migrated tables, and service_role is left as it was
      assert.ok(prodBefore.relations['public.clued_context_events'].includes('anon:TRUNCATE'));
      for (const privilege of tablePrivileges) {
        assert.ok(prodAfter.relations['public.clued_context_events'].includes(`service_role:${privilege}`), privilege);
      }
      assert.deepEqual(prodAfter.default_acl['postgres/public/r'].filter((entry) => !entry.startsWith('postgres:')),
        tablePrivileges.map((privilege) => `service_role:${privilege}`).sort());
    });

    await t.test('API roles cannot execute the revoked functions or use the revoked table privileges', async () => {
      for (const [db, prodOnly] of [[plain, false], [prod, true]]) {
        for (const signature of [...FULL_REVOKE, ...PUBLIC_REVOKE,
          ...(prodOnly ? [...PROD_ONLY_FULL_REVOKE, ...PROD_ONLY_PUBLIC_REVOKE] : [])]) {
          for (const role of API_ROLES) assert.equal(await canExecute(db, role, signature), false, `${role} ${signature}`);
        }
        for (const signature of AUTHENTICATED_REVOKE) {
          assert.equal(await canExecute(db, 'anon', signature), true, `anon keeps ${signature}`);
          assert.equal(await canExecute(db, 'authenticated', signature), false, `authenticated ${signature}`);
        }
        for (const signature of KEPT.anon) assert.equal(await canExecute(db, 'anon', signature), true, `anon keeps ${signature}`);
        for (const signature of KEPT.authenticated) {
          assert.equal(await canExecute(db, 'authenticated', signature), true, `authenticated keeps ${signature}`);
        }
        const { rows } = await db.query(`select c.oid::regclass::text relation, r.rolname, p.privilege
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          cross join unnest($1::text[]) r(rolname) cross join unnest($2::text[]) p(privilege)
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
            and has_table_privilege(r.rolname, c.oid, p.privilege)`, [API_ROLES, tablePrivileges]);
        assert.deepEqual(rows, []);
        // RLS-governed access is untouched: the owner policies still need SELECT on these tables.
        assert.equal((await db.query("select has_table_privilege('authenticated', 'public.clued_context_events', 'select') ok")).rows[0].ok, true);
      }
    });

    await t.test('every RPC the Worker or the app names stays executable by the role that calls it', async () => {
      const worker = rpcNames(await readSources('worker', /\.ts$/));
      const app = rpcNames(await readSources('app', /\.(ts|tsx)$/));
      const bare = (signature) => signature.replace(/^public\./, '').replace(/\(.*$/, '');
      for (const signature of [...FULL_REVOKE, ...PROD_ONLY_FULL_REVOKE]) {
        assert.equal(worker.has(bare(signature)), false, `the Worker calls ${signature}`);
        assert.equal(app.has(bare(signature)), false, `the app calls ${signature}`);
      }
      for (const signature of AUTHENTICATED_REVOKE) {
        assert.ok(worker.has(bare(signature)), `the Worker calls ${signature} as anon`);
        assert.equal(app.has(bare(signature)), false, `the app calls ${signature}`);
      }
      const overloads = (name) => Object.keys(prodBefore.functions).filter((signature) => signature.startsWith(`public.${name}(`));
      const checked = new Set();
      // The Worker calls Binding RPCs as anon and account RPCs with the user's session (authenticated);
      // the app calls RPCs with the user's session. Item 3 deliberately ends authenticated on its list.
      for (const [names, role, except] of [[worker, 'anon', []], [worker, 'authenticated', AUTHENTICATED_REVOKE],
        [app, 'authenticated', []]]) {
        for (const name of names) {
          for (const signature of minus(overloads(name), except)) {
            if (!prodBefore.functions[signature].includes(role) && !prodBefore.functions[signature].includes('PUBLIC')) continue;
            checked.add(signature);
            for (const db of [plain, prod]) assert.equal(await canExecute(db, role, signature), true, `${role} ${signature}`);
          }
        }
      }
      // 133 on 2026-10-07: a much smaller number means the source scan stopped finding the RPCs.
      assert.ok(checked.size >= 120, `checked ${checked.size} Worker and app RPCs`);
    });

    await t.test('pinned search_path: the functions still work', async () => {
      const union = (await prod.query(`select clued_private.authorization_scope_union_v12(
        '[{"actions":["write","read"]},{"actions":["audit","read"]}]'::jsonb) v`)).rows[0].v;
      assert.deepEqual(union, ['audit:read', 'context:read', 'context:write']);
      for (const signature of PROD_ONLY_FULL_REVOKE) {
        assert.match((await prod.query(`select ${signature.replace(/\(\)$/, '')}() v`)).rows[0].v, /^[0-9a-f]{64}$/);
      }
    });

    await t.test('a second application through either path changes nothing', async () => {
      await applyThroughExecute(plain);
      assert.deepEqual(await snapshot(plain), plainAfter);
      await apply(prod, [MIGRATION]);
      assert.deepEqual(await snapshot(prod), prodAfter);
    });

    // Reuse the local server with an isolated database for the retention and index fixtures.
    await plain.query('create database io_maintenance');
    const maintenance = servers[0].server.getPgClient('io_maintenance');
    clients.push(maintenance);
    await maintenance.connect();
    await checkDatabaseMaintenance(t, maintenance);
    await apply(plain, migrations.filter(name => name > MIGRATION));
    await checkWorkerDue(t, plain);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    for (const { server, directory } of servers) {
      await stopCluster(server);
      await removeTestDirectory(directory).catch(() => {});
    }
  }
});
