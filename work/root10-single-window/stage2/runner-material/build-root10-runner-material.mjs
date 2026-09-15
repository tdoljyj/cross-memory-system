#!/usr/bin/env node
// Read-only Root10 runner-material assembler. It performs GitHub verification only;
// it never signs a GA, writes the control store, starts a container, or declares PASS.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const args=process.argv.slice(2),configPath=args[0];
const valueAfter=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1]};
if(!configPath||!args.includes('--emit-json'))throw Error('usage: node build-root10-runner-material.mjs CONFIG.json --emit-json [--ga FINAL_GA.json] [--status-full Status29.full.json]');
const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
const repository='tdoljyj/cross-memory-system',gh=cfg.gh_path||'gh';
const need=(v,m)=>{if(!v)throw Error(m);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(b)+'\0').update(b).digest('hex');
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const digest=v=>sha(JSON.stringify(ordered(v))+'\n');
const same=(a,b)=>digest(a)===digest(b);
const exactKeys=(v,keys,label)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),label);
const hex40=v=>typeof v==='string'&&/^[0-9a-f]{40}$/.test(v);
const hex64=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const read=p=>fs.readFileSync(p,'utf8');
const apiCache=new Map();
const api=endpoint=>{
  need(endpoint==='repos/'+repository||endpoint.startsWith('repos/'+repository+'/'),'PRIVATE_REPOSITORY_ONLY');
  if(apiCache.has(endpoint))return structuredClone(apiCache.get(endpoint));
  const v=JSON.parse(execFileSync(gh,['api','--hostname','github.com',endpoint],{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,windowsHide:true}));
  apiCache.set(endpoint,v);return structuredClone(v);
};
const publications=new Map();
function verifyPublication(label,input){
  exactKeys(input,['pr_number','merge_commit'],label+'_PUBLICATION_INPUT');
  need(Number.isSafeInteger(input.pr_number)&&input.pr_number>0&&hex40(input.merge_commit),label+'_PUBLICATION_ID');
  const repo=api('repos/'+repository);need(repo.private===true&&repo.full_name===repository,label+'_PRIVATE_REPOSITORY');
  const pr=api('repos/'+repository+'/pulls/'+input.pr_number);
  need(pr.merged===true&&pr.merged_at&&pr.base?.ref==='main'&&pr.merged_by?.login==='tdoljyj'&&pr.merge_commit_sha===input.merge_commit,label+'_ACTUAL_OWNER_PR_MERGE');
  const commit=api('repos/'+repository+'/commits/'+input.merge_commit),v=commit.commit?.verification;
  need(commit.sha===input.merge_commit&&commit.parents?.length===2&&commit.committer?.login==='web-flow'&&v?.verified===true&&v.reason==='valid',label+'_VERIFIED_WEB_FLOW_MERGE');
  const prs=api('repos/'+repository+'/commits/'+input.merge_commit+'/pulls');
  need(Array.isArray(prs)&&prs.filter(p=>p.number===input.pr_number&&p.merge_commit_sha===input.merge_commit&&p.merged_at&&p.base?.ref==='main').length===1,label+'_EXACT_MERGED_PR');
  const tree=api('repos/'+repository+'/git/trees/'+commit.commit.tree.sha+'?recursive=1');
  need(tree.sha===commit.commit.tree.sha&&tree.truncated===false&&Array.isArray(tree.tree),label+'_COMPLETE_TREE');
  const out={label,pr_number:input.pr_number,merge_commit:input.merge_commit,tree_sha:tree.sha,tree:tree.tree};publications.set(input.merge_commit,out);return out;
}
const originalSource=verifyPublication('ORIGINAL_SOURCE',cfg.original_source),p1=verifyPublication('P1',cfg.p1),p2=verifyPublication('P2',cfg.p2);
need(p1.merge_commit!==p2.merge_commit,'P1_P2_MUST_BE_DISTINCT_OWNER_MERGES');
const sourceComparison=api('repos/'+repository+'/compare/'+originalSource.merge_commit+'...'+p1.merge_commit);
need(sourceComparison.base_commit?.sha===originalSource.merge_commit&&sourceComparison.merge_base_commit?.sha===originalSource.merge_commit&&['ahead','identical'].includes(sourceComparison.status),'ORIGINAL_SOURCE_MUST_BE_ANCESTOR_OF_P1');
const comparison=api('repos/'+repository+'/compare/'+p1.merge_commit+'...'+p2.merge_commit);
need(comparison.base_commit?.sha===p1.merge_commit&&comparison.merge_base_commit?.sha===p1.merge_commit&&['ahead','identical'].includes(comparison.status),'P1_MUST_BE_ANCESTOR_OF_P2');

function actualBlobRaw(ref){
  const m=/^https:\/\/api[.]github[.]com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/([0-9a-f]{40})$/.exec(ref?.uri);
  need(m&&hex64(ref.sha256),'EXACT_GITHUB_BLOB_REF');
  const response=api('repos/'+repository+'/git/blobs/'+m[1]);
  need(response.sha===m[1]&&response.encoding==='base64','ACTUAL_BLOB_RESPONSE');
  const bytes=Buffer.from(response.content,'base64');
  need(bytes.length===response.size&&sha(bytes)===ref.sha256&&blob(bytes)===m[1],'ACTUAL_BLOB_BYTES');
  return {id:m[1],raw:bytes.toString('utf8')};
}
function artifactAt(raw,pub,repoPath,label){
  need(typeof repoPath==='string'&&!repoPath.startsWith('/')&&!repoPath.includes('..'),label+'_SAFE_REPO_PATH');
  const id=blob(raw),matches=pub.tree.filter(e=>e.path===repoPath);
  need(matches.length===1&&matches[0].type==='blob'&&matches[0].mode==='100644'&&matches[0].sha===id,label+'_EXACT_PUBLICATION_PATH');
  const remote=actualBlobRaw({uri:'https://api.github.com/repos/'+repository+'/git/blobs/'+id,sha256:sha(raw)});
  need(remote.raw===raw,label+'_ACTUAL_PUBLISHED_BYTES');
  return {raw,publication:{commitSha:pub.merge_commit,artifactPath:repoPath}};
}
function descriptor(ref,pub=originalSource,exactPath=null){
  const source=actualBlobRaw(ref);
  const matches=pub.tree.filter(e=>e.type==='blob'&&e.mode==='100644'&&e.sha===source.id&&(exactPath===null||e.path===exactPath));
  need(matches.length>0,'BLOB_NOT_IN_OWNER_MERGE:'+source.id);
  return {ref,raw:source.raw,publication:{commitSha:pub.merge_commit,artifactPath:matches.map(e=>e.path).sort()[0]}};
}

exactKeys(cfg.paths,['runtime_acceptance_local','runtime_acceptance_repo','controller_qualification_local','controller_qualification_repo','status29_signing_payload_local','status29_signing_payload_repo'],'EXACT_LOCAL_AND_REPO_PATHS');
const runtimeRaw=read(cfg.paths.runtime_acceptance_local),runtime=JSON.parse(runtimeRaw);
const qualificationRaw=read(cfg.paths.controller_qualification_local),qualification=JSON.parse(qualificationRaw);
const statusPayloadRaw=read(cfg.paths.status29_signing_payload_local),statusPayload=JSON.parse(statusPayloadRaw);
artifactAt(runtimeRaw,p2,cfg.paths.runtime_acceptance_repo,'ROOT10_RUNTIME');
artifactAt(qualificationRaw,p2,cfg.paths.controller_qualification_repo,'ROOT10_QUALIFICATION');
artifactAt(statusPayloadRaw,p2,cfg.paths.status29_signing_payload_repo,'STATUS29_SIGNING_PAYLOAD');
need(runtime.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&runtime.independent_reviewer==='/root'&&runtime.no_automatic_retry===true&&runtime.no_successor_ga===true,'EXACT_ROOT10_RUNTIME');
need(qualification.state==='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'&&qualification.independent_reviewer==='/root'&&qualification.first_budget_sequence===117&&qualification.automatic_retry===false&&qualification.successor_ga===false,'EXACT_ROOT10_QUALIFICATION');
need(runtime.controller_digest===qualification.controller_digest&&runtime.scope_digest===qualification.scope_digest,'RUNTIME_QUALIFICATION_BINDING');
const subject=runtime.accepted_subject,expected=subject?.expected_ga;
need(subject?.root10_single_window?.contract_ref&&subject.root10_single_window.result_reviewer?.publication?.commitSha===p1.merge_commit&&subject.root10_single_window.executor_applicability?.publication?.commitSha===p1.merge_commit,'EXACT_ROOT10_P1_RUNTIME_BINDING');
need(subject.root10_single_window.result_reviewer.publication.artifactPath&&subject.root10_single_window.executor_applicability.publication.artifactPath,'EXACT_ROOT10_P1_ARTIFACT_PATHS');
need(same(subject.result_reviewer_ref,subject.root10_single_window.result_reviewer.ref),'EXACT_ROOT10_RESULT_REVIEWER_REF');
for(const purpose of ['STATUS','GATE_AUTHORIZATION','GATE_RESULT'])need(subject.root10_single_window.issuer_qualification_refs?.[purpose]?.sha256===qualification.issuer_qualification_sha256?.[purpose],'EXACT_ROOT10_ISSUER_QUALIFICATION:'+purpose);
descriptor(subject.root10_single_window.contract_ref,p1);
descriptor(subject.root10_single_window.result_reviewer.ref,p1,subject.root10_single_window.result_reviewer.publication.artifactPath);
descriptor(subject.root10_single_window.executor_applicability.ref,p1,subject.root10_single_window.executor_applicability.publication.artifactPath);
need(statusPayload.object_type==='StatusManifest'&&statusPayload.generation===29&&statusPayload.control_trust_root_generation===qualification.generation_id&&statusPayload.schema_digest===subject.control_schema_refs?.StatusManifest?.sha256,'EXACT_STATUS29_PAYLOAD');
need(subject.late_bound_fields?.status_manifest_ref?.signed_payload_sha256===digest(statusPayload),'STATUS29_ACCEPTED_SIGNING_PAYLOAD');
need(expected?.controller_digest===runtime.controller_digest&&expected.controller_qualification_ref?.sha256===sha(qualificationRaw)&&expected.control_trust_root_generation===qualification.generation_id,'EXACT_FIXED_GA_RUNTIME_BINDING');

const gaPath=valueAfter('--ga'),statusFullPath=valueAfter('--status-full');
need(!(statusFullPath&&!gaPath),'STATUS_FULL_REQUIRES_FINAL_GA');
let gaRaw=null,ga=null;
const fixedKeys=Object.keys(expected).sort();
need(fixedKeys.length===38,'EXACT_38_FIXED_GA_FIELDS');
if(gaPath){
  gaRaw=read(gaPath);ga=JSON.parse(gaRaw);need(JSON.stringify(ga)+'\n'===gaRaw,'EXACT_COMPACT_GA');
  const late=['gate_authorization_id','authorization_status','status_manifest_ref','issued_at','expires_at','deadline','budget_reservation_ref','target_revision','runner_generation','credential_generation','session_generation','idempotency_key','signature'];
  need(Object.keys(ga).sort().join(',')===[...fixedKeys,...late].sort().join(',')&&Object.keys(ga).length===51,'EXACT_51_FIELD_GA');
  for(const key of fixedKeys)need(same(ga[key],expected[key]),'EXACT_ACCEPTED_GA_FIELD:'+key);
  need(ga.target_revision===p2.merge_commit&&ga.controller_digest===runtime.controller_digest&&ga.controller_qualification_ref.sha256===sha(qualificationRaw),'EXACT_FINAL_GA_P2_TARGET');
  need(ga.control_trust_root_generation===qualification.generation_id&&ga.authorization_status==='AUTHORIZED'&&ga.purpose==='SKILL_COEXISTENCE_QUALIFICATION'&&ga.environment==='ISOLATED_TEST','EXACT_FINAL_GA_SCOPE');
  need(Date.parse(ga.deadline)-Date.parse(ga.issued_at)===600000&&ga.expires_at===ga.deadline,'EXACT_FINAL_GA_600_SECONDS');
}
const source=ga??expected;
const gateRef=source.artifact_refs?.find(ref=>ref.sha256===subject.gate?.content_digest);
need(gateRef&&gateRef.sha256===subject.gate.content_digest,'EXACT_GATE_REF');
const prerequisiteRefs=[source.profile_ref.accepted_ref,...source.stage_receipt_refs,...source.upstream_gate_result_receipt_refs];
const uniquePrerequisites=[...new Map(prerequisiteRefs.map(ref=>[ref.uri+'\0'+ref.sha256,ref])).values()];
let statusFullRaw=null;
if(statusFullPath){
  statusFullRaw=read(statusFullPath);const full=JSON.parse(statusFullRaw),payload=structuredClone(full);delete payload.signature_binding;
  need(same(payload,statusPayload)&&sha(statusFullRaw)===ga.status_manifest_ref.sha256&&ga.status_manifest_ref.uri==='control://status-manifests/'+full.status_manifest_id,'EXACT_FULL_STATUS29_AND_GA_REF');
  need(full.signature_binding?.owner_merge_commit===p2.merge_commit&&full.signature_binding?.signed_object_sha256===digest(statusPayload),'EXACT_STATUS29_SIGNATURE_BINDING');
}
const runtimeArtifact=artifactAt(runtimeRaw,p2,cfg.paths.runtime_acceptance_repo,'ROOT10_RUNTIME');
const qualificationArtifact=artifactAt(qualificationRaw,p2,cfg.paths.controller_qualification_repo,'ROOT10_QUALIFICATION');
const material={
  operation:'CREATE',ga_raw:gaRaw,
  runtime_acceptance:runtimeArtifact,
  controller_qualification:qualificationArtifact,
  gate_definition:descriptor(gateRef,originalSource),
  profile_signing_payload:descriptor(subject.profile_signing_payload_ref,originalSource),
  prerequisite_materials:uniquePrerequisites.map(ref=>descriptor(ref,originalSource)),
  gate_suite:descriptor(subject.gate_suite_ref,originalSource),
  execution_scope:descriptor(source.scope_ref,originalSource),
  result_reviewer:descriptor(subject.result_reviewer_ref,p1,subject.root10_single_window.result_reviewer.publication.artifactPath),
  status_manifest:{raw:statusFullRaw,payload_raw:statusPayloadRaw,publication:{commitSha:p2.merge_commit,artifactPath:cfg.paths.status29_signing_payload_repo},store_ref:ga?.status_manifest_ref??null,source_binding_sha256:sha(runtimeRaw)},
};
process.stdout.write(JSON.stringify(material)+'\n');
