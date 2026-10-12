import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyClockReader,credentialFingerprint} from './merge-admission-clock-bootstrap.mjs';
const id='10000000-0000-4000-8000-000000000001',scope='0597aa60-9b98-4da6-a4ab-63d7705b632f',queue='merge:tdoljyj/cross-memory-system:main';
const config={repository:'tdoljyj/cross-memory-system',scope:{project_id:scope,queue_ref:queue},bootstrap_clock_reader:{binding_id:id,credential_fingerprint:credentialFingerprint('clued_bnd_mock_only_reader')}};
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:config.repository,GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',CLUED_CONTEXT_READ_TOKEN:'clued_bnd_mock_only_reader'};
const pins={epoch_id:id,stream_id:id,clock_generation_id:id,foundation_digest:'a'.repeat(64),catalog_digest:'b'.repeat(64)};
const seal_pins={end_sequence:1,closing_us:'1791800001000000',catalog_digest:'b'.repeat(64)};
const server_auth={schema:'clued.clock-audit-transport-auth/1',status:'AUTHENTICATED_TARGET_READ',required_scope:'audit:read',context_key:'project:'+scope,queue_ref:queue,binding_scope_fingerprint:'c'.repeat(64),transport_definition_digest:'d'.repeat(64),contributor_count:2};
function fixture(transform=x=>x){const calls=[];return {calls,fetchImpl:async(url,init)=>{
 const input=JSON.parse(init.body),op=input.measurement.operation;calls.push({url,input,init});
 const measurement=op==='clock_open'?{kind:'epoch_snapshot_candidate',epoch_id:id,opening_us:'1791800000000000'}:op==='clock_seal'?{seal_id:id}:{status:'ok',has_more:false,events:[]};
 return Response.json(transform({status:'ok',operation:op,measurement,pins,seal_pins,server_auth},op));}};}
test('real flat typed transport opens, seals and reads only a bounded sample; no Source/T0 accepted',async()=>{
 const f=fixture(),r=await qualifyClockReader({env,config,fetchImpl:f.fetchImpl});
 assert.equal(r.status,'AUTHENTICATED_READER_OBSERVATION');assert.equal(r.candidate_epoch.opening_us,'1791800000000000');
 assert.equal(r.credential_fingerprint,credentialFingerprint(env.CLUED_CONTEXT_READ_TOKEN));
 assert.equal(JSON.stringify(r).includes(env.CLUED_CONTEXT_READ_TOKEN),false);assert.deepEqual([r.source_authenticated,r.official_metric,r.t0],[false,false,null]);
 assert.deepEqual(f.calls.map(x=>x.input.measurement.operation),['clock_open','clock_seal','clock_page']);
 assert.ok(f.calls.every(x=>x.input.context_key==='project:'+scope&&x.input.measurement.queue_ref===queue&&x.init.redirect==='error'));
 assert.equal(f.calls[2].input.measurement.limit,1);
});
test('non-main, external repository and missing credential refuse before network',async()=>{
 for(const e of [{...env,GITHUB_REF:'refs/heads/feature'},{...env,GITHUB_REPOSITORY:'other/repo'},{...env,GITHUB_ACTIONS:'false'},{...env,CLUED_CONTEXT_READ_TOKEN:''}]){
  const f=fixture(),r=await qualifyClockReader({env:e,config,fetchImpl:f.fetchImpl});assert.equal(r.status,'NOT_QUALIFIED');assert.equal(f.calls.length,0);}
});
test('audit refusal has no retry or authority fallback and no raw error/token output',async()=>{
 let n=0;const r=await qualifyClockReader({env,config,fetchImpl:async()=>{n++;return Response.json({secret:env.CLUED_CONTEXT_READ_TOKEN},{status:403});}});
 assert.equal(n,1);assert.equal(r.status,'NOT_QUALIFIED');assert.equal(JSON.stringify(r).includes(env.CLUED_CONTEXT_READ_TOKEN),false);
});
test('another credential is refused before network even if it is syntactically a Binding',async()=>{
 const f=fixture(),r=await qualifyClockReader({env:{...env,CLUED_CONTEXT_READ_TOKEN:'clued_bnd_not_the_accepted_reader'},config,fetchImpl:f.fetchImpl});
 assert.equal(r.status,'NOT_QUALIFIED');assert.equal(r.reason_code,'ACCEPTED_MINIMAL_READER_PIN_MISMATCH');assert.equal(f.calls.length,0);
});
test('missing contributors or wrong target/transport schema refuse before sealing',async()=>{
 for(const patch of [{contributor_count:0},{queue_ref:'merge:other/repo:main'},{context_key:'global'},{schema:'untrusted'},{binding_scope_fingerprint:'bad'}]){
  const f=fixture(x=>({...x,server_auth:{...x.server_auth,...patch}})),r=await qualifyClockReader({env,config,fetchImpl:f.fetchImpl});assert.equal(r.status,'NOT_QUALIFIED');assert.equal(f.calls.length,1);}
});
test('epoch pins and between-call Scope drift stay unqualified',async()=>{
 for(const change of [x=>({...x,pins:{...pins,epoch_id:'20000000-0000-4000-8000-000000000002'}}),x=>({...x,server_auth:{...server_auth,contributor_count:3}})]){
  const f=fixture((x,op)=>op==='clock_seal'?change(x):x),r=await qualifyClockReader({env,config,fetchImpl:f.fetchImpl});assert.equal(r.status,'NOT_QUALIFIED');}
});
test('oversized and invalid UTF8 response cannot become qualified',async()=>{
 for(const body of [new Uint8Array(512*1024+1),new Uint8Array([0xff,0xff])]){
  const r=await qualifyClockReader({env,config,fetchImpl:async()=>new Response(body)});assert.equal(r.status,'NOT_QUALIFIED');assert.equal(r.t0,null);}
});
