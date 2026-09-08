import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
import {prepareRestoration} from './prepare-restoration.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('preparation accepts only preserved terminal metadata; never executes SQL',()=>{
 const baselineRaw=fs.readFileSync(new URL('../../../../qualification-live/recovery-install-preflight.json',import.meta.url),'utf8'),patchRaw=fs.readFileSync(new URL('../predispatch-nonpass-successor/alter.candidate.sql',import.meta.url),'utf8');
 const current=JSON.parse(baselineRaw),body=patchRaw.slice(patchRaw.indexOf('as $$')+5,patchRaw.lastIndexOf('$$;'));current.stored_control_objects=structuredClone(current.execution.control_objects);current.execution.control_objects=[];
 // Explicit synthetic terminal fixture derived from the preserved original snapshot.
 current.transition_definition=patchRaw;const f=current.functions.find(x=>x.name==='execution_transition');f.sha256=sha(patchRaw);f.prosrc_sha256=sha(body);
 current.execution.current.active_ga_id=null;current.execution.current.pending_budget_sequence=null;const a=current.execution.attempts[0];a.phase='BLOCKED';a.receipt_id='grr_synthetic_restoration_only';a.receipt_raw=JSON.stringify({gate_result_receipt_id:a.receipt_id,result:'BLOCKED'})+'\n';a.receipt_sha256=sha(a.receipt_raw);a.decision={termination_mode:'PREDISPATCH_NONPASS_NOT_STARTED'};
 const result=prepareRestoration({baselineRaw,patchRaw,terminalSnapshot:current});assert.equal(result.new_qualification_admitted,false);assert.equal(result.expected_full_postimage.functions.find(x=>x.name==='execution_transition').sha256,'e75e18bbe3c7ed3125aba7b7b2c5db95e23b8022cd05b5bf0e818440becbca88');assert.ok(result.sql.includes('exact_terminal_restoration_preimage_drift'));assert.ok(result.sql.includes('original_fourteen_function_restoration_postimage_mismatch'));
 for(const mutate of [s=>s.execution.current.active_ga_id=a.ga_id,s=>s.execution.current.charged_seconds--,s=>s.execution.current.pending_budget_sequence=1,s=>s.execution.attempts[0].phase='UNKNOWN',s=>s.functions[0].acl=null,s=>s.execution.events.pop()]){const bad=structuredClone(current);mutate(bad);assert.throws(()=>prepareRestoration({baselineRaw,patchRaw,terminalSnapshot:bad}));}
});
