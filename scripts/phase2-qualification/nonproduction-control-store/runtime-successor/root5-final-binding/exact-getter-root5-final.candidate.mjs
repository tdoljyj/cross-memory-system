// Pure Root5 final one-successor SQL generator. No future event, timestamp, xid, signature or acceptance is issued.
import crypto from 'node:crypto';import {isDeepStrictEqual as same} from 'node:util';
const need=(v,m)=>{if(!v)throw Error(m);},sha=x=>crypto.createHash('sha256').update(x).digest('hex'),quote=x=>"'"+x.replaceAll("'","''")+"'";
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const json=v=>JSON.stringify(stable(v));
export function buildExactGetter(input){
 const {previous_sql,previous_sha256,existing_forwards,next_sequence,key,previous_binding,new_binding,source_acceptance_refs}=input;
 need(typeof previous_sql==='string'&&sha(previous_sql)===previous_sha256,'EXACT_PREVIOUS_GETTER_SOURCE');
 need(Number.isInteger(existing_forwards)&&existing_forwards>=4&&existing_forwards<8&&Number.isSafeInteger(next_sequence)&&next_sequence>44&&typeof key==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(key),'EXACT_ONE_ROOT5_FINAL_SERIES_FORWARD');
 need(previous_binding&&new_binding&&same(Object.keys(previous_binding).sort(),Object.keys(new_binding).sort()),'UNCHANGED_BINDING_SHAPE');
 for(const field of ['root_id','profile_sha256','gate_id','prior_seconds','prior_evidence_bytes'])need(previous_binding[field]===new_binding[field],'UNCHANGED_BINDING_SCOPE_FLOOR:'+field);
 need(new_binding.root_id==='ctr_414bd3c724264a83894b0c55cf2ab878'&&new_binding.gate_id==='G-PREENTRY-SKILL-QUALIFICATION','SAME_ORIGINAL_ROOT_AND_GATE');
 const sourceKeys=['controller_manifest','gate_suite','independent_acceptance','qualification','runtime_acceptance','scope'];need(same(Object.keys(source_acceptance_refs??{}).sort(),sourceKeys),'EXACT_SIX_SOURCE_REFS');
 for(const ref of Object.values(source_acceptance_refs)){need(same(Object.keys(ref).sort(),['publication','ref'])&&same(Object.keys(ref.ref??{}).sort(),['sha256','uri'])&&same(Object.keys(ref.publication??{}).sort(),['artifactPath','commitSha']),'EXACT_SOURCE_DESCRIPTOR');need(/^[a-f0-9]{64}$/.test(ref.ref.sha256)&&/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(ref.ref.uri)&&/^[a-f0-9]{40}$/.test(ref.publication.commitSha)&&/^(scripts\/phase2-qualification\/|artifacts\/clued-validation\/phase2-entry-preparation-20260908\/bootstrap\/)[A-Za-z0-9_./-]+$/.test(ref.publication.artifactPath)&&!ref.publication.artifactPath.includes('..'),'EXACT_TYPED_SOURCE_PUBLICATION');}
 for(const [field,source]of [['controller_sha256','controller_manifest'],['scope_sha256','scope'],['qualification_sha256','qualification'],['runtime_acceptance_sha256','runtime_acceptance']])need(new_binding[field]===source_acceptance_refs[source].ref.sha256,'SOURCE_BINDING_DIGEST:'+field);
 need(/^[a-f0-9]{64}$/.test(new_binding.gate_sha256)&&typeof new_binding.gate_version==='string'&&new_binding.gate_version.length>0&&new_binding.gate_version.length<=128,'EXACT_GATE_VERSION_DIGEST');
 const oldGuard='if n not in ('+Array.from({length:existing_forwards},(_,i)=>i+1).join(',')+')';
 need(previous_sql.split(oldGuard).length===2,'EXACT_PREVIOUS_FORWARD_COUNT_GUARD');
 const end=' return next result;\nend $$;';need(previous_sql.split(end).length===2,'EXACT_PREVIOUS_FINAL_RETURN');
 const next=existing_forwards+1;
 const fragment=` if n=${existing_forwards} then return next result;return;end if;
 predecessor:=result;
 select * into e from clued_control.execution_events where root_id=original.root_id and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED' order by sequence offset ${existing_forwards} limit 1;
 value:=e.request->'body';
 if e.sequence is distinct from ${next_sequence} or e.idempotency_key is distinct from ${quote(key)}
 or e.request->>'operation' is distinct from 'EXECUTION_BINDING_FORWARD_ACCEPTED'
 or (select array_agg(k order by k) from jsonb_object_keys(e.request) k) is distinct from array['body','operation']::text[]
 or (select array_agg(k order by k) from jsonb_object_keys(value) k) is distinct from array['new_binding','new_binding_sha256','previous_binding','previous_binding_sha256','source_acceptance_refs']::text[]
 or to_jsonb(predecessor) is distinct from ${quote(json(previous_binding))}::jsonb
 or value->'previous_binding' is distinct from to_jsonb(predecessor)
 or value->'new_binding' is distinct from ${quote(json(new_binding))}::jsonb
 or value->'source_acceptance_refs' is distinct from ${quote(json(source_acceptance_refs))}::jsonb
 or value->>'previous_binding_sha256' is distinct from encode(sha256(convert_to((value->'previous_binding')::text,'UTF8')),'hex')
 or value->>'new_binding_sha256' is distinct from encode(sha256(convert_to((value->'new_binding')::text,'UTF8')),'hex')
 then raise exception 'exact_bounded_forward_${next}_required';end if;
 select * into result from jsonb_populate_record(null::clued_control.execution_binding,value->'new_binding');
 return next result;
end $$;`;
 const sql=previous_sql.replace(oldGuard,'if n not in ('+Array.from({length:next},(_,i)=>i+1).join(',')+')').replace(end,()=>fragment);
 return {state:'LOCAL_EXACT_GETTER_CANDIDATE_NOT_ACCEPTED_NOT_INSTALLED',sql,sha256:sha(sql),existing_forwards,next_forward_count:next,planned_sequence:next_sequence,actual_event_created:false,authority_effect:'NONE'};
}
