-- P5 fourth independent-review repair: keep every Attempt issuance slot
-- permanently unique.  A terminal successor therefore remains the conflict
-- target for a retry that passed its last Idempotency read before the
-- successor's Mutation committed.

alter table public.clued_p5_gateway_attempts
  add column if not exists issuance_parent text;

update public.clued_p5_gateway_attempts
   set issuance_parent='legacy:'||id::text
 where issuance_parent is null;

alter table public.clued_p5_gateway_attempts
  alter column issuance_parent set not null;

create unique index if not exists clued_p5_gateway_attempt_issuance_uidx
  on public.clued_p5_gateway_attempts(
    organization_id,workspace_id,binding_id,operation_family,idempotency_key,issuance_parent
  );

create or replace function clued_private.p5_attempt_issuance_parent_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.issuance_parent is distinct from old.issuance_parent then
    raise exception 'P5_ATTEMPT_ISSUANCE_PARENT_IMMUTABLE';
  end if;
  return new;
end $$;

revoke all on function clued_private.p5_attempt_issuance_parent_immutable() from public;
drop trigger if exists clued_p5_attempt_issuance_parent_immutable
  on public.clued_p5_gateway_attempts;
create trigger clued_p5_attempt_issuance_parent_immutable
  before update of issuance_parent on public.clued_p5_gateway_attempts
  for each row execute function clued_private.p5_attempt_issuance_parent_immutable();

create or replace function public.clued_p5_attempt_begin(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v record; v_attempt_id uuid; v_hash text; v_target_kind text; v_target_id uuid;
  v_base bigint; v_key text; v_parent text; v_existing public.clued_p5_idempotency%rowtype;
  v_latest public.clued_p5_gateway_attempts%rowtype;
begin
  -- Authorization and the complete request shape always precede any durable
  -- Attempt or Idempotency observation.
  select * into v from clued_private.p5_resolve_request(p_token_hash,p_input,'canonical:write');
  v_target_kind:=p_input->>'target_kind';
  if v_target_kind not in ('record','project') then raise exception 'P5_INVALID_TARGET_KIND'; end if;
  v_target_id:=(p_input->>'target_id')::uuid;
  v_base:=(p_input->>'base_version')::bigint;
  if v_base<=0 then raise exception 'P5_POSITIVE_BASE_VERSION_REQUIRED'; end if;
  v_key:=p_input->>'idempotency_key';
  if char_length(coalesce(v_key,'')) not between 8 and 160 then raise exception 'P5_INVALID_IDEMPOTENCY_KEY'; end if;
  v_hash:=clued_private.p5_sha256(p_input-'session_token');

  loop
    -- Permanent Idempotency remains the canonical replay source.  A payload
    -- mismatch never receives a new Attempt capability.
    select * into v_existing from public.clued_p5_idempotency i
     where i.organization_id=v.organization_id and i.workspace_id=v.workspace_id
       and i.binding_id=v.binding_id and i.operation_family='canonical_mutation'
       and i.idempotency_key=v_key;
    if found then
      if v_existing.request_hash is distinct from v_hash then
        return jsonb_build_object('status','rejected',
          'error',jsonb_build_object('type','IDEMPOTENCY_PAYLOAD_CONFLICT'));
      end if;
      if v_existing.canonical_result is not null then
        return jsonb_build_object('status','replayed','request_hash',v_hash,
          'canonical_result',v_existing.canonical_result,'receipt_id',v_existing.receipt_id);
      end if;
    end if;

    -- Follow one immutable lineage per Binding-scoped Idempotency key.  The
    -- latest row decides whether to share, retire, replay, or issue its only
    -- permitted successor.
    select * into v_latest from public.clued_p5_gateway_attempts a
     where a.organization_id=v.organization_id and a.workspace_id=v.workspace_id
       and a.binding_id=v.binding_id and a.operation_family='canonical_mutation'
       and a.idempotency_key=v_key
     order by a.created_at desc,a.id desc limit 1;
    if found then
      if v_latest.request_hash is distinct from v_hash then
        return jsonb_build_object('status','rejected',
          'error',jsonb_build_object('type','IDEMPOTENCY_PAYLOAD_CONFLICT'));
      end if;
      if v_latest.status='open' and v_latest.expires_at>now() then
        return jsonb_build_object('status','open','attempt_id',v_latest.id,'request_hash',v_hash,
          'organization_id',v.organization_id,'workspace_id',v.workspace_id,'binding_id',v.binding_id,
          'target_kind',v_target_kind,'target_id',v_target_id,'base_version',v_base,
          'idempotency_key',v_key);
      end if;
      if v_latest.status='open' then
        update public.clued_p5_gateway_attempts
           set status='expired'
         where id=v_latest.id and status='open' and expires_at<=now();
      elsif v_latest.status in ('completed','failed') then
        return jsonb_build_object('status','rejected',
          'error',jsonb_build_object('type','P5_ATTEMPT_CANONICAL_RESULT_MISSING','sqlstate','P0001'));
      end if;
      v_parent:=v_latest.id::text;
    else
      v_parent:='root';
    end if;

    -- This is the final Idempotency read before issuance.  The INSERT below
    -- is nevertheless safe if a Mutation commits immediately afterwards:
    -- issuance_parent is unique across every status, so completion/failure
    -- never releases the predecessor's one successor slot.
    select * into v_existing from public.clued_p5_idempotency i
     where i.organization_id=v.organization_id and i.workspace_id=v.workspace_id
       and i.binding_id=v.binding_id and i.operation_family='canonical_mutation'
       and i.idempotency_key=v_key;
    if found then
      if v_existing.request_hash is distinct from v_hash then
        return jsonb_build_object('status','rejected',
          'error',jsonb_build_object('type','IDEMPOTENCY_PAYLOAD_CONFLICT'));
      end if;
      if v_existing.canonical_result is not null then
        return jsonb_build_object('status','replayed','request_hash',v_hash,
          'canonical_result',v_existing.canonical_result,'receipt_id',v_existing.receipt_id);
      end if;
    end if;

    -- Test-only deterministic pause. It is unreachable unless the database
    -- session explicitly enables the existing P5 fault-injection gate; normal
    -- Worker and production sessions take no extra branch or lock.
    if current_setting('clued.p5_test_faults',true)='on'
       and current_setting('clued.p5_test_pause_attempt_insert',true)='on' then
      perform pg_advisory_xact_lock(500050004);
    end if;

    insert into public.clued_p5_gateway_attempts(
      organization_id,workspace_id,user_id,binding_id,operation_family,idempotency_key,
      request_hash,target_kind,target_id,base_version,issuance_parent
    ) values (
      v.organization_id,v.workspace_id,v.user_id,v.binding_id,'canonical_mutation',v_key,
      v_hash,v_target_kind,v_target_id,v_base,v_parent
    ) on conflict (
      organization_id,workspace_id,binding_id,operation_family,idempotency_key,issuance_parent
    ) do nothing
      returning id into v_attempt_id;

    if v_attempt_id is not null then
      return jsonb_build_object('status','open','attempt_id',v_attempt_id,'request_hash',v_hash,
        'organization_id',v.organization_id,'workspace_id',v.workspace_id,'binding_id',v.binding_id,
        'target_kind',v_target_kind,'target_id',v_target_id,'base_version',v_base,
        'idempotency_key',v_key);
    end if;

    -- A conflict is a permanent issuance decision, not a transient open-row
    -- race.  The winning slot remains present after completed/failed, so this
    -- branch may safely replay after the INSERT without opening a new window.
    select * into v_latest from public.clued_p5_gateway_attempts a
     where a.organization_id=v.organization_id and a.workspace_id=v.workspace_id
       and a.binding_id=v.binding_id and a.operation_family='canonical_mutation'
       and a.idempotency_key=v_key and a.issuance_parent=v_parent;
    if not found then
      raise exception 'P5_ATTEMPT_ISSUANCE_INVARIANT';
    end if;
    if v_latest.request_hash is distinct from v_hash then
      return jsonb_build_object('status','rejected',
        'error',jsonb_build_object('type','IDEMPOTENCY_PAYLOAD_CONFLICT'));
    end if;
    if v_latest.status='open' and v_latest.expires_at>now() then
      return jsonb_build_object('status','open','attempt_id',v_latest.id,'request_hash',v_hash,
        'organization_id',v.organization_id,'workspace_id',v.workspace_id,'binding_id',v.binding_id,
        'target_kind',v_target_kind,'target_id',v_target_id,'base_version',v_base,
        'idempotency_key',v_key);
    end if;
    if v_latest.status in ('completed','failed') then
      select * into v_existing from public.clued_p5_idempotency i
       where i.organization_id=v.organization_id and i.workspace_id=v.workspace_id
         and i.binding_id=v.binding_id and i.operation_family='canonical_mutation'
         and i.idempotency_key=v_key;
      if found and v_existing.request_hash=v_hash and v_existing.canonical_result is not null then
        return jsonb_build_object('status','replayed','request_hash',v_hash,
          'canonical_result',v_existing.canonical_result,'receipt_id',v_existing.receipt_id);
      end if;
      return jsonb_build_object('status','rejected',
        'error',jsonb_build_object('type','P5_ATTEMPT_CANONICAL_RESULT_MISSING','sqlstate','P0001'));
    end if;
    -- The winning child naturally expired before it was consumed.  Retire it
    -- on the next loop and use its immutable ID as the next issuance parent.
  end loop;
exception when others then
  return jsonb_build_object('status','rejected','error',jsonb_build_object('type',sqlerrm,'sqlstate',sqlstate));
end $$;

revoke execute on function public.clued_p5_attempt_begin(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_p5_attempt_begin(text,jsonb)
  to clued_p5_gateway;

notify pgrst,'reload schema';
