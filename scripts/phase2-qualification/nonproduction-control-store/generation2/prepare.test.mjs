import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prepare,generation} from './prepare.mjs';
const source=JSON.parse(fs.readFileSync(process.env.CLUED_ROOT2_SOURCE_PATH));
const base=new URL('../../../../artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/',import.meta.url);
const dynamic=fs.readFileSync(new URL('Generation2DynamicIssuerPurposeIndependentAcceptance.json',base));
const status=fs.readFileSync(new URL('Generation2StatusIssuerPurposeIndependentAcceptance.json',base));
test('actual generation 1 observation produces an unregistered exact forward subject',async()=>{
 const r=await prepare(source,dynamic,status);
 assert.equal(r.subject.control_trust_root_generation,generation);assert.equal(r.admission_boundary.root_registered,false);
 assert.equal(r.subject.history.prefix_sequence,1);assert.equal(r.subject.predecessor.sha256,'df0544694243768a473a7d45b50aa612937755aee9bf6b785ce8165363f2325a');
 assert.notEqual(r.subject.issuer_bindings[0].qualification_ref.sha256,r.subject.issuer_bindings[1].qualification_ref.sha256);
});
test('changed or incomplete remote event history cannot be accepted as the same predecessor',async()=>{
 const changed=structuredClone(source);changed.root_read.events[0].request.body.scope.model_budget=1;
 await assert.rejects(()=>prepare(changed,dynamic,status));
 const missing=structuredClone(source);missing.root_read.events=[];
 await assert.rejects(()=>prepare(missing,dynamic,status));
});
test('modified or crossed purpose acceptance bytes cannot qualify generation 2',async()=>{
 await assert.rejects(()=>prepare(source,status,dynamic));
 await assert.rejects(()=>prepare(source,Buffer.concat([dynamic,Buffer.from(' ')]),status));
});
