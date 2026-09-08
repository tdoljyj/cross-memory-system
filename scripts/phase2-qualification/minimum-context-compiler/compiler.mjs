// No Canonical/Receipt/authority writes. This compiler consumes the existing exact scoped SQL search.
import crypto from 'node:crypto';
import {isBoundTokenizer} from './tokenizer.mjs';
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));if(typeof v==='number'&&!Number.isSafeInteger(v))throw Error('UNSAFE_NUMBER');return v;}
export const serialize=value=>JSON.stringify(stable(value))+'\n';
const allowedFields=new Set(['title','content','updated_at']);
function fail(reason){const e=Error(reason);e.code=reason;throw e;}
function validatePolicy(p){
 if(!p||!['global','profile'].includes(p.context_key)&&!/^project:[a-f0-9-]{36}$/.test(p.context_key??''))fail('INVALID_SCOPE');
 if(typeof p.task!=='string'||p.task.length<1||p.task.length>1000)fail('INVALID_TASK');
 if(!Number.isSafeInteger(p.token_budget)||p.token_budget<1||p.token_budget>2048)fail('INVALID_TOKEN_BUDGET');
 if(!Array.isArray(p.required_records)||p.required_records.length<1||p.required_records.length>50||new Set(p.required_records.map(x=>x.id)).size!==p.required_records.length)fail('INVALID_REQUIRED_RECORD_SET');
 for(const x of p.required_records){if(typeof x.id!=='string'||!Number.isSafeInteger(x.version)||x.version<1||!Array.isArray(x.fields)||x.fields.length<1||new Set(x.fields).size!==x.fields.length||x.fields.some(f=>!allowedFields.has(f)))fail('INVALID_FIELD_POLICY');}
 if(!Array.isArray(p.critical_constraints)||p.critical_constraints.length<1||p.critical_constraints.length>100)fail('CRITICAL_CONSTRAINTS_NOT_BOUND');
 for(const c of p.critical_constraints){const r=p.required_records.find(r=>r.id===c.record_id);if(!r||!r.fields.includes(c.field)||typeof c.exact_text!=='string'||!c.exact_text.length)fail('CONSTRAINT_FIELD_NOT_AUTHORIZED');}
}
export function compileSearchResult(result,policy,tokenizer){
 validatePolicy(policy);
 if(!isBoundTokenizer(tokenizer))fail('TOKENIZER_NOT_BOUND');
 if(!result||result.status!=='ok'||result.mode!=='lexical'||result.context_key!==policy.context_key||!Array.isArray(result.results))fail('AUTHORIZED_RETRIEVAL_MISMATCH');
 const records=[];
 for(const wanted of policy.required_records){
  const matches=result.results.filter(x=>x.kind==='record'&&x.id===wanted.id);
  if(matches.length!==1)fail('INSUFFICIENT_OR_AMBIGUOUS_AUTHORIZED_CONTEXT');
  const source=matches[0];
  if(source.scope!==policy.context_key)fail('CROSS_SCOPE_SOURCE');
  if(source.version!==wanted.version)fail('SOURCE_VERSION_DRIFT');
  if(source.record_schema_version!==1||!['note','state','task','decision'].includes(source.record_type)||!['active','done','completed'].includes(source.status)||!['active','completed'].includes(source.lifecycle_status))fail('SOURCE_NOT_CURRENT');
  const fields={};
  for(const field of wanted.fields){if(typeof source[field]!=='string')fail('REQUIRED_FIELD_UNAVAILABLE');fields[field]=source[field];}
  records.push({source_ref:{kind:'record',id:source.id,version:source.version,scope:source.scope,record_type:source.record_type},fields});
 }
 for(const c of policy.critical_constraints){const r=records.find(x=>x.source_ref.id===c.record_id);if(!r.fields[c.field].includes(c.exact_text))fail('CRITICAL_CONSTRAINT_SOURCE_MISMATCH');}
 // All selected fields and constraints are required. Never truncate a required constraint to fit.
 records.sort((a,b)=>a.source_ref.id.localeCompare(b.source_ref.id));
 const pack={task:policy.task,context_key:policy.context_key,records,critical_constraints:policy.critical_constraints,policy_sha256:hash(serialize(policy))};
 const text=serialize(pack);if(Buffer.byteLength(text)>1048576)fail('CONTEXT_BYTE_LIMIT');
 const tokens=tokenizer.count(text);if(!Number.isSafeInteger(tokens)||tokens<1)fail('INVALID_TOKENIZER_RESULT');
 if(tokens>policy.token_budget)fail('INSUFFICIENT_AUTHORIZED_CONTEXT');
 return {state:'LOCAL_COMPILED_CONTEXT_CANDIDATE',text,text_sha256:hash(text),token_count:tokens,token_budget:policy.token_budget,tokenizer:tokenizer.target,
  provenance:{rpc:'clued_mcp_search_context',context_key:result.context_key,selected_records:records.map(r=>r.source_ref),policy_sha256:pack.policy_sha256},authority_effect:'NONE',canonical_writes:0};
}
export async function readAndCompile({client,bindingTokenHash,sessionToken,contextKey,query,policy,tokenizer}){
 validatePolicy(policy);if(contextKey!==policy.context_key)fail('SCOPE_POLICY_MISMATCH');
 if(!isBoundTokenizer(tokenizer))fail('TOKENIZER_NOT_BOUND');
 if(typeof query!=='string'||query.length<1||query.length>500)fail('INVALID_QUERY');
 // Existing resolver/session authorization executes within this existing server RPC.
 // No aggregate export or old snapshots, no context cache, no provider fallback.
 const input={context_key:contextKey,query,session_token:sessionToken,include_history:false,limit:50};
 const read=await client.query('select public.clued_mcp_search_context($1,$2::jsonb) as value',[bindingTokenHash,JSON.stringify(input)]);
 const result=read.rows?.[0]?.value;if(result?.query!==query)fail('RETRIEVAL_QUERY_MISMATCH');
 return compileSearchResult(result,policy,tokenizer);
}
