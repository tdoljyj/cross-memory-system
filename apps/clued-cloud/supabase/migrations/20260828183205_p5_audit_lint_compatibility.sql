-- Keep the public P5 callers on their reviewed record-shaped contract while
-- giving plpgsql_check a concrete internal audit payload. The adapter is the
-- only record-typed function and never dereferences the anonymous record.

create or replace function clued_private.p5_audit_jsonb(
  p_auth jsonb,p_target_kind text,p_target_id uuid,p_base bigint,p_new bigint,
  p_result text,p_evidence jsonb,p_error text,p_receipt uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into public.clued_p5_audit_events(
    organization_id,workspace_id,actor_kind,user_actor_id,binding_actor_id,
    service_account_actor,automation_actor,target_kind,target_id,context_key,role,scope,purpose,
    policy_version,revocation_epoch,base_version,new_version,result,evidence,error_type,receipt_id
  ) values (
    (p_auth->>'organization_id')::uuid,(p_auth->>'workspace_id')::uuid,p_auth->>'actor_kind',
    (p_auth->>'user_id')::uuid,(p_auth->>'binding_id')::uuid,
    case when p_auth->>'actor_kind'='service_account' then p_auth->>'binding_id' end,
    case when p_auth->>'actor_kind'='automation' then p_auth->>'binding_id' end,
    p_target_kind,p_target_id,p_auth->>'context_key',p_auth->>'role',
    coalesce(p_evidence->>'scope','canonical:write'),p_auth->>'purpose',
    (p_auth->>'policy_version')::bigint,(p_auth->>'revocation_epoch')::bigint,
    p_base,p_new,p_result,p_evidence,p_error,p_receipt
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function clued_private.p5_audit(
  p_auth record,p_target_kind text,p_target_id uuid,p_base bigint,p_new bigint,
  p_result text,p_evidence jsonb,p_error text,p_receipt uuid
) returns uuid language plpgsql security definer set search_path='' as $$
begin
  return clued_private.p5_audit_jsonb(
    to_jsonb(p_auth),p_target_kind,p_target_id,p_base,p_new,p_result,p_evidence,p_error,p_receipt
  );
end $$;

revoke all on function clued_private.p5_audit_jsonb(jsonb,text,uuid,bigint,bigint,text,jsonb,text,uuid)
  from public,anon,authenticated,service_role,clued_p5_gateway;
revoke all on function clued_private.p5_audit(record,text,uuid,bigint,bigint,text,jsonb,text,uuid)
  from public,anon,authenticated,service_role,clued_p5_gateway;
