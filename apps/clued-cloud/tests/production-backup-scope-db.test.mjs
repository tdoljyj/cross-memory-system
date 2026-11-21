import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { BACKUP_INVENTORY_SQL, createVerifiedBackup, SnapshotSession, validateInventory,
  verifyArchiveScope } from '../scripts/verify-production-backup-scope.mjs';

const fixtureSql = `create schema clued_private; create schema clued_watchdog; create schema supabase_migrations;
  create table public.fixture_public(id integer primary key, value text);
  create table clued_private.fixture_private(id integer primary key, value text);
  create table clued_watchdog.fixture_watchdog(id integer primary key, value text);
  insert into public.fixture_public values(1,'synthetic-public');
  insert into clued_private.fixture_private values(2,'synthetic-private');
  insert into clued_watchdog.fixture_watchdog values(3,'synthetic-watchdog');
  create function public.fixture_rpc(integer) returns integer language sql as $$select $1+1$$;
  create function clued_private.dataset_split_native_grant_context_v1(integer) returns integer language sql as $$select $1+2$$;
  create function clued_watchdog.fixture_watchdog_helper(integer) returns integer language sql as $$select $1+3$$;
  comment on function clued_private.dataset_split_native_grant_context_v1(integer) is 'synthetic helper metadata';
  comment on table public.fixture_public is 'synthetic table metadata';
  create sequence public.fixture_sequence;
  alter table public.fixture_public alter column id set default nextval('public.fixture_sequence');
  alter sequence public.fixture_sequence owned by public.fixture_public.id;
  create type public.fixture_status as enum ('ready','done');
  create domain public.fixture_positive as integer check(value>0);
  create view public.fixture_view as select * from public.fixture_public;
  create materialized view public.fixture_materialized as select * from public.fixture_public;
  alter table public.fixture_public enable row level security;
  create policy fixture_read on public.fixture_public using(true);
  create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[], idempotency_key text unique);
  insert into supabase_migrations.schema_migrations values('fixture-1','synthetic-history',array['select 1'],'fixture-key');`;
const execute = (command, args) => {
  const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, 'Synthetic PostgreSQL command failed: ' + (child.stderr || child.error?.message));
  return child.stdout;
};
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

// No mocked pg_dump and no skipped missing-runtime PASS. Supply a matching
// PG_DUMP/PG_RESTORE for embedded PostgreSQL, or an existing Docker image for a
// PostgreSQL17 fixture. The latter uses no network and never pulls an image.
async function databaseFixture(dir) {
  const image = process.env.CLUED_BACKUP_TEST_IMAGE;
  if (image) {
    const container = 'clued-production-backup-synthetic-' + crypto.randomBytes(8).toString('hex');
    execute('docker',['run','--pull=never','--rm','-d','--name',container,'--network=none',
      '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','DATABASE_URL=postgresql://postgres@/postgres?host=/var/run/postgresql',
      '-v',dir + ':/backup',image,'postgres','-c','listen_addresses=']);
    try {
      let ready = false;
      for (let i=0;i<100;i++) {
        // The image's temporary initialization server also answers pg_isready.
        // Wait until entrypoint has exec'd the final server, not its next restart.
        if (spawnSync('docker',['exec',container,'sh','-ceu',
          'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'],
          { stdio:'ignore' }).status === 0) { ready=true; break; }
        await new Promise(resolve => setTimeout(resolve,100));
      }
      assert.ok(ready,'Synthetic PostgreSQL did not start');
      const sql = async statement => {
        const session = new SnapshotSession(container);
        try { return await session.query(statement); } finally { await session.close(); }
      };
      return { sql, session: () => new SnapshotSession(container), dumpPath: name => '/backup/' + name,
        runPg: async (tool,args) => execute('docker',['exec',container,'sh','-ceu',
          tool === 'pg_dump' ? 'exec pg_dump --dbname="$DATABASE_URL" "$@"' : 'exec pg_restore "$@"','sh',...args]),
        close: async () => { execute('docker',['rm','-f',container]); } };
    } catch (error) { execute('docker',['rm','-f',container]); throw error; }
  }
  const password = crypto.randomBytes(24).toString('hex'), port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir:path.join(dir,'db'), user:'postgres',password,port,
    persistent:true,createPostgresUser:false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'],onLog(){},onError(){} });
  let started = false;
  try {
    await server.initialise(); await server.start(); started=true;
    const connection = () => server.getPgClient('postgres','127.0.0.1');
    const sql = async statement => { const client=connection(); await client.connect();
      try { const r=await client.query(statement); return String(r.rows?.[0]?.[Object.keys(r.rows[0])[0]] ?? ''); }
      finally { await client.end(); } };
    return { sql, session: async () => { const client=connection(); await client.connect(); return {
      query: async statement => { const r=await client.query(statement); const first=r.rows?.[0];
        return first ? String(first[Object.keys(first)[0]]) : ''; }, close: () => client.end() }; },
      dumpPath: name => path.join(dir,name),
      runPg: async (tool,args) => execute(process.env[tool === 'pg_dump' ? 'PG_DUMP' : 'PG_RESTORE'] ?? tool,
        tool === 'pg_dump' ? ['--dbname',`postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,...args] : args),
      close: () => stopCluster(server) };
  } catch (error) { if (started) await stopCluster(server); throw error; }
}

test('actual PostgreSQL backup selection, catalog coverage and migration scope fail closed', { timeout:120000 }, async t => {
  const root = path.resolve(process.env.TMPDIR ?? os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root,'clued-backup-scope-test-'));
  let db;
  try {
    db=await databaseFixture(dir); await db.sql(fixtureSql);
    const inventory=JSON.parse(await db.sql(BACKUP_INVENTORY_SQL));
    const oldPath=db.dumpPath('old.dump'), correctedPath=db.dumpPath('corrected.dump');
    let toc, proof;
    await t.test('the former -n plus -t command actually omits all three schemas and native helpers', async () => {
      await db.runPg('pg_dump',['--format=custom','--no-owner','--no-privileges','--schema=public',
        '--schema=clued_private','--schema=clued_watchdog','--table=supabase_migrations.schema_migrations','--file=' + oldPath]);
      const old=await db.runPg('pg_restore',['--list',oldPath]);
      assert.match(old,/TABLE DATA supabase_migrations schema_migrations/);
      assert.doesNotMatch(old,/fixture_public|fixture_private|fixture_watchdog|dataset_split_native_grant_context_v1/);
      assert.throws(() => verifyArchiveScope(inventory,old),/missing a snapshot catalog object/);
    });
    await t.test('one snapshot-bound archive includes actual schema table data, routines and exact migration history', async () => {
      proof=await createVerifiedBackup({ session:await db.session(),runPg:db.runPg,dumpPath:correctedPath });
      toc=await db.runPg('pg_restore',['--list',correctedPath]);
      for (const name of ['fixture_public','fixture_private','fixture_watchdog','schema_migrations']) assert.match(toc,new RegExp('TABLE DATA [^\\n]*' + name));
      assert.match(toc,/FUNCTION clued_private dataset_split_native_grant_context_v1/);
      assert.equal(proof.verified,true); assert.equal(proof.table_data_entries,5); assert.equal(proof.routines,3);
      // Decode the archive data itself, rather than accepting just TOC labels.
      const decoded=await db.runPg('pg_restore',['--data-only','--file=-',correctedPath]);
      for (const value of ['synthetic-public','synthetic-private','synthetic-watchdog','synthetic-history']) assert.ok(decoded.includes(value));
      const definitions=await db.runPg('pg_restore',['--schema-only','--file=-',correctedPath]);
      assert.match(definitions,/CREATE FUNCTION clued_private\.dataset_split_native_grant_context_v1/);
      assert.ok(definitions.includes('select $1+2'), 'Archive omitted native helper body');
      assert.ok(!JSON.stringify(proof).includes('synthetic-public'));
    });
    await t.test('missing native helper, table data and changed catalog identity cannot claim coverage', () => {
      const missing=toc.split('\n').filter(line => !line.includes('FUNCTION clued_private dataset_split_native_grant_context_v1')).join('\n');
      assert.throws(() => verifyArchiveScope(inventory,missing),/missing a snapshot catalog object/);
      assert.throws(() => verifyArchiveScope(inventory,toc.split('\n').filter(line => !line.includes('TABLE DATA public fixture_public')).join('\n')),/missing snapshot table data/);
      const changed=structuredClone(inventory); changed.objects.find(o => o.name === 'dataset_split_native_grant_context_v1').oid += 100000;
      assert.throws(() => verifyArchiveScope(changed,toc),/outside snapshot scope/);
      assert.throws(() => verifyArchiveScope(inventory,toc + '\n99999; 0 987654 TABLE DATA outside leaked postgres\n'),/unexpected table data/);
    });
    await t.test('an extra migration table or routine refuses before any dump is produced', async () => {
      for (const [create,drop] of [
        ['create table supabase_migrations.unapproved(id integer)','drop table supabase_migrations.unapproved'],
        ['create function supabase_migrations.unapproved() returns integer language sql as $$select 1$$','drop function supabase_migrations.unapproved()'],
      ]) {
        await db.sql(create); let dumped=false;
        await assert.rejects(createVerifiedBackup({ session:await db.session(),dumpPath:db.dumpPath('refused.dump'),
          runPg:async () => { dumped=true; throw new Error('must refuse before dump'); } }),/Migration scope|Unapproved object/);
        assert.equal(dumped,false); await db.sql(drop);
      }
      assert.equal(validateInventory(JSON.parse(await db.sql(BACKUP_INVENTORY_SQL))).objects.length,inventory.objects.length);
    });
    await t.test('concurrent added migration objects do not enter the already exported snapshot', async () => {
      let altered=false;
      await createVerifiedBackup({ session:await db.session(),dumpPath:db.dumpPath('snapshot.dump'),
        runPg:async (tool,args) => { if (tool==='pg_dump') { await db.sql('create table supabase_migrations.concurrent_extra(id integer)'); altered=true; }
          return db.runPg(tool,args); } });
      assert.equal(altered,true);
      assert.doesNotMatch(await db.runPg('pg_restore',['--list',db.dumpPath('snapshot.dump')]),/concurrent_extra/);
      await assert.rejects(createVerifiedBackup({ session:await db.session(),runPg:db.runPg,dumpPath:db.dumpPath('after-race.dump') }),/Migration scope/);
      await db.sql('drop table supabase_migrations.concurrent_extra');
    });
    await t.test('actual inline defaults and FK target indexes remain fully covered', async () => {
      await db.sql(`create table public.inline_default_probe(id integer default 42,
        created_at timestamptz default now(), custom integer default public.fixture_rpc(1),
        numbers integer[] default array[1,2], "中文列" text default '中文', ordinary integer);
        create unlogged table public.unlogged_default_probe(value boolean default true);
        create table public.index_parent(id integer);
        create unique index standalone_fk_target on public.index_parent(id);
        create table public.index_child(parent_id integer references public.index_parent(id));
        alter view public.fixture_view alter column value set default 'view-default';`);
      const dump=db.dumpPath('inline-defaults.dump');
      assert.equal((await createVerifiedBackup({session:await db.session(),runPg:db.runPg,dumpPath:dump})).verified,true);
      const session=await db.session();let expanded;
      try {await session.query("SET search_path = ''");expanded=JSON.parse(await session.query(BACKUP_INVENTORY_SQL));}
      finally {await session.close();}
      const archiveToc=await db.runPg('pg_restore',['--list',dump]);
      const sql=await db.runPg('pg_restore',['--schema-only','--section=pre-data','--file=-',
        '--table=inline_default_probe','--table=unlogged_default_probe',dump]);
      assert.doesNotMatch(archiveToc,/DEFAULT public inline_default_probe/);
      assert.match(sql,/id integer DEFAULT 42/);
      assert.equal(verifyArchiveScope(expanded,archiveToc,sql).verified,true);
      for(const changed of [sql.replace('DEFAULT 42',''),sql.replace('DEFAULT 42','DEFAULT 43'),
        sql.replace('DEFAULT 42','/* DEFAULT 42 */')]){
        assert.throws(()=>verifyArchiveScope(expanded,archiveToc,changed),/missing a snapshot column default/);
      }
      for(const omitted of ['DEFAULT public fixture_public id','DEFAULT public fixture_view value',
        'INDEX public standalone_fk_target']){
        const missing=archiveToc.split('\n').filter(line=>!line.includes(omitted)).join('\n');
        assert.notEqual(missing,archiveToc,'Negative fixture did not remove a real archive object');
        assert.throws(()=>verifyArchiveScope(expanded,missing,sql),/missing a snapshot/);
      }
      assert.equal(expanded.objects.find(o=>o.name==='standalone_fk_target'&&o.kind==='INDEX').required,true);
    });
  } finally {
    if (db) await db.close();
    await removeTestDirectory(dir);
  }
});
