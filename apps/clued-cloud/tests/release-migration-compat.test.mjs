import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyMigration, declaredReason, evaluatePromotionMigrations, stripSql }
  from '../scripts/release-migration-compat.mjs';

const rules = (text) => classifyMigration(text).findings.map((finding) => finding.rule);

test('additive migrations are compatible with the previous Worker', () => {
  assert.deepEqual(rules(`
    create table if not exists clued_private.example_v1 (id uuid primary key, note text);
    alter table clued_private.example_v1 add column created_at timestamptz default now();
    alter table clued_private.example_v1 enable row level security;
    alter table clued_private.example_v1 drop constraint if exists example_old_check;
    alter table public.existing alter column note drop not null;
    create or replace function public.clued_example_v1(p jsonb) returns jsonb language sql as $$ select p $$;
    revoke all on function public.clued_example_v1(jsonb) from public, anon;
    grant execute on function public.clued_example_v1(jsonb) to authenticated;
  `), []);
});

test('drops, renames, retypes and tightening of existing objects are breaking', () => {
  assert.deepEqual(rules('drop table if exists clued_private.old_v1;'), ['drop_relation']);
  assert.deepEqual(rules('drop index public.old_uidx;'), ['drop_relation']);
  assert.deepEqual(rules('alter table public.t drop column legacy;'), ['drop_column']);
  assert.deepEqual(rules('alter table public.t drop column if exists legacy;'), ['drop_column']);
  assert.deepEqual(rules('alter table public.t drop legacy;'), ['drop_column']);
  assert.deepEqual(rules('alter table public.t rename column a to b;'), ['rename']);
  assert.deepEqual(rules('alter table public.t rename to u;'), ['rename']);
  assert.deepEqual(rules('alter materialized view public.mv rename to mv2;'), ['rename']);
  assert.deepEqual(rules('alter table public.t set schema archive;'), ['rename']);
  assert.deepEqual(rules('alter table public.t alter column a type bigint;'), ['retype_column']);
  assert.deepEqual(rules('alter table public.t alter column a set not null;'), ['set_not_null']);
  assert.deepEqual(rules('alter table public.t enable row level security;'), ['enable_rls']);
  assert.deepEqual(rules('drop policy p on public.t;'), ['drop_policy']);
  assert.deepEqual(rules('drop function if exists public.clued_old_v1(jsonb);'), ['drop_function']);
  assert.deepEqual(rules('drop function if exists public.f(int) cascade;'), ['drop_cascade', 'drop_function']);
  assert.deepEqual(rules(`drop function public.f(text);
    create function public.f(p jsonb) returns jsonb language sql as $$ select p $$;`),
  ['function_signature_change']);
  assert.deepEqual(rules('alter function public.f(text) rename to g;'), ['rename_function']);
});

test('an overload swap is a signature change, not a temporary helper', () => {
  assert.deepEqual(rules(`create or replace function public.f(p text) returns int language sql as $$ select 1 $$;
    drop function public.f(integer);`), ['function_signature_change']);
});

test('temporary helpers, wrappers and replaced policies are compatible', () => {
  assert.deepEqual(rules(`
    create function clued_private.patch_v1() returns void language plpgsql as $f$ begin null; end $f$;
    select clued_private.patch_v1();
    drop function clued_private.patch_v1();
  `), []);
  assert.deepEqual(rules(`
    alter function public.clued_mcp_restore(text,jsonb) rename to clued_mcp_restore_base;
    alter function public.clued_mcp_restore_base(text,jsonb) set schema clued_private;
    create or replace function public.clued_mcp_restore(p text, q jsonb) returns jsonb
      language sql as $$ select clued_private.clued_mcp_restore_base(p, q) $$;
  `), []);
  assert.deepEqual(rules('drop policy if exists p on public.t; create policy p on public.t using (true);'), []);
});

test('comments, literals, E-strings, quoted identifiers and dollar bodies cannot hide or trip a rule', () => {
  assert.equal(stripSql("select 'drop table x'; -- drop table y\n/* drop table z */").includes('drop'), false);
  assert.deepEqual(rules(String.raw`comment on table public.x is E'it\'s'; alter table public.x drop column y;`),
    ['drop_column']);
  assert.deepEqual(rules(`create function public.f() returns void language plpgsql as $f1$
    begin execute 'drop table t'; drop table if exists pg_temp.scratch; end $f1$;`), []);
  assert.deepEqual(rules('create table public."a;b" (id int); alter table public.t drop column c;'), ['drop_column']);
});

test('only a full-line comment before the first statement declares a file breaking', () => {
  assert.equal(declaredReason('-- header\n-- clued-release: breaking retires old\ndrop table t;\n'), 'retires old');
  assert.equal(declaredReason('drop table t;\n-- clued-release: breaking too late\n'), null);
  assert.equal(declaredReason("select '-- clued-release: breaking in a literal';\n"), null);
});

test('a promotion splits expand and contract files, and blocks an undeclared breaking file', () => {
  const additive = { name: '20261101000000_a.sql', text: 'create table public.a (id int);\n' };
  const dropping = { name: '20261101000001_b.sql', text: 'drop table public.old;\n' };
  const declared = { name: '20261101000002_c.sql',
    text: '-- clued-release: breaking retires public.old after Worker 1.2 stopped reading it\ndrop table public.old;\n' };
  const ok = evaluatePromotionMigrations([additive]);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.worker_rollback, 'automatic');
  assert.deepEqual(ok.expand, [additive.name]);
  assert.equal(evaluatePromotionMigrations([additive, dropping]).status, 'blocked');
  const split = evaluatePromotionMigrations([additive, declared]);
  assert.equal(split.status, 'ok');
  assert.deepEqual(split.expand, [additive.name]);
  assert.deepEqual(split.contract_after_deploy, [declared.name]);
  assert.equal(split.worker_rollback, 'until_contract_migrations');
});

test('every repository migration parses, and the check stays narrow on real history', async () => {
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql'));
  let breaking = 0;
  for (const name of names) {
    if (classifyMigration(await readFile(new URL(name, directory), 'utf8')).breaking) breaking += 1;
  }
  // 12 of 286 files on 2026-10-31; a jump means a rule became too broad.
  assert.ok(breaking <= Math.ceil(names.length * 0.06), `${breaking} of ${names.length} flagged`);
});
