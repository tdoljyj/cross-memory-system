// Reuse only the established disposable PostgreSQL fixture, not previous cases.
import fs from 'node:fs';
let fixture=fs.readFileSync(new URL('../evidence.test.mjs',import.meta.url),'utf8').split('  const windowStart=')[0];
fixture=fixture.replace("{createExecutionStore,projectRef,rootId} from './client.mjs'","{createControlObjectStore as createExecutionStore,projectRef,rootId} from './client.mjs'")
 .replace('../../../../apps/','../../../../../apps/').replace("directory,'../install.candidate.sql'","directory,'../../install.candidate.sql'")
 .replaceAll("'G1'","'G-PREENTRY-SKILL-QUALIFICATION'");
const cases=String.raw`
  const status=id=>({object_type:'StatusManifest',schema_version:'1.0',
   schema_digest:'6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2',status_manifest_id:'sm_'+id,
   issuer_purpose:'STATUS',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',
   control_trust_root_generation:gen,generation:1,as_of:new Date(Date.now()-1000).toISOString(),
   expires_at:new Date(Date.now()+120000).toISOString(),signature_binding:{synthetic_only:true}});
  const sm=status('fixed'),smRaw=JSON.stringify(sm)+'\n',smURI='control://status-manifests/'+sm.status_manifest_id;
  await t.test('Status exact bytes are globally unique, immutable and private',async()=>{
   assert.equal((await store.appendStatus(smRaw)).status,'STORED_NO_AUTHORITY');
   assert.equal((await store2.appendStatus(smRaw)).status,'DUPLICATE');
   await assert.rejects(store.appendStatus(JSON.stringify({...sm,as_of:new Date(Date.now()-2000).toISOString()})+'\n'),/immutable_status_identity_conflict/);
   await assert.rejects(store.appendStatus(JSON.stringify({...sm,status_manifest_id:'sm_second'})+'\n'),/duplicate key/);
   await assert.rejects(store.appendStatus(JSON.stringify({...sm,status_manifest_id:'sm_wrong',issuer_purpose:'GATE_RESULT'})+'\n'),/status_scope_or_encoding_mismatch/);
   await assert.rejects(writer.query('select * from clued_control.control_objects'),/permission denied/);
   await assert.rejects(admin.query("update clued_control.control_objects set raw=raw"),/immutable/);
   assert.equal((await admin.query('select count(*)::int n from clued_control.control_objects')).rows[0].n,1);
  });
  const ga=makeGa('status'),raw=JSON.stringify({...ga,status_manifest_ref:{uri:smURI,sha256:sha(smRaw)}});
  await t.test('reserve requires actual stored Status and reads only the active exact object',async()=>{
   await assert.rejects(store.reserveExactGa(JSON.stringify(ga)),/exact_stored_status_required/);
   await store.reserveExactGa(raw);
   await store.appendStatus(JSON.stringify({...sm,status_manifest_id:'sm_unrelated',generation:2})+'\n');
   const current=await store.read();
   assert.deepEqual(current.control_objects,[{object_type:'StatusManifest',uri:smURI,raw:smRaw,sha256:sha(smRaw)}]);
   await writer.query("set timezone='Asia/Shanghai'");const otherZone=await store.read();
   await writer.query("set timezone='UTC'");assert.deepEqual(otherZone,await store.read());
  });
  // This isolated fixture positions an already-stopped attempt solely to test
  // new evidence storage; it is not evidence of a real Docker STOP or GA.
  await admin.query("update clued_control.gate_attempts set phase='STOPPED',container_id=$1 where ga_id='ga_status'",[container]);
  const dRaw=JSON.stringify({ga_id:'ga_status',ga_sha256:sha(raw),result:'BLOCKED',synthetic_fixture:true})+'\n';
  const eRaw=JSON.stringify({ga_id:'ga_status',ga_sha256:sha(raw),events:[],synthetic_fixture:true})+'\n';
  let n=0;
  const transition=async body=>{const current=await store.read();return store.transition({ga_id:'ga_status',operation:'DECISION_RESERVED',idempotency_key:'decision_'+(++n),expected_sequence:current.current.sequence,body});};
  const body={result:'BLOCKED',decision_raw:dRaw,decision_sha256:sha(dRaw),evidence_index_raw:eRaw,evidence_index_sha256:sha(eRaw)};
  await t.test('decision and index require full hash-matching bytes bound to this exact GA',async()=>{
   await assert.rejects(transition({...body,decision_raw:undefined}),/complete_reserved_evidence_bytes_required/);
   await assert.rejects(transition({...body,evidence_index_sha256:'b'.repeat(64)}),/complete_reserved_evidence_bytes_required/);
   const foreign=JSON.stringify({ga_id:'ga_other',ga_sha256:sha(raw)});
   await assert.rejects(transition({...body,evidence_index_raw:foreign,evidence_index_sha256:sha(foreign)}),/reserved_evidence_ga_mismatch/);
   assert.equal((await store.read()).attempts[0].phase,'STOPPED');
   const recorded=await transition(body);
   const current=await store.read();
   assert.deepEqual(current.attempts[0].decision,body);
   assert.equal((await store.readEvent(recorded.sequence)).event.request.body.decision_raw,dRaw);
   assert.deepEqual(recorded.current_context.control_objects,current.control_objects);
   assert.equal(recorded.current_context.attempts[0].phase,'DECISION_RESERVED');
   assert.equal(recorded.current_context.current.sequence,recorded.sequence);
   await assert.rejects(transition(body),/decision_reservation_conflict/);
   assert.equal(current.current.active_ga_id,'ga_status');assert.equal(current.attempts[0].receipt_raw,null);
  });
  assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{value:'unchanged'}]);
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));await server.stop().catch(()=>{});}
});
`;
fs.writeFileSync(new URL('control-objects.test.mjs',import.meta.url),fixture+cases);
