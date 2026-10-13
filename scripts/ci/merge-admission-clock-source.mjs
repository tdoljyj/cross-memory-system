// Pure clock-source validation and bounded discrete percentile calculation.
// Source/transport acceptance is provided by the authenticated collector.
function integer(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error('invalid_microseconds');
  return BigInt(value);
}

export function proveDiscretePercentileCandidate(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['start_us','end_us','segments','uncertainty'].includes(k)))
      throw Error('invalid_input');
    const start = integer(input.start_us), end = integer(input.end_us);
    if (start >= end || !Array.isArray(input.segments) || !Array.isArray(input.uncertainty))
      throw Error('invalid_window');
    const duration = end - start, depths = new Map(); let cursor = start;
    for (const segment of input.segments) {
      if (!segment || Object.keys(segment).sort().join(',') !== 'depth,end_us,start_us') throw Error('invalid_segment');
      const left = integer(segment.start_us), right = integer(segment.end_us);
      if (left !== cursor || right <= left || right > end ||
        !Number.isSafeInteger(segment.depth) || segment.depth < 0) throw Error('segment_partition_invalid');
      depths.set(segment.depth, (depths.get(segment.depth) ?? 0n) + right - left); cursor = right;
    }
    if (cursor !== end) throw Error('segment_partition_incomplete');
    const intervals = input.uncertainty.map(interval => {
      if (!interval || Object.keys(interval).sort().join(',') !== 'end_us,start_us') throw Error('invalid_interval');
      const left = integer(interval.start_us), right = integer(interval.end_us);
      if (right < left) throw Error('interval_reversed');
      return [left > start ? left : start, right < end ? right : end];
    }).filter(([left,right]) => right > left).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    // Union, not sum: overlapping uncertainty cannot count the same time twice.
    let delta = 0n, left = null, right = null;
    for (const [a,b] of intervals) {
      if (left === null) { left = a; right = b; }
      else if (a <= right) { if (b > right) right = b; }
      else { delta += right - left; left = a; right = b; }
    }
    if (left !== null) delta += right - left;
    let cumulative = 0n; const cdf = [];
    for (const depth of [...depths.keys()].sort((a,b) => a-b)) {
      const previous = cumulative; cumulative += depths.get(depth);
      const lower = cumulative > delta ? cumulative-delta : 0n;
      const previousUpper = previous+delta < duration ? previous+delta : duration;
      cdf.push({depth,candidate_le_duration_us:cumulative.toString(),
        lower_le_duration_us:lower.toString(),previous_upper_le_duration_us:previousUpper.toString()});
      // Exact inequalities for the left-continuous discrete 95th percentile.
      // A common k across every permitted transition time is a proof candidate,
      // not an estimate selected from the inside-transaction observation times.
      if (lower*100n >= duration*95n && previousUpper*100n < duration*95n) {
        return {status:'UNIQUE_VALUE_CANDIDATE',value:depth,
          duration_us:duration.toString(),uncertainty_union_us:delta.toString(),cdf,
          source_authenticated:false,official_metric:false,
          requires_complete_sealed_clock_qualified_source:true};
      }
    }
    return {status:'NOT_QUALIFIED',reason:'conservative_bounds_do_not_prove_unique_percentile',value:null,
      duration_us:duration.toString(),uncertainty_union_us:delta.toString(),cdf,
      source_authenticated:false,official_metric:false};
  } catch (error) {
    return {status:'NOT_QUALIFIED',reason:error.message,value:null,source_authenticated:false,official_metric:false};
  }
}

// Pure integration candidate: raw JSON packets only; no network, credentials,
// authorization claim or production T0. Uses the actual foundation FIFO replay
// and independently reviewed conservative percentile proof unchanged.
import {timestampMicros,emptyReplayState,applyTransaction,queueAt} from './merge-admission-measurement-history.mjs';
const sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const no=reason=>({status:'NOT_QUALIFIED',value:null,reason,source_authenticated:false,official_metric:false,t0:null});
const micro=value=>{if(typeof value!=='string'||! /^(0|[1-9][0-9]*)$/.test(value)||value.length>24)throw Error();return BigInt(value);};
const seq=value=>{if(!Number.isSafeInteger(value)||value<0||value>100000)throw Error();return value;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Precisely the state read by the foundation's queueAt for this merge ref.
// Receipt-only transactions and irrelevant/fence-only claim changes cannot
// change queue depth; they do not contribute invented time uncertainty.
const queueState=(state,queueRef)=>{
  const ref=queueRef.toLowerCase();
  return JSON.stringify({policy:state.policy&&[state.policy.merge_slot_seconds,state.policy.merge_slot_running_seconds,state.policy.merge_slot_green_seconds],
    marker:state.markers.get(ref)??null,
    claims:[...state.claims.values()].filter(c=>['ACTIVE','DRAINING'].includes(c.status)&&c.merge_queued_at!==null&&c.merge_refs.some(x=>x.toLowerCase()===ref))
      .sort((a,b)=>a.claim_id<b.claim_id?-1:a.claim_id>b.claim_id?1:0).map(c=>[c.claim_id,c.expires_at,c.merge_queued_at,c.merge_slot_at,
        c.merge_slot_ci_at,c.merge_slot_ci_state,c.merge_slot_hard_cap_seconds])});
};

// A serialized source transaction has one unknown commit instant in [L,U].
// Between L and U the FIFO state is either its complete before or after state;
// at each threshold, equal-side states contribute no CDF uncertainty. Cutting
// both states' deterministic expiry boundaries preserves this pointwise bound.
function appendStateEnvelope(envelopes,left,right,states,queueRef) {
  let at=left;
  while(at<right) {
    const queues=states.map(state=>queueAt(state,queueRef,at));let end=right;
    for(const q of queues)if(q.head&&q.head.until>at&&q.head.until<end)end=q.head.until;
    if(end<=at)throw Error('state_envelope_non_advancing');
    const minDepth=Math.min(...queues.map(q=>q.depth)),maxDepth=Math.max(...queues.map(q=>q.depth));
    const previous=envelopes.at(-1);
    if(previous&&previous.end===at&&previous.min_depth===minDepth&&previous.max_depth===maxDepth)previous.end=end;
    else envelopes.push({start:at,end,min_depth:minDepth,max_depth:maxDepth});
    at=end;
  }
}
function proveStateEnvelope(from,to,segments,envelopes,unconstrained) {
  if(unconstrained.duration_us===undefined||unconstrained.uncertainty_union_us===undefined)throw Error('state_envelope_input_invalid');
  const duration=to-from,depths=new Set();let cursor=from;
  for(const e of envelopes) {
    if(e.start!==cursor||e.end<=e.start||e.end>to||!Number.isSafeInteger(e.min_depth)||
      !Number.isSafeInteger(e.max_depth)||e.min_depth<0||e.max_depth<e.min_depth)throw Error('state_envelope_partition_invalid');
    cursor=e.end;depths.add(e.min_depth);depths.add(e.max_depth);
  }
  if(cursor!==to)throw Error('state_envelope_partition_incomplete');
  const base={...unconstrained};delete base.status;delete base.value;delete base.reason;delete base.cdf;
  const cdf=[];
  for(const depth of [...depths].sort((a,b)=>a-b)) {
    let lower=0n,previousUpper=0n,cumulative=0n;
    for(const e of envelopes) {
      const width=e.end-e.start;
      if(e.max_depth<=depth)lower+=width;
      if(e.min_depth<depth)previousUpper+=width;
    }
    for(const s of segments)if(s.depth<=depth)cumulative+=BigInt(s.end_us)-BigInt(s.start_us);
    cdf.push({depth,candidate_le_duration_us:cumulative.toString(),lower_le_duration_us:lower.toString(),
      previous_upper_le_duration_us:previousUpper.toString()});
    if(lower*100n>=duration*95n&&previousUpper*100n<duration*95n)
      return {...base,status:'UNIQUE_VALUE_CANDIDATE',value:depth,cdf,requires_complete_sealed_clock_qualified_source:true};
  }
  return {...base,status:'NOT_QUALIFIED',reason:'conservative_bounds_do_not_prove_unique_percentile',value:null,cdf};
}

export function integrateClockSourceCandidate(rawPages,rawOptions) {
  if(typeof rawPages!=='string'||typeof rawOptions!=='string')return no('raw_json_required');
  if(Buffer.byteLength(rawPages)>32*1024*1024||Buffer.byteLength(rawOptions)>4096)return no('input_limit');
  let stage='packet_malformed';
  try{
    const pages=JSON.parse(rawPages),options=JSON.parse(rawOptions);
    if(!options||Object.keys(options).sort().join(',')!=='expectedCatalogDigest,expectedFoundationDigest,queueRef' ||
      !sha.test(options.expectedCatalogDigest??'')||!sha.test(options.expectedFoundationDigest??'')||
      typeof options.queueRef!=='string'||!options.queueRef.startsWith('merge:'))return no('reader_pins_invalid');
    if(!Array.isArray(pages)||pages.length===0||pages.length>100000)return no('pages_missing');
    const first=pages[0],e=first.epoch,z=first.seal,observations=first.observation_seals,manifest=first.coverage_manifest;
    if(!e||!z||!uuid.test(e.epoch_id??'')||!uuid.test(z.seal_id??'')||!uuid.test(e.stream_id??'')||
      !uuid.test(e.clock_generation_id??'')||e.epoch_id!==z.epoch_id||e.stream_id!==first.stream_id||
      e.catalog_digest!==options.expectedCatalogDigest||z.catalog_digest!==options.expectedCatalogDigest||
      e.foundation_digest!==options.expectedFoundationDigest||e.queue_ref!==options.queueRef.toLowerCase()||
      !manifest||manifest.queue_ref!==e.queue_ref||manifest.event_count!==z.end_sequence)return no('epoch_or_seal_pins_invalid');
    const start=seq(e.start_sequence),end=seq(z.end_sequence),from=micro(e.opening_us),to=micro(z.closing_us);
    if(start!==0||start>end||from>=to||to-from>31n*86400000000n||!Array.isArray(e.initial_events)||e.initial_events.length>100000)
      return no('epoch_window_invalid');
    if(z.raw_regression!==false||z.sample_gap!==false||z.ddl_tainted!==false)return no('source_epoch_unqualified');
    if(!Array.isArray(observations)||observations.length===0||observations.length>100000)return no('visibility_observations_missing');
    for(const observation of observations){if(Object.keys(observation).sort().join(',')!=='closing_us,end_sequence' ||
      seq(observation.end_sequence)<start||observation.end_sequence>end||micro(observation.closing_us)<from||micro(observation.closing_us)>to)
      return no('visibility_observation_invalid');}
    if(!observations.some(o=>o.end_sequence===end&&o.closing_us===z.closing_us))return no('final_visibility_seal_missing');
    const events=[],samples=[];let after=0;
    for(let index=0;index<pages.length;index++){
      const p=pages[index];
      if(!p||p.status!=='ok'||p.candidate_ready!==true||!same(p.epoch,e)||!same(p.seal,z)||
        !same(p.observation_seals,observations)||
        !same(p.coverage_manifest,manifest)||
        p.stream_id!==e.stream_id||p.source_digest!==options.expectedFoundationDigest||
        seq(p.end_sequence)!==end||seq(p.after_sequence)!==after||!Array.isArray(p.events)||!Array.isArray(p.clock_samples)||
        p.has_more!==(index<pages.length-1))return no('page_pins_or_continuity_invalid');
      const member=new Map();
      for(const item of p.events){if(seq(item.sequence)!==after+1)return no('journal_gap_or_duplicate');after++;member.set(item.sequence,item.transaction_id);events.push(item);}
      if(seq(p.next_sequence)!==after || (p.has_more&&p.events.length===0))return no('page_cursor_invalid');
      const seen=new Set();
      for(const sample of p.clock_samples){if(seq(sample.sequence)<=start||seen.has(sample.sequence)||member.get(sample.sequence)!==sample.transaction_id)
        return no('sample_member_invalid');seen.add(sample.sequence);micro(sample.raw_us);samples.push(sample);}
      if(seen.size!==p.events.filter(item=>item.sequence>start).length)return no('sample_gap');
    }
    if(after!==end)return no('journal_incomplete');
    // A fixed target projection has its own consecutive sequence, never exposes
    // the private account-wide cursor, and starts after the complete live epoch
    // snapshot. It does not fabricate a policy journal event or pre-epoch history.
    const groups=[],seenTransactions=new Set();let group,lastRecorded=null;
    for(const item of events){
      if(item.source_digest!==options.expectedFoundationDigest||!/^[0-9]{1,20}$/.test(item.transaction_id??'')||
        !['policy','claim','queue_marker'].includes(item.kind)||typeof item.context_key!=='string'||typeof item.object_key!=='string'||
        !item.payload||typeof item.payload!=='object'||Array.isArray(item.payload))return no('target_journal_invalid');
      const at=timestampMicros(item.recorded_at);if(lastRecorded!==null&&at<lastRecorded)return no('target_recorded_order_invalid');lastRecorded=at;
      if(group?.transaction_id!==item.transaction_id){if(seenTransactions.has(item.transaction_id))return no('transaction_interleaved');
        seenTransactions.add(item.transaction_id);group={transaction_id:item.transaction_id,events:[]};groups.push(group);}
      group.events.push(item);
    }
    const initial=emptyReplayState();stage='initial_state_invalid';
    const unique=new Set();
    for(const item of e.initial_events){if(!['policy','claim','queue_marker'].includes(item.kind)||typeof item.object_key!=='string'||
      unique.has(item.kind+':'+item.object_key))return no('initial_state_invalid');unique.add(item.kind+':'+item.object_key);}
    if(e.initial_events.filter(x=>x.kind==='policy'&&x.object_key==='fifo-v1').length!==1||e.initial_events.filter(x=>x.kind==='policy').length!==1||
      e.initial_events.some(x=>x.kind==='claim'&&(!Array.isArray(x.payload?.merge_refs)||!x.payload.merge_refs.some(r=>r.toLowerCase()===e.queue_ref)))||
      e.initial_events.some(x=>x.kind==='queue_marker'&&x.object_key.toLowerCase()!==e.queue_ref))return no('initial_target_state_invalid');
    applyTransaction(initial,{events:e.initial_events});if(!initial.policy)return no('initial_policy_missing');
    samples.sort((a,b)=>a.sequence-b.sequence);const bySeq=new Map(samples.map(s=>[s.sequence,s]));
    let lastRaw=from;for(const s of samples){const at=micro(s.raw_us);if(at<lastRaw||at>to)return no('raw_clock_regression');lastRaw=at;}
    const transitions=[],envelopes=[];let envelopeCursor=from;stage='commit_interval_invalid';
    const changedState={claims:new Map(initial.claims),markers:new Map(initial.markers),policy:initial.policy};
    for(let n=0;n<groups.length;n++){
      const g=groups[n],last=bySeq.get(g.events.at(-1).sequence),next=n+1<groups.length?bySeq.get(groups[n+1].events[0].sequence):null;
      const lower=micro(last.raw_us);let upper=next?micro(next.raw_us):to;
      for(const o of observations)if(o.end_sequence>=g.events.at(-1).sequence&&micro(o.closing_us)<upper)upper=micro(o.closing_us);
      // Serialization plus monotone raw members must make the intervals ordered
      // and non-overlapping; never use a two-state bound for concurrent commits.
      if(lower>upper||lower<envelopeCursor||upper>to)return no('commit_interval_invalid');
      appendStateEnvelope(envelopes,envelopeCursor,lower,[changedState],options.queueRef);
      // applyTransaction replaces the maps atomically, preserving this old view.
      const prior={claims:changedState.claims,markers:changedState.markers,policy:changedState.policy};
      const before=queueState(changedState,options.queueRef);applyTransaction(changedState,g);
      const affectsQueue=queueState(changedState,options.queueRef)!==before;
      appendStateEnvelope(envelopes,lower,upper,affectsQueue?[prior,changedState]:[changedState],options.queueRef);
      transitions.push({group:g,lower,upper,affectsQueue});envelopeCursor=upper;
    }
    appendStateEnvelope(envelopes,envelopeCursor,to,[changedState],options.queueRef);
    // For a legal transaction order, committed state differs from this nominal
    // (lower-bound) replay only inside the union of [lower, upper] intervals.
    // Deterministic FIFO expiry boundaries are included too; they are not
    // stretched to the next journal event or inferred from recorded_at.
    const segments=[];let cursor=from,index=0;stage='queue_replay_invalid';
    while(cursor<to){
      while(index<transitions.length&&transitions[index].lower<=cursor)applyTransaction(initial,transitions[index++].group);
      const q=queueAt(initial,options.queueRef,cursor);let right=to;
      if(index<transitions.length&&transitions[index].lower<right)right=transitions[index].lower;
      if(q.head&&q.head.until<right)right=q.head.until;
      if(right<=cursor)return no('queue_replay_non_advancing');
      segments.push({start_us:cursor.toString(),end_us:right.toString(),depth:q.depth});cursor=right;
    }
    const bounds=transitions.filter(x=>x.affectsQueue).map(x=>({start_us:x.lower.toString(),end_us:x.upper.toString()}));
    // Retain the generic union diagnostic/backwards-compatible pure proof,
    // but prove the value from state-constrained CDF bounds, not total delta.
    const unconstrained=proveDiscretePercentileCandidate({start_us:from.toString(),end_us:to.toString(),segments,uncertainty:bounds});
    const proof=proveStateEnvelope(from,to,segments,envelopes,unconstrained);
    return {...proof,source_authenticated:false,official_metric:false,t0:null,
      candidate_ready:true,epoch_id:e.epoch_id,seal_id:z.seal_id,start_sequence:start,end_sequence:end,
      transaction_count:transitions.length,segments,commit_intervals:transitions.map(x=>({transaction_id:x.group.transaction_id,
        first_sequence:x.group.events[0].sequence,last_sequence:x.group.events.at(-1).sequence,
        lower_us:x.lower.toString(),upper_us:x.upper.toString(),affects_queue:x.affectsQueue})),
      timestamp_semantics:'raw sample after serialization <= actual commit <= next serialized sample / row-lock seal',
      trust_model:'authenticated DB and reviewed publisher; trusted Owner/provider administrators'};
  }catch{return no(stage);}
}
