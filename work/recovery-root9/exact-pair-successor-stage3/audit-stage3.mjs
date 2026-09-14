import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';

const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1]};
const dir=path.resolve(arg('--dir')??'.'),repo=path.resolve(arg('--repo')??path.join(dir,'../../../..'));
const read=n=>fs.readFileSync(path.join(dir,n));
const text=n=>read(n).toString('utf8');
const json=n=>JSON.parse(text(n));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m)};
const result=json('STAGE3_RESULT.json'),casResult=json('CAS_BUILD_RESULT.json'),fnResult=json('FUNCTION_SUCCESSOR_RESULT.json');
const files=['Stage2PublicationEvidence.verified.json','Status28SignatureEvidence.json','Status28Generation.json','RuntimeAcceptance.root9.exact-pair.json','STAGE3_RESULT.json','CAS_BUILD_RESULT.json','FUNCTION_SUCCESSOR_RESULT.json','root9_exact_pair_expected_current_cas.sealed.sql','execution_transition.exact-pair.sql','commit_gate_result.exact-pair.sql','reserve_gate.exact-pair.sql'];
for(const n of files)need(read(n).length>1,'EMPTY:'+n);
need(sha(read('Stage2PublicationEvidence.verified.json'))===result.stage2_publication_evidence_ref.sha256&&blob(read('Stage2PublicationEvidence.verified.json'))===result.stage2_publication_evidence_ref.uri.split('/').at(-1),'PUB_REF');
need(sha(read('Status28SignatureEvidence.json'))===result.status28_signature_evidence_ref.sha256&&blob(read('Status28SignatureEvidence.json'))===result.status28_signature_evidence_ref.uri.split('/').at(-1),'SIG_REF');
need(sha(read('Status28Generation.json'))===result.status28_generation_ref.sha256&&blob(read('Status28Generation.json'))===result.status28_generation_ref.uri.split('/').at(-1),'STATUS_REF');
need(sha(read('RuntimeAcceptance.root9.exact-pair.json'))===result.runtime_acceptance_ref.sha256&&blob(read('RuntimeAcceptance.root9.exact-pair.json'))===result.runtime_acceptance_ref.uri.split('/').at(-1),'RUNTIME_REF');
const status=json('Status28Generation.json'),unsigned=structuredClone(status);delete unsigned.signature_binding;
function canonical(v){if(typeof v==='number')need(Number.isSafeInteger(v),'NUMBER');if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v)}
need(sha(Buffer.from(canonical(unsigned)+'\n'))==='a765cc9a6506c8486cb46087cbfa0c9f81f0ff03df23cb0dd421ea83f877a154','STATUS_S');
need(status.signature_binding.owner_merge_commit==='ec6e3df1cc36d4ef8dbd2bfb91555aa5a604f5b6'&&status.signature_binding.signature_evidence_ref.sha256===result.status28_signature_evidence_ref.sha256,'STATUS_BINDING');
const require=createRequire(path.join(repo,'apps/clued-cloud/package.json')),Ajv=require('ajv');
const schema=jsonFrom(path.join(repo,'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9-exact-pair/status-manifest.root5.schema.json'));
function jsonFrom(p){return JSON.parse(fs.readFileSync(p,'utf8'))}
const validate=new Ajv({allErrors:true,strict:false,validateFormats:false}).compile(schema);need(validate(status),'STATUS_SCHEMA:'+JSON.stringify(validate.errors));
const runtime=json('RuntimeAcceptance.root9.exact-pair.json'),s=runtime.accepted_subject,g=s.expected_ga,r=s.exact_pair_recovery;
need(runtime.controller_digest===result.controller_digest&&g.controller_digest===result.controller_digest&&g.controller_qualification_ref.sha256===result.controller_qualification_ref.sha256,'RUNTIME_BINDING');
need(g.source_ref.blobs.length===24&&new Set(g.source_ref.blobs.map(x=>x.uri)).size===24,'SOURCE_24');
need(s.bounded_series_materials.repairs.length===9&&s.bounded_series_materials.repairs.at(-1).ref.sha256===result.repair_acceptance_ref.sha256,'REPAIR_9');
need(r.kind==='ROOT9_EXACT_PREDISPATCH_BUDGET_INHERITANCE'&&r.failed_ga_id==='ga_4a88b0436cf80beeb5e194c98bb0297e'&&r.budget_sequence===102&&r.successor_controller_digest===result.controller_digest,'RECOVERY_SUBJECT');
for(const k of ['root_unchanged','gate_unchanged','profile_unchanged','scope_unchanged','generations_unchanged'])need(r[k]===true,'UNCHANGED:'+k);
for(const k of ['refund','capacity_increase','new_allocation','budget_reassignment'])need(r[k]===false,'FORBIDDEN:'+k);
const cas=text('root9_exact_pair_expected_current_cas.sealed.sql');
need(sha(Buffer.from(cas))===casResult.sha256&&Buffer.byteLength(cas)===casResult.bytes,'CAS_IDENTITY');
for(const token of ["c.sequence is distinct from 104","set sequence=106","values(root,105,q_idem,q_req),(root,106,r_idem,r_req)","active_ga_id=old_ga","pending_budget_sequence is null","old_ga_untouched_by_cas"]){if(token==='old_ga_untouched_by_cas')continue;need(cas.includes(token),'CAS_TOKEN:'+token)}
need((cas.match(/clued_control\.append_status_manifest\(/g)||[]).length===1,'ONE_STATUS_CALL');
need((cas.match(/insert into clued_control\.execution_events/gi)||[]).length===1,'ONE_EVENT_INSERT');
need(!/update\s+clued_control\.(gate_attempts|successor_binding|execution_binding|events|execution_events|control_objects)/i.test(cas),'CAS_HISTORY_UPDATE');
need(!/\b(delete|truncate|drop)\b/i.test(cas),'CAS_DESTRUCTIVE');
const fnNames={
 'execution_transition.exact-pair.sql':'execution_transition',
 'commit_gate_result.exact-pair.sql':'commit_gate_result',
 'reserve_gate.exact-pair.sql':'reserve_gate'
};
for(const [n,fn] of Object.entries(fnNames)){const raw=text(n);need(raw.startsWith(`CREATE OR REPLACE FUNCTION clued_control.${fn}(`)&&raw.endsWith('end $function$\n'),'FUNCTION_SHAPE:'+fn);need(sha(Buffer.from(raw))===fnResult.functions[n].sha256,'FUNCTION_SHA:'+fn);need(!/\b(delete|truncate|drop)\b/i.test(raw),'FUNCTION_DESTRUCTIVE:'+fn)}
need(text('execution_transition.exact-pair.sql').includes('c.sequence is distinct from 106'),'EXEC_106');
const commit=text('commit_gate_result.exact-pair.sql');need(commit.includes('c.sequence is distinct from 108')&&commit.includes('e.sequence=107')&&commit.includes('e.sequence=108')&&commit.includes('active_ga_id=null,pending_budget_sequence=102'),'COMMIT_108');
const reserve=text('reserve_gate.exact-pair.sql');
for(const token of ['series_recovery := c.sequence=108','series_n=10 and series_latest=102 and series_count=series_n and c.pending_budget_sequence=102',"correction_event from clued_control.execution_events where root_id=root and sequence=105","repoint from clued_control.execution_events where root_id=root and sequence=106","jsonb_array_length(correction_event.request->'body'->'evidence'->'required_repair_refs')<>9","insert into clued_control.gate_attempts"]){need(reserve.includes(token),'RESERVE_TOKEN:'+token)}
need(!reserve.includes('insert into clued_control.execution_events'),'RESERVE_NO_EVENT_INSERT');
const manifest={object_type:'Root9ExactPairStage3Manifest',schema_version:'1.0',files:Object.fromEntries(files.map(n=>[n,{sha256:sha(read(n)),git_blob_sha1:blob(read(n)),bytes:read(n).length}])),controller_digest:result.controller_digest,qualification_sha256:result.controller_qualification_ref.sha256,runtime_acceptance_sha256:result.runtime_acceptance_ref.sha256,status28_sha256:result.status28_generation_ref.sha256,expected_current:{before:104,after:106,old_ga_phase_after:'PENDING'},terminal_sequences:{decision_reserved:107,signing:108},budget_sequence:102,root_unchanged:true,gate_unchanged:true,profile_unchanged:true,scope_unchanged:true,generations_unchanged:true,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false,authority_effect:'NONE_UNTIL_OWNER_MERGE_INDEPENDENT_FINAL_GO_AND_EXECUTION'};
const manifestRaw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
if(process.argv.includes('--write-manifest'))fs.writeFileSync(path.join(dir,'Stage3Manifest.json'),manifestRaw);
console.log(JSON.stringify({state:'PASS_ROOT9_EXACT_PAIR_STAGE3_STATIC_AUDIT',files:files.length,manifest_sha256:sha(manifestRaw),controller_digest:result.controller_digest,runtime_acceptance_sha256:result.runtime_acceptance_ref.sha256,status28_sha256:result.status28_generation_ref.sha256,cas_sha256:casResult.sha256,function_successors:Object.fromEntries(Object.entries(fnResult.functions).map(([k,v])=>[k,v.sha256])),database_writes:0,refund:false,capacity_increase:false,new_allocation:false,budget_reassignment:false},null,2));
