// Pure parts of the production-schema drift check (Task 2a5fdb66). The
// replay itself (two embedded PostgreSQL clusters) runs as the
// migration-verify CI check: `node scripts/production-schema-drift.mjs check`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { productionChain, catalogSqlPath, readSnapshot, SNAPSHOT_CONTRACT } from '../scripts/production-schema-chain.mjs';
import {
  SCHEMA_STATEMENT, buildSnapshot, compareFingerprints, deviationMatcher, diffIsEmpty, pendingReferenceFindings, relationAliases,
  repositoryOnlyObjects, runCheck, serializeSnapshot,
} from '../scripts/production-schema-drift.mjs';
import { md5 } from '../scripts/migration-ledger.mjs';

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
