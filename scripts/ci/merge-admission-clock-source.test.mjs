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
