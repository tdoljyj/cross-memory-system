import assert from 'node:assert/strict';
import test from 'node:test';
import { timestampMicros, validateJournal, emptyReplayState, applyTransaction, queueAt,
  queueDepthCandidate } from './merge-admission-measurement-history.mjs';
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002';
const STREAM = '00000000-0000-4000-8000-000000000003', DIGEST = 'a'.repeat(64), REF = 'merge:owner/repo:main';
const at = seconds => new Date(Date.UTC(2026,9,11)+seconds*1000).toISOString();
const policy = { merge_slot_seconds:2700,merge_slot_running_seconds:5400,merge_slot_green_seconds:1800 };
const claim = (id=A, joined=0) => ({ claim_id:id,task_id:STREAM,context_key:'global',fence:1,status:'ACTIVE',
  expires_at:at(20000),merge_queued_at:at(joined),merge_slot_at:at(joined),merge_slot_ci_at:null,
  merge_slot_ci_state:null,merge_slot_hard_cap_seconds:null,merge_refs:[REF],bound_pr:'owner/repo#1',admitted_heads:[] });
const state = (...claims) => ({ claims:new Map(claims.map(c=>[c.claim_id,c])),markers:new Map(),policy });
const event = (sequence,kind,payload,seconds,transaction_id='1') => ({sequence,kind,payload,recorded_at:at(seconds),
  transaction_id,source_digest:DIGEST,context_key:'global',object_key:kind==='claim'?payload.claim_id:kind==='queue_marker'?payload.merge_ref:'fifo-v1'});
const fixture = () => ({status:'ok',stream_id:STREAM,source_digest:DIGEST,after_sequence:0,end_sequence:3,
  next_sequence:3,has_more:false,events:[event(1,'policy',{profile:policy},0),event(2,'claim',claim(),0),
    event(3,'claim',{...claim(),status:'RELEASED'},10000,'2')]});
const validate = p => validateJournal(JSON.stringify(p),{expectedSourceDigest:DIGEST,expectedStream:STREAM});
test('microseconds and UTC offsets are preserved, impossible calendar dates are refused',()=>{
  assert.equal(timestampMicros('2026-10-11T00:00:00.000002Z')-timestampMicros('2026-10-11T00:00:00.000001Z'),1n);
  assert.equal(timestampMicros('2026-10-11T08:00:00.000001+08:00'),timestampMicros('2026-10-11T00:00:00.000001Z'));
  assert.throws(()=>timestampMicros('2026-02-30T00:00:00Z'));
});
test('complete journal validates integrity but never invents provenance or official status',()=>{
  const r=validate(fixture());assert.equal(r.status,'INTEGRITY_VALIDATED');assert.equal(r.groups.length,2);
  assert.equal(r.official_metric,false);assert.equal(r.provenance_verified,false);
});
test('missing sequence, moving source/stream and unclosed pages are not measured',()=>{
  for(const change of [p=>p.events.pop(),p=>p.events[1].sequence++,p=>p.source_digest='b'.repeat(64),
    p=>p.events[1].source_digest='b'.repeat(64),p=>p.stream_id=A,p=>p.has_more=true]){
    const p=fixture();change(p);assert.equal(validate(p).value,null);
  }
});
test('interleaved transaction identities and regressed recorded clocks are refused',()=>{
  const p=fixture();p.events.push(event(4,'claim',claim(B),10001,'1'));p.end_sequence=p.next_sequence=4;
  assert.equal(validate(p).reason,'transaction_interleaved');
  p.events.pop();p.end_sequence=p.next_sequence=3;p.events[2].recorded_at=at(-1);
  assert.equal(validate(p).reason,'event_time_regression');
});
test('one failed transaction projection never exposes an intermediate state',()=>{
  const s=emptyReplayState();const bad={events:[event(1,'policy',{profile:policy},0),event(2,'claim',{...claim(),fence:0},0)]};
  assert.throws(()=>applyTransaction(s,bad));assert.equal(s.policy,null);assert.equal(s.claims.size,0);
});
test('base FIFO promotes the next entry on the original renewal deadline',()=>{
  const s=state(claim(A,0),claim(B,10));
  assert.equal(queueAt(s,REF,timestampMicros(at(2699))).depth,2);
  const q=queueAt(s,REF,timestampMicros(at(2700)));assert.equal(q.depth,1);assert.equal(q.head.claim_id,B);
  assert.equal(q.head.since,timestampMicros(at(2700)));
});
test('running/green clocks only apply from the actual head start and hard cap still wins',()=>{
  const c={...claim(),merge_slot_ci_state:'running',merge_slot_ci_at:at(2000),merge_slot_hard_cap_seconds:7200};
  assert.equal(queueAt(state(c),REF,timestampMicros(at(7000))).head.until,timestampMicros(at(7200)));
  const old={...claim(B,10),merge_slot_ci_state:'running',merge_slot_ci_at:at(20)};
  assert.equal(queueAt(state(claim(A),old),REF,timestampMicros(at(2700))).head.until,timestampMicros(at(5400)));
});
test('expired waiting entries remain counted while a live head exists, matching the existing kernel',()=>{
  const waiting={...claim(B,10),expires_at:at(20)};
  assert.equal(queueAt(state(claim(A),waiting),REF,timestampMicros(at(100))).depth,2);
  assert.equal(queueAt(state(claim(A),waiting),REF,timestampMicros(at(2700))).depth,0);
});
test('departing-head marker eliminates old positions and seeds the next head start',()=>{
  const s=state(claim(A),claim(B,10));s.markers.set(REF,{merge_ref:REF,head_left_at:at(100),left_queued_at:at(0),left_claim_id:A});
  const q=queueAt(s,REF,timestampMicros(at(101)));assert.equal(q.depth,1);assert.equal(q.head.claim_id,B);
  assert.equal(q.head.since,timestampMicros(at(100)));
});
test('microsecond FIFO ordering is not replaced by UUID ordering within a millisecond',()=>{
  const a={...claim(A),merge_queued_at:'2026-10-11T00:00:00.000002Z'};
  const b={...claim(B),merge_queued_at:'2026-10-11T00:00:00.000001Z'};
  assert.equal(queueAt(state(a,b),REF,timestampMicros(at(1))).head.claim_id,B);
});
test('closed observation window computes p95 with clock-only head lapses and includes empty intervals',()=>{
  const v=validate(fixture());const r=queueDepthCandidate(v,{queueRef:REF,start:at(0),end:at(10000)});
  assert.equal(r.status,'CALCULATION_CANDIDATE');assert.equal(r.value,1);assert.equal(r.official_metric,false);
  assert.equal(r.provenance_verified,false);
  assert.deepEqual(r.distribution,[{depth:0,duration_us:'7300000000'},{depth:1,duration_us:'2700000000'}]);
});
test('never extrapolate a later window beyond observed source closure',()=>{
  const r=queueDepthCandidate(validate(fixture()),{queueRef:REF,start:at(0),end:at(10001)});
  assert.equal(r.value,null);assert.equal(r.reason,'window_not_closed_by_source_observations');
});
test('invalid options fail closed instead of throwing outside the validation boundary',()=>{
  for (const options of [null, [], 1, 'options']) {
    assert.equal(validateJournal(JSON.stringify(fixture()), options).status, 'NOT_MEASURED');
    assert.equal(queueDepthCandidate(validate(fixture()), options).status, 'NOT_MEASURED');
  }
});
