CREATE OR REPLACE FUNCTION clued_control.commit_gate_result(p_raw text, p_sha text, p_decision_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; receipt jsonb; r jsonb; final_result text;
begin
 if p_raw is null or octet_length(p_raw)>131072 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_receipt_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_receipt_object'; end if;
 receipt:=p_raw::jsonb;final_result:=receipt->>'result';
 if jsonb_typeof(receipt)<>'object' or coalesce(receipt->>'gate_result_receipt_id','') !~ '^grr_[A-Za-z0-9_.-]{1,128}$'
 or final_result is null or final_result not in ('PASS','FAIL','BLOCKED','STALE') then raise exception 'invalid_original_grr_result'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=receipt->>'gate_authorization_id' for update;
 if a.ga_id is null then raise exception 'original_ga_missing'; end if;
 if a.receipt_raw is not null then
  if a.receipt_raw is distinct from p_raw or a.receipt_sha256 is distinct from p_sha or a.decision->>'decision_sha256' is distinct from p_decision_sha
  then raise exception 'one_ga_one_immutable_grr'; end if;
  return jsonb_build_object('status','DUPLICATE','receipt_sha256',a.receipt_sha256,'authority_effect','NONE');
 end if;
 if c.active_ga_id is distinct from a.ga_id or a.phase<>'SIGNING' or a.decision->>'decision_sha256' is distinct from p_decision_sha
 or a.decision->>'result' is distinct from final_result then raise exception 'exact_decision_reservation_required'; end if;
 if coalesce(receipt->>'schema_digest','') !~ '^[0-9a-f]{64}$' or receipt->>'issuer_purpose' is distinct from 'GATE_RESULT'
 or coalesce(receipt->>'audience','')='' or jsonb_typeof(receipt->'signature') is distinct from 'string'
 or coalesce(receipt->>'signature','')=''
 then raise exception 'signed_receipt_envelope_required'; end if;
 -- The existing trusted host must verify this exact signed payload, issuer and
 -- stopped evidence BEFORE calling. JSON shape/storage is not cryptography.
 r:=clued_control.read_root(root);
 if final_result='PASS' and (a.revoked or clock_timestamp()>=a.expires_at or r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
 or a.ga->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or a.ga->>'runner_generation' is distinct from c.runner_generation or a.ga->>'credential_generation' is distinct from c.credential_generation
 or a.ga->>'session_generation' is distinct from c.session_generation) then raise exception 'stale_or_revoked_pass_forbidden'; end if;
 if a.ga_id='ga_dd2dc30bfc6b93ac2f30b7292dc347cc' then
  if final_result is distinct from 'BLOCKED'
  or p_sha is distinct from '689dee948265ef13dfc7f92d17cbcdd4d8ab29d81d4f030af4a4dceab371cd57'
  or a.ga_sha256 is distinct from 'bdd9ec691c959d6105b000284939606f4994c6fc69e684598655fc8c4d02dc92'
  or a.budget_sequence is distinct from 102
  or a.sequence is distinct from 2
  or a.container_id is not null or a.revoked
  or a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
  or a.ga->>'controller_digest' is distinct from '9373e3d9843055e9babc1564f4aaceb0966886f854fc0e107281d4ce618b3ce1'
  or a.decision->>'termination_mode' is distinct from 'EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA5'
  or c.sequence is distinct from 110
  or c.pending_budget_sequence is not null
  or c.charged_seconds is distinct from 11106
  or c.charged_evidence_bytes is distinct from 2470030259
  or (select count(*) from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id)<>2
  or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=109 and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='DECISION_RESERVED')
  or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=110 and e.request->>'ga_id'=a.ga_id and e.request->>'operation'='SIGNING')
  then raise exception 'exact_root9_expired_pending_blocked_commit_required'; end if;
  update clued_control.gate_attempts set receipt_id=receipt->>'gate_result_receipt_id',receipt_raw=p_raw,receipt_sha256=p_sha,phase=final_result where root_id=root and ga_id=a.ga_id;
  update clued_control.execution_current set active_ga_id=null,pending_budget_sequence=102 where root_id=root;
 else
  update clued_control.gate_attempts set receipt_id=receipt->>'gate_result_receipt_id',receipt_raw=p_raw,receipt_sha256=p_sha,phase=final_result where root_id=root and ga_id=a.ga_id;
  update clued_control.execution_current set active_ga_id=null where root_id=root;
 end if;
 return jsonb_build_object('status','COMMITTED','receipt_sha256',p_sha,'result',final_result,'authority_effect','NONE');
end $function$
