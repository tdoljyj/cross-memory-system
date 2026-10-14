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

test('verified Record display does not promote a candidate, retained history, legacy Record or Event', () => {
  const current={record_type:'note',authoritative:true,record_currentness:'CURRENT',source_semantics:'canonical_record'};
  assert.equal(model.immediateAuthoritativeRecord(current),true);
  for(const extra of [{authoritative:false},{authoritative:undefined},{record_currentness:'UNKNOWN'},{record_currentness:'STALE'},
    {record_currentness:'CONFLICT'},{record_currentness:'HISTORY'},{source_kind:'development',qualification:'candidate'},
    {source_semantics:'legacy_compatibility'},{record_type:'event'}]) assert.equal(model.immediateAuthoritativeRecord({...current,...extra}),false);
  assert.equal(model.VIEW_KEYS.length,8);
});
