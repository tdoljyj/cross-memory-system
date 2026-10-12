// The Events timeline proves observed immutable events and pagination only.
// It exposes no delivery watermark. Equal immediate lists, a short page or a
// cache overlap cannot prove that a recently closed window has been delivered.
import {createHash} from 'node:crypto';
import {timestampMicros} from './merge-admission-measurement-history.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validId=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
function project(e,repository){
  if(!validId(String(e.id))||e.repo?.name?.toLowerCase()!==repository.toLowerCase())throw Error('NATIVE_ACTIVITY_IDENTITY_INVALID');
  timestampMicros(e.created_at);
  if(typeof e.type!=='string'||! /^[A-Za-z]{1,64}$/.test(e.type))throw Error('NATIVE_ACTIVITY_TYPE_INVALID');
  if(e.type!=='PushEvent')return {id:String(e.id),type:e.type,created_at:e.created_at,payload:null};
  if(!sha(e.payload?.before)||!sha(e.payload?.head)||typeof e.payload.ref!=='string'||!e.payload.ref.startsWith('refs/heads/'))throw Error('NATIVE_PUSH_EVENT_INVALID');
  return {id:String(e.id),type:'PushEvent',created_at:e.created_at,payload:{before:e.payload.before,head:e.payload.head,ref:e.payload.ref}};
}
// Tombstones and their two original contradictory observations are safe data,
// sealed by the existing publisher together with the activity packet. A later
// consistent list cannot restore causal eligibility for this window.
function quarantineId(quarantined,observed,id,...rows){
  const q=quarantined.get(id)??{id,reason_code:'NATIVE_ACTIVITY_IMMUTABLE_EVENT_CHANGED',observations:[]};
  for(const row of rows)if(row&&!q.observations.some(old=>hash(old)===hash(row))&&q.observations.length<2)q.observations.push(row);
  quarantined.set(id,q);observed.delete(id);
}
function observe(row,observed,quarantined){
  if(quarantined.has(row.id)){observed.delete(row.id);return false;}
  const old=observed.get(row.id);
  if(old&&hash(old)!==hash(row)){quarantineId(quarantined,observed,row.id,old,row);return false;}
  observed.set(row.id,row);return true;
}
async function pass(request,repository,window,observed,quarantined){
  const rows=[],ids=new Set();let openingEventObserved=false,shortPageObserved=false;
  for(let page=1;page<=3;page++){
    const r=await request(`/repos/${repository}/events?per_page=100&page=${page}`);
    if(r?.ok!==true||!Array.isArray(r.body)||r.body.length>100)throw Error('NATIVE_ACTIVITY_PAGE_UNAVAILABLE');
    for(const e of r.body){
      const row=project(e,repository),id=String(e.id);
      if(ids.has(id)){
        if(quarantined.has(id))continue;
        if(observed.has(id)&&hash(observed.get(id))!==hash(row)){quarantineId(quarantined,observed,id,observed.get(id),row);continue;}
        throw Error('NATIVE_ACTIVITY_IDENTITY_INVALID');
      }
      ids.add(id);
      if(timestampMicros(e.created_at)<timestampMicros(window.start))openingEventObserved=true;
      if(observe(row,observed,quarantined)&&row.type==='PushEvent')rows.push(row);
    }
    if(r.body.length<100){shortPageObserved=true;break;}
  }
  return {rows,ids:[...ids],openingEventObserved,shortPageObserved};
}
export async function collectNativeActivity({request,repository,window,authenticatedActivity=null}){
  const observed=new Map(),quarantined=new Map();let a=null,b=null,refusal=null;
  try{
    // Only the actual caller supplies a previously authenticated publisher
    // packet. Old completeness booleans are deliberately not consulted.
    const old=authenticatedActivity?.repository===repository&&authenticatedActivity?.window?.start===window.start?authenticatedActivity:null;
    if(old?.quarantine!==undefined){
      if(!Array.isArray(old.quarantine))throw Error('NATIVE_ACTIVITY_QUARANTINE_INVALID');
      for(const q of old.quarantine){
        if(!validId(q?.id)||q.reason_code!=='NATIVE_ACTIVITY_IMMUTABLE_EVENT_CHANGED'||!Array.isArray(q.observations)||q.observations.length!==2||quarantined.has(q.id))throw Error('NATIVE_ACTIVITY_QUARANTINE_INVALID');
        const rows=q.observations.map(e=>project({...e,repo:{name:repository}},repository));
        if(rows.some(row=>!row||row.id!==q.id)||hash(rows[0])===hash(rows[1]))throw Error('NATIVE_ACTIVITY_QUARANTINE_INVALID');
        quarantineId(quarantined,observed,q.id,...rows);
      }
      if(!Array.isArray(old.quarantined_ids)||hash([...old.quarantined_ids].sort())!==hash([...quarantined.keys()].sort()))throw Error('NATIVE_ACTIVITY_QUARANTINE_INVALID');
    }else if(old?.quarantined_ids!==undefined)throw Error('NATIVE_ACTIVITY_QUARANTINE_INVALID');
    // Restore all safe identities, including non-Push type/time projections.
    // Legacy packets retain only their actually recorded Push observations.
    for(const e of old?.observed_identities??old?.events??[]){const row=project({...e,repo:{name:repository}},repository);
      if(observed.has(row.id)&&hash(observed.get(row.id))===hash(row))throw Error('NATIVE_ACTIVITY_CACHE_DUPLICATE');
      observe(row,observed,quarantined);}
    a=await pass(request,repository,window,observed,quarantined);b=await pass(request,repository,window,observed,quarantined);
    const inWindow=rows=>rows.filter(e=>!quarantined.has(e.id)&&timestampMicros(e.created_at)>=timestampMicros(window.start)&&timestampMicros(e.created_at)<timestampMicros(window.end));
    if(hash(inWindow(a.rows))!==hash(inWindow(b.rows)))throw Error('NATIVE_ACTIVITY_COHORT_CHANGED_AT_CLOSE');
  }catch(e){refusal=/^[A-Z0-9_]+$/.test(e.message)?e.message:'NATIVE_ACTIVITY_INVALID';}
  const inWindow=rows=>rows.filter(e=>!quarantined.has(e.id)&&timestampMicros(e.created_at)>=timestampMicros(window.start)&&timestampMicros(e.created_at)<timestampMicros(window.end)),
    oldIds=authenticatedActivity?.provider_ids??[],overlap=b?.ids.some(id=>oldIds.includes(id))??false;
  return {schema:'clued.r9-native-activity/4',repository,window,status:'PARTIAL',
    reason_code:refusal??(quarantined.size?'NATIVE_ACTIVITY_IMMUTABLE_EVENT_CHANGED':'NATIVE_ACTIVITY_CLOSING_DELIVERY_NOT_ESTABLISHED'),
    coverage_to_opening:false,closing_delivery_watermark:null,delivery_through_window_end:'UNKNOWN',
    provider_retention:{maximum_events:300,maximum_days:30,opening_coverage:'UNKNOWN',observed_event_before_opening:!!(a?.openingEventObserved&&b?.openingEventObserved),
      short_page_observed:!!b?.shortPageObserved,authenticated_cache_overlap_observed:overlap},
    observed_pagination_status:refusal||quarantined.size?'PARTIAL':'CONSISTENT',events:[...observed.values()].filter(e=>e.type==='PushEvent'),provider_ids:b?.ids??a?.ids??[],
    observed_identities:[...observed.values()],
    quarantined_ids:[...quarantined.keys()].sort(),quarantine:[...quarantined.values()].sort((a,b)=>a.id.localeCompare(b.id)),
    opening_digest:a?hash(inWindow(a.rows)):null,closing_digest:b?hash(inWindow(b.rows)):null,
    source_authenticated:false,official_metric:false};
}
