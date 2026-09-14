#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const repoArg=arg('--repo-root');if(!repoArg)throw Error('REPO_ROOT_REQUIRED');
const repo=path.resolve(repoArg),builder=path.join(HERE,'build-status27-completion.mjs');
const evidence=path.join(repo,'work/recovery-root9/postbudget-cas-p3/P2PublicationEvidence.verified.json');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'p2-status27-portable-'));
const need=(v,m)=>{if(!v)throw Error(m);};
const run=a=>spawnSync(process.execPath,[builder,...a],{encoding:'utf8'});
const reject=(name,a,marker)=>{const r=run(a);need(r.status!==0&&(r.stdout+r.stderr).includes(marker),`${name}:${r.status}:${r.stdout}:${r.stderr}`);};
try{
  const out=path.join(tmp,'out');
  const positive=run(['--repo-root',repo,'--p2-publication-evidence',evidence,'--out',out]);
  need(positive.status===0&&positive.stdout.includes('P2_SIGNED_STATUS27_COMPLETION_PASS_FOR_P3_PUBLICATION'),`positive:${positive.stderr}`);
  const sig=JSON.parse(fs.readFileSync(path.join(out,'Status27SignatureEvidence.json'))),full=JSON.parse(fs.readFileSync(path.join(out,'Status27Generation.json')));
  need(sig.state==='P2_OWNER_MERGE_BOUND_VERIFIED'&&sig.merge.sha==='20d6ec1e62eebed26e56bc2e4f52eed87704e8ab','P2_BINDING');
  need(sig.payload.blob_sha1==='1816ca696f55bd8d4b182d1edd4d5e2d912f5705'&&sig.payload.raw_sha256==='9701fd4512797f4a90b96a59e06f438422e84f8eb03038fd3ae947ec46fd5c95','PAYLOAD_ID');
  need(!Object.hasOwn(sig.bound_refs,'p3_publication_evidence')&&!Object.hasOwn(sig.bound_refs,'status_manifest'),'NO_BACKEDGE');
  need(full.signature_binding.owner_merge_commit===sig.merge.sha&&full.signature_binding.signature_evidence_ref.sha256==='54a8dfdeb553266ddc83842d523869ab65488d73f2356645a87a3a3ce26664e4','FULL_BINDING');
  reject('missing-repo',['--p2-publication-evidence',evidence,'--verify-only'],'REPO_ROOT_REQUIRED');
  reject('missing-evidence',['--repo-root',repo,'--verify-only'],'P2_PUBLICATION_EVIDENCE_REQUIRED');
  const bad=path.join(tmp,'bad.json');fs.writeFileSync(bad,'{}\n');
  reject('bad-evidence',['--repo-root',repo,'--p2-publication-evidence',bad,'--verify-only'],'P2_PUBLICATION_EVIDENCE_RAW_IDENTITY');
  reject('missing-out',['--repo-root',repo,'--p2-publication-evidence',evidence],'OUT_REQUIRED');
  reject('p2-output',['--repo-root',repo,'--p2-publication-evidence',evidence,'--out',path.join(repo,'work/recovery-root9/postbudget-stage2/child')],'REFUSE_P2_OUTPUT');
  const conflict=path.join(tmp,'conflict');fs.mkdirSync(conflict);fs.writeFileSync(path.join(conflict,'Status27SignatureEvidence.json'),'{}\n');
  reject('conflict',['--repo-root',repo,'--p2-publication-evidence',evidence,'--out',conflict],'REFUSE_OVERWRITE_DIFFERENT_BYTES');
  need(JSON.stringify(sig).includes('no_full_status_reverse_hash')&&!JSON.stringify(sig).includes('Status27Generation.json'),'NO_CYCLE_TOKEN');
  need(full.generation===27&&full.signature_binding.signed_object_sha256==='c3fd1848edbd0b186cb0ba259cb3e8d739bcb3f0dac25754985133de68813a06','FULL_SCHEMA_SHAPE');
  console.log(JSON.stringify({state:'P2_STATUS27_PORTABLE_TEST_PASS',positive:1,negative_cases:8,repo_root_fixture:true,one_way_hash_chain:true,live_writes:0}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
