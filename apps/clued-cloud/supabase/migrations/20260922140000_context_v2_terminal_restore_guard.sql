-- Context v2: a terminal Record cannot be reopened by an ordinary or stale
-- restore request. Keep the prior M1 mutation core and its Receipt semantics.
create table clued_private.record_reopen_audit (
  reopen_receipt_id uuid primary key references public.clued_audit_receipts(id),
  user_id uuid not null,
  record_id uuid not null,
  terminal_receipt_id uuid not null references public.clued_audit_receipts(id),
  terminal_version bigint not null,
  reopen_reason text not null check (length(btrim(reopen_reason)) between 1 and 1000),
  recorded_at timestamptz not null default now()
);
create index record_reopen_audit_record_idx
  on clued_private.record_reopen_audit(user_id,record_id,recorded_at desc);
alter table clued_private.record_reopen_audit enable row level security;
revoke all on table clued_private.record_reopen_audit
  from public,anon,authenticated,service_role;

-- Install the guard inside the existing M1 receipt transaction, after its
-- version/row checks. Unexpected upstream definitions stop the migration.
do $migration$
declare body text; anchor text := $anchor$      v_old_sources:=coalesce(v_record.source_refs,'{}');$anchor$;
  guard text := $guard$      if v_operation='restore' then
        if p_input->>'authority' is distinct from 'user_explicit'
          or coalesce((p_input->>'user_confirmed')::boolean,false)=false
          or nullif(btrim(p_input->>'reopen_reason'),'') is null
          or length(btrim(p_input->>'reopen_reason'))>1000
          or p_input->>'terminal_receipt_id' is distinct from v_record.receipt_id::text
          or v_record.receipt_id is null then
          raise exception 'terminal_restore_requires_explicit_authorization' using errcode='42501';
        end if;
        if not exists(select 1 from public.clued_audit_receipts r
          where r.id=v_record.receipt_id and r.user_id=p_user_id
            and r.status='committed' and r.operation_family='record_mutation') then
          raise exception 'terminal_receipt_not_verified' using errcode='42501';
        end if;
      end if;
$guard$;
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'terminal_guard_core_definition_mismatch';
  end if;
  execute replace(body,anchor,guard||anchor);
end $migration$;

create function clued_private.record_mutation_with_terminal_guard(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  -- Reuse the existing Currentness transaction lock before receipt/row locks.
  -- This also serializes same-key requests targeting different Records.
  perform clued_private.currentness_user_lock(p_user_id);
  v_result:=clued_private.record_mutation_core(
    p_user_id,p_binding_id,p_input,p_received_payload_hash);
  if p_input->>'operation'='restore' and v_result->>'status'='committed'
    and coalesce((v_result->>'replayed')::boolean,false)=false then
    insert into clued_private.record_reopen_audit(
      reopen_receipt_id,user_id,record_id,terminal_receipt_id,
      terminal_version,reopen_reason)
    values ((v_result->>'receipt_id')::uuid,p_user_id,(p_input->>'id')::uuid,
      (p_input->>'terminal_receipt_id')::uuid,(p_input->>'base_version')::bigint,
      btrim(p_input->>'reopen_reason'));
  end if;
  return v_result;
end $$;
revoke all on function
  clued_private.record_mutation_with_terminal_guard(uuid,uuid,jsonb,text)
  from public,anon,authenticated,service_role;

-- Both Binding/OAuth and account HTTP writes pass through the same guard.
create or replace function public.clued_record_mutate(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; original_scope text;
begin
 b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',
  coalesce(p_input->>'scope','global'),
  case p_input->>'operation' when 'close' then 'close'
    when 'restore' then 'restore' else 'write' end);
 perform clued_private.currentness_user_lock(b.user_id);
 if exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id)
   and p_input->>'operation'='reclassify_scope' then
  select canonical_scope into original_scope from public.clued_memories
    where id=(p_input->>'id')::uuid and user_id=b.user_id for update;
  if not found then raise exception 'record_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_assert_entry_v12(
    b.id,'scope',original_scope,'canonical','write');
 end if;
 if exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id)
   and p_input->>'operation' in ('close','restore') then
  if (coalesce(p_input->'mutation','{}')-array['closure_summary','closed_reason'])
       <>'{}'::jsonb
    or p_input ?| array['source_refs','source_unavailable_reason',
                        'observed_at','confidence'] then
   raise exception 'lifecycle_action_cannot_edit_record_content'
     using errcode='42501';
  end if;
 end if;
 return clued_private.record_mutation_with_terminal_guard(
  b.user_id,b.id,p_input,
  clued_private.m1_sha256(jsonb_build_object(
    'operation','record_mutation','payload',p_input)));
end $$;
revoke all on function public.clued_record_mutate(text,jsonb)
  from public,authenticated,service_role;
grant execute on function public.clued_record_mutate(text,jsonb) to anon;

create or replace function public.clued_user_record_mutate(
  p_input jsonb,p_received_payload_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select clued_private.record_mutation_with_terminal_guard(
    clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash)
$$;
revoke all on function public.clued_user_record_mutate(jsonb,text)
  from public,anon,service_role;
grant execute on function public.clued_user_record_mutate(jsonb,text)
  to authenticated;
