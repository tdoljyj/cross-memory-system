import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {checkAuthorizationLifetime} from './result-terminal.mjs';
import {checkConsumedBudget} from './budget-evidence.mjs';
import {checkDockerWriteIdentity,fixedWriteTargetRules} from './write-targets.mjs';
import {checkStoppedObservation} from './grr.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('600 successor lifetime accepts exact600, rejects601/effect expiry; expired nonPASS only remains nonauthority',()=>{
 const a={operation:'CREATE',issued:1000,deadline:601000,expires:601000,now:2000};
 assert.equal(checkAuthorizationLifetime(a).authority_effect,'NONE');
 assert.throws(()=>checkAuthorizationLifetime({...a,deadline:602000,expires:602000}));
 assert.throws(()=>checkAuthorizationLifetime({...a,now:601000}));
 assert.throws(()=>checkAuthorizationLifetime({...a,operation:'GRR',result:'PASS',now:602000}));
 assert.equal(checkAuthorizationLifetime({...a,operation:'GRR',result:'FAIL',now:602000}).historical_nonpass_only,true);
});
test('synthetic600 consumed original budget rejects180, duplicate consumption and changed raw',()=>{
 const now=Date.parse('2026-09-08T12:00:01Z'),root={root_set_id:'SYNTHETIC_ONLY',expires_at:'2026-09-08T14:00:00Z'},project='SYNTHETIC_ONLY';
 const b={controller_digest:'c',credential_generation:'c',environment:'ISOLATED_TEST',evidence_bytes:134217728,expires_at:'2026-09-08T13:00:00Z',idempotency_key:'synthetic',not_before:'2026-09-08T12:00:00Z',profile_digest:'p',purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:'r',runner_generation:'r',scope_digest:'s',seconds:600,session_generation:'s'};
 const raw=JSON.stringify(b)+'\n',attempt={budget_sequence:1},ga={...b,control_trust_root_generation:'r',issued_at:b.not_before,expires_at:'2026-09-08T12:10:00Z',budget_reservation_ref:{uri:'urn:clued:control-evidence:'+project+':execution-events:1',sha256:sha(raw)}};
 const state={current:{pending_budget_sequence:null},attempts:[attempt],events:[{sequence:1,root_id:root.root_set_id,request:{operation:'BUDGET_RESERVED',body:{raw,sha256:sha(raw)}}}]};
 const a={ga,state,attempt,root,project,now};assert.equal(checkConsumedBudget(a).sequence,1);
 for(const mutate of [x=>x.state.attempts.push({budget_sequence:1}),x=>x.state.events[0].request.body.raw+=' ',x=>{const n={...b,seconds:180},r=JSON.stringify(n)+'\n';x.state.events[0].request.body={raw:r,sha256:sha(r)};x.ga.budget_reservation_ref.sha256=sha(r);}]){const changed=structuredClone(a);mutate(changed);assert.throws(()=>checkConsumedBudget(changed));}
});
test('actual historical inspect proves distinct manifest/config domains; mutants cannot substitute image/identity/STOP',()=>{
 const p=new URL('../docker-engineering-observation/work/observation/main-after-stop.stdout',import.meta.url),bytes=fs.readFileSync(p);
 assert.equal(sha(bytes),'2481ef1f263a714083f51cfa4f213bf43f0df0a071ce54bf7de5b3c56b781f82');
 const value=JSON.parse(bytes)[0],nonce=value.Name.slice('/clued-synthetic-'.length);
 // Original engineering container has its own recorded name. Preserve it verbatim for STOP;
 // a synthetic copy exercises only the new fixed runtime name binding.
 checkStoppedObservation(value,value.Id);
 const synthetic={...value,Name:'/clued-synthetic-'+nonce};checkDockerWriteIdentity(synthetic,value.Id,nonce);
 for(const change of [x=>x.Image=fixedWriteTargetRules.docker_config_digest,x=>x.Config.Image='docker.io/other@'+fixedWriteTargetRules.docker_manifest_digest,x=>x.Id='0'.repeat(64),x=>x.Name+='changed']){const v=structuredClone(synthetic);change(v);assert.throws(()=>checkDockerWriteIdentity(v,value.Id,nonce));}
 for(const change of [x=>x.Id='0'.repeat(64),x=>x.State.Pid=1,x=>x.State.Pid='0',x=>x.State.FinishedAt='0001-01-01T00:00:00Z',x=>x.State.FinishedAt='2026-02-30T00:00:00Z']){const v=structuredClone(value);change(v);assert.throws(()=>checkStoppedObservation(v,value.Id));}
});
