#!/usr/bin/env node
// Pure in-memory adversarial checks for the P3 fail-closed contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const get=n=>JSON.parse(fs.readFileSync(path.join(HERE,n)));
const e=get('P2PublicationEvidence.verified.json');
const sig=get('Status27SignatureEvidence.json');
const review=get('IndependentReview.NO_AUTHORITY.template.json');
const sql=fs.readFileSync(path.join(HERE,'postbudget_root9_cas.template.sql'),'utf8');
const rejects=(name,fn)=>{let failed=false;try{fn();}catch{failed=true;}assert.equal(failed,true,`${name}_MUST_REJECT`);};
const need=(v,m)=>{if(!v)throw Error(m);};
const clone=v=>structuredClone(v);
const verifyEvidence=x=>{
  need(x.state==='VERIFIED_POSTBUDGET_STAGE2_OWNER_MERGE','state');
  need(x.merge.sha==='20d6ec1e62eebed26e56bc2e4f52eed87704e8ab','merge');
  need(x.merge.tree==='54c448837711086bcf0e334de4c6acc97c1f338f','tree');
  need(x.merge.verification.verified===true&&x.merge.verification.reason==='valid','verified');
  need(x.merge.parents[0]==='251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5'&&x.merge.parents[1]==='64e8dec1549af469cf4647df8a3aa3945b76a3e6','parents');
};
const requireAbsentBudget=acc=>need(!Object.hasOwn(acc.accepted_subject.expected_ga,'budget_reservation_ref'),'expected_ga_budget_must_be_absent');
const onlySequenceUpdate=s=>{
  const cas=s.split('do $postbudget_root9_cas$')[1]?.split('$postbudget_root9_cas$;')[0]??'';
  const u=cas.match(/update\s+clued_control\.execution_current\s+set\s+([\s\S]*?)\s+where\b/i);
  need(u&&/^sequence\s*=\s*104\s*$/i.test(u[1].trim()),'update_set');
};

verifyEvidence(e);
for(const [name,mutate] of [
  ['unverified',x=>x.merge.verification.verified=false],
  ['reason',x=>x.merge.verification.reason='unsigned'],
  ['merge',x=>x.merge.sha='0'.repeat(40)],
  ['tree',x=>x.merge.tree='0'.repeat(40)],
  ['first-parent',x=>x.merge.parents[0]='0'.repeat(40)],
  ['source-parent',x=>x.merge.parents[1]='0'.repeat(40)]
]){const x=clone(e);mutate(x);rejects(name,()=>verifyEvidence(x));}

const absent={accepted_subject:{expected_ga:{}}}; requireAbsentBudget(absent);
const jsonNull=clone(absent);jsonNull.accepted_subject.expected_ga.budget_reservation_ref=null;
rejects('explicit-json-null-budget',()=>requireAbsentBudget(jsonNull));
need(!Object.hasOwn(sig.bound_refs,'status_manifest'),'signature-cycle');
need(sig.state==='P2_OWNER_MERGE_BOUND_VERIFIED','p2-signature-state');
const cyclic=clone(sig);cyclic.bound_refs.status_manifest={sha256:'0'.repeat(64)};
rejects('signature-full-status-backedge',()=>need(!Object.hasOwn(cyclic.bound_refs,'status_manifest'),'cycle'));
onlySequenceUpdate(sql);
rejects('charged-seconds-set',()=>onlySequenceUpdate(sql.replace('set sequence=104','set sequence=104, charged_seconds=0')));
rejects('pending-budget-set',()=>onlySequenceUpdate(sql.replace('set sequence=104','set sequence=104, pending_budget_sequence=103')));
rejects('review-template-not-pass',()=>need(review.state==='PASS_NO_BLOCKERS','not-a-review'));
console.log(JSON.stringify({state:'POSTBUDGET_CAS_P3_NEGATIVE_SELFTEST_PASS',negative_cases:11,explicit_json_null_budget_rejected:true,signature_hash_loop_rejected:true,budget_or_charge_update_rejected:true,review_template_cannot_pass:true,database_writes:0}));
