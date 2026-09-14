#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const nested=path.join(HERE,'payload/work/recovery-root9/stage2b');
const OUT=fs.existsSync(path.join(HERE,'RESULT.json'))?HERE:nested;
const repoRoot=OUT===HERE?path.resolve(HERE,'../../..'):path.resolve(HERE,'../..');
const workspaceRoot=OUT===HERE&&!fs.existsSync(path.join(repoRoot,'apps/clued-cloud/package.json'))?path.resolve(HERE,'../../../../../..'):path.resolve(HERE,'../..');
const gaPath=OUT===HERE?path.join(repoRoot,'work/ga-readiness/build-ga.mjs'):path.join(HERE,'payload/work/ga-readiness/build-ga.mjs');
const localRoot=path.join(workspaceRoot,'repair-root9');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>sha(Buffer.from(canonical(v)+'\n'));
const read=n=>fs.readFileSync(path.join(OUT,n));
const json=n=>JSON.parse(read(n));
const ref=b=>({uri:`https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${blob(b)}`,sha256:sha(b)});

const result=json('RESULT.json'),m2=json('Stage2APublicationRefs.verified.json'),root=json('Root9Generation.json'),proof=json('Root9SignatureEvidence.json'),status=json('Status26SigningPayload.json'),acc=json('RuntimeAcceptance.root9.json'),graph=json('dependency-graph.json');
assert.equal(result.state,'STAGE2B_PREPUBLICATION_CANDIDATE_PASS');
assert.equal(result.authority_effect,'NONE');
assert.equal(m2.merge.sha,'0ae9f5f29cc97982ef30f36fd8efbd67c521e5fd');
assert.deepEqual(m2.merge.parents,['ab097d2a46677a22ae2a102f278bd9c5f98573c5','2b6f4d2bde79e7ed903d2f74bb07a9f373d59c53']);
assert.equal(m2.merge.author_login,'tdoljyj');assert.equal(m2.merge.merged_by,'tdoljyj');assert.equal(m2.merge.committer_login,'web-flow');assert.equal(m2.merge.verification.verified,true);assert.equal(m2.merge.verification.reason,'valid');
assert.equal(proof.merge.sha,m2.merge.sha);assert.equal(proof.payload.blob_sha,'8959f752626bc5deb3902e5477d55b1350661a1a');assert.equal(proof.payload.file_sha256,'4c355619730d9e5e9d9bb0a2e5af7ace2fc619afcfe43dc6ba21c5385f84f37a');
assert.deepEqual(root.signature_binding.signature_evidence_ref,ref(read('Root9SignatureEvidence.json')));assert.equal(root.signature_binding.owner_merge_commit,m2.merge.sha);
const rootUnsigned=structuredClone(root);delete rootUnsigned.signature_binding;
assert.equal(digest(rootUnsigned),'f4c24b8dc86bfb7472d3b844c453b0821fe868ef02289870c6f0f13198888bfd');assert.equal(root.signature_binding.signed_object_sha256,digest(rootUnsigned));
assert.equal(digest(root),'7483e3d240b270d7ad49d9262c63bd49ae0290db08c1dec66aa0de2f239eab60');assert.equal(read('Root9CanonicalDigest.txt').toString().trim(),digest(root));
assert.equal(Object.hasOwn(status,'signature_binding'),false);assert.equal(status.generation,26);assert.equal(digest(status),'d0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8');assert.equal(read('Status26SignedPayloadDigest.txt').toString().trim(),digest(status));
assert.equal(status.source_refs.some(x=>x.uri.includes('/70e1a2b3ab171e6e93819518d39512575d7fc4a3')&&x.sha256==='171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71'),true);
assert.equal(status.source_refs.some(x=>x.uri.startsWith('urn:clued:control-trust-root-set:')&&x.sha256===digest(root)),true);
assert.equal(acc.controller_digest,result.controller_digest);assert.equal(acc.root9_binding.root_authority_ref.sha256,digest(root));assert.deepEqual(acc.root9_binding.status26_signing_payload_ref,ref(read('Status26SigningPayload.json')));assert.equal(acc.root9_binding.status26_signed_payload_sha256,digest(status));
assert.equal(acc.accepted_subject.expected_ga.schema_digest,result.schema_pins.ga);assert.equal(acc.accepted_subject.control_schema_refs.StatusManifest.sha256,result.schema_pins.status);assert.equal(acc.accepted_subject.control_schema_refs.GateResultReceipt.sha256,result.schema_pins.grr);
assert.equal(acc.accepted_subject.bounded_series_materials.repairs.length,8);assert.equal(acc.accepted_subject.bounded_series_materials.repairs[7].publication.commitSha,m2.merge.sha);assert.equal(acc.accepted_subject.late_bound_fields.target_revision.resolver,'ACTUAL_RUNTIME_AND_SOURCE_MANIFEST_OWNER_MERGE_V1');assert.equal(acc.publication_boundary.future_merge_sha_embedded,false);assert.equal(JSON.stringify(acc).includes('__PENDING'),false);
assert.equal(graph.cycle_detected,false);assert.equal(graph.forbidden_before_m3.includes('future M3 SHA'),true);
const ga=fs.readFileSync(gaPath,'utf8');assert.match(ga,/control-context-verifier-recovery-successor-root9\/context\.mjs/);assert.match(ga,/EXACT_TWO_PARENT_M2_MERGE_REQUIRED/);assert.match(ga,/UNIQUE_MAIN_PR_REQUIRED/);assert.match(ga,/TARGET_REVISION_MUST_BE_POST_M2_STAGE2B_MERGE/);assert.equal(/0{40}/.test(ga),false);
assert.match(ga,/ACC_PATH='work\/recovery-root9\/stage2b\/RuntimeAcceptance\.root9\.json'/);assert.match(ga,/BUILD_PATH='work\/ga-readiness\/build-ga\.mjs'/);assert.equal(ga.includes('RuntimeAcceptance.root9.candidate.json'),false);

function locate(relPublished,relLocal){const published=path.join(repoRoot,relPublished),local=path.join(localRoot,relLocal);return fs.existsSync(published)?published:local;}
const rootSchemaPath=locate('scripts/phase2-qualification/nonproduction-control-store/protocol-successor/control-trust-root-set.schema.json','root_candidate/source/control-trust-root-set.schema.json');
const statusSchemaPath=locate('scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/status-manifest.root5.schema.json','stage1-pr/payload/scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/status-manifest.root5.schema.json');
const pkg=fs.existsSync(path.join(repoRoot,'apps/clued-cloud/package.json'))?path.join(repoRoot,'apps/clued-cloud/package.json'):path.join(workspaceRoot,'ga-build-patch/apps/clued-cloud/package.json');
const require=createRequire(pkg),Ajv=require('ajv');
const compile=p=>{const s=JSON.parse(fs.readFileSync(p));const c=structuredClone(s);c.$schema='http://json-schema.org/draft-07/schema#';for(const k of Object.keys(c))if(k.startsWith('x-clued-'))delete c[k];return new Ajv({allErrors:true,strictKeywords:true,format:'full'}).compile(c);};
const rootCheck=compile(rootSchemaPath);assert.equal(rootCheck(root),true,JSON.stringify(rootCheck.errors));
const statusCheck=compile(statusSchemaPath),probe=structuredClone(status);probe.signature_binding={owner_merge_commit:'0'.repeat(40),signed_object_sha256:digest(status),signature_evidence_ref:{uri:'urn:pending:stage2c',sha256:'0'.repeat(64)}};assert.equal(statusCheck(probe),true,JSON.stringify(statusCheck.errors));

const sums=read('SHA256SUMS.txt').toString().trim().split('\n');assert.equal(sums.length,12);
for(const line of sums){const [want,repoPath]=line.split(/\s{2}/);const p=repoPath==='work/ga-readiness/build-ga.mjs'?gaPath:path.join(OUT,repoPath.replace(/^work\/recovery-root9\/stage2b\//,''));assert.equal(sha(fs.readFileSync(p)),want,'SHA256:'+repoPath);}
assert.equal(result.capacity_value_change,false);assert.equal(result.refund,false);assert.equal(result.database_writes,0);assert.equal(result.budget_reservations,0);assert.equal(result.ga_dispatches,0);
console.log(JSON.stringify({state:'STAGE2B_PREPUBLICATION_VERIFY_PASS',stage2b_files:11,external_build_ga:1,root9_canonical:digest(root),status26_S:digest(status),fixed_ga_fields:38,repair_refs:8,capacity_changed:false,refund:false,database_writes:0,budget_reservations:0,ga_dispatches:0,authority_effect:'NONE'},null,2));
