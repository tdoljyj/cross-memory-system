// Pure parts of the production-schema drift check (Task 2a5fdb66). The
// replay itself (two embedded PostgreSQL clusters) runs as the
// migration-verify CI check: `node scripts/production-schema-drift.mjs check`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { productionChain, catalogSqlPath, readSnapshot, SNAPSHOT_CONTRACT } from '../scripts/production-schema-chain.mjs';
import {
  SCHEMA_STATEMENT, buildSnapshot, compareFingerprints, deviationMatcher, diffIsEmpty, pendingReferenceFindings, prepareReplay, relationAliases,
  printSummary, readBaseMigrations, repositoryOnlyObjects, runCheck, serializeSnapshot,
} from '../scripts/production-schema-drift.mjs';
import { md5 } from '../scripts/migration-ledger.mjs';
import { pendingBreakingFindings } from '../scripts/release-migration-compat.mjs';

const column = (key, type = 'text') => ['column', key, { type, not_null: false, default: null, identity: null, generated: null }];
const relation = (key) => ['relation', key, { relkind: 'r', rls: true, force_rls: false, view_md5: null }];

test('fingerprints compare by key and value; known deviations are counted, not reported', () => {
  const production = [relation('public.a'), column('public.a.x'), column('public.a.y'), ['acl', 'relation:public.s', []]];
  const replay = [relation('public.a'), column('public.a.x', 'integer'), column('public.a.z')];
  const diff = compareFingerprints(production, replay);
  assert.deepEqual(diff.only_expected, ['column public.a.y']);
  assert.deepEqual(diff.only_actual, ['column public.a.z']);
  assert.deepEqual(diff.changed.map((change) => change.key), ['column public.a.x']);
  assert.equal(diffIsEmpty(diff), false);
  const ignored = deviationMatcher(['column public.a.y', 'column public.a.x', 'column public.a.z']
    .map((key) => ({ key, reason: 'legacy' })));
  const quiet = compareFingerprints(production, replay, ignored);
  assert.equal(diffIsEmpty(quiet), true);
  assert.equal(quiet.ignored, 3, 'the empty ACL row is no row at all');
  assert.deepEqual(quiet.stale_deviations, []);
});

test('known deviations are exact keys with reasons, and one that matches no difference is stale', () => {
  assert.throws(() => deviationMatcher([{ key: 'column public.a.y', reason: ' ' }]), /known_deviation_invalid/);
  assert.throws(() => deviationMatcher([{ key: 'column public.a.*', reason: 'all' }]), /known_deviation_invalid/);
  assert.throws(() => deviationMatcher([{ key: '*', reason: 'everything' }]), /known_deviation_invalid/);
  const same = [relation('public.a'), column('public.a.x')];
  const diff = compareFingerprints(same, same, deviationMatcher([{ key: 'column public.a.x', reason: 'was different once' }]));
  assert.deepEqual(diff.stale_deviations, ['column public.a.x']);
  assert.equal(diff.ignored, 0);
});

test('a replay-skip row must hold no schema statement', () => {
  assert.equal(SCHEMA_STATEMENT.test('do $$ begin update mtpe_m0.registry_entry set activation_id = act; end $$;'), false);
  for (const text of ['create table t(x int);', 'ALTER TABLE t ADD c int', 'grant select on t to anon', 'drop function f()',
    'comment on table t is \'x\'']) assert.equal(SCHEMA_STATEMENT.test(text), true, text);
});

test('an ACL that grants the compared roles nothing equals no ACL row', () => {
  const diff = compareFingerprints([['acl', 'relation:public.s_seq', []]], []);
  assert.equal(diffIsEmpty(diff), true);
  assert.equal(diffIsEmpty(compareFingerprints([['acl', 'relation:public.t', ['anon:SELECT']]], [])), false);
});

test('repository-only objects are the columns and functions production lacks', () => {
  const production = [column('public.clued_agent_bindings.id')];
  const repository = [column('public.clued_agent_bindings.id'), column('public.clued_agent_bindings.expires_at', 'timestamp with time zone'),
    ['function', 'clued_private.p5_resolve_binding(p_token_hash text)', {}], relation('public.clued_organizations')];
  assert.deepEqual(repositoryOnlyObjects(production, repository), [
    { kind: 'column', key: 'public.clued_agent_bindings.expires_at' },
    { kind: 'function', key: 'clued_private.p5_resolve_binding(p_token_hash text)' },
  ]);
});

const productionObjects = [
  relation('public.clued_agent_bindings'), column('public.clued_agent_bindings.id'), column('public.clued_agent_bindings.revoked_at'),
  relation('clued_private.binding_roles_v1'), column('clued_private.binding_roles_v1.role'), column('clued_private.ci_nodes_v1.connection_expires_at'),
];
const repositoryOnly = [{ kind: 'column', key: 'public.clued_agent_bindings.expires_at' }, { kind: 'column', key: 'public.clued_agent_bindings.role' }];

test('aliases bind declared rows and FROM/JOIN names to relations', () => {
  const aliases = relationAliases(`declare b public.clued_agent_bindings; r clued_private.binding_roles_v1%rowtype;
    select 1 from public.clued_agent_bindings as x join clued_private.binding_roles_v1 y on y.binding_id = x.id where true`,
  ['public.clued_agent_bindings', 'clued_private.binding_roles_v1']);
  assert.deepEqual([...aliases.get('b')], ['public.clued_agent_bindings']);
  assert.deepEqual([...aliases.get('x')], ['public.clued_agent_bindings']);
  assert.deepEqual([...aliases.get('r')], ['clued_private.binding_roles_v1']);
  assert.deepEqual([...aliases.get('y')], ['clued_private.binding_roles_v1']);
  assert.equal(aliases.has('on'), false);
  assert.equal(aliases.has('where'), false);
});

test('a pending migration that reads a repository-only column fails; tonight\'s bug is the example', () => {
  // The shape of public.clued_ci_node_registration_v1 in 20261023092957_ci_scheduling_stage1_v1.
  const buggy = { file: 'migrations/20261023092957_ci_scheduling_stage1_v1.sql', text: `create or replace function public.clued_ci_node_registration_v1(p_input jsonb)
returns jsonb language plpgsql as $$
declare b public.clued_agent_bindings; n clued_private.ci_nodes_v1;
begin
  select * into b from public.clued_agent_bindings where id = (p_input->>'binding_id')::uuid;
  insert into clued_private.ci_nodes_v1(binding_id, connection_expires_at) values (b.id, b.expires_at) returning * into n;
  return '{}'::jsonb;
end $$;
` };
  const findings = pendingReferenceFindings([buggy], repositoryOnly, productionObjects);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, 'public.clued_agent_bindings.expires_at');
  assert.equal(findings[0].via, 'b');
  assert.match(findings[0].context, /b\.expires_at/);
});

test('the PR #967 fix, comments, aliases of other tables and the allow comment are not findings', () => {
  const fixed = { file: 'migrations/fix.sql', text: `-- b.expires_at is absent in production, so read it through to_jsonb
declare b public.clued_agent_bindings;
begin values ((to_jsonb(b)->>'expires_at')::timestamptz); end;` };
  const otherTable = { file: 'migrations/roles.sql', text: `select 1 from public.clued_agent_bindings x where x.id = $1;
select 1 from clued_private.binding_roles_v1 x where x.role = 'ci-admission';` };
  const allowed = { file: 'migrations/adds-column.sql', text: `-- production-schema: allow public.clued_agent_bindings.expires_at
alter table public.clued_agent_bindings add column if not exists expires_at timestamptz;
update public.clued_agent_bindings set expires_at = now() where public.clued_agent_bindings.expires_at is null;` };
  const unqualified = { file: 'migrations/unqualified.sql', text: `create table public.t(expires_at timestamptz); select clued_agent_bindings_v from x;` };
  assert.deepEqual(pendingReferenceFindings([fixed, otherTable, allowed, unqualified], repositoryOnly, productionObjects), []);
  const notAllowed = { ...allowed, text: allowed.text.replace(/^-- production-schema.*\n/, '') };
  assert.equal(pendingReferenceFindings([notAllowed], repositoryOnly, productionObjects).length, 1);
});

const sql = (name) => `create table public.${name}(id int);\n`;

function repository() {
  const migrations = {
    '20260901000000_one.sql': sql('one'),
    '20260902000000_two.sql': sql('two'),
    '20260903000000_never.sql': sql('never'),
    '20261101000000_pending.sql': sql('pending'),
    '20261102000000_applied_late.sql': sql('applied_late'),
  };
  const ledger = {
    contract: 'clued.production-migration-ledger.v1', database_project: 'clued-prod', exported_at: 'x',
    history_through: '20260902120000', row_count: 2,
    rows: [
      { version: '20260901120000', name: 'one', statements_md5: md5(sql('one').replace(/\n/g, '\r\n')),
        statements_length: [...sql('one').replace(/\n/g, '\r\n')].length,
        source: 'migrations/20260901000000_one.sql', transform: 'crlf' },
      { version: '20260902120000', name: 'two', statements_md5: md5(sql('two')), statements_length: [...sql('two')].length,
        source: 'migrations/20260902000000_two.sql', transform: 'identical' },
    ],
    repository_only: [{ file: 'migrations/20260903000000_never.sql', status: 'never_applied', reason: 'test' }],
    known_deviations: [],
  };
  return { migrations, historyOnly: {}, ledger, historicalThrough: '20260930000000' };
}

const appliedRow = (version, name, text) => ({ version, name, statements_md5: md5(text), statements_length: [...text].length });

test('the production chain follows production order, runs LF text and leaves repository-only files out', () => {
  const repo = repository();
  const applied = [
    appliedRow('20260902120000', 'two', sql('two')),
    appliedRow('20260901120000', 'one', sql('one').replace(/\n/g, '\r\n')),
    appliedRow('20261031000000', 'applied_late', sql('applied_late')),
  ];
  const chain = productionChain({ applied, ...repo });
  assert.deepEqual(chain.errors, []);
  assert.deepEqual(chain.applied.map((step) => step.file), [
    'migrations/20260901000000_one.sql', 'migrations/20260902000000_two.sql', 'migrations/20261102000000_applied_late.sql']);
  assert.equal(chain.applied[0].text, sql('one'), 'the file text runs, not the stored CRLF text');
  assert.deepEqual(chain.pending.map((step) => step.file), ['migrations/20261101000000_pending.sql']);
});

test('ledger rows newer than the snapshot are replayed after it, not lost and not pending (review M2)', () => {
  const repo = repository();
  // The ledger has row two; the snapshot was taken before it.
  const chain = productionChain({ applied: [appliedRow('20260901120000', 'one', sql('one').replace(/\n/g, '\r\n'))], ...repo });
  assert.deepEqual(chain.errors, []);
  assert.deepEqual(chain.applied.map((step) => step.file), ['migrations/20260901000000_one.sql']);
  assert.deepEqual(chain.ahead.map((step) => step.file), ['migrations/20260902000000_two.sql']);
  assert.equal(chain.pending.some((step) => step.file === 'migrations/20260902000000_two.sql'), false);
  // A ledger row older than the snapshot's newest row that the snapshot lacks is an error.
  const gap = productionChain({ applied: [appliedRow('20260902120000', 'two', sql('two'))], ...repo });
  assert.ok(gap.errors.includes('chain_snapshot_missing_ledger_row:20260901120000_one'), JSON.stringify(gap.errors));
});

test('a production row no repository text carries stops the check', () => {
  const repo = repository();
  const applied = [appliedRow('20260901120000', 'one', sql('one').replace(/\n/g, '\r\n')), appliedRow('20260902120000', 'two', sql('two')),
    appliedRow('20261031164748', 'ci_node_registration_binding_expiry_v1', 'create function x();')];
  const chain = productionChain({ applied, ...repo });
  assert.ok(chain.errors.includes('production_row_not_in_repository:20261031164748_ci_node_registration_binding_expiry_v1'));
  assert.ok(chain.errors.includes('chain_row_unresolved:20261031164748_ci_node_registration_binding_expiry_v1'));
});

test('a failing check exits non-zero although embedded-postgres\'s exit hook ends the process with exit(0)', () => {
  // The hook embedded-postgres registers (async-exit-hook) is the one that turned FAIL into exit 0.
  const script = `import hook from 'async-exit-hook';hook((done)=>done());
    const {settleExitCode}=await import(${JSON.stringify(new URL('../scripts/production-schema-drift.mjs', import.meta.url).href)});
    settleExitCode(1);console.log('settled');`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'settled', run.stderr);
  assert.equal(run.status, 1, run.stderr);
});

test('the check refuses a snapshot taken with a different catalog query before starting a database', async () => {
  const report = await runCheck({ repository: repository(), catalogSql: 'select 1',
    snapshot: { contract: SNAPSHOT_CONTRACT, objects: [], applied: [], catalog_sql_sha256: '0'.repeat(64) } });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.errors, ['snapshot_catalog_sql_changed']);
  const invalid = await runCheck({ repository: repository(), catalogSql: 'select 1', snapshot: { contract: 'other' } });
  assert.deepEqual(invalid.errors, ['snapshot_contract_invalid']);
});

test('snapshot import keeps the reviewed lists and serializes one object per line', () => {
  const previous = { prehistory: ['migrations/a.sql'], replay_skip: [{ file: 'f', reason: 'r' }],
    replay_substitutions: [{ file: 'f', find: 'a', replace: 'b', reason: 'r' }], known_deviations: [{ key: 'k', reason: 'r' }] };
  const snapshot = buildSnapshot({ catalog: { catalog: { schemas: ['public'], objects: [relation('public.a')] } },
    applied: { applied: [{ version: '1', name: 'n', statements_md5: 'm', statements_length: 2, statement_count: 1 }] },
    catalogSql: 'select 1', capturedAt: '2026-10-31T00:00:00Z', previous });
  assert.equal(snapshot.catalog_sql_sha256, createHash('sha256').update('select 1').digest('hex'));
  assert.deepEqual(snapshot.known_deviations, previous.known_deviations);
  assert.deepEqual(snapshot.applied, [{ version: '1', name: 'n', statements_md5: 'm', statements_length: 2 }]);
  const text = serializeSnapshot(snapshot);
  assert.deepEqual(JSON.parse(text), snapshot);
  assert.match(text, /\n {4}\["relation","public.a",/);
  assert.throws(() => buildSnapshot({ catalog: {}, applied: [], catalogSql: '', capturedAt: '' }), /import_input_invalid/);
});

test('the committed snapshot is bound to the committed catalog query and every exception has a reason', async () => {
  const snapshot = await readSnapshot();
  const catalogSql = await readFile(catalogSqlPath, 'utf8');
  assert.equal(snapshot.contract, SNAPSHOT_CONTRACT);
  assert.equal(snapshot.catalog_sql_sha256, createHash('sha256').update(catalogSql).digest('hex'));
  assert.ok(snapshot.applied.length > 0 && snapshot.objects.length > 0);
  for (const list of ['replay_skip', 'replay_substitutions', 'known_deviations']) {
    for (const entry of snapshot[list]) assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 20, `${list}: ${JSON.stringify(entry)}`);
  }
  assert.doesNotThrow(() => deviationMatcher(snapshot.known_deviations));
});

test('ledger rows newer than the snapshot go through the same replay-skip and substitution lists', () => {
  const errors = [];
  const skipped = new Map([['history-only/backfill.sql', 'data only']]);
  const substitutions = new Map([['migrations/b.sql', [{ find: 'create extension pg_cron;', replace: 'select 1;' }]],
    ['migrations/c.sql', [{ find: 'twice', replace: 'x' }]]]);
  const ahead = [{ file: 'history-only/backfill.sql', text: 'update t set x = 1;' },
    { file: 'migrations/b.sql', text: 'create extension pg_cron; create table b();' },
    { file: 'migrations/c.sql', text: 'twice twice' }];
  const prepared = prepareReplay(ahead, { skipped, substitutions, errors });
  assert.deepEqual(prepared.map((step) => step.file), ['migrations/b.sql', 'migrations/c.sql']);
  assert.equal(prepared[0].text, 'select 1; create table b();');
  assert.deepEqual(errors, ['snapshot_replay_substitution_not_unique:migrations/c.sql']);
});

// A pending migration that drops a column the previous Worker still reads fails the check
// before any database starts; declared as a contract step, or purely additive, it is clean.
// Applied (historic) files are never judged, even when they drop things.
test('migration-verify blocks an undeclared breaking pending migration and passes a declared or additive one', async () => {
  const catalogSql = 'select 1';
  const snapshotFor = (repo) => ({ contract: SNAPSHOT_CONTRACT, objects: [], catalog_sql_sha256: createHash('sha256').update(catalogSql).digest('hex'),
    applied: [appliedRow('20260901120000', 'one', sql('one').replace(/\n/g, '\r\n')), appliedRow('20260902120000', 'two', sql('two')),
      appliedRow('20261031000000', 'applied_late', repo.migrations['20261102000000_applied_late.sql'])] });
  const withPending = (pendingText, lateText = sql('applied_late')) => {
    const repo = repository();
    repo.migrations['20261101000000_pending.sql'] = pendingText;
    repo.migrations['20261102000000_applied_late.sql'] = lateText;
    return repo;
  };
  const drop = 'alter table public.clued_agent_bindings drop column expires_at;\n';
  const baseFiles = new Set(Object.keys(repository().migrations).filter((name) => name !== '20261101000000_pending.sql'));
  const blocked = await runCheck({ repository: withPending(drop), snapshot: snapshotFor(withPending(drop)), catalogSql, baseMigrations: baseFiles });
  assert.equal(blocked.status, 'FAIL');
  assert.deepEqual(blocked.errors, ['pending_migration_breaks_previous_worker']);
  assert.deepEqual(blocked.pending_breaking.map((finding) => [finding.file, finding.rule]), [['migrations/20261101000000_pending.sql', 'drop_column']]);
  const lines = [];
  printSummary(blocked, (line) => lines.push(line));
  assert.ok(lines.some((line) => line.includes('20261101000000_pending.sql') && line.includes('drop column expires_at') && line.includes('previous Worker')), lines.join('\n'));
  const judged = (repo, base) => pendingBreakingFindings(productionChain({ applied: snapshotFor(repo).applied, ...repo }).pending
    .filter((step) => !base.has(step.file.slice('migrations/'.length))));
  const declared = withPending('-- clued-release: breaking Worker 41 no longer reads expires_at' + String.fromCharCode(10) + drop);
  assert.deepEqual(judged(declared, baseFiles), []);
  const additive = withPending('alter table public.clued_agent_bindings add column note text;' + String.fromCharCode(10));
  assert.deepEqual(judged(additive, baseFiles), []);
  // A file the base already has was judged when it was added: a snapshot that lags production cannot fail it.
  const onMain = withPending(drop);
  assert.deepEqual(judged(onMain, new Set(Object.keys(onMain.migrations))), []);
});

test('the base migrations are read from the base commit tree, relative to the application directory', async () => {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  if (head.status !== 0) return;
  // No trusted sibling checkout here, so the base commit tree is what gets read (CI has a real trusted sibling).
  const noTrusted = fileURLToPath(new URL('./no-trusted-checkout', import.meta.url));
  const names = await readBaseMigrations({ CI_BASE_SHA: head.stdout.trim() }, noTrusted);
  assert.ok(names instanceof Set && names.size > 100, 'the base tree lists the committed migrations');
  assert.equal(names.has('20261113151000_work_claim_terminal_admission_removed_v1.sql'), true);
});

// S1b: migration-verify checks the trusted base out with only scripts/ci, config and .github (sparse, cone mode, as
// actions/checkout does), so its migrations directory is not on disk; the names still come from its HEAD tree.
test('a sparse trusted checkout gives the same base migration names as a full one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drift-sparse-trusted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trusted = path.join(root, 'trusted');
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', trusted, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  };
  const migrations = path.join(trusted, 'apps', 'clued-cloud', 'supabase', 'migrations');
  await mkdir(migrations, { recursive: true });
  await mkdir(path.join(trusted, 'scripts', 'ci'), { recursive: true });
  for (const name of ['20260901120000_one.sql', '20260902120000_two.sql', '20261101000000_three.sql']) await writeFile(path.join(migrations, name), `-- ${name}` + String.fromCharCode(10));
  await writeFile(path.join(trusted, 'scripts', 'ci', 'ci-required-selection.mjs'), String.fromCharCode(10));
  spawnSync('git', ['init', '-q', trusted]);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const full = await readBaseMigrations({}, trusted);
  assert.deepEqual([...full].sort(), ['20260901120000_one.sql', '20260902120000_two.sql', '20261101000000_three.sql']);
  git('sparse-checkout', 'set', 'scripts/ci', 'config', '.github');
  assert.equal(existsSync(migrations), false, 'the sparse checkout leaves the migrations directory off disk');
  assert.deepEqual([...await readBaseMigrations({}, trusted)].sort(), [...full].sort());
});

test('unknown base migrations are an error, never an empty judgement', async () => {
  const noTrusted = fileURLToPath(new URL('./no-trusted-checkout', import.meta.url));
  await assert.rejects(readBaseMigrations({}, noTrusted), /base migrations are unknown/);
  await assert.rejects(readBaseMigrations({ CI_BASE_SHA: '0'.repeat(40) }, noTrusted), /base migrations are unknown/);
});
