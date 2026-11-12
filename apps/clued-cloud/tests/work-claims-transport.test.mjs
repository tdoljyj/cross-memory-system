import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { contractVersionOf } from '../scripts/verify-served-agent-contract.mjs';

// Task 6dfd7560: every resume reports the component versions the build was made from.
const CLUED_COMPONENTS = {
  schema: 'clued.components/1',
  versions: Object.fromEntries(JSON.parse(readFileSync(new URL('../../../config/clued-components.json', import.meta.url), 'utf8'))
    .components.map((c) => [c.id, String(c.version)])),
  source_commit: null,
};
const CONTRACT_SOURCE = (await readFile(new URL('../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const CONTRACT_VERSION = contractVersionOf(CONTRACT_SOURCE);
const CONTRACT_SHA256 = createHash('sha256').update(CONTRACT_SOURCE).digest('hex');

// Work Claim Admission v0.1, step 2: the five work-claim tools and the resume
// fold-in over the Worker transport. The database side is covered by
// currentness-work-claims-db.test.mjs; here every RPC is mocked.

const assets = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const enabled = { ...assets, PROJECT_VIEWS_V2: 'true', CLUED_WORK_CLAIMS_V1: 'true' };
const disabled = { ...assets, PROJECT_VIEWS_V2: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'w'.repeat(43)}`;
const oauthToken = 'account-or-legacy-oauth-token';
const WORK_TOOLS = ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_verify', 'clued_work_takeover'];
const require=createRequire(import.meta.url);

function mcp(token, name, args = {}, id = 1) {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
}
function list(token) {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}
function mockFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const rpc = /\/rpc\/([^/?]+)$/.exec(String(input))?.[1];
    const body = JSON.parse(init.body);
    calls.push({ rpc, body, tool: body.p_tool ?? null });
    return handler({ rpc, body, calls });
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

test('work claim tools are advertised only behind CLUED_WORK_CLAIMS_V1, with the right scopes and hints', async () => {
  const worker = await loadContinuityWorker();
  const on = (await (await worker.fetch(list(bindingToken), enabled, ctx)).json()).result.tools;
  const off = (await (await worker.fetch(list(bindingToken), disabled, ctx)).json()).result.tools;
  for (const name of WORK_TOOLS) {
    assert.ok(on.some((tool) => tool.name === name), `${name} advertised when enabled`);
    assert.ok(!off.some((tool) => tool.name === name), `${name} hidden when disabled`);
  }
  assert.equal(off.length + WORK_TOOLS.length, on.length, 'the flag adds exactly the five tools');
  const byName = Object.fromEntries(on.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.clued_work_verify._meta['clued/requiredScopes'], ['context:read']);
  assert.equal(byName.clued_work_verify.annotations.readOnlyHint, false, 'qualified CI resolve can bind a relation');
  assert.equal(byName.clued_work_verify.annotations.idempotentHint, true);
  assert.equal(byName.clued_work_verify.inputSchema.properties.pr_ref.pattern, '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$');
  assert.equal(byName.clued_work_verify.annotations.destructiveHint, false);
  for (const name of ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_takeover']) {
    assert.deepEqual(byName[name]._meta['clued/requiredScopes'], ['context:write'], name);
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.match(byName[name].description, /Required Clued scope: context:write\.$/);
  }
  assert.equal(byName.clued_work_takeover.annotations.destructiveHint, true, 'takeover supersedes another claim');
  assert.equal(byName.clued_work_claim.annotations.idempotentHint, true);
  assert.equal(byName.clued_work_renew.annotations.idempotentHint, false);
  assert.deepEqual(byName.clued_work_claim.inputSchema.required, ['task_id', 'write_set', 'idempotency_key', 'holder_label']);
  const alternatives=byName.clued_work_renew.inputSchema.anyOf;
  const normal=alternatives.at(-1);
  assert.deepEqual(normal.not,{required:['action']});
  assert.deepEqual(normal.required,['claim_id','fence','lease_version','progress_ref']);
  const commands=Object.fromEntries(alternatives.slice(0,-1).map(branch=>[branch.properties.action.const,branch.required]));
  for(const branch of alternatives) {
    assert.equal(branch.type,'object');assert.equal(branch.additionalProperties,false);
    for(const [name,definition] of Object.entries(byName.clued_work_renew.inputSchema.properties))
      if(name!=='action'&&name!=='terminal_release_ready') assert.deepEqual(branch.properties[name],definition,'complete branch preserves '+name);
    assert.equal(Object.hasOwn(branch.properties,'terminal_release_ready'),branch.properties.action?.const==='authorize_head');
  }
  assert.deepEqual(commands.prepare_handover,['action','claim_id','fence','holder_label','idempotency_key']);
  assert.deepEqual(commands.offer_handover,['action','request_id','lease_key']);
  assert.deepEqual(commands.accept_handover,['action','request_id','receiver_key']);
  assert.deepEqual(byName.clued_work_release.inputSchema.required, ['claim_id', 'fence', 'outcome']);
  const verifySchema=byName.clued_work_verify.inputSchema;
  assert.equal(verifySchema.type,'object');
  assert.equal(verifySchema.required,undefined,'claim_id belongs only to normal verify');
  assert.equal(verifySchema.additionalProperties,false);
  assert.equal(verifySchema.properties.scope.default,undefined,'Host union must never default an unknown resolve scope');
  assert.deepEqual(verifySchema.anyOf[0].required,['claim_id']);
  assert.deepEqual(verifySchema.anyOf[0].not,{required:['action']});
  assert.deepEqual(verifySchema.anyOf[1].required,['action','pr_ref','head_sha','base_sha','target_branch']);
  assert.deepEqual(verifySchema.anyOf[2].required,['action','scope','claim_id','fence','execution_epoch','lease_version','changed_paths','lease_key']);
  for(const branch of verifySchema.anyOf) {
    assert.equal(branch.type,'object');assert.equal(branch.additionalProperties,false);
    for(const name of Object.keys(branch.properties)) assert.ok(Object.hasOwn(verifySchema.properties,name),'outer Host properties preserve '+name);
  }
  assert.deepEqual(byName.clued_work_takeover.inputSchema.required, ['claim_id', 'idempotency_key', 'holder_label']);
  assert.deepEqual(byName.clued_work_release.inputSchema.properties.outcome.enum, ['completed', 'abandoned', 'draining']);
  for (const name of WORK_TOOLS) assert.equal(byName[name].inputSchema.additionalProperties, false, name);
  // Existing renewal/release compatibility remains; only the explicit holder
  // edit branch adds the private key to verification, never normal or resolve.
  for (const name of ['clued_work_renew', 'clued_work_release']) {
    assert.equal(byName[name].inputSchema.properties.lease_key.pattern, '^clued_lk_[0-9a-f]{64}$', name);
    const required=name==='clued_work_renew'?normal.required:byName[name].inputSchema.required;
    assert.ok(!required.includes('lease_key'), name);
  }
  for (const name of ['clued_work_claim', 'clued_work_takeover']) {
    assert.equal(byName[name].inputSchema.properties.lease_key, undefined, name);
  }
  assert.equal(verifySchema.properties.lease_key.pattern,'^clued_lk_[0-9a-f]{64}$');
  for(const branch of verifySchema.anyOf.slice(0,2)) assert.equal(branch.properties.lease_key,undefined);
  assert.ok(byName.clued_work_renew.inputSchema.properties.holder_session_ref);
  // The self-reported holder label (migration 20261005200000) on claim, takeover and renew.
  for (const name of ['clued_work_claim', 'clued_work_takeover', 'clued_work_renew']) {
    const props = byName[name].inputSchema.properties;
    assert.deepEqual([props.holder_label.maxLength, props.holder_client.maxLength, props.holder_session_title.maxLength],
      [200, 80, 200], name);
  }
  assert.match(byName.clued_work_renew.description, /work_claim_lease_key_required/);
  assert.match(byName.clued_work_claim.description, /lease_key is the claim's private key: keep it in this session only/);
  assert.match(byName.clued_work_claim.description, /A continuation takes none/);
  assert.match(byName.clued_work_release.inputSchema.properties.evidence_ref.description, /continue without a token/);
  assert.equal(byName.clued_work_claim._meta['clued/scopeEnforcement'], 'server-side');
});

test('verify schema keeps complete Host properties and closed normal/resolve/edit alternatives without a resolve scope default',async()=>{
  const worker=await loadContinuityWorker();
  const tools=(await (await worker.fetch(list(bindingToken),enabled,ctx)).json()).result.tools;
  const schema=tools.find(tool=>tool.name==='clued_work_verify').inputSchema;
  const Ajv=require('ajv');
  const ajv=new Ajv({allErrors:true,useDefaults:true,formats:{uuid:/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i}});
  const validate=ajv.compile(schema), [normal,resolve,edit]=schema.anyOf;
  const claim_id='22222222-2222-4222-8222-222222222222';
  const lookup={action:'resolve_pr_claim',pr_ref:'owner/repository#12',head_sha:'a'.repeat(40),base_sha:'b'.repeat(40),target_branch:'main'};
  const normalInput={claim_id,changed_paths:['source/file.mjs'],head_sha:'a'.repeat(7),base_sha:'b'.repeat(64),pr_ref:'owner/repository#0'};
  const editing={action:'verify_edit',scope:'global',claim_id,fence:2,execution_epoch:3,lease_version:4,
    changed_paths:['source/file.mjs'],lease_key:'clued_lk_'+'e'.repeat(64)};
  const project=(properties,input)=>Object.fromEntries(Object.entries(input).filter(([key])=>Object.hasOwn(properties,key)));
  const cases=[normalInput,lookup,{...lookup,read_only:true},{...lookup,read_only:false},{...lookup,scope:'global'},
    {...lookup,scope:'project:55555555-5555-4555-8555-555555555555'},editing,{...editing,changed_paths:[]}];
  for(const input of cases) {
    const fresh=structuredClone(input);
    assert.equal(validate(fresh),true,JSON.stringify(validate.errors));
    assert.deepEqual(fresh,input,'AJV must not inject a scope into resolve or otherwise alter business input');
    assert.deepEqual(project(schema.properties,input),input,'a Host that projects only outer properties loses no fields');
    const branch=input.action==='verify_edit'?edit:input.action?resolve:normal;
    assert.deepEqual(project(branch.properties,input),input,'independent alternative normalization loses no fields');
  }
  assert.equal(schema.properties.scope.default,undefined);assert.equal(resolve.properties.scope.default,undefined);
  assert.equal(edit.properties.scope.default,undefined,'editing always requires the actual explicit Task scope');
  assert.equal(normal.properties.scope.default,'global','legacy normal verification keeps its original context semantics');
  assert.equal(resolve.properties.claim_id,undefined);assert.equal(resolve.properties.changed_paths,undefined);
  assert.equal(resolve.properties.mechanical_paths_proven,undefined);
  assert.equal(resolve.properties.mechanical_policy,undefined);
  const published={text:'{}',sha256:'a'.repeat(64),base_sha:'b'.repeat(40),base_committed_at:'2026-11-12T00:00:00Z'};
  assert.equal(validate({...normalInput,mechanical_policy:published}),true,'CI admission publishes the trusted list on normal verification');
  assert.equal(validate({...normalInput,mechanical_policy:{...published,extra:true}}),false);
  assert.equal(validate({...lookup,mechanical_policy:published}),false);
  assert.equal(schema.properties.head_sha.pattern,'^[0-9a-f]{7,64}$');
  assert.equal(resolve.properties.head_sha.pattern,'^[0-9a-f]{40}$');
  assert.equal(resolve.properties.base_sha.pattern,'^[0-9a-f]{40}$');
  for(const key of ['action','pr_ref','head_sha','base_sha','target_branch']) {
    const missing={...lookup};delete missing[key];assert.equal(validate(missing),false,'resolve missing '+key);
  }
  for(const key of ['action','scope','claim_id','fence','execution_epoch','lease_version','changed_paths','lease_key']){
    const missing={...editing};delete missing[key];assert.equal(validate(missing),false,'edit missing '+key);
  }
  for(const extra of [{pr_ref:lookup.pr_ref},{head_sha:lookup.head_sha},{base_sha:lookup.base_sha},
    {target_branch:'main'},{mechanical_paths_proven:['generated/file']},{read_only:true},{terminal_release_ready:true},
    {fence:0},{execution_epoch:0},{lease_version:0},{lease_key:'invalid'}])
    assert.equal(validate({...editing,...extra}),false,JSON.stringify(extra));
  assert.equal(validate({...normalInput,lease_key:editing.lease_key}),false,'normal verification never takes a holder key');
  for(const bad of [{}, {...lookup,claim_id}, {...lookup,changed_paths:['source/file.mjs']},
    {...lookup,mechanical_paths_proven:['generated/file']}, {...lookup,lease_key:'clued_lk_'+'c'.repeat(64)},
    {...lookup,head_sha:'a'.repeat(7)}, {...lookup,base_sha:'b'.repeat(7)}, {...lookup,pr_ref:'owner/repository#0'},
    {...lookup,read_only:'true'}, {...lookup,action:'execution_current'}, {...lookup,target_branch:'main\nother'},
    {...lookup,unexpected_authority:true}, {...normalInput,read_only:true}, {...normalInput,action:'resolve_pr_claim'}])
    assert.equal(validate(structuredClone(bad)),false,JSON.stringify(bad));
  const mechanical={...normalInput,mechanical_paths_proven:['generated/file']};
  const hasMechanical=Object.hasOwn(normal.properties,'mechanical_paths_proven');
  assert.equal(validate(mechanical),hasMechanical,'only the mechanical successor advertises normal-only proof');
  if(hasMechanical) assert.deepEqual(schema.properties.mechanical_paths_proven,normal.properties.mechanical_paths_proven);
});

test('only authorize_head can declare holder terminal readiness through complete advertised Host schemas',async()=>{
  const worker=await loadContinuityWorker();
  const tools=(await (await worker.fetch(list(bindingToken),enabled,ctx)).json()).result.tools;
  const schema=tools.find(tool=>tool.name==='clued_work_renew').inputSchema;
  const Ajv=require('ajv'),ajv=new Ajv({allErrors:true,formats:{uuid:/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i}});
  const validate=ajv.compile(schema),auth=schema.anyOf.find(branch=>branch.properties.action.const==='authorize_head');
  const input={action:'authorize_head',scope:'global',claim_id:'22222222-2222-4222-8222-222222222222',fence:1,lease_version:1,
    lease_key:'clued_lk_'+'e'.repeat(64),repository:'owner/repository',head_sha:'f'.repeat(40),target_branch:'main',
    idempotency_key:'terminal-ready-fixture',terminal_release_ready:true};
  for(const ready of [true,false]){
    const business={...input,terminal_release_ready:ready};assert.equal(validate(business),true,JSON.stringify(validate.errors));
    for(const props of [schema.properties,auth.properties])
      assert.deepEqual(Object.fromEntries(Object.entries(business).filter(([key])=>Object.hasOwn(props,key))),business);
  }
  assert.equal(validate({...input,terminal_release_ready:'true'}),false);
  for(const branch of schema.anyOf.filter(branch=>branch!==auth)){
    assert.equal(branch.properties.terminal_release_ready,undefined,'other commands cannot declare or clear readiness');
    const action=branch.properties.action?.const;
    const invalid={...input,...(action?{action}:{progress_ref:'new-progress'})};if(!action)delete invalid.action;
    assert.equal(validate(invalid),false);
  }
});

test('real Worker Binding and OAuth preserve holder edit and readiness business fields but never use Host metadata as proof',async()=>{
  const worker=await loadContinuityWorker();
  const editing={action:'verify_edit',scope:'global',claim_id:'22222222-2222-4222-8222-222222222222',fence:1,execution_epoch:2,
    lease_version:3,lease_key:'clued_lk_'+'e'.repeat(64),changed_paths:['source/file.mjs']};
  const authorizing={action:'authorize_head',scope:'global',claim_id:editing.claim_id,fence:1,lease_version:3,lease_key:editing.lease_key,
    repository:'owner/repository',head_sha:'f'.repeat(40),target_branch:'main',idempotency_key:'worker-ready-fixture',terminal_release_ready:true};
  const {calls,restore}=mockFetch(({body})=>{
    assert.equal(Object.hasOwn(body.p_input,'_meta'),false);
    return Response.json(body.p_input.lease_key?{status:'ok',verdict:'ADMITTED',holder_edit_authorized:true}
      :{status:'rejected',error_code:'work_claim_lease_key_required'});
  });
  try{
    for(const token of [bindingToken,oauthToken])for(const [tool,business] of [['clued_work_verify',editing],['clued_work_renew',authorizing]]){
      const annotated={...business,_meta:{lease_key:'clued_lk_'+'a'.repeat(64),execution_epoch:99,terminal_release_ready:false}};
      const response=(await (await worker.fetch(mcp(token,tool,annotated),enabled,ctx)).json()).result;
      assert.equal(response.isError,false);assert.deepEqual(calls.at(-1).body.p_input,business);
      if(token===bindingToken)assert.equal(calls.at(-1).rpc,tool+'_v1');
      else{assert.equal(calls.at(-1).rpc,'clued_oauth_call');assert.equal(calls.at(-1).body.p_tool,tool);}
      const missing={...annotated};delete missing.lease_key;
      const denied=(await (await worker.fetch(mcp(token,tool,missing),enabled,ctx)).json()).result.structuredContent;
      assert.equal(denied.error_code,'work_claim_lease_key_required');assert.equal(Object.hasOwn(calls.at(-1).body.p_input,'lease_key'),false);
    }
  }finally{restore();}
});

test('real Worker Binding and OAuth resolve preserve omitted scope/claim and read_only while stripping Host metadata',async()=>{
  const worker=await loadContinuityWorker();
  const business={action:'resolve_pr_claim',pr_ref:'owner/repository#12',head_sha:'a'.repeat(40),base_sha:'b'.repeat(40),target_branch:'main'};
  const {calls,restore}=mockFetch(({body})=>{
    assert.equal(Object.hasOwn(body.p_input,'_meta'),false);
    assert.equal(Object.hasOwn(body.p_input,'scope'),false);
    assert.equal(Object.hasOwn(body.p_input,'claim_id'),false);
    assert.equal(Object.hasOwn(body.p_input,'lease_key'),false);
    return Response.json(body.p_input.head_sha?{status:'ok',binding_status:'unbound',scope:null,task_id:null,claim:null,
      auto_bound:false,receipt_id:null}:{status:'rejected',error_code:'work_claim_pr_binding_input_invalid'});
  });
  try {
    for(const token of [bindingToken,oauthToken]) for(const input of [business,{...business,read_only:true}]) {
      const annotated={...input,_meta:{scope:'global',claim_id:'22222222-2222-4222-8222-222222222222',
        read_only:false,head_sha:'c'.repeat(40),lease_key:'clued_lk_'+'d'.repeat(64),mechanical_paths_proven:['forged/file']}};
      const result=(await (await worker.fetch(mcp(token,'clued_work_verify',annotated),enabled,ctx)).json()).result;
      assert.equal(result.isError,false);assert.equal(result.structuredContent.binding_status,'unbound');
      const command=calls.at(-1);
      if(token===bindingToken) { assert.equal(command.rpc,'clued_work_verify_v1');assert.match(command.body.p_token_hash,/^[0-9a-f]{64}$/); }
      else { assert.equal(command.rpc,'clued_oauth_call');assert.equal(command.body.p_tool,'clued_work_verify'); }
      assert.deepEqual(command.body.p_input,input);
      const missing={...annotated};delete missing.head_sha;
      const denied=(await (await worker.fetch(mcp(token,'clued_work_verify',missing),enabled,ctx)).json()).result.structuredContent;
      assert.equal(denied.error_code,'work_claim_pr_binding_input_invalid');
      assert.equal(Object.hasOwn(calls.at(-1).body.p_input,'head_sha'),false,'Host metadata never supplies missing business proof');
    }
  } finally {restore();}
});

test('complete command alternatives preserve validation and Host-normalized private business fields', async () => {
  const worker=await loadContinuityWorker();
  const tools=(await (await worker.fetch(list(bindingToken),enabled,ctx)).json()).result.tools;
  const schema=tools.find(tool=>tool.name==='clued_work_renew').inputSchema;
  // Existing lockfile dependency, independent JSON Schema implementation.
  const Ajv=require('ajv');
  const ajv=new Ajv({allErrors:true,formats:{uuid:/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i}});
  const validate=ajv.compile(schema);
  const claim_id='22222222-2222-4222-8222-222222222222',request_id='33333333-3333-4333-8333-333333333333';
  const common={scope:'project:55555555-5555-4555-8555-555555555555',claim_id,fence:2,lease_version:3};
  const lease_key='clued_lk_'+'a'.repeat(64),receiver_key='clued_lk_'+'b'.repeat(64);
  const cases=[
    {...common,progress_ref:'receipt:fixture-progress'},
    {...common,action:'authorize_head',lease_key,repository:'owner/repository',head_sha:'c'.repeat(40),
      target_branch:'main',workflow:'clued-g4-database.yml',idempotency_key:'fixture-authorize'},
    {scope:common.scope,claim_id,fence:2,action:'prepare_handover',holder_label:'fixture receiver',idempotency_key:'fixture-prepare'},
    {scope:common.scope,action:'offer_handover',request_id,lease_key},
    {scope:common.scope,action:'accept_handover',request_id,receiver_key},
    {scope:common.scope,action:'cancel_handover',request_id,receiver_key},
    {scope:common.scope,action:'finish_handover',delivery_id:request_id,lease_key},
  ];
  const oldSchema={type:'object',properties:schema.properties,additionalProperties:false,oneOf:[
    {not:{required:['action']},required:schema.anyOf.at(-1).required},
    ...schema.anyOf.slice(0,-1).map(branch=>({properties:{action:branch.properties.action},required:branch.required})),
  ]};
  const oldValidate=ajv.compile(oldSchema);
  const oldWithoutNot=structuredClone(oldSchema);delete oldWithoutNot.oneOf[0].not;
  const newWithoutNot=structuredClone(schema);delete newWithoutNot.anyOf.at(-1).not;
  const withProgress={...cases[1],progress_ref:'head:'+ 'c'.repeat(40)};
  assert.equal(oldValidate(withProgress),true,'the former schema is valid with full JSON Schema semantics');
  const limitedOld=ajv.compile(oldWithoutNot);
  assert.equal(limitedOld(withProgress),false);
  assert.ok(limitedOld.errors.some(error=>error.keyword==='oneOf'),'ignoring not reproduces ambiguous alternatives');
  assert.equal(ajv.compile(newWithoutNot)(withProgress),true,'the adapted schema tolerates this limited Host');
  for(const input of [...cases,{...cases[1],progress_ref:'head:'+ 'c'.repeat(40)}]) {
    assert.equal(validate(input),true,JSON.stringify(validate.errors));
    const branch=schema.anyOf.find(branch=>branch.properties.action.const===input.action)??schema.anyOf.at(-1);
    // A Host may independently clamp an alternative's properties instead of
    // inheriting outer properties. Every exact business value must survive.
    const normalized=Object.fromEntries(Object.entries(input).filter(([key])=>Object.hasOwn(branch.properties,key)));
    assert.deepEqual(normalized,input);
  }
  for(const [index,key] of [[0,'progress_ref'],[1,'lease_key'],[1,'head_sha'],[2,'holder_label'],
    [3,'lease_key'],[4,'receiver_key'],[5,'request_id'],[6,'delivery_id']]) {
    const bad={...cases[index]};delete bad[key];assert.equal(validate(bad),false,`${cases[index].action??'renew'} missing ${key}`);
  }
  for(const bad of [{...cases[1],action:'unknown'}, {...cases[1],head_sha:'*'},
    {...cases[1],unexpected_authority:true}, {...cases[1],lease_key:'invalid'}, {...cases[0],fence:0}])
    assert.equal(validate(bad),false);
});

test('a disabled flag refuses the call before any database request', async () => {
  const worker = await loadContinuityWorker();
  const { calls, restore } = mockFetch(() => Response.json({ status: 'committed' }));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_work_claim', {
      task_id: '11111111-1111-4111-8111-111111111111', write_set: ['a/b'], idempotency_key: 'disabled-flag-test',
    }), disabled, ctx);
    const body = await response.json();
    assert.ok(body.error, JSON.stringify(body));
    assert.match(body.error.message, /work claims are disabled/);
    assert.equal(calls.length, 0, 'no RPC reached the database');
  } finally { restore(); }
});

test('Host annotations never enter strict private work-claim commands or supply missing proof, for Binding and OAuth callers', async () => {
  const worker = await loadContinuityWorker();
  const business = { action: 'authorize_head', scope: 'global', claim_id: '22222222-2222-4222-8222-222222222222',
    fence: 1, lease_version: 1, lease_key: `clued_lk_${'a'.repeat(64)}`, repository: 'owner/repository',
    head_sha: 'b'.repeat(40), target_branch: 'main', idempotency_key: 'host-meta-head-fixture' };
  const { calls, restore } = mockFetch(({ body }) => {
    assert.equal(Object.hasOwn(body.p_input, '_meta'), false);
    return Response.json(body.p_input.lease_key ? { status: 'committed', authorization_id: 'fixture' }
      : { status: 'rejected', error_code: 'work_claim_lease_key_required' });
  });
  try {
    for (const token of [bindingToken, oauthToken]) {
      const annotated = { ...business, _meta: { callId: 'host-call', clientInfo: { name: 'host' },
        authority: 'owner', scope: 'project:other', lease_key: `clued_lk_${'c'.repeat(64)}` } };
      const result = await (await worker.fetch(mcp(token, 'clued_work_renew', annotated), enabled, ctx)).json();
      assert.equal(result.result.structuredContent.status, 'committed');
      const command = calls.findLast(call => call.rpc === 'clued_work_renew_v1' || call.tool === 'clued_work_renew');
      assert.deepEqual(command.body.p_input, business);
      const { lease_key: ignored, ...missing } = annotated;
      const rejected = await (await worker.fetch(mcp(token, 'clued_work_renew', missing), enabled, ctx)).json();
      assert.equal(rejected.result.structuredContent.error_code, 'work_claim_lease_key_required');
      const last = calls.findLast(call => call.rpc === 'clued_work_renew_v1' || call.tool === 'clued_work_renew');
      assert.equal(Object.hasOwn(last.body.p_input, 'lease_key'), false);
      assert.equal(last.body.p_input.scope, 'global');
    }
  } finally { restore(); }
});

test('Binding and OAuth callers reach the same step-1 RPCs with the arguments passed through', async () => {
  const worker = await loadContinuityWorker();
  const expectedRpc = {
    clued_work_claim: 'clued_work_claim_v1', clued_work_renew: 'clued_work_renew_v1',
    clued_work_release: 'clued_work_release_v1', clued_work_verify: 'clued_work_verify_v1',
    clued_work_takeover: 'clued_work_takeover_v1',
  };
  const args = {
    clued_work_claim: { scope: 'global', task_id: '11111111-1111-4111-8111-111111111111',
      write_set: ['apps/clued-cloud/package.json', 'apps/clued-cloud/package-lock.json'],
      trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'], idempotency_key: 'host-a:task:claim', base_commit: 'f7ba6ff3',
      holder_label: 'npm audit fix · Claude Code · laptop' },
    clued_work_renew: { claim_id: '22222222-2222-4222-8222-222222222222', fence: 1, lease_version: 1, progress_ref: 'sha-1',
      lease_key: `clued_lk_${'a'.repeat(64)}`, holder_session_ref: 'session-new' },
    clued_work_release: { claim_id: '22222222-2222-4222-8222-222222222222', fence: 1, outcome: 'completed', evidence_ref: 'pr:450',
      lease_key: `clued_lk_${'a'.repeat(64)}` },
    clued_work_verify: { claim_id: '22222222-2222-4222-8222-222222222222', changed_paths: ['apps/clued-cloud/package.json'], head_sha: '3329174e', pr_ref: 'tdoljyj/cross-memory-system#482' },
    clued_work_takeover: { claim_id: '22222222-2222-4222-8222-222222222222', idempotency_key: 'host-b:claim:takeover',
      holder_label: 'takeover · Codex · desktop', holder_client: 'Codex' },
  };
  const { calls, restore } = mockFetch(({ rpc, body }) =>
    Response.json({ status: 'committed', echo: rpc ?? body.p_tool, lease_key: `clued_lk_${'b'.repeat(64)}`,
      claim: { claim_id: '22222222-2222-4222-8222-222222222222', holder_binding_id: 'b-1' } }));
  try {
    for (const name of WORK_TOOLS) {
      for (const token of [bindingToken, oauthToken]) {
        const response = await worker.fetch(mcp(token, name, args[name]), enabled, ctx);
        assert.equal(response.status, 200, await response.clone().text());
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.status, 'committed');
        // holder_binding_id is a different key from binding_id and survives sanitization.
        assert.equal(result.structuredContent.claim.holder_binding_id, 'b-1');
        // The lease key reaches the caller that took the claim.
        assert.equal(result.structuredContent.lease_key, `clued_lk_${'b'.repeat(64)}`);
        const call = calls.at(-1);
        if (token === bindingToken) {
          assert.equal(call.rpc, expectedRpc[name]);
          assert.match(call.body.p_token_hash, /^[0-9a-f]{64}$/);
          assert.equal(call.body.p_tool, undefined);
        } else {
          assert.equal(call.rpc, 'clued_oauth_call');
          assert.equal(call.body.p_tool, name);
        }
        assert.deepEqual(call.body.p_input, args[name]);
      }
    }
    assert.equal(calls.length, WORK_TOOLS.length * 2);
  } finally { restore(); }
});

test('page-free handover commands preserve private receiving proofs only in the authenticated tool response',async()=>{
  const worker=await loadContinuityWorker();
  const receiveKey=`clued_lk_${'c'.repeat(64)}`,leaseKey=`clued_lk_${'d'.repeat(64)}`;
  const requestId='77777777-7777-4777-8777-777777777777';
  const inputs=[
    {action:'prepare_handover',scope:'global',claim_id:'22222222-2222-4222-8222-222222222222',fence:2,
      holder_label:'private receiver',holder_session_ref:'receiver',idempotency_key:'receiving:exact-operation'},
    {action:'offer_handover',scope:'global',request_id:requestId,lease_key:leaseKey},
    {action:'accept_handover',scope:'global',request_id:requestId,receiver_key:receiveKey},
  ];
  const {calls,restore}=mockFetch(({body})=>Response.json(body.p_input.action==='prepare_handover'
    ?{status:'committed',request_id:requestId,receiver_key:receiveKey}
    :body.p_input.action==='offer_handover'?{status:'committed',request_id:requestId,state:'offered'}
      :{status:'pending',delivery_id:requestId,execution_epoch:3}));
  try{
    for(const input of inputs){
      const response=await worker.fetch(mcp(bindingToken,'clued_work_renew',input),enabled,ctx);
      const result=(await response.json()).result;
      assert.equal(result.isError,false);assert.deepEqual(calls.at(-1).body.p_input,input);
      assert.equal(calls.at(-1).rpc,'clued_work_renew_v1');
      assert.notEqual(calls.at(-1).body.p_token_hash,bindingToken);
      if(input.action==='prepare_handover')assert.equal(result.structuredContent.receiver_key,receiveKey);
      if(input.action==='accept_handover'){
        assert.equal(result.structuredContent.status,'pending');assert.equal('lease_key' in result.structuredContent,false);
      }
    }
  }finally{restore();}
});

test('a conflict or budget rejection is a structured result, not a transport error', async () => {
  const worker = await loadContinuityWorker();
  const rejection = { status: 'rejected', error_code: 'work_claim_conflict', conflicts: [{
    claim_id: '33333333-3333-4333-8333-333333333333', task_id: '11111111-1111-4111-8111-111111111111',
    holder_binding_id: 'b-2', holder_session_ref: 'session-b', status: 'ACTIVE', fence: 1,
    expires_at: '2026-10-01T08:00:00+00:00',
    overlap: { same_task: false, paths: ['apps/clued-cloud/package-lock.json'], trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'] },
  }] };
  const { restore } = mockFetch(() => Response.json(rejection));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_work_claim', {
      task_id: '44444444-4444-4444-8444-444444444444', write_set: ['apps/clued-cloud/**'], idempotency_key: 'host-c:task:claim',
    }), enabled, ctx);
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.isError, false, 'the Agent reads the conflict and stops; it is not a tool failure');
    assert.deepEqual(result.structuredContent, rejection);
    assert.equal(response.headers.get('www-authenticate'), null);
  } finally { restore(); }
});

test('a refusal over the per-Task cap carries the Owner Request with an absolute confirm_url', async () => {
  const worker = await loadContinuityWorker();
  const requestId = '55555555-5555-4555-8555-555555555555';
  const rejection = { status: 'rejected', error_code: 'work_claim_budget_exhausted', limit: 'max_claims_per_task_24h',
    max_claims_per_task_24h: 10, claims_last_24h: 10, task_id: '11111111-1111-4111-8111-111111111111',
    retry_after: '2026-10-04T00:00:00+00:00',
    owner_request: { request_id: requestId, action: 'work_claim.extra_claims', status: 'pending',
      resources: ['record:11111111-1111-4111-8111-111111111111'], confirm_path: `/confirm/${requestId}` } };
  const { restore } = mockFetch(() => Response.json(rejection));
  try {
    for (const token of [bindingToken, oauthToken]) {
      const response = await worker.fetch(mcp(token, 'clued_work_claim', {
        task_id: '11111111-1111-4111-8111-111111111111', write_set: ['a/b'], idempotency_key: 'over-the-cap',
      }), enabled, ctx);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.owner_request.confirm_url, `https://clued.test/confirm/${requestId}`);
      assert.equal(result.structuredContent.owner_request.confirm_path, `/confirm/${requestId}`);
    }
  } finally { restore(); }
});

test('resume folds in contract_version and the live claims; a failed claims read is reported, not thrown', async () => {
  const worker = await loadContinuityWorker();
  const resume = { status: 'restored', session_token: 'session-test', version: 7, active_constraints: [],
    currentness_evaluation: { overall: 'CURRENT', authoritative: true } };
  const claims = { status: 'ok', observed_at: '2026-10-01T06:00:00+00:00', scope: 'global',
    active_work_claims: [{ claim_id: '22222222-2222-4222-8222-222222222222', task_id: '11111111-1111-4111-8111-111111111111',
      holder_binding_id: 'b-1', write_set: ['apps/clued-cloud/package-lock.json', 'apps/clued-cloud/package.json'],
      trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'], fence: 1, status: 'ACTIVE', expires_at: '2026-10-01T08:00:00+00:00' }],
    work_claim_profile: { profile_id: 'work-claim-v1-default', lease_seconds: 7200 } };
  const expected = {
    ...resume,
    clued_components: CLUED_COMPONENTS,
    authority_capture_completeness: { state: 'unknown', basis: 'server_observes_only_writes_that_reached_clued', independent_of: 'currentness' },
    contract_version: CONTRACT_VERSION,
    agent_contract_sha256: CONTRACT_SHA256,
    active_work_claims: claims.active_work_claims,
    active_work_claim_count: 1,
    work_claim_profile: claims.work_claim_profile,
  };
  const handler = ({ rpc, body }) => Response.json(
    rpc === 'clued_work_claims_active_v1' || body.p_tool === 'clued_work_claims_active' ? claims : resume);

  // MCP and REST, Binding and OAuth: the same two RPCs, the same folded result.
  for (const token of [bindingToken, oauthToken]) {
    const { calls, restore } = mockFetch(handler);
    try {
      const viaMcp = await worker.fetch(mcp(token, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      assert.equal(viaMcp.status, 200, await viaMcp.clone().text());
      assert.deepEqual((await viaMcp.json()).result.structuredContent, expected);
      const viaRest = await worker.fetch(new Request('https://clued.test/v1/continuity/resume', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ context_key: 'global' }) }), enabled, ctx);
      assert.equal(viaRest.status, 200);
      assert.deepEqual(await viaRest.json(), expected);
      assert.equal(calls.length, 4);
      if (token === bindingToken) {
        assert.deepEqual(calls.map((c) => c.rpc), ['clued_mcp_restore', 'clued_work_claims_active_v1', 'clued_mcp_restore', 'clued_work_claims_active_v1']);
        assert.deepEqual(calls[1].body.p_input, { scope: 'global' });
        assert.equal(calls[1].body.p_token_hash, calls[0].body.p_token_hash);
      } else {
        assert.deepEqual(calls.map((c) => c.tool), ['clued_session_resume', 'clued_work_claims_active', 'clued_session_resume', 'clued_work_claims_active']);
        assert.deepEqual(calls[1].body.p_input, { scope: 'global' });
      }
    } finally { restore(); }
  }

  // A project context asks for claims readable in that project scope.
  {
    const { calls, restore } = mockFetch(handler);
    try {
      await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'project:55555555-5555-4555-8555-555555555555' }), enabled, ctx);
      assert.deepEqual(calls[1].body.p_input, { scope: 'project:55555555-5555-4555-8555-555555555555' });
    } finally { restore(); }
  }

  // Flag off: contract identity remains present and only the restore RPC runs.
  {
    const { calls, restore } = mockFetch(handler);
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), disabled, ctx);
      const result = (await response.json()).result.structuredContent;
      assert.equal(result.contract_version, CONTRACT_VERSION);
      assert.equal(result.agent_contract_sha256, CONTRACT_SHA256);
      assert.equal('active_work_claims' in result, false);
      assert.deepEqual(result.clued_components, CLUED_COMPONENTS, 'component versions do not depend on the work-claims flag');
      assert.equal(calls.length, 1);
    } finally { restore(); }
  }

  // Claims read fails (for example the migration is not applied yet): the
  // resume still succeeds and says the claims are unavailable.
  {
    const { restore } = mockFetch(({ rpc }) => rpc === 'clued_work_claims_active_v1'
      ? new Response(JSON.stringify({ code: '42883', message: 'function does not exist' }), { status: 404, headers: { 'content-type': 'application/json' } })
      : Response.json(resume));
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.contract_version, CONTRACT_VERSION);
      assert.equal(result.structuredContent.active_work_claims, null);
      assert.equal(result.structuredContent.active_work_claims_unavailable, true);
      assert.equal(result.structuredContent.session_token, 'session-test');
    } finally { restore(); }
  }

  // A resume that itself failed is passed through unchanged.
  {
    const { calls, restore } = mockFetch(() => Response.json({ error: 'resume_failed' }));
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      const result = (await response.json()).result;
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { error: 'resume_failed' });
      assert.equal(calls.length, 1, 'no claims read after a failed resume');
    } finally { restore(); }
  }
});

test('reconcile and other tools are not touched by the fold-in', async () => {
  const worker = await loadContinuityWorker();
  const reconcile = { status: 'current', currentness_state: 'CURRENT' };
  const { calls, restore } = mockFetch(() => Response.json(reconcile));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_session_reconcile', { session_token: 'session-test' }), enabled, ctx);
    const result = (await response.json()).result.structuredContent;
    assert.equal('contract_version' in result, false);
    assert.equal('active_work_claims' in result, false);
    assert.equal(calls.length, 1);
  } finally { restore(); }
});
