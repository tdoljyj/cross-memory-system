import crypto from 'node:crypto';
import {compileSearchResult} from '../minimum-context-compiler/compiler.mjs';
import {isBoundTokenizer} from '../minimum-context-compiler/tokenizer.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=m=>{throw Error(m);};
export async function readAndCompileWithSources({client,bindingTokenHash,sessionToken,contextKey,query,policy,tokenizer,sourceBytes}){
 if(contextKey!==policy?.context_key)fail('SCOPE_POLICY_MISMATCH');
 if(!isBoundTokenizer(tokenizer))fail('TOKENIZER_NOT_BOUND');
 if(typeof query!=='string'||query.length<1||query.length>500)fail('INVALID_QUERY');
 if(!(sourceBytes instanceof Map))fail('SOURCE_BYTES_MAP_REQUIRED');
 const input={context_key:contextKey,query,session_token:sessionToken,include_history:false,limit:50};
 const selection=policy.required_records.map(({id,version})=>({id,version}));
 const read=await client.query('select clued_source_reader.read_compiler_sources($1,$2::jsonb,$3::jsonb) as value',
  [bindingTokenHash,JSON.stringify(input),JSON.stringify(selection)]);
 const observed=read.rows?.[0]?.value;
 if(observed?.search_result?.query!==query)fail('RETRIEVAL_QUERY_MISMATCH');
 const base=compileSearchResult(observed.search_result,policy,tokenizer);
 if(!Array.isArray(observed.source_bindings)||observed.source_bindings.length!==selection.length)fail('SOURCE_BINDING_INCOMPLETE');
 const bound=[];let checkedBytes=0;
 for(const wanted of selection){
  const matches=observed.source_bindings.filter(x=>x.record_id===wanted.id);
  if(matches.length!==1)fail('SOURCE_BINDING_AMBIGUOUS');
  const b=matches[0];if(b.record_version!==wanted.version||b.scope!==contextKey)fail('SOURCE_BINDING_DRIFT');
  if(!Array.isArray(b.evidence)||b.evidence.length===0||b.evidence.length>50)fail('RAW_SOURCE_REFERENCE_MISSING');
  const refs=[];const seen=new Set();
  for(const e of b.evidence){
   if(typeof e.evidence_id!=='string'||seen.has(e.evidence_id)||e.evidence_schema_version!==1||
     !/^[a-f0-9]{64}$/.test(e.content_hash)||!Number.isSafeInteger(e.size_bytes)||e.size_bytes<0)fail('INVALID_EVIDENCE_METADATA');
   seen.add(e.evidence_id);const bytes=sourceBytes.get(e.evidence_id);
   if(!Buffer.isBuffer(bytes))fail('RAW_SOURCE_BYTES_UNAVAILABLE');
   checkedBytes+=bytes.length;if(checkedBytes>1048576)fail('RAW_SOURCE_BYTE_LIMIT');
   if(bytes.length!==e.size_bytes||hash(bytes)!==e.content_hash)fail('RAW_SOURCE_BYTES_MISMATCH');
   refs.push({evidence_id:e.evidence_id,content_hash:e.content_hash,size_bytes:e.size_bytes});
  }
  refs.sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
  bound.push({record_id:wanted.id,record_version:wanted.version,scope:contextKey,evidence:refs});
 }
 bound.sort((a,b)=>a.record_id.localeCompare(b.record_id));
 const text=JSON.stringify({context:JSON.parse(base.text),source_bindings:bound})+'\n';
 const token_count=tokenizer.count(text);
 if(Buffer.byteLength(text)>1048576||!Number.isSafeInteger(token_count)||token_count>policy.token_budget)fail('INSUFFICIENT_AUTHORIZED_CONTEXT');
 return {...base,state:'LOCAL_SOURCE_BOUND_CONTEXT_CANDIDATE',text,text_sha256:hash(text),token_count,
  provenance:{...base.provenance,source_bindings:bound,raw_bytes_verified:true,raw_bytes_observation:'CALLER_SUPPLIED_BUFFERS_MATCH_CURRENT_STORED_EVIDENCE_METADATA'}};
}
