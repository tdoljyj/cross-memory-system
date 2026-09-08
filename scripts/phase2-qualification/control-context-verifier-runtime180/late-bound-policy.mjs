const need=(ok,why)=>{if(!ok)throw Error(why);};
export function checkLateBoundPolicy(policy){
 need(policy&&Object.keys(policy).sort().join(',')==='budget_reservation_ref,status_manifest_ref,target_revision','ONLY_THREE_EXPLICIT_LATE_BOUND_FIELDS');
 const b=policy.budget_reservation_ref,s=policy.status_manifest_ref,t=policy.target_revision;
 need(b&&Object.keys(b).sort().join(',')==='maximum_evidence_bytes,maximum_seconds,resolver'&&b.resolver==='CURRENT_EXACT_EXECUTION_BUDGET_EVENT_V1'&&b.maximum_seconds===180&&b.maximum_evidence_bytes===134217728,'FIXED_BUDGET_RESOLVER_POLICY');
 need(s&&Object.keys(s).sort().join(',')==='resolver,signed_payload_sha256'&&s.resolver==='STORED_STATUS_FROM_EXACT_OWNER_SIGNED_PAYLOAD_V1'&&/^[a-f0-9]{64}$/.test(s.signed_payload_sha256),'FIXED_SIGNED_STATUS_PAYLOAD_POLICY');
 need(t&&Object.keys(t).join(',')==='resolver'&&t.resolver==='ACTUAL_RUNTIME_AND_SOURCE_MANIFEST_OWNER_MERGE_V1','FIXED_TARGET_PUBLICATION_POLICY');
 return {state:'FIXED_FIELD_RESOLVERS_ONLY_NOT_ADMISSION'};
}
