import assert from 'node:assert/strict';
import test from 'node:test';
import { proveDiscretePercentileCandidate as prove } from './merge-admission-clock-source.mjs';
const interval = (a,b) => ({start_us:String(a),end_us:String(b)});
const segment = (a,b,depth) => ({...interval(a,b),depth});
const input = (segments,uncertainty=[],end=100) => ({start_us:'0',end_us:String(end),segments,uncertainty});

test('94–96 transition does not choose either permitted percentile', () => {
  const p=prove(input([segment(0,94,0),segment(94,100,1)],[interval(94,96)]));
  assert.equal(p.status,'NOT_QUALIFIED'); assert.equal(p.value,null);
  assert.equal(p.reason,'conservative_bounds_do_not_prove_unique_percentile');
});
test('a sufficient margin proves one discrete candidate while keeping provenance false', () => {
  const p=prove(input([segment(0,98,0),segment(98,100,1)],[interval(98,99)]));
  assert.equal(p.status,'UNIQUE_VALUE_CANDIDATE'); assert.equal(p.value,0);
  assert.equal(p.source_authenticated,false); assert.equal(p.official_metric,false);
});
test('exact 95-percent threshold uses >= at k and < at its predecessor', () => {
  assert.equal(prove(input([segment(0,95,0),segment(95,100,1)])).value,0);
  assert.equal(prove(input([segment(0,94,0),segment(94,100,1)])).value,1);
});
test('overlapping uncertainty is unioned and clipped to the window', () => {
  const p=prove(input([segment(0,100,0)],[interval(90,96),interval(94,104)]));
  assert.equal(p.uncertainty_union_us,'10');
});
test('no missing or overlapping partition is accepted', () => {
  for(const seg of [[segment(0,40,0),segment(41,100,1)],[segment(0,70,0),segment(60,100,1)],[]])
    assert.equal(prove(input(seg)).status,'NOT_QUALIFIED');
});
test('invalid options and an injected provenance assertion cannot unlock a metric', () => {
  for(const p of [null,{}, {...input([segment(0,100,0)]),official_metric:true},
    input([segment(0,100,-1)]),input([segment(0,100,0)],[interval(10,9)])]) {
    assert.equal(prove(p).status,'NOT_QUALIFIED'); assert.equal(prove(p).official_metric,false);
  }
});
test('integer microseconds remain exact beyond Number safe-integer range', () => {
  const start=9007199254740993000n,end=start+100n;
  const p=prove({start_us:String(start),end_us:String(end),
    segments:[segment(start,end,3)],uncertainty:[]});
  assert.equal(p.value,3); assert.equal(p.duration_us,'100');
});
test('every claimed value matches exhaustive permissible single-transition placements', () => {
  for(let lo=1;lo<100;lo++) for(let hi=lo;hi<=100;hi++) {
    const p=prove(input([segment(0,lo,0),segment(lo,100,1)],[interval(lo,hi)]));
    if(p.status==='UNIQUE_VALUE_CANDIDATE') {
      for(let commit=lo;commit<=hi;commit++) assert.equal(p.value,commit>=95?0:1,`${lo}/${hi}/${commit}`);
    }
  }
});

import {integrateClockSourceCandidate as read} from './merge-admission-clock-source.mjs';
function sealedEmpty(){const digest='a'.repeat(64),catalog='b'.repeat(64),queue='merge:owner/repo:main';return {
 status:'ok',stream_id:'10000000-0000-4000-8000-000000000001',source_digest:digest,after_sequence:0,next_sequence:0,end_sequence:0,has_more:false,
 candidate_ready:true,events:[],clock_samples:[],
 epoch:{epoch_id:'10000000-0000-4000-8000-000000000002',stream_id:'10000000-0000-4000-8000-000000000001',queue_ref:queue,
 clock_generation_id:'10000000-0000-4000-8000-000000000003',start_sequence:0,opening_us:'1000',foundation_digest:digest,catalog_digest:catalog,
 initial_events:[{kind:'policy',object_key:'fifo-v1',context_key:'global',payload:{profile:{merge_slot_seconds:1,merge_slot_running_seconds:1,merge_slot_green_seconds:1}}}]},
 seal:{seal_id:'10000000-0000-4000-8000-000000000004',epoch_id:'10000000-0000-4000-8000-000000000002',end_sequence:0,closing_us:'1100',catalog_digest:catalog,
 raw_regression:false,sample_gap:false,ddl_tainted:false},observation_seals:[{end_sequence:0,closing_us:'1100'}],coverage_manifest:{queue_ref:queue,event_count:0}};}
const invoke=p=>read(JSON.stringify([p]),JSON.stringify({expectedCatalogDigest:p.epoch.catalog_digest,expectedFoundationDigest:p.source_digest,queueRef:p.epoch.queue_ref}));
test('closed complete target state permits calculation without source/transport authority',()=>{const r=invoke(sealedEmpty());assert.equal(r.status,'UNIQUE_VALUE_CANDIDATE');assert.equal(r.value,0);assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);});
test('a missing clock witness or mismatched target manifest cannot become a zero metric',()=>{for(const change of [p=>p.seal.sample_gap=true,p=>p.coverage_manifest.event_count=1,p=>p.observation_seals=[]]){const p=sealedEmpty();change(p);const r=invoke(p);assert.equal(r.status,'NOT_QUALIFIED');assert.equal(r.value,null);}});
test('raw-only boundary rejects active objects and reports a fixed malformed reason',()=>{const r=read(new Proxy({}, {get(){throw 'do_not_echo';}}),'{}');assert.equal(r.status,'NOT_QUALIFIED');assert.equal(JSON.stringify(r).includes('do_not_echo'),false);assert.equal(read('{','{}').status,'NOT_QUALIFIED');});

// Complete synthetic source packets exercise the existing raw-reader boundary;
// they never assert authenticated provenance or an official observation.
const wireTime=value=>{
  const us=BigInt(value),seconds=us/1000000n;
  return new Date(Number(seconds)*1000).toISOString().slice(0,19)+'.'+String(us%1000000n).padStart(6,'0')+'Z';
};
const queueClaim=(index,changes={})=>({
  claim_id:'20000000-0000-4000-8000-'+String(index).padStart(12,'0'),fence:1,status:'ACTIVE',
  merge_refs:['merge:owner/repo:main'],merge_queued_at:wireTime(0),merge_slot_at:wireTime(0),
  merge_slot_ci_at:null,merge_slot_ci_state:null,merge_slot_hard_cap_seconds:null,
  expires_at:wireTime(2000000),...changes
});
function statePacket(initial,transactions,{from=1000,to=1100,upper=null}={}){
  const p=sealedEmpty();p.epoch.opening_us=String(from);p.seal.closing_us=String(to);
  const claimEvent=c=>({kind:'claim',object_key:c.claim_id,context_key:'global',payload:c});
  p.epoch.initial_events.push(...initial.map(claimEvent));
  let sequence=0;
  for(let tx=0;tx<transactions.length;tx++)for(const {claim,raw} of transactions[tx]){
    sequence++;const transaction_id=String(tx+1);
    p.events.push({...claimEvent(claim),sequence,transaction_id,recorded_at:wireTime(raw),source_digest:p.source_digest});
    p.clock_samples.push({sequence,transaction_id,raw_us:String(raw)});
  }
  p.next_sequence=p.end_sequence=p.seal.end_sequence=p.coverage_manifest.event_count=sequence;
  p.observation_seals=[...(upper===null?[]:[{end_sequence:sequence,closing_us:String(upper)}]),{end_sequence:sequence,closing_us:String(to)}];
  return p;
}

test('state-only renewal leaves one depth proved despite a wide commit interval',()=>{
  const c=queueClaim(1),p=statePacket([c],[[{claim:{...c,expires_at:wireTime(3000000)},raw:1020}]],{upper:1080});
  const r=invoke(p);assert.equal(r.status,'UNIQUE_VALUE_CANDIDATE');assert.equal(r.value,1);
  assert.equal(r.uncertainty_union_us,'60');assert.equal(r.requires_complete_sealed_clock_qualified_source,true);assert.equal(r.source_authenticated,false);assert.equal(r.official_metric,false);assert.equal(r.t0,null);
});

test('a one-to-two change remains on the same side of the p95 candidate threshold',()=>{
  const r=invoke(statePacket([queueClaim(1)],[[{claim:queueClaim(2),raw:1020}]],{upper:1080}));
  assert.equal(r.status,'UNIQUE_VALUE_CANDIDATE');assert.equal(r.value,2);
  const k=r.cdf.find(x=>x.depth===2);assert.equal(k.lower_le_duration_us,'100');assert.equal(k.previous_upper_le_duration_us,'80');
});

test('a genuine threshold-crossing commit interval remains unknown',()=>{
  const r=invoke(statePacket([],[[{claim:queueClaim(1),raw:1094}]],{upper:1096}));
  assert.equal(r.status,'NOT_QUALIFIED');assert.equal(r.reason,'conservative_bounds_do_not_prove_unique_percentile');assert.equal(r.value,null);
});

test('the state envelope cuts both pre- and post-transaction deterministic expiry boundaries',()=>{
  const c=queueClaim(1,{expires_at:wireTime(1050)});
  const r=invoke(statePacket([c],[[{claim:{...c,expires_at:wireTime(1060)},raw:1020}]],{upper:1080}));
  assert.equal(r.status,'UNIQUE_VALUE_CANDIDATE');assert.equal(r.value,1);
  assert.equal(r.cdf.find(x=>x.depth===0).lower_le_duration_us,'40');
  assert.equal(r.cdf.find(x=>x.depth===1).previous_upper_le_duration_us,'50');
});

test('whole transaction source members never expose an intermediate queue state',()=>{
  const c=queueClaim(1),p=statePacket([],[[{claim:c,raw:1030},{claim:{...c,status:'RELEASED'},raw:1040}]],{upper:1090});
  const r=invoke(p);assert.equal(r.status,'UNIQUE_VALUE_CANDIDATE');assert.equal(r.value,0);assert.equal(r.transaction_count,1);
  assert.equal(r.commit_intervals[0].first_sequence,1);assert.equal(r.commit_intervals[0].last_sequence,2);assert.equal(r.commit_intervals[0].affects_queue,false);
});

test('a state proof cannot salvage missing members, interleaved transactions, clock overlap or impossible seals',()=>{
  const p=statePacket([],[[{claim:queueClaim(1),raw:1020}],[{claim:queueClaim(2),raw:1040}],[{claim:queueClaim(3),raw:1060}]]);
  for(const mutate of [x=>x.clock_samples.pop(),x=>x.events[2].transaction_id=x.events[0].transaction_id,
    x=>x.clock_samples[1].raw_us='1010',x=>x.events[1].sequence++,
    x=>x.observation_seals.unshift({end_sequence:1,closing_us:'1010'})]){
    const bad=structuredClone(p);mutate(bad);const r=invoke(bad);assert.equal(r.status,'NOT_QUALIFIED');assert.equal(r.value,null);
  }
});

test('state-envelope claims agree with exhaustive legal microsecond commit placements',()=>{
  for(const mode of ['enter','leave'])for(let lo=0;lo<=20;lo++)for(let hi=lo;hi<=20;hi++){
    const c=queueClaim(1),initial=mode==='enter'?[]:[c],after=mode==='enter'?c:{...c,status:'RELEASED'};
    const p=statePacket(initial,[[{claim:after,raw:1000+lo}]],{to:1020,upper:1000+hi});
    const allowed=new Set();for(let commit=lo;commit<=hi;commit++){
      const zeroDuration=mode==='enter'?commit:20-commit;allowed.add(zeroDuration*100>=20*95?0:1);
    }
    const r=invoke(p);
    if(allowed.size===1){assert.equal(r.status,'UNIQUE_VALUE_CANDIDATE',`${mode}/${lo}/${hi}`);assert.equal(r.value,[...allowed][0]);}
    else {assert.equal(r.status,'NOT_QUALIFIED',`${mode}/${lo}/${hi}`);assert.equal(r.value,null);}
  }
});