import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

function moduleAt(path) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports });
  return exports;
}
const auth = moduleAt('../lib/context-authorization.ts');
const model = moduleAt('../app/imprints/imprint-model.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const scope = resource_id => ({ resource_kind: 'scope', resource_id, environment: 'canonical', actions: ['read','write','close','restore','audit'] });
const P = 'project:11111111-1111-4111-8111-111111111111';
const context = environment => ({ resource_kind: 'context', resource_id: '22222222-2222-4222-8222-222222222222', environment,
  project_id: P.slice(8), project_name: 'Clued', context_name: '验收', actions: ['read','write','close','feedback_submit'] });

test('the three specified-scope examples submit only their exact selected identity, environment and operation', () => {
  const rows = [scope('global'),scope('profile'),scope(P),context('test'),context('preview')];
  for (const [row, preset, actions] of [[rows[1],'reader',['read']],[rows[2],'developer',['read','write']],[rows[3],'developer',['read','write']]]) {
    const selected = { [auth.resourceKey(row)]: auth.presetActions(row,preset) };
    assert.deepEqual(plain(auth.selectedResources(rows,selected)),[{resource_kind:row.resource_kind,resource_id:row.resource_id,environment:row.environment,actions}]);
  }
  assert.deepEqual(plain(auth.selectedResources(rows,auth.initialSelection(rows).selected)),[]);
  assert.equal(auth.resourceGroups(rows).find(group=>group.key===P.slice(8)).name,'Clued');
});

test('full policy is one real macro, presets cannot add an unselected resource, and both range switches clear precise choices', () => {
  const macro={...scope('contexts:*'),actions:['read','write','close','restore','audit','feedback_submit']};
  const rows=[macro,scope('profile'),context('test')]; const initial=auth.initialSelection(rows);
  assert.equal(initial.range,'all'); assert.deepEqual(plain(auth.selectedResources(rows,initial.selected)),[macro]);
  const specified=auth.changeRange(rows,'specified','full');assert.deepEqual(plain(specified),{});
  const custom={ [auth.resourceKey(rows[2])]:['write'] }; const edit=auth.applyPreset(rows,custom,'developer');
  assert.deepEqual(plain(auth.selectedResources(rows,edit)),[{resource_kind:'context',resource_id:rows[2].resource_id,environment:'test',actions:['read','write']}]);
  assert.deepEqual(Object.keys(auth.changeRange(rows,'all','reader')),[auth.resourceKey(macro)]);
  assert.deepEqual(plain(auth.presetActions(rows[2],'full')),['read','write','close','feedback_submit']);
  assert.deepEqual(plain(auth.availablePresets([{...macro,actions:['read','audit']}])),['reader']);
  assert.deepEqual(plain(auth.presetActions({...rows[2],actions:['write']},'reader')),[]);
});

test('specified-scope display orders profile, personal records and projects without changing authorization payloads', () => {
  const rows = [context('test'), scope('global'), scope(P), scope('profile'), context('preview')];
  const before = plain(rows);
  const selected = { [auth.resourceKey(rows[0])]: ['read'], [auth.resourceKey(rows[1])]: ['read', 'write'] };
  const payload = plain(auth.selectedResources(rows, selected));
  const groups = auth.resourceGroups(rows);
  assert.deepEqual(plain(groups.map(group => group.key)), ['personal', P.slice(8)]);
  assert.deepEqual(plain(groups[0].rows.map(row => row.resource_id)), ['profile', 'global']);
  assert.equal(groups[0].name, '个人资料与个人记录');
  assert.deepEqual(plain(groups[1].rows), [before[0], before[2], before[4]]);
  assert.deepEqual(plain(rows), before);
  assert.deepEqual(plain(auth.selectedResources(rows, selected)), payload);
  assert.deepEqual(plain(auth.authorizationDisplayOrder(rows)), [before[3], before[1], before[0], before[2], before[4]]);
  const preview = [{ context: P }, { context: 'global' }, { context: 'profile' }];
  assert.deepEqual(plain(auth.authorizationDisplayOrder(preview)), [preview[2], preview[1], preview[0]]);
  assert.deepEqual(plain(preview), [{ context: P }, { context: 'global' }, { context: 'profile' }]);
});

test('verified Record display does not promote a candidate, retained history, legacy Record or Event', () => {
  const current={record_type:'note',authoritative:true,record_currentness:'CURRENT',source_semantics:'canonical_record'};
  assert.equal(model.immediateAuthoritativeRecord(current),true);
  for(const extra of [{authoritative:false},{authoritative:undefined},{record_currentness:'UNKNOWN'},{record_currentness:'STALE'},
    {record_currentness:'CONFLICT'},{record_currentness:'HISTORY'},{source_kind:'development',qualification:'candidate'},
    {source_semantics:'legacy_compatibility'},{record_type:'event'}]) assert.equal(model.immediateAuthoritativeRecord({...current,...extra}),false);
  assert.equal(model.VIEW_KEYS.length,8);
});

test('future markers use their own action vocabulary and stay outside precise resource groups', () => {
  const futureRecords = scope('owned-project-records:future');
  const futureContexts = { ...scope('owned-project-contexts:future'), actions: ['read', 'write', 'close', 'feedback_submit', 'restore', 'audit'] };
  const rows = [futureRecords, futureContexts, scope('profile'), context('test')];
  assert.equal(auth.isFuturePolicy(futureRecords), true);
  assert.equal(auth.isMacro(futureContexts), true);
  assert.equal(auth.resourceTitle(futureRecords), '未来项目记录');
  assert.equal(auth.resourceTitle(futureContexts), '未来项目上下文');
  assert.deepEqual(plain(auth.requestedResources(rows, ['context:read', 'context:write', 'audit:read'])[1].actions), ['read', 'write', 'close', 'feedback_submit']);
  assert.deepEqual(plain(auth.resourceGroups(rows).flatMap(group => group.rows).map(row => row.resource_id)), ['profile', rows[3].resource_id]);
});
