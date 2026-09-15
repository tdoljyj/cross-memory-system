// Read-only verification of corrective Root10 P2 and local assembly only.
// The original Root signature stays bound to PR190; corrected controller source
// is a distinct Owner publication. No database, signature mutation, budget or GA.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const need=(v,m)=>{if(!v)throw Error(m)};
const [configPath]=process.argv.slice(2);need(configPath&&process.argv.length===3,'CORRECTIVE_P2_CONFIG_REQUIRED');
const cfg=JSON.parse(fs.readFileSync(path.resolve(configPath),'utf8'));
const configKeys=['p2_pr_number','p2_head_branch','stage2_directory','original_root_publication_path','corrective_source_publication_path'];
need(Object.keys(cfg).sort().join(',')===configKeys.sort().join(','),'EXACT_CORRECTIVE_P2_CONFIG_FIELDS');
need(Number.isSafeInteger(cfg.p2_pr_number)&&cfg.p2_pr_number>0&&typeof cfg.p2_head_branch==='string'&&/^codex\/[A-Za-z0-9._/-]+$/.test(cfg.p2_head_branch),'EXACT_CORRECTIVE_P2_SELECTOR');
const repository='tdoljyj/cross-memory-system',prefix='repos/'+repository;
const api=p=>JSON.parse(execFileSync('gh',['api',prefix+p],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:30000,windowsHide:true}));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const digest=v=>sha(JSON.stringify(ordered(v))+'\n');
const blob=s=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(s)+'\0').update(s).digest('hex');
const serialize=v=>JSON.stringify(v,null,2)+'\n';
const ref=s=>({uri:'https://api.github.com/repos/'+repository+'/git/blobs/'+blob(s),sha256:sha(s)});
const stage2=path.resolve(cfg.stage2_directory),read=name=>fs.readFileSync(path.join(stage2,name),'utf8');
const rootP1=JSON.parse(fs.readFileSync(path.resolve(cfg.original_root_publication_path),'utf8'));
const sourceP1=JSON.parse(fs.readFileSync(path.resolve(cfg.corrective_source_publication_path),'utf8'));
need(rootP1.state==='ACTUAL_ROOT10_P1_OWNER_PUBLICATION_VERIFIED'&&rootP1.private===true&&rootP1.verified===true&&rootP1.pr===190,'ORIGINAL_ROOT_PR190_REQUIRED');
need(sourceP1.state==='ACTUAL_ROOT10_CORRECTIVE_SOURCE_OWNER_PUBLICATION_VERIFIED'&&sourceP1.private===true&&sourceP1.verified===true&&sourceP1.pr!==190&&sourceP1.merge_commit!==rootP1.merge_commit,'DISTINCT_CORRECTIVE_SOURCE_PUBLICATION_REQUIRED');
function verifyOwnerPublication(publication,label){
 const pr=api('/pulls/'+publication.pr),commit=api('/commits/'+publication.merge_commit);
 need(pr.merged===true&&pr.merged_by?.login==='tdoljyj'&&pr.base.ref==='main'&&pr.merge_commit_sha===publication.merge_commit,label+'_OWNER_PR');
 need(commit.sha===publication.merge_commit&&commit.parents.length===2&&commit.committer?.login==='web-flow'&&commit.commit.verification.verified===true&&commit.commit.verification.reason==='valid'&&commit.commit.tree.sha===publication.tree,label+'_VERIFIED_MERGE');
 return {pr,commit};
}
verifyOwnerPublication(rootP1,'ORIGINAL_ROOT_P1');verifyOwnerPublication(sourceP1,'CORRECTIVE_SOURCE_P1');
const lineage=api('/compare/'+rootP1.merge_commit+'...'+sourceP1.merge_commit);
need(lineage.base_commit.sha===rootP1.merge_commit&&lineage.merge_base_commit.sha===rootP1.merge_commit&&['ahead','identical'].includes(lineage.status),'ORIGINAL_ROOT_MUST_PRECEDE_CORRECTIVE_SOURCE');
const repo=api(''),p2Pr=api('/pulls/'+cfg.p2_pr_number);
need(repo.private===true&&repo.full_name===repository&&p2Pr.merged===true&&p2Pr.state==='closed'&&p2Pr.merged_by?.login==='tdoljyj'&&p2Pr.base.ref==='main'&&p2Pr.head.ref===cfg.p2_head_branch,'ACTUAL_PRIVATE_CORRECTIVE_P2_OWNER_MERGE_REQUIRED');
const merge=api('/commits/'+p2Pr.merge_commit_sha);
need(merge.sha===p2Pr.merge_commit_sha&&merge.parents.length===2&&merge.committer?.login==='web-flow'&&merge.commit.verification.verified===true&&merge.commit.verification.reason==='valid','VERIFIED_CORRECTIVE_P2_WEB_FLOW_MERGE_REQUIRED');
const comparison=api('/compare/'+sourceP1.merge_commit+'...'+merge.sha);
need(comparison.base_commit.sha===sourceP1.merge_commit&&comparison.merge_base_commit.sha===sourceP1.merge_commit&&comparison.status==='ahead','CORRECTIVE_SOURCE_MUST_PRECEDE_P2');
const tree=api('/git/trees/'+merge.commit.tree.sha+'?recursive=1');need(tree.truncated===false&&tree.sha===merge.commit.tree.sha,'COMPLETE_CORRECTIVE_P2_TREE_REQUIRED');
const base='work/root10-single-window/stage2/';
const names=['Root10P1Publication.verified.json','Root10CorrectiveSourcePublication.verified.json','Root10SignatureEvidence.json','Root10Generation.json','ControllerQualification.root10.json','RuntimeAcceptance.root10.json','Status29SigningPayload.json','Root10Stage2IndependentReview.json'];
const raw=Object.fromEntries(names.map(name=>[name,read(name)]));
need(raw['Root10P1Publication.verified.json']===fs.readFileSync(path.resolve(cfg.original_root_publication_path),'utf8'),'PUBLISHED_ORIGINAL_ROOT_PROOF_BYTES');
need(raw['Root10CorrectiveSourcePublication.verified.json']===fs.readFileSync(path.resolve(cfg.corrective_source_publication_path),'utf8'),'PUBLISHED_CORRECTIVE_SOURCE_PROOF_BYTES');
for(const [name,value] of Object.entries(raw)){
 const entries=tree.tree.filter(e=>e.path===base+name);need(entries.length===1&&entries[0].type==='blob'&&entries[0].mode==='100644'&&entries[0].sha===blob(value),'EXACT_CORRECTIVE_P2_PUBLISHED_BYTES:'+name);
 const remote=api('/git/blobs/'+entries[0].sha);need(remote.encoding==='base64'&&Buffer.from(remote.content,'base64').equals(Buffer.from(value)),'CORRECTIVE_P2_REMOTE_BLOB_BYTES:'+name);
}
const root=JSON.parse(raw['Root10Generation.json']),status=JSON.parse(raw['Status29SigningPayload.json']);
const qualification=JSON.parse(raw['ControllerQualification.root10.json']),runtime=JSON.parse(raw['RuntimeAcceptance.root10.json']),subject=runtime.accepted_subject;
const independent=JSON.parse(raw['Root10Stage2IndependentReview.json']);
need(independent.decision==='ROOT10_STAGE2_GO'&&independent.independent_reviewer==='/root/root9_recovery_review'&&Array.isArray(independent.blockers)&&independent.blockers.length===0,'EXACT_CORRECTIVE_STAGE2_GO_REQUIRED');
need(independent.original_root_publication?.merge_commit===rootP1.merge_commit&&independent.corrective_source_publication?.merge_commit===sourceP1.merge_commit,'INDEPENDENT_REVIEW_DUAL_PUBLICATION_BINDING');
for(const name of names.filter(n=>n!=='Root10Stage2IndependentReview.json'))need(independent.reviewed_artifacts?.[name]?.sha256===sha(raw[name]),'INDEPENDENT_REVIEW_EXACT_BYTES:'+name);
need(digest(root.signature_binding.signature_evidence_ref)===digest(ref(raw['Root10SignatureEvidence.json']))&&root.control_trust_root_generation==='ctrgen_48100437d24e448ba01c542ebe1290da'&&root.signature_binding.owner_merge_commit===rootP1.merge_commit,'EXACT_ORIGINAL_PR190_ROOT_BINDING');
need(qualification.source_publication?.owner_merge_commit===sourceP1.merge_commit&&qualification.source_publication.source_tree===sourceP1.tree&&runtime.controller_digest===qualification.controller_digest&&subject.expected_ga.source_ref.commit===sourceP1.merge_commit&&subject.expected_ga.source_ref.tree===sourceP1.tree,'EXACT_CORRECTIVE_CONTROLLER_SOURCE_BINDING');
need(subject.root10_single_window?.result_reviewer?.publication?.commitSha===rootP1.merge_commit&&subject.root10_single_window.executor_applicability?.publication?.commitSha===sourceP1.merge_commit,'EXACT_SPLIT_RUNTIME_PUBLICATION_BINDING');
need(status.object_type==='StatusManifest'&&status.generation===29&&status.control_trust_root_generation===root.control_trust_root_generation&&!Object.hasOwn(status,'signature_binding'),'EXACT_UNSIGNED_STATUS29');
need(status.issuer_purpose==='STATUS'&&digest(status.issuer_ref)===digest(root.issuer_bindings.find(x=>x.purpose==='STATUS').qualification_ref)&&runtime.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256===digest(status),'EXACT_STATUS29_RUNTIME_BINDING');
need(Date.parse(merge.commit.committer.date)>=Date.parse(root.not_before)&&Date.parse(merge.commit.committer.date)<Date.parse(root.expires_at)&&status.expires_at===root.expires_at,'CORRECTIVE_P2_WITHIN_ROOT10_WINDOW');
const observed_at=new Date().toISOString();
const publication={state:'ACTUAL_ROOT10_P2_OWNER_PUBLICATION_VERIFIED',repository,private:true,pr:cfg.p2_pr_number,url:p2Pr.html_url,merged_by:p2Pr.merged_by.login,merge_commit:merge.sha,tree:merge.commit.tree.sha,parents:merge.parents.map(p=>p.sha),committer:merge.committer.login,verified:true,verification_reason:'valid',original_root_merge_commit:rootP1.merge_commit,corrective_source_merge_commit:sourceP1.merge_commit,observed_at,artifacts:Object.fromEntries(Object.entries(raw).map(([n,v])=>[n,{...ref(v),path:base+n}])),authority_effect:'NONE_UNTIL_REVIEWED_EXPECTED_CURRENT_ACTIVATION'};
const publicationRaw=serialize(publication);
const evidence={kind:'STATUS_SIGNING_PAYLOAD_SIGNATURE_BINDING',status:'VERIFIED',issuer_purpose:'STATUS',observed_at,repository:{full_name:repository,private:true},pr:{number:cfg.p2_pr_number,url:p2Pr.html_url,merged_by:p2Pr.merged_by.login,merge_commit_sha:merge.sha},merge:{sha:merge.sha,tree:merge.commit.tree.sha,parents:merge.parents.map(p=>p.sha),committer_login:merge.committer.login,verification:{verified:true,reason:'valid'}},payload:{artifact_path:base+'Status29SigningPayload.json',blob_sha:blob(raw['Status29SigningPayload.json']),file_sha256:sha(raw['Status29SigningPayload.json']),payload_sha256:digest(status)},authority_effect:'NONE',database_write:false,ga_issued:false};
const evidenceRaw=serialize(evidence),fullStatus={...status,signature_binding:{owner_merge_commit:merge.sha,signed_object_sha256:digest(status),signature_evidence_ref:ref(evidenceRaw)}},fullStatusRaw=serialize(fullStatus);
const common={root_id:root.root_set_id,generation_id:root.control_trust_root_generation,controller_sha256:qualification.controller_digest,qualification_sha256:sha(raw['ControllerQualification.root10.json']),runtime_acceptance_sha256:sha(raw['RuntimeAcceptance.root10.json']),original_root_owner_merge_commit:rootP1.merge_commit,corrective_source_owner_merge_commit:sourceP1.merge_commit,p2_owner_merge_commit:merge.sha,required_repair_refs:[],acceptance_publication_ref:ref(publicationRaw),controller_qualification_ref:ref(raw['ControllerQualification.root10.json']),runtime_acceptance_ref:ref(raw['RuntimeAcceptance.root10.json']),independent_review_ref:ref(raw['Root10Stage2IndependentReview.json']),authority_effect:'NONE_UNTIL_REVIEWED_EXPECTED_CURRENT_ACTIVATION',formal_pqual_claimed:false,ga_issued:false};
const files={'Root10P2Publication.verified.json':publicationRaw,'Status29SignatureEvidence.json':evidenceRaw,'Status29Generation.json':fullStatusRaw,'Root10PreparedEvidence.json':serialize({state:'ROOT10_EXACT_CORRECTIVE_SOURCE_P2_PREPARATION_EVIDENCE',...common}),'Root10QualifiedEvidence.json':serialize({state:'ROOT10_EXACT_CORRECTIVE_SOURCE_P2_QUALIFICATION_PUBLICATION_EVIDENCE',...common,status_manifest_ref:{uri:'control://status-manifests/'+status.status_manifest_id,sha256:sha(fullStatusRaw)}}),'Root10P2Assembly.json':serialize({state:'ROOT10_CORRECTIVE_P2_SIGNATURE_OBSERVED_NOT_ACTIVATED',publication_ref:ref(publicationRaw),status_signature_evidence_ref:ref(evidenceRaw),status_full_sha256:sha(fullStatusRaw),root_full_sha256:sha(raw['Root10Generation.json']),required_next_step:'Complete full rollback, negative probes, independent review and expected-current CAS before the sole GA',database_write:false,ga_issued:false,new_budget_allocated:false})};
process.stdout.write(JSON.stringify({files})+'\n');
