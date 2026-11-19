import { stopCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

// Release door v1 in the production release workflow (FABLE-release-identity-
// autonomous-20261119 §1.2, §2 and §3.1 tests 8 to 12). The workflow's own
// bash steps run unchanged against a throwaway database: `docker` on PATH hands
// `postgres:17-alpine psql ...` to release-door-psql-fixture.mjs, because the
// embedded package has no psql binary.
//
// The door here is a stand-in with the agreed signature,
// clued_private.release_door_v1(p_input jsonb) returns jsonb, and the agreed
// answers ({status, consumed, grant} or {status, consumed: false,
// owner_request}; probe and request_only). The real door is PR-A's install
// migration; these tests prove what the workflow does around any door.

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '../..');
const workflow = (await fs.readFile(path.join(repoRoot, '.github/workflows/clued-cloud-production-release.yml'), 'utf8'))
  .replace(/\r\n?/g, '\n');
const psqlFixture = fileURLToPath(new URL('./release-door-psql-fixture.mjs', import.meta.url)).split(path.sep).join('/');
const REPOSITORY = 'tdoljyj/cross-memory-system';
const SHA = 'c'.repeat(40);
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

const steps = workflow.split(/\n      - /).slice(1);
function stepScript(name) {
  const step = steps.find((s) => s.startsWith(`name: ${name}\n`));
  assert.ok(step, `workflow step ${name}`);
  const body = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length);
  return body.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
}

const DOOR_INSTALL = `create schema if not exists clued_private;
create table clued_private.release_door_fixture_settings(auto_approve boolean not null);
insert into clued_private.release_door_fixture_settings values (true);
create table clued_private.release_door_fixture_grants(grant_id uuid primary key default gen_random_uuid(),
  action text not null, resources jsonb not null, uses integer not null default 0, max_uses integer not null);
create table clued_private.release_door_fixture_requests(request_id uuid primary key default gen_random_uuid(),
  action text not null, resources jsonb not null);
create table clued_private.release_door_fixture_receipts(n bigserial primary key, grant_id uuid not null, input jsonb not null);
create function clued_private.release_door_v1(p_input jsonb) returns jsonb language plpgsql as $door$
declare
  v_grant clued_private.release_door_fixture_grants;
  v_request uuid;
begin
  if coalesce((p_input->>'probe')::boolean, false) then
    return jsonb_build_object('status', 'ok', 'probe', true);
  end if;
  if jsonb_typeof(p_input->'resources') is distinct from 'array' or p_input->>'action' is null then
    raise exception 'release_door_input_invalid';
  end if;
  if not coalesce((p_input->>'request_only')::boolean, false) then
    if (select auto_approve from clued_private.release_door_fixture_settings) then
      insert into clued_private.release_door_fixture_grants(action, resources, max_uses)
        values (p_input->>'action', p_input->'resources', 1) returning * into v_grant;
    else
      select * into v_grant from clued_private.release_door_fixture_grants
        where action = p_input->>'action' and resources = p_input->'resources' and uses < max_uses
        order by grant_id limit 1 for update;
    end if;
    if v_grant.grant_id is not null then
      update clued_private.release_door_fixture_grants set uses = uses + 1 where grant_id = v_grant.grant_id;
      insert into clued_private.release_door_fixture_receipts(grant_id, input) values (v_grant.grant_id, p_input);
      return jsonb_build_object('status', 'ok', 'consumed', true,
        'grant', jsonb_build_object('grant_id', v_grant.grant_id, 'use', v_grant.uses + 1, 'max_uses', v_grant.max_uses));
    end if;
  end if;
  select request_id into v_request from clued_private.release_door_fixture_requests
    where action = p_input->>'action' and resources = p_input->'resources';
  if v_request is null then
    insert into clued_private.release_door_fixture_requests(action, resources)
      values (p_input->>'action', p_input->'resources') returning request_id into v_request;
  end if;
  return jsonb_build_object('status', 'ok', 'consumed', false, 'owner_request', jsonb_build_object(
    'request_id', v_request, 'status', 'pending', 'confirm_path', '/confirm/' || v_request));
end
$door$;
`;
const INSTALL = '20990101000000_fixture_release_door.sql';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('release door v1: the release workflow consumes, probes and boots the door inside the migration transaction',
  { timeout: 600000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-release-door-flow-'));
    const password = crypto.randomBytes(16).toString('hex');
    const port = await freePort();
    const server = new EmbeddedPostgres({ databaseDir: path.join(directory, 'db'), user: 'postgres', password, port,
      persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
    const clients = [];
    try {
      await server.initialise();
      await server.start();
      const admin = server.getPgClient();
      clients.push(admin);
      await admin.connect();

      // A fake `docker` whose only image is the workflow's psql.
      const bin = path.join(directory, 'bin');
      await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, 'docker'), '#!/usr/bin/env bash\n' +
        'while [ "$#" -gt 0 ] && [ "$1" != postgres:17-alpine ]; do shift; done\n' +
        '[ "$#" -ge 2 ] && [ "$2" = psql ] || { echo "docker stand-in: only postgres:17-alpine psql" >&2; exit 97; }\n' +
        `shift 2\nexec node "${psqlFixture}" "$@"\n`, { mode: 0o755 });

      let databases = 0;
      // One database and one checkout per case: migrations under
      // apps/clued-cloud/supabase/migrations, the grant script under scripts/ci.
      async function fresh({ door = false, autoApprove = true } = {}) {
        const name = `flow_${++databases}`;
        await admin.query(`create database ${name}`);
        const db = new pg.Client({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/${name}` });
        clients.push(db);
        await db.connect();
        await db.query('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[])');
        if (door) {
          await db.query(DOOR_INSTALL);
          await db.query('update clued_private.release_door_fixture_settings set auto_approve = $1', [autoApprove]);
        }
        const checkout = path.join(directory, name);
        const migrations = path.join(checkout, 'apps/clued-cloud/supabase/migrations');
        await fs.mkdir(migrations, { recursive: true });
        await fs.mkdir(path.join(checkout, 'scripts/ci'), { recursive: true });
        await fs.copyFile(path.join(repoRoot, 'scripts/ci/clued-release-grant.mjs'), path.join(checkout, 'scripts/ci/clued-release-grant.mjs'));
        const summary = path.join(checkout, 'summary.md');
        const write = (file, text) => fs.writeFile(path.join(migrations, file), text);
        const run = (stepName, cwd, env) => {
          const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|node_options|github_.*|clued_.*|release_.*|migrations)$/i.test(key)));
          const result = spawnSync('bash', ['-c', stepScript(stepName)], { cwd, encoding: 'utf8', env: { ...base,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
            CLUED_MIGRATION_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/${name}`,
            CLUED_CONFIRM_ORIGIN: 'https://kooyumi.pixelgrav.com', GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: SHA,
            GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: summary, ...env } });
          return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
        };
        const migrate = (files, { installMd5 = '0'.repeat(32) } = {}) => run('Apply the named migrations',
          path.join(checkout, 'apps/clued-cloud'), { MIGRATIONS: files.join(','), RELEASE_DOOR_INSTALL_MD5: installMd5 });
        const deploy = () => run('Consume the Owner Grant for this commit', checkout, {});
        const value = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0];
        const ledger = () => value('select count(*)::int from supabase_migrations.schema_migrations');
        const doorExists = () => value("select to_regprocedure('clued_private.release_door_v1(jsonb)') is not null");
        const receipts = () => value('select count(*)::int from clued_private.release_door_fixture_receipts');
        return { db, write, migrate, deploy, value, ledger, doorExists, receipts, summary };
      }
      const resource = (file) => `repo:${REPOSITORY}/${SHA}/apps/clued-cloud/supabase/migrations/${file}`;

      await t.test('8: bootstrap: only the pinned install migration may run before the door exists, and it consumes in its own transaction', async () => {
        // md5 matches: the install migration commits together with its consumed grant.
        let c = await fresh();
        await c.write(INSTALL, DOOR_INSTALL);
        let r = c.migrate([INSTALL], { installMd5: md5(DOOR_INSTALL) });
        assert.equal(r.status, 0, r.out);
        assert.equal(await c.doorExists(), true);
        assert.equal(await c.ledger(), 1);
        assert.equal(await c.receipts(), 1, 'the install migration consumed a grant before it committed');
        const receipt = await c.value('select input from clued_private.release_door_fixture_receipts');
        assert.equal(receipt.action, 'migration.production');
        assert.deepEqual(receipt.resources, [resource(INSTALL)]);
        assert.deepEqual(receipt.with, [{ action: 'release.production', resources: [`repo:${REPOSITORY}/${SHA}`] }]);
        assert.match(await fs.readFile(c.summary, 'utf8'), /已消费授权/);

        // md5 differs: nothing runs, the database is unchanged.
        c = await fresh();
        await c.write(INSTALL, DOOR_INSTALL);
        r = c.migrate([INSTALL], { installMd5: md5('something else\n') });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /发布门/);
        assert.deepEqual([await c.doorExists(), await c.ledger()], [false, 0]);

        // Another file while the pin names the install migration: refused, unchanged.
        c = await fresh();
        await c.write(INSTALL, DOOR_INSTALL);
        await c.write('20990101000001_other.sql', 'create table bootstrap_other(x int);\n');
        r = c.migrate(['20990101000001_other.sql', INSTALL], { installMd5: md5(DOOR_INSTALL) });
        assert.notEqual(r.status, 0, r.out);
        assert.deepEqual([await c.doorExists(), await c.ledger(), await c.value("select to_regclass('bootstrap_other') is null")], [false, 0, true]);

        // The pinned text runs but leaves no door: rolled back.
        c = await fresh();
        const hollow = 'create table hollow_install(x int);\n';
        await c.write('20990101000002_hollow.sql', hollow);
        r = c.migrate(['20990101000002_hollow.sql'], { installMd5: md5(hollow) });
        assert.notEqual(r.status, 0, r.out);
        assert.deepEqual([await c.ledger(), await c.value("select to_regclass('hollow_install') is null")], [0, true]);
      });

      await t.test('9: no grant and auto-approval off: the first migration rolls back and leaves one pending request with its link', async () => {
        const c = await fresh({ door: true, autoApprove: false });
        const file = '20990102000000_add_table.sql';
        await c.write(file, 'create table pending_table(x int);\n');
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const r = c.migrate([file]);
          assert.notEqual(r.status, 0, r.out);
          assert.match(r.out, /https:\/\/kooyumi\.pixelgrav\.com\/confirm\/[0-9a-f-]{36}/);
          assert.deepEqual([await c.ledger(), await c.value("select to_regclass('pending_table') is null"), await c.receipts()], [0, true, 0]);
          assert.equal(await c.value('select count(*)::int from clued_private.release_door_fixture_requests'), 1, `attempt ${attempt} reuses one request`);
        }
        assert.deepEqual(await c.value('select resources from clued_private.release_door_fixture_requests'), [resource(file)]);
      });

      await t.test('10: a migration that breaks the door cannot commit', async () => {
        const c = await fresh({ door: true });
        for (const [file, text] of [['20990103000000_drop_door.sql', 'drop function clued_private.release_door_v1(jsonb);\n'],
          ['20990103000001_hollow_door.sql', "create or replace function clued_private.release_door_v1(p_input jsonb) returns jsonb language sql as $$ select '{\"status\": \"broken\"}'::jsonb $$;\n"]]) {
          await c.write(file, text);
          const r = c.migrate([file]);
          assert.notEqual(r.status, 0, r.out);
          assert.equal(await c.doorExists(), true);
          assert.equal(await c.ledger(), 0);
          assert.equal(await c.receipts(), 0, 'its grant consumption rolled back with it');
          assert.equal(await c.value("select clued_private.release_door_v1('{\"probe\": true}')->>'status'"), 'ok');
        }
      });

      await t.test('11: a first migration that fails uses no grant', async () => {
        // No step of migrate mode reaches the door outside the transaction that applies the files.
        const migrateSteps = steps.filter((s) => /inputs\.mode == 'migrate'/.test(s.split('\n').find((line) => /^\s*if:/.test(line)) ?? ''));
        const code = (s) => s.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
        const doorSteps = migrateSteps.filter((s) => /clued-release-grant\.mjs|release_door_v1/.test(code(s))).map((s) => s.split('\n')[0]);
        assert.deepEqual(doorSteps, ['name: Apply the named migrations']);

        const c = await fresh({ door: true, autoApprove: false });
        const broken = '20990104000000_broken.sql', good = '20990104000001_good.sql';
        await c.write(broken, 'select * from no_such_table;\n');
        await c.write(good, 'create table good_table(x int);\n');
        await c.db.query(`insert into clued_private.release_door_fixture_grants(action, resources, max_uses)
          values ('migration.production', $1, 1), ('migration.production', $2, 1)`, [JSON.stringify([resource(broken)]), JSON.stringify([resource(good)])]);
        const r = c.migrate([broken]);
        assert.notEqual(r.status, 0, r.out);
        assert.equal(await c.value('select uses from clued_private.release_door_fixture_grants where resources = $1', [JSON.stringify([resource(broken)])]), 0);
        assert.equal(await c.receipts(), 0);
        // The same grant shape is consumed when the file succeeds.
        const ok = c.migrate([good]);
        assert.equal(ok.status, 0, ok.out);
        assert.equal(await c.value('select uses from clued_private.release_door_fixture_grants where resources = $1', [JSON.stringify([resource(good)])]), 1);
        assert.equal(await c.ledger(), 1);
      });

      await t.test('normal order: one consumption covers every named file, each file commits with its probe and ledger row', async () => {
        const c = await fresh({ door: true });
        const files = ['20990105000000_a.sql', '20990105000001_b.sql'];
        await c.write(files[0], 'create table normal_a(x int);\n');
        await c.write(files[1], 'create table normal_b(x int);\n');
        const r = c.migrate(files);
        assert.equal(r.status, 0, r.out);
        assert.equal(await c.ledger(), 2);
        assert.equal(await c.receipts(), 1);
        assert.deepEqual((await c.value('select input from clued_private.release_door_fixture_receipts')).resources, files.map(resource));
        // A file already recorded is refused before any door call.
        const again = c.migrate([files[0]]);
        assert.notEqual(again.status, 0);
        assert.equal(await c.receipts(), 1);
      });

      await t.test('12: deploy consumes through the database login role and fails when the door does not exist', async () => {
        let c = await fresh();
        let r = c.deploy();
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /发布门/);
        c = await fresh({ door: true });
        r = c.deploy();
        assert.equal(r.status, 0, r.out);
        const receipt = await c.value('select input from clued_private.release_door_fixture_receipts');
        assert.deepEqual([receipt.action, receipt.resources], ['release.production', [`repo:${REPOSITORY}/${SHA}`]]);
        c = await fresh({ door: true, autoApprove: false });
        r = c.deploy();
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /https:\/\/kooyumi\.pixelgrav\.com\/confirm\/[0-9a-f-]{36}/);
      });
    } finally {
      for (const client of clients.reverse()) await client.end().catch(() => {});
      await stopCluster(server);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
