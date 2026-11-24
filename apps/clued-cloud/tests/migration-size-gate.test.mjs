// Capacity gate before a production migration (FABLE-prod-db-shrink-v2-20261124 §8, B3). Every case runs the real command
// line on real files: at or above the threshold a file that adds a table, an index or a column is refused; a file of
// functions and data changes, or a size below the threshold, passes; a file that declares itself a shrink migration may
// only add indexes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(app, 'scripts/migration-size-gate.mjs');
const LIMIT = 500 * 1024 * 1024;
const AT = Math.floor(LIMIT * 0.85);
const BELOW = AT - 1;

function withFiles(texts, body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-size-gate-'));
  try {
    const files = texts.map((text, index) => {
      const file = path.join(dir, `2026112${index}000000_fixture_${index}.sql`);
      writeFileSync(file, text);
      return file;
    });
    return body(files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gate = (size, files, extra = []) => spawnSync(process.execPath, [script, '--size-bytes', String(size), '--files', files.join(','), ...extra],
  { cwd: app, encoding: 'utf8' });
const verdict = (size, ...texts) => withFiles(texts, (files) => gate(size, files));

test('the threshold is 85% of 500 MB and the command takes no threshold of its own', async () => {
  const { THRESHOLD_BYTES } = await import('../scripts/migration-size-gate.mjs');
  assert.equal(THRESHOLD_BYTES, AT);
  withFiles(['create table public.t(a int);\n'], (files) => {
    assert.notEqual(gate(BELOW, files, ['--threshold-bytes', String(LIMIT)]).status, 0);
    assert.notEqual(gate(BELOW, files, ['--threshold', '1']).status, 0);
  });
});

test('at the threshold a new table is refused with its file, line and statement; below it, or with functions only, it passes', () => {
  const table = '-- a comment\n\ncreate table public.size_gate_fixture (\n  id bigint primary key\n);\n';
  const refused = verdict(AT, table);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /_fixture_0\.sql:3: create table public\.size_gate_fixture \(/);
  assert.equal(verdict(AT + 10_000_000, table).status, 1);
  const below = verdict(BELOW, table);
  assert.equal(below.status, 0, below.stdout + below.stderr);
  const functions = `create or replace function clued_private.size_gate_fixture_v1(p_at timestamptz) returns integer
language plpgsql set search_path = '' as $$
declare n integer;
begin
  create temp table if not exists size_gate_scratch(a int);
  create index on size_gate_scratch(a);
  execute 'create table clued_private.never_at_migration_time(a int)';
  delete from public.clued_memory_audit where occurred_at < p_at - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function clued_private.size_gate_fixture_v1(timestamptz) from public, anon, authenticated, service_role;
grant execute on function clued_private.size_gate_fixture_v1(timestamptz) to postgres;
comment on table public.clued_memory_audit is 'create table and create index in a comment string';
update public.clued_continuity_sessions set restored_currentness_vector = null where ended_at < now() - interval '35 days';
delete from public.clued_memory_audit where occurred_at < now() - interval '30 days';
`;
  const passed = verdict(AT, functions);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
});

test('every statement that adds storage is refused at the threshold', () => {
  for (const sql of [
    'alter table public.t add constraint t_a_key unique (a);',
    'alter table public.t add constraint t_pkey primary key (a);',
    'alter table public.t add primary key (a);',
    'alter table public.t add constraint t_ex exclude using gist (r with &&);',
    'alter table public.t add column b text;',
    'alter table if exists only public.t add if not exists b text;',
    'alter table public.t alter column a set not null, add column c int;',
    'create materialized view public.v as select 1 as a;',
    'create unique index t_a on public.t(a);',
    'create index concurrently t_b on public.t(b);',
    'create unlogged table public.u(a int);',
    'create table public.c as select * from public.t;',
    'select * into public.copy_of_t from public.t;',
    "do $$ begin execute 'create index t_c on public.t(c)'; end $$;",
    "do $$ begin if true then create table public.inside_do(a int); end if; end $$;",
    "do $$ begin execute format('create index %I on public.t(a)', 't_d'); end $$;",
    "do $d$ declare s text := 'create index t_e on public.t(a)'; begin execute s; end $d$;",
    "do language plpgsql $$ begin execute 'alter table public.t add column z int'; end $$;",
  ]) {
    const result = verdict(AT, `${sql}\n`);
    assert.equal(result.status, 1, `${sql}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /_fixture_0\.sql:1: \S/, sql);
  }
});

test('temporary tables, comments, strings, constraints without storage and plpgsql SELECT INTO pass at the threshold', () => {
  for (const sql of [
    'create temp table scratch(a int);',
    'create temporary table scratch(a int) on commit drop;',
    'create local temporary table scratch as select 1;',
    'select 1 into temp scratch;',
    '-- create table public.commented(a int);',
    '/* create index x on public.t(a); /* nested */ */ select 1;',
    "select 'create table public.quoted(a int)';",
    "select E'create index \\' x on public.t(a)';",
    'select "create table" from public.t;',
    'alter table public.t add constraint t_check check (a > 0);',
    'alter table public.t add constraint t_fk foreign key (a) references public.u(a);',
    'alter table public.t alter column a drop not null;',
    'grant create on schema public to service_role;',
    'create trigger t_touch before update on public.t for each row execute function public.touch();',
    "do $$ declare v int; begin select count(*) into v from public.t; perform v; end $$;",
    "do $$ begin perform cron.schedule('x', '1 2 * * *', 'select 1'); end $$;",
    'create view public.v as select 1 as a;',
    'drop index if exists public.t_a;',
    'truncate table public.t;',
  ]) {
    const result = verdict(AT, `${sql}\n`);
    assert.equal(result.status, 0, `${sql}\n${result.stdout}${result.stderr}`);
  }
});

test('a declared shrink migration may add indexes only, and only a declaration before the first statement counts', () => {
  const shrink = '-- Retention indexes for the sweep.\n-- clued-release: shrink receipts are deleted by created_at\n';
  const index = 'create index if not exists clued_audit_receipts_created_idx on public.clued_audit_receipts(created_at);\n';
  assert.equal(verdict(AT, `${shrink}${index}`).status, 0);
  assert.equal(verdict(AT, `${shrink}do $$ begin execute 'create index i on public.t(a)'; end $$;\n`).status, 0);
  for (const added of ['create table public.t(a int);\n', 'alter table public.t add column a int;\n',
    'alter table public.t add constraint t_u unique (a);\n', "do $$ begin execute format('create index %I on public.t(a)', 'i'); end $$;\n"]) {
    const result = verdict(AT, `${shrink}${index}${added}`);
    assert.equal(result.status, 1, added);
    assert.match(result.stderr, /shrink/);
  }
  // After a statement, in a string or in a block comment, the words declare nothing.
  assert.equal(verdict(AT, `select 1;\n-- clued-release: shrink late\n${index}`).status, 1);
  assert.equal(verdict(AT, `select '-- clued-release: shrink in a string';\n${index}`).status, 1);
  assert.equal(verdict(AT, `/*\n-- clued-release: shrink in a block comment\n*/\n${index}`).status, 1);
  // The release compatibility marker may sit next to it.
  assert.equal(verdict(AT, `-- clued-release: breaking drops an old column\n${shrink}${index}`).status, 0);
});

test('every named file is judged and the refusal names the file that adds', () => {
  const result = verdict(AT, 'delete from public.t;\n', 'create index i on public.t(a);\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /_fixture_1\.sql:1: create index/);
  assert.doesNotMatch(result.stderr, /_fixture_0\.sql/);
});

test('a file the tokenizer cannot read is refused at the threshold and passes with a warning below it', () => {
  const broken = 'create function f() returns int language sql as $$ select 1;\n';
  const at = verdict(AT, broken);
  assert.equal(at.status, 1);
  assert.match(at.stderr, /unclosed dollar quote/);
  const below = verdict(BELOW, broken);
  assert.equal(below.status, 0, below.stdout + below.stderr);
  assert.match(below.stdout, /::warning[^\n]*unclosed dollar quote/);
});

test('a missing or malformed size and a missing file fail the step', () => {
  withFiles(['select 1;\n'], (files) => {
    for (const size of ['', 'abc', '-1', '1.5', '4e8']) assert.equal(gate(size, files).status, 2, size);
    assert.equal(spawnSync(process.execPath, [script, '--files', files[0]], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [script, '--size-bytes', String(BELOW)], { encoding: 'utf8' }).status, 2);
    assert.notEqual(gate(BELOW, [path.join(path.dirname(files[0]), 'missing.sql')]).status, 0);
  });
});

test('every committed migration is read by the tokenizer, and the run-history cleanup counts as an addition', async () => {
  const { judgeMigration } = await import('../scripts/migration-size-gate.mjs');
  const { readFileSync } = await import('node:fs');
  const dir = path.join(app, 'supabase/migrations');
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(names.length > 300);
  for (const name of names) {
    const verdictOf = judgeMigration(readFileSync(path.join(dir, name), 'utf8'), name);
    assert.equal(verdictOf.error, undefined, `${name}: ${verdictOf.error}`);
  }
  // Its DO block runs `execute cleanup` from a variable: a non-literal EXECUTE cannot be judged and counts (§8).
  const cleanup = judgeMigration(readFileSync(path.join(dir, '20261118080000_cron_run_history_retention.sql'), 'utf8'));
  assert.deepEqual(cleanup.additions.map((item) => item.kind), ['dynamic']);
});
