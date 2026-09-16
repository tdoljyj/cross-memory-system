CREATE OR REPLACE FUNCTION clued_control.reserve_execution_budget(p_raw text, p_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' SET "TimeZone" TO 'UTC'
AS $function$
declare
 root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; v jsonb; c clued_control.execution_current; b clued_control.execution_binding; w record;
 previous clued_control.execution_events; next_sequence bigint; ref jsonb; r jsonb;
begin
 if p_raw is null or p_raw is distinct from '{"controller_digest":"fc6ca1759ef68a958564bd2d9fc16aab23297c2db30ac7581b4ec6227977c91f","credential_generation":"credgen_bac92a11e7144a3fb9e67f40a6a07d11","environment":"ISOLATED_TEST","evidence_bytes":134217728,"expires_at":"2026-09-23T04:00:00Z","idempotency_key":"root11_single_window_budget_20260916","not_before":"2026-09-16T04:00:00Z","profile_digest":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","purpose":"SKILL_COEXISTENCE_QUALIFICATION","root_generation":"ctrgen_c725e90a595c00a041754ede3b00f408","runner_generation":"runnergen_a256855fec9441839105c69b746c5244","scope_digest":"115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5","seconds":600,"session_generation":"sessiongen_ffb02a907d334b0da0b37bf457a758c2"}
' or p_sha is distinct from '8796ef665c25b6d139ac9d7ccc097248b557a2638ede9d2cefa531fae2280a53'
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') or not(p_raw is json object with unique keys)
 then raise exception 'root10_exact_one_budget_bytes_required'; end if;
 v:=p_raw::jsonb;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key='root11_single_window_budget_20260916';
 if found then
  if previous.sequence<>136 or previous.request is distinct from jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)) then raise exception 'root10_budget_idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 select * into b from clued_control.effective_execution_binding(); select * into w from clued_control.effective_execution_window() where root_id=root;
 r:=clued_control.read_root(root);
 if c.sequence<>135 or c.active_ga_id is not null or c.pending_budget_sequence is not null
 or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987
 or r->>'state'<>'STORED_NO_GATE_AUTHORITY' or r->>'generation_id'<>'ctrgen_c725e90a595c00a041754ede3b00f408'
 or w.generation_id<>'ctrgen_c725e90a595c00a041754ede3b00f408' or w.budget_sequence_floor<>136
 or b.controller_sha256<>'fc6ca1759ef68a958564bd2d9fc16aab23297c2db30ac7581b4ec6227977c91f' or b.qualification_sha256<>'cc385768f9e04269d69b211a23fb08f4463215afa5c919649f42e17c7d58cbe9' or b.runtime_acceptance_sha256<>'171f8e32f79c0f071e8d0986d5ec8307154ecb9b346e998f3c356c4ea660d192'
 or b.profile_sha256<>'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5' or b.scope_sha256<>'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5' or b.gate_sha256<>'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a'
 or (select count(*) from clued_control.events where root_id=root)<>11
 or (select count(*) from clued_control.execution_events where root_id=root)<>135
 or (select count(*) from clued_control.gate_attempts where root_id=root)<>18
 or exists(select 1 from clued_control.gate_attempts where root_id=root and phase not in ('FAIL','BLOCKED','STALE'))
 or (select count(*) from clued_control.execution_events where root_id=root and sequence>44 and request->>'operation'='BUDGET_RESERVED')<>11
 or (select count(*) from clued_control.execution_events where root_id=root and sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>17
 or not exists(select 1 from clued_control.gate_attempts where root_id=root and ga_id='ga_6addc4f9764b69ba8c10d258135ae0d4' and ga_sha256='327bb92ca8a27f8e67eac06daaa27afa5df99814823fe0a2eb69b7c41747641a' and phase='BLOCKED' and budget_sequence=102 and container_id is null and receipt_sha256='3d6fc55e6d2065fb40974161f3c0abb556817989c560e3072a080bea033ccfdd')
 or exists(select 1 from clued_control.execution_events where root_id=root and sequence=136)
 or clock_timestamp()<'2026-09-16T04:00:00Z'::timestamptz or clock_timestamp()+interval '600 seconds'>='2026-09-23T04:00:00Z'::timestamptz
 then raise exception 'root10_exact_prebudget_postimage_required'; end if;
 next_sequence:=c.sequence+1;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values(root,next_sequence,'root11_single_window_budget_20260916',jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)));
 update clued_control.execution_current set sequence=next_sequence,pending_budget_sequence=next_sequence,
 charged_seconds=charged_seconds+600,charged_evidence_bytes=charged_evidence_bytes+134217728
 where root_id=root and sequence=135 and active_ga_id is null and pending_budget_sequence is null
 and charged_seconds=11706 and charged_evidence_bytes=2604247987;
 if not found then raise exception 'root10_budget_final_cas'; end if;
 ref:=jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||next_sequence,'sha256',p_sha);
 return jsonb_build_object('status','BUDGET_RESERVED','budget_reservation_ref',ref,'sequence',next_sequence,'authority_effect','NONE','automatic_refund',false);
end $function$;
