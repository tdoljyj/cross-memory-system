// Reuse established disposable PG fixture only, with no previous test cases.
import fs from 'node:fs';
let text=fs.readFileSync(new URL('../control-objects-successor/control-objects.test.mjs',import.meta.url),'utf8').split('  const status=id=>')[0];
text=text.replace('{createControlObjectStore as createExecutionStore,projectRef,rootId}', '{createBudgetStore as createExecutionStore,projectRef,rootId}')
 .replace("'session-initial',0,null,1410,19264968)","'session-initial',0,null,null,1410,19264968)");
text+=String.raw`
  const sm={object_type:'StatusManifest',schema_version:'1.0',schema_digest:'6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2',
   status_manifest_id:'sm_budget',issuer_purpose:'STATUS',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',
   control_trust_root_generation:gen,generation:1,as_of:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+300000).toISOString(),signature_binding:{synthetic_only:true}};
  const smRaw=JSON.stringify(sm)+'\n';await store.appendStatus(smRaw);
  const allocation=key=>({controller_digest:h,credential_generation:'credential-initial',environment:'ISOLATED_TEST',evidence_bytes:134217728,
   expires_at:new Date(Date.now()+300000).toISOString(),idempotency_key:key,not_before:new Date(Date.now()-1000).toISOString(),profile_digest:h,
   purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:gen,runner_generation:'runner-initial',scope_digest:h,seconds:180,session_generation:'session-initial'});
  const gaFor=(key,ref)=>({...makeGa(key),issued_at:new Date(Date.now()-100).toISOString(),
   status_manifest_ref:{uri:'control://status-manifests/sm_budget',sha256:sha(smRaw)},budget_reservation_ref:ref});
  await t.test('budget must be committed before GA consume; rollback preserves counters',async()=>{
   await writer.query('begin');const reservation=await store.reserveBudget(JSON.stringify(allocation('same_tx'))+'\n');
   await assert.rejects(store.reserveExactGa(JSON.stringify(gaFor('same_tx',reservation.budget_reservation_ref))),/exact_prior_committed_budget_required/);
   await writer.query('rollback');const current=(await store.read()).current;
   assert.equal(current.pending_budget_sequence,null);assert.equal(current.charged_seconds,1410);
  });
  let selected,ref,seq;
  await t.test('concurrent distinct allocations reserve one slot and charge only once',async()=>{
   const raws=['concurrent_a','concurrent_b'].map(key=>JSON.stringify(allocation(key))+'\n');
   const outcomes=await Promise.allSettled([store.reserveBudget(raws[0]),store2.reserveBudget(raws[1])]);
   assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
   const index=outcomes.findIndex(x=>x.status==='fulfilled');selected=raws[index];ref=outcomes[index].value.budget_reservation_ref;seq=outcomes[index].value.sequence;
   const current=(await store.read()).current;assert.equal(current.pending_budget_sequence,seq);
   assert.equal(current.charged_seconds,1590);assert.equal(current.charged_evidence_bytes,19264968+134217728);
   assert.equal((await store.readEvent(seq)).event.request.body.raw,selected);
   assert.equal(ref.uri,'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'+seq);
  });
  await t.test('same key changed raw conflicts; original duplicate never recharges',async()=>{
   assert.equal((await store2.reserveBudget(selected)).status,'DUPLICATE');
   const changed={...JSON.parse(selected),expires_at:new Date(Date.now()+280000).toISOString()};
   await assert.rejects(store.reserveBudget(JSON.stringify(changed)+'\n'),/budget_idempotency_conflict/);
   assert.equal((await store.read()).current.charged_seconds,1590);
  });
  await t.test('wrong reference/window cannot consume; one exact GA consumes without second charge',async()=>{
   const expired=gaFor('expired',ref);expired.issued_at=new Date(Date.now()-1000).toISOString();expired.deadline=new Date(Date.now()-1).toISOString();expired.expires_at=expired.deadline;
   await assert.rejects(store.reserveExactGa(JSON.stringify(expired)),/ga_window_invalid/);
   assert.equal((await store.read()).current.pending_budget_sequence,seq);assert.equal((await store.read()).current.charged_seconds,1590);
   await assert.rejects(store.reserveExactGa(JSON.stringify(gaFor('bad_ref',{...ref,sha256:'b'.repeat(64)}))),/exact_prior_committed_budget_required/);
   const wide=gaFor('wide',ref);wide.issued_at=new Date(Date.parse(JSON.parse(selected).not_before)-1).toISOString();
   await assert.rejects(store.reserveExactGa(JSON.stringify(wide)),/budget_consumption_binding_or_window_mismatch/);
   const raw=JSON.stringify(gaFor('consumer',ref));await store.reserveExactGa(raw);
   assert.equal((await store.reserveExactGa(raw)).status,'DUPLICATE');
   await assert.rejects(store.reserveExactGa(JSON.stringify(gaFor('second_consumer',ref))),/actual_pending_budget_required/);
   const state=await store.read();assert.equal(state.current.pending_budget_sequence,null);assert.equal(state.current.charged_seconds,1590);
   assert.equal(state.attempts[0].budget_sequence,seq);
   await assert.rejects(admin.query('update clued_control.gate_attempts set budget_sequence=budget_sequence+1'),/immutable_gate_bytes/);
  });
  await t.test('UNKNOWN never refunds the allocation or clears active capacity',async()=>{
   // A synthetic state transition, not an actual process observation.
   const state=await store.read();await store.transition({ga_id:'ga_consumer',idempotency_key:'unknown_budget',operation:'UNKNOWN',body:{},expected_sequence:state.current.sequence});
   await assert.rejects(store.reserveBudget(JSON.stringify(allocation('after_unknown'))+'\n'),/budget_or_pending_capacity_unavailable/);
   const current=(await store.read()).current;assert.equal(current.charged_seconds,1590);assert.equal(current.active_ga_id,'ga_consumer');
  });
  assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{value:'unchanged'}]);
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));await server.stop().catch(()=>{});}
});
`;
fs.writeFileSync(new URL('budget.test.mjs',import.meta.url),text);
