-- Information Flow M0-D slice S3: promotion, candidate_promotions,
-- native_write_markers and the two-step Native confirmation guard.
-- Contract: development/contracts/information-flow/M0DCloseout.v0.1.md (frozen,
-- Decision 825aa822-7cb2-4239-a3a1-0989200ef068), sections 4.3, 5.1, 6.3, 8.
--
-- Promotion writes the Record only through
-- clued_private.record_mutation_with_terminal_guard; record_mutation_core,
-- evidence_ingest_core, decision_supersede_core and the M1 receipt core are
-- reused, never forked. Candidate transitions reuse the M1 receipt core with
-- row-version CAS. The confirmation token is issued and consumed by separate
-- definer RPCs granted only to `authenticated` and guarded by
-- authorization_owner_v12 (direct human account session). No MCP tool and no
-- delegated OAuth case reaches any of them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Two-step confirmation tokens (contract 4.3.2). Only the sha256 of the raw
-- token is stored; the raw token is returned once, by the issuing request.
create table clued_private.candidate_confirmation_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_tier text not null check (candidate_tier in ('information','knowledge')),
  candidate_id uuid not null,
  candidate_version integer not null check (candidate_version>=1),
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  native_choices jsonb not null,
  confirmation_view jsonb not null,
  view_digest text not null check (view_digest ~ '^[0-9a-f]{64}$'),
  record_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  session_id text,
  auth_time timestamptz not null,
  issued_xact xid8 not null default pg_current_xact_id(),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_receipt_id uuid references public.clued_audit_receipts(id),
  consume_outcome text check (consume_outcome in ('promoted','conflict','expired','rejected')),
  check ((consumed_at is null)=(consumed_receipt_id is null)),
  check ((consumed_at is null)=(consume_outcome is null)),
  check (expires_at>issued_at)
);
-- At most one live token per candidate; issuing revokes the previous one.
create unique index candidate_confirmation_tokens_live_uidx
  on clued_private.candidate_confirmation_tokens(candidate_tier,candidate_id)
  where consumed_at is null and revoked_at is null;

-- Promotion provenance and the positive human_confirmed marker (4.3.1, 6.3).
-- Keyed by the record_mutation Receipt that wrote the Record version.
create table clued_private.candidate_promotions (
  receipt_id uuid primary key references public.clued_audit_receipts(id),
  promotion_receipt_id uuid not null unique references public.clued_audit_receipts(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_tier text not null check (candidate_tier in ('information','knowledge')),
  candidate_id uuid not null,
  candidate_version integer not null check (candidate_version>=1),
  record_id uuid not null,
  record_version bigint not null check (record_version>=1),
  origin_principal text not null check (origin_principal in ('native_ui','agent_binding')),
  -- No FK: provenance survives Binding deletion, as in the candidate store.
  origin_binding_id uuid,
  confirming_principal text not null default 'native_account_session'
    check (confirming_principal='native_account_session'),
  confirming_user_id uuid not null,
  confirming_session_id text,
  token_id uuid not null unique references clued_private.candidate_confirmation_tokens(id),
  view_digest text not null check (view_digest ~ '^[0-9a-f]{64}$'),
  authority text not null check (authority in ('user_explicit','observed','inferred')),
  created_at timestamptz not null default now(),
  unique (user_id,record_id,record_version),
  check ((origin_principal='agent_binding')=(origin_binding_id is not null))
);

-- Positive marker for direct Native account-session writes (6.3). One
-- decision_supersede Receipt commits several versions, so the key carries the
-- Record id as well as the Receipt id.
create table clued_private.native_write_markers (
  receipt_id uuid not null references public.clued_audit_receipts(id),
  record_id uuid not null,
  record_version bigint not null check (record_version>=1),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor text not null default 'native_account_session' check (actor='native_account_session'),
  entry text not null check (entry ~ '^[a-z0-9_.:-]{1,80}$'),
  session_id text,
  auth_time timestamptz,
  created_at timestamptz not null default now(),
  primary key (receipt_id,record_id),
  unique (user_id,record_id,record_version)
);

alter table clued_private.candidate_confirmation_tokens enable row level security;
alter table clued_private.candidate_promotions enable row level security;
alter table clued_private.native_write_markers enable row level security;
revoke all on table clued_private.candidate_confirmation_tokens,
  clued_private.candidate_promotions, clued_private.native_write_markers
  from public, anon, authenticated, service_role;

-- Token rows are append-only except for their single terminal transition.
create function clued_private.candidate_confirmation_token_guard_v1()
returns trigger language plpgsql set search_path='' as $$
declare v_mutable text[]:=array['revoked_at','consumed_at','consumed_receipt_id','consume_outcome'];
begin
  if (to_jsonb(new)-v_mutable) is distinct from (to_jsonb(old)-v_mutable) then
    raise exception 'confirmation_token_immutable' using errcode='55000';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'confirmation_token_immutable' using errcode='55000';
  end if;
  if old.consumed_at is not null and (new.consumed_at,new.consumed_receipt_id,new.consume_outcome)
      is distinct from (old.consumed_at,old.consumed_receipt_id,old.consume_outcome) then
    raise exception 'confirmation_token_immutable' using errcode='55000';
  end if;
  return new;
end $$;
create trigger candidate_confirmation_tokens_guard before update
  on clued_private.candidate_confirmation_tokens for each row
  execute function clued_private.candidate_confirmation_token_guard_v1();

-- Markers are immutable. Delete is not blocked so the auth.users cascade
-- still works; no role holds a grant that could delete them.
create function clued_private.promotion_marker_immutable_v1()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'promotion_marker_immutable' using errcode='55000';
end $$;
create trigger candidate_promotions_immutable before update
  on clued_private.candidate_promotions for each row
  execute function clued_private.promotion_marker_immutable_v1();
create trigger native_write_markers_immutable before update
  on clued_private.native_write_markers for each row
  execute function clued_private.promotion_marker_immutable_v1();

-- ---------------------------------------------------------------------------
-- Session helpers
-- ---------------------------------------------------------------------------

-- Authentication time of the calling account session (Owner decision D1):
-- the JWT `auth_time` claim when present, otherwise the latest `amr[]`
-- timestamp that Supabase GoTrue carries. NULL when neither is present or the
-- value is more than 60 seconds in the future, so callers fail closed.
create function clued_private.native_auth_time_v1()
returns timestamptz language plpgsql volatile security definer set search_path='' as $$
declare v_claims jsonb:=auth.jwt(); v_epoch numeric;
begin
  if jsonb_typeof(v_claims->'auth_time')='number' then
    v_epoch:=(v_claims->>'auth_time')::numeric;
  elsif jsonb_typeof(v_claims->'amr')='array' then
    select max((a->>'timestamp')::numeric) into v_epoch
      from jsonb_array_elements(v_claims->'amr') a
      where jsonb_typeof(a)='object' and jsonb_typeof(a->'timestamp')='number';
  end if;
  if v_epoch is null or v_epoch<=0 or v_epoch>extract(epoch from clock_timestamp())+60 then
    return null;
  end if;
  return to_timestamp(v_epoch::double precision);
end $$;

create function clued_private.native_session_fresh_v1()
returns boolean language sql volatile security definer set search_path='' as $$
  select coalesce(clued_private.native_auth_time_v1()>=clock_timestamp()-interval '15 minutes',false)
$$;

-- Non-raising twin of authorization_owner_v12: a direct human account
-- session (no delegated client_id) of an available account.
create function clued_private.native_direct_session_v1()
returns boolean language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
  if u is null or nullif(auth.jwt()->>'client_id','') is not null then return false; end if;
  perform clued_private.authorization_account_v12(u);
  return true;
exception when others then
  return false;
end $$;

-- Writes the Native marker for every version a fresh committed account-session
-- write produced. A replay writes nothing, so pre-S3 writes are never
-- backfilled (contract 6.3).
create function clued_private.native_write_marker_v1(p_user_id uuid,p_result jsonb,p_entry text)
returns void language plpgsql security definer set search_path='' as $$
declare v_receipt_id uuid;
begin
  if p_result->>'status' is distinct from 'committed'
    or coalesce((p_result->>'replayed')::boolean,false)
    or coalesce(p_result->>'receipt_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return;
  end if;
  v_receipt_id:=(p_result->>'receipt_id')::uuid;
  if not exists(select 1 from public.clued_audit_receipts r where r.id=v_receipt_id and r.user_id=p_user_id
      and r.status='committed' and r.binding_id is null
      and r.operation_family in ('record_mutation','decision_supersede')) then
    return;
  end if;
  insert into clued_private.native_write_markers(receipt_id,record_id,record_version,user_id,entry,session_id,auth_time)
  select v_receipt_id,v.key::uuid,v.value::bigint,p_user_id,p_entry,
    nullif(auth.jwt()->>'session_id',''),clued_private.native_auth_time_v1()
  from public.clued_audit_receipts r, jsonb_each_text(r.committed_versions) v
  where r.id=v_receipt_id
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- human_confirmed (contract 6.3): replaces the S2 fail-closed stub. True only
-- from a positive marker for the exact version; a null binding_id alone never
-- counts; missing means false; no backfill.
-- ---------------------------------------------------------------------------
create or replace function clued_private.record_human_confirmed_v1(p_user_id uuid,p_record_id uuid,p_version bigint)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
      select 1 from clued_private.candidate_promotions p
        join clued_private.candidate_confirmation_tokens t
          on t.id=p.token_id and t.consumed_at is not null
         and t.consumed_receipt_id=p.promotion_receipt_id and t.consume_outcome='promoted'
        join public.clued_audit_receipts r on r.id=p.receipt_id
       where p.user_id=p_user_id and p.record_id=p_record_id and p.record_version=p_version
         and r.user_id=p_user_id and r.status='committed' and r.binding_id is null
         and (r.committed_versions->>p_record_id::text)::bigint=p_version)
    or exists(
      select 1 from clued_private.native_write_markers n
        join public.clued_audit_receipts r on r.id=n.receipt_id
       where n.user_id=p_user_id and n.record_id=p_record_id and n.record_version=p_version
         and r.user_id=p_user_id and r.status='committed' and r.binding_id is null
         and (r.committed_versions->>p_record_id::text)::bigint=p_version)
$$;

-- ---------------------------------------------------------------------------
-- Promotion helpers
-- ---------------------------------------------------------------------------

-- Observed authority (4.3.1) needs >=1 Evidence whose content_hash the intake
-- RPC computed server-side. The join to the submission row is the proof: only
-- intake_submit_core_v1 writes it. A matching storage_ref alone never
-- qualifies, because generic evidence_ingest_core accepts caller values.
create function clued_private.candidate_observed_evidence_ok_v1(p_user_id uuid,p_candidate_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from clued_private.information_candidates c
      join clued_private.information_intake_submissions s
        on s.id=c.submission_id and s.user_id=p_user_id and s.evidence_id=any(c.evidence_ids)
      join public.clued_evidence ev
        on ev.id=s.evidence_id and ev.user_id=p_user_id and ev.content_hash=s.segment_sha256
       and ev.storage_ref='intake:'||s.id::text
     where c.id=p_candidate_id and c.user_id=p_user_id)
$$;

-- Knowledge lineage at promotion time (4.3.3): every source still at exactly
-- the proposed version, human_confirmed, CURRENT (state/task/decision) or
-- active, and unflagged. Returns NULL when all pass, else a reason code.
create function clued_private.knowledge_lineage_ok_v1(p_user_id uuid,p_sources jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare v_src jsonb; v_rec public.clued_memories%rowtype;
begin
  if jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources)=0 then
    return 'knowledge_source_not_found';
  end if;
  perform 1 from public.clued_memories m
    where m.user_id=p_user_id and m.id in (select (x->>'id')::uuid from jsonb_array_elements(p_sources) x)
    order by m.id for share;
  for v_src in select x from jsonb_array_elements(p_sources) x order by (x->>'id')::uuid loop
    select * into v_rec from public.clued_memories m where m.user_id=p_user_id and m.id=(v_src->>'id')::uuid;
    if not found then return 'knowledge_source_not_found'; end if;
    if v_rec.version is distinct from (v_src->>'version')::bigint then return 'knowledge_source_version_mismatch'; end if;
    if v_rec.record_type in ('state','task','decision') then
      if clued_private.record_currentness_fence(p_user_id,v_rec.id,null) is distinct from 'CURRENT' then
        return 'knowledge_source_not_current';
      end if;
    elsif v_rec.lifecycle_status is distinct from 'active' then
      return 'knowledge_source_not_current';
    end if;
    if clued_private.record_human_confirmed_v1(p_user_id,v_rec.id,v_rec.version) is not true then
      return 'knowledge_source_not_human_confirmed';
    end if;
    if clued_private.record_evidence_unflagged_v1(p_user_id,v_rec.id,v_rec.version) is not true then
      return 'knowledge_source_evidence_withdrawn';
    end if;
  end loop;
  return null;
end $$;

-- The closed per-tier mapping (4.3.1, Owner decision D8). The full M1 create
-- input is built from scratch as an allow-list: no payload key is copied into
-- type_fields; item priority, action_level, confidence, topics and entity
-- mentions never reach the Record. The Native step-2 choices are the only
-- other input, validated here, and all of them are inside the view digest.
create function clued_private.candidate_record_body_v1(
  p_user_id uuid,p_tier text,p_candidate_id uuid,p_choices jsonb,p_record_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_info clued_private.information_candidates%rowtype; v_know clued_private.knowledge_candidates%rowtype;
  v_scope text; v_type text; v_title text; v_content text; v_base jsonb; v_native jsonb;
  v_authority text; v_confidence jsonb; v_reason text; v_key text; v_val jsonb; v_text text;
  v_sources jsonb; v_source_reason text; v_item jsonb; v_kind text;
begin
  if not clued_private.intake_keys_exact_v1(p_choices,
      '["authority","confidence","confidence_reason","native_type_fields"]') then
    raise exception 'invalid_native_choices' using errcode='22023';
  end if;
  v_native:=p_choices->'native_type_fields';
  if jsonb_typeof(v_native) is distinct from 'object' then
    raise exception 'invalid_native_type_fields' using errcode='22023';
  end if;
  -- Authority: chosen by the Native user; never defaulted, never imported.
  if jsonb_typeof(p_choices->'authority') is distinct from 'string' then
    raise exception 'authority_required' using errcode='22023';
  end if;
  v_authority:=p_choices->>'authority';
  if v_authority='imported' or (p_tier='knowledge' and v_authority='observed') then
    raise exception 'authority_not_permitted' using errcode='22023';
  end if;
  if v_authority not in ('user_explicit','observed','inferred') then
    raise exception 'invalid_authority' using errcode='22023';
  end if;
  v_confidence:=p_choices->'confidence';
  if jsonb_typeof(v_confidence)='null' then
    if v_authority='inferred' then raise exception 'inferred_confidence_required' using errcode='22023'; end if;
  elsif jsonb_typeof(v_confidence) is distinct from 'number' or (v_confidence#>>'{}')::numeric not between 0 and 1 then
    raise exception 'invalid_confidence' using errcode='22023';
  end if;
  if jsonb_typeof(p_choices->'confidence_reason')='null' then
    v_reason:=null;
  elsif not clued_private.intake_is_str_v1(p_choices->'confidence_reason',1,1000)
    or btrim(p_choices->>'confidence_reason')='' then
    raise exception 'invalid_confidence_reason' using errcode='22023';
  else
    v_reason:=p_choices->>'confidence_reason';
  end if;

  if p_tier='information' then
    select * into v_info from clued_private.information_candidates where id=p_candidate_id and user_id=p_user_id;
    if not found then raise exception 'candidate_not_found' using errcode='P0002'; end if;
    v_item:=v_info.payload; v_kind:=v_item->>'item_type';
    v_scope:=v_info.scope;
    v_title:=v_item->>'summary'; v_content:=v_item->>'claim';
    v_type:=case v_kind when 'preference' then 'profile_fact' when 'decision' then 'decision'
      when 'task' then 'task' when 'status' then 'state'
      when 'fact' then 'note' when 'event' then 'note' when 'artifact' then 'note'
      when 'issue' then 'note' when 'unclassified' then 'note' end;
    if v_type is null then raise exception 'unmapped_item_type' using errcode='22023'; end if;
    v_base:=case v_kind when 'preference' then jsonb_build_object('fact_kind','preference')
      when 'decision' then jsonb_build_object('rationale',v_content)
      when 'task' then '{}'::jsonb
      when 'status' then jsonb_build_object('state_kind','status')
      else jsonb_build_object('note_kind',v_kind) end;
    v_base:=v_base||jsonb_build_object('information_flow',jsonb_build_object(
      'schema','clued.promotion.v1','candidate_id',v_info.id,'item_type',v_kind,'input_digest',v_info.input_digest));
    v_sources:=to_jsonb(v_info.evidence_ids);
    v_source_reason:=null;
  elsif p_tier='knowledge' then
    select * into v_know from clued_private.knowledge_candidates where id=p_candidate_id and user_id=p_user_id;
    if not found then raise exception 'candidate_not_found' using errcode='P0002'; end if;
    v_scope:=v_know.scope;
    v_type:='note';
    v_title:=left(v_know.assertion,120); v_content:=v_know.assertion;
    v_base:=jsonb_build_object('note_kind','knowledge','knowledge',jsonb_build_object(
      'schema','clued.knowledge-lineage.v1','rule_id',v_know.rule_id,'sources',v_know.sources,
      'evidence_ids',to_jsonb(v_know.evidence_ids),'candidate_id',v_know.id));
    v_sources:=to_jsonb(v_know.evidence_ids);
    v_source_reason:=case when cardinality(v_know.evidence_ids)=0
      then 'Derived knowledge; lineage in type_fields.knowledge' end;
  else
    raise exception 'invalid_tier' using errcode='22023';
  end if;

  -- Native step-2 allow-list; every other key is refused.
  for v_key,v_val in select key,value from jsonb_each(v_native) loop
    v_text:=case when jsonb_typeof(v_val)='string' then v_val#>>'{}' end;
    if v_key='execution_bucket' then
      if v_type<>'task' then raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if v_text is null or v_text not in ('now','next','blocked','later') then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='priority' then
      if v_type<>'task' then raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if jsonb_typeof(v_val)<>'number' or (v_val#>>'{}') !~ '^(0|[1-9][0-9]?|100)$' then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key in ('current_frontier_blocking') then
      if jsonb_typeof(v_val)<>'boolean' then raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='criticality' then
      if v_text is null or v_text not in ('CRITICAL','HIGH','NORMAL','LOW') then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='owner_track' then
      if v_text is null or v_text not in ('ENGINEERING_PLATFORM','PRODUCT_EXPERIENCE','FOUNDATIONAL_RESEARCH','BUSINESS_GROWTH') then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='intake_kind' then
      if v_text is null or v_text not in ('TASK','DECISION_FOLLOW_UP','PROPOSAL','BUG','DEFECT','BLOCKER','RISK',
          'INCIDENT','TECHNICAL_DEBT','LEGACY_RESIDUAL_SCOPE','RESEARCH_QUESTION','PRODUCT_ISSUE','BRAND_ISSUE',
          'COMMERCIAL_ISSUE') then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='note_kind' then
      -- Knowledge keeps note_kind=knowledge; only Information notes may be re-kinded.
      if v_type<>'note' or p_tier<>'information' then
        raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if v_text is null or v_text not in ('PROPOSAL','BUG','DEFECT','BLOCKER','RISK','INCIDENT','TECHNICAL_DEBT',
          'LEGACY_RESIDUAL_SCOPE','RESEARCH_QUESTION','PRODUCT_ISSUE','BRAND_ISSUE','COMMERCIAL_ISSUE','DECISION_FOLLOW_UP') then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='state_kind' then
      if v_type<>'state' then raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if v_text is null or v_text not in ('blocker','risk','incident','technical_debt') then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='decision_follow_up' then
      if v_type<>'decision' then raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if jsonb_typeof(v_val)<>'boolean' then raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    elsif v_key='rationale' then
      if v_type<>'decision' then raise exception 'native_type_field_not_allowed:%',v_key using errcode='22023'; end if;
      if not clued_private.intake_is_str_v1(v_val,1,2000) or btrim(v_text)='' then
        raise exception 'native_type_field_invalid:%',v_key using errcode='22023'; end if;
    else
      raise exception 'native_type_field_not_allowed:%',left(v_key,80) using errcode='22023';
    end if;
  end loop;
  -- The M1 task shape needs a bucket, and the contract forbids a server-set
  -- one: the Native user must choose it (D8).
  if v_type='task' and not (v_native ? 'execution_bucket') then
    raise exception 'execution_bucket_required' using errcode='22023';
  end if;

  if v_scope like 'project:%' then
    v_scope:='project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope));
  end if;
  return jsonb_build_object(
    'operation','create','id',p_record_id,'record_type',v_type,'record_schema_version',1,
    'lifecycle_status','active','scope',v_scope,'authority',v_authority,'confidence',v_confidence,
    'confidence_reason',coalesce(v_reason,'Promoted from Information Flow candidate '||p_candidate_id::text
      ||' after Native two-step confirmation'),
    'observed_at',null,'source_refs',v_sources,'source_unavailable_reason',v_source_reason,
    'mutation',jsonb_build_object('title',v_title,'content',v_content,
      'type_fields',v_base||v_native,'relations','{}'::jsonb));
end $$;

-- Candidate locator shared by the cores: locks the row and returns the
-- fields every transition needs, for either tier.
create function clued_private.candidate_lock_v1(p_user_id uuid,p_tier text,p_candidate_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v jsonb;
begin
  if p_tier='information' then
    select jsonb_build_object('id',c.id,'scope',c.scope,'status',c.status,'version',c.version,
      'input_digest',c.input_digest,'expires_at',c.expires_at,'source_kind',c.source_kind,
      'binding_id',c.binding_id,'evidence_ids',to_jsonb(c.evidence_ids),'sources',null) into v
      from clued_private.information_candidates c where c.id=p_candidate_id and c.user_id=p_user_id for update;
  elsif p_tier='knowledge' then
    select jsonb_build_object('id',k.id,'scope',k.scope,'status',k.status,'version',k.version,
      'input_digest',k.input_digest,'expires_at',k.expires_at,'source_kind',k.source_kind,
      'binding_id',k.binding_id,'evidence_ids',to_jsonb(k.evidence_ids),'sources',k.sources) into v
      from clued_private.knowledge_candidates k where k.id=p_candidate_id and k.user_id=p_user_id for update;
  else
    raise exception 'invalid_tier' using errcode='22023';
  end if;
  return v;
end $$;

-- One status transition with row-version CAS already verified by the caller.
create function clued_private.candidate_transition_v1(
  p_user_id uuid,p_tier text,p_candidate_id uuid,p_to text,p_receipt_id uuid,
  p_record_id uuid,p_record_version bigint
) returns integer language plpgsql security definer set search_path='' as $$
declare v_version integer;
begin
  if p_tier='information' then
    update clued_private.information_candidates set status=p_to,version=version+1,
      promoted_record_id=p_record_id,promoted_version=p_record_version::integer,
      decided_by='native_ui',decided_at=now(),last_receipt_id=p_receipt_id,updated_at=now()
      where id=p_candidate_id and user_id=p_user_id and status='pending' returning version into v_version;
  else
    update clued_private.knowledge_candidates set status=p_to,version=version+1,
      promoted_record_id=p_record_id,promoted_version=p_record_version::integer,
      decided_by='native_ui',decided_at=now(),last_receipt_id=p_receipt_id,updated_at=now()
      where id=p_candidate_id and user_id=p_user_id and status='pending' returning version into v_version;
  end if;
  if v_version is null then raise exception 'candidate_not_pending' using errcode='55000'; end if;
  insert into clued_private.candidate_transitions(
    user_id,candidate_tier,candidate_id,from_status,to_status,from_version,to_version,actor,binding_id,receipt_id)
  values(p_user_id,p_tier,p_candidate_id,'pending',p_to,v_version-1,v_version,'native_ui',null,p_receipt_id);
  return v_version;
end $$;

-- ---------------------------------------------------------------------------
-- Cores
-- ---------------------------------------------------------------------------

-- Step 1 (4.3.2): issue a token bound to user, tier, candidate id and
-- version, input digest, the Native choices, the pre-allocated Record id, the
-- session and the digest of the final Record body. No M1 Receipt: issuing is
-- not a Canonical write; the token row (hash only) is the audit.
create function clued_private.candidate_confirmation_issue_core_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_tier text:=p_input->>'tier'; v_id uuid; v_candidate jsonb; v_choices jsonb;
  v_record_id uuid:=gen_random_uuid(); v_view jsonb; v_digest text; v_raw text; v_token_id uuid;
  v_expires timestamptz; v_auth_time timestamptz:=clued_private.native_auth_time_v1();
  v_now timestamptz; v_lineage text; v_error text;
begin
  if v_auth_time is null or v_auth_time<clock_timestamp()-interval '15 minutes' then
    return jsonb_build_object('status','rejected','error_code','reauthentication_required','authoritative',false);
  end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('tier','candidate_id','base_version','authority','confidence','confidence_reason','native_type_fields')) then
      raise exception 'candidate_confirmation_unknown_field' using errcode='22023';
    end if;
    if v_tier is null or v_tier not in ('information','knowledge')
      or coalesce(p_input->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'invalid_confirmation_input' using errcode='22023';
    end if;
    v_id:=(p_input->>'candidate_id')::uuid;
    v_candidate:=clued_private.candidate_lock_v1(p_user_id,v_tier,v_id);
    if v_candidate is null then raise exception 'candidate_not_found' using errcode='P0002'; end if;
    if v_candidate->>'status'<>'pending' then raise exception 'candidate_not_pending' using errcode='55000'; end if;
    if (v_candidate->>'version')::integer<>(p_input->>'base_version')::integer then
      raise exception 'candidate_version_conflict' using errcode='40001';
    end if;
    if (v_candidate->>'expires_at')::timestamptz<=now() then
      raise exception 'candidate_expired' using errcode='55000';
    end if;
    v_choices:=jsonb_build_object('authority',coalesce(p_input->'authority','null'::jsonb),
      'confidence',coalesce(p_input->'confidence','null'::jsonb),
      'confidence_reason',coalesce(p_input->'confidence_reason','null'::jsonb),
      'native_type_fields',coalesce(p_input->'native_type_fields','{}'::jsonb));
    v_view:=clued_private.candidate_record_body_v1(p_user_id,v_tier,v_id,v_choices,v_record_id);
    if v_view->>'authority'='observed' and not clued_private.candidate_observed_evidence_ok_v1(p_user_id,v_id) then
      raise exception 'observed_requires_server_computed_evidence' using errcode='42501';
    end if;
    v_digest:=clued_private.m1_sha256(v_view);
    if v_tier='knowledge' then
      -- Informational only; lineage is enforced at promotion (4.3.3).
      v_lineage:=coalesce(clued_private.knowledge_lineage_ok_v1(p_user_id,v_candidate->'sources'),'OK');
    end if;
    update clued_private.candidate_confirmation_tokens set revoked_at=clock_timestamp()
      where candidate_tier=v_tier and candidate_id=v_id and consumed_at is null and revoked_at is null;
    v_raw:='clued_cft_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.candidate_confirmation_tokens(
      user_id,candidate_tier,candidate_id,candidate_version,input_digest,native_choices,confirmation_view,
      view_digest,record_id,token_hash,session_id,auth_time,issued_at,expires_at)
    values(p_user_id,v_tier,v_id,(v_candidate->>'version')::integer,v_candidate->>'input_digest',v_choices,v_view,
      v_digest,v_record_id,encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
      nullif(auth.jwt()->>'session_id',''),v_auth_time,v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,
      'expires_at',v_expires,'tier',v_tier,'candidate_id',v_id,
      'candidate_version',(v_candidate->>'version')::integer,'input_digest',v_candidate->>'input_digest',
      'confirmation_view',v_view,'view_digest',v_digest,'record_id',v_record_id,'authoritative',false)
      ||case when v_tier='knowledge' then jsonb_build_object('lineage_check',v_lineage) else '{}'::jsonb end;
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '40001' or sqlstate '42501'
      or sqlstate 'P0002' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2 (4.3.1/4.3.2): consume the token and promote in one transaction.
create function clued_private.candidate_promote_core_v1(
  p_user_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_tier text:=p_input->>'tier'; v_id uuid;
  v_token clued_private.candidate_confirmation_tokens%rowtype; v_token_id uuid; v_candidate jsonb;
  v_body jsonb; v_rec jsonb; v_record_version bigint; v_record_receipt uuid; v_outcome text; v_reason text;
  v_version integer; v_refs jsonb; v_event_id text; v_evidence uuid[]; v_result jsonb; v_error text; v_state text;
  v_code text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,null,'candidate_promote',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then
    -- Single use (D4) also covers an idempotency rejection: a live token
    -- presented with a conflicting key or request hash is burned against the
    -- new rejected Receipt. Replays of a stored result present a token that
    -- the original attempt already consumed or burned.
    if v_receipt.status='rejected' and v_receipt.error_code in ('IDEMPOTENCY_KEY_CONFLICT','REQUEST_HASH_MISMATCH')
        and jsonb_typeof(p_input->'confirmation_token')='string' then
      update clued_private.candidate_confirmation_tokens set consumed_at=clock_timestamp(),
          consumed_receipt_id=v_receipt.id,consume_outcome='rejected'
        where user_id=p_user_id
          and token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
          and consumed_at is null and revoked_at is null;
    end if;
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    -- Authority, record type, Evidence and confirmation flags are never
    -- caller input here: they come only from the token-bound confirmation.
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('idempotency_key','request_hash','tier','candidate_id','base_version','confirmation_token','view_digest')) then
      raise exception 'candidate_promote_unknown_field' using errcode='22023';
    end if;
    if v_tier is null or v_tier not in ('information','knowledge')
      or coalesce(p_input->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]{0,8}$'
      or coalesce(p_input->>'view_digest','') !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid_promote_input' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501';
    end if;
    v_id:=(p_input->>'candidate_id')::uuid;
    -- Lock order candidate -> token, as in issue, reject and withdraw.
    v_candidate:=clued_private.candidate_lock_v1(p_user_id,v_tier,v_id);
    -- Another user's token is invisible: it reads as invalid.
    select * into v_token from clued_private.candidate_confirmation_tokens t
      where t.user_id=p_user_id
        and t.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
      for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    -- Issue and consume can never happen in the same request (transaction).
    if v_token.issued_xact=pg_current_xact_id() then
      raise exception 'confirmation_token_same_request' using errcode='42501';
    end if;
    if v_token.candidate_tier<>v_tier or v_token.candidate_id<>v_id
      or v_token.candidate_version<>(p_input->>'base_version')::integer
      or v_token.view_digest<>p_input->>'view_digest'
      or v_token.session_id is distinct from nullif(auth.jwt()->>'session_id','') then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501';
    end if;
    if not clued_private.native_session_fresh_v1() then
      raise exception 'reauthentication_required' using errcode='42501';
    end if;
    if v_candidate is null then raise exception 'candidate_not_found' using errcode='P0002'; end if;
    if v_candidate->>'status'<>'pending' then raise exception 'candidate_not_pending' using errcode='55000'; end if;
    if (v_candidate->>'version')::integer<>(p_input->>'base_version')::integer then
      raise exception 'candidate_version_conflict' using errcode='40001';
    end if;
    if v_candidate->>'input_digest'<>v_token.input_digest then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501';
    end if;
    select coalesce(array_agg(e::uuid order by e::uuid),'{}') into v_evidence
      from jsonb_array_elements_text(v_candidate->'evidence_ids') e;

    if (v_candidate->>'expires_at')::timestamptz<=now() then
      v_outcome:='expired';
    else
      -- The body is recomputed from the stored choices; any drift (mapping,
      -- scope merge, candidate content) makes the confirmed view stale.
      v_body:=clued_private.candidate_record_body_v1(p_user_id,v_tier,v_id,v_token.native_choices,v_token.record_id);
      if clued_private.m1_sha256(v_body)<>v_token.view_digest then
        raise exception 'confirmation_view_stale' using errcode='40001';
      end if;
      if v_body->>'authority'='observed' and (v_tier<>'information'
          or not clued_private.candidate_observed_evidence_ok_v1(p_user_id,v_id)) then
        raise exception 'observed_requires_server_computed_evidence' using errcode='42501';
      end if;
      if v_body->>'authority' not in ('user_explicit','observed','inferred') then
        raise exception 'authority_not_permitted' using errcode='42501';
      end if;
      if v_tier='knowledge' then
        v_reason:=clued_private.knowledge_lineage_ok_v1(p_user_id,v_candidate->'sources');
        if v_reason is not null then v_outcome:='conflict'; end if;
      end if;
    end if;

    if v_outcome is null then
      -- The one Record write: the same M1 wrapper the public entries use.
      v_rec:=clued_private.record_mutation_with_terminal_guard(p_user_id,null,
        v_body||jsonb_build_object('idempotency_key','candidate-promote:'||v_receipt.id::text),
        clued_private.m1_sha256(jsonb_build_object('operation','record_mutation','payload',v_body)));
      if v_rec->>'status'='failed' then
        raise exception 'promotion_record_failed:%',coalesce(v_rec->>'error_code','unknown') using errcode='XX000';
      elsif v_rec->>'status' is distinct from 'committed' or coalesce((v_rec->>'replayed')::boolean,false) then
        v_code:=coalesce(v_rec->>'error_code','unknown');
        raise exception 'promotion_record_rejected:%',v_code
          using errcode=case when v_code ~ 'CONFLICT|VERSION' then '40001' else '22023' end;
      end if;
      v_record_version:=(v_rec->'committed_versions'->>v_token.record_id::text)::bigint;
      v_record_receipt:=(v_rec->>'receipt_id')::uuid;
      if v_record_version is null then
        raise exception 'promotion_record_version_missing' using errcode='XX000';
      end if;
      insert into clued_private.candidate_promotions(
        receipt_id,promotion_receipt_id,user_id,candidate_tier,candidate_id,candidate_version,record_id,record_version,
        origin_principal,origin_binding_id,confirming_user_id,confirming_session_id,token_id,view_digest,authority)
      values(v_record_receipt,v_receipt.id,p_user_id,v_tier,v_id,(v_candidate->>'version')::integer,
        v_token.record_id,v_record_version,v_candidate->>'source_kind',(v_candidate->>'binding_id')::uuid,
        p_user_id,nullif(auth.jwt()->>'session_id',''),v_token.id,v_token.view_digest,v_body->>'authority');
      v_outcome:='promoted';
    end if;

    v_version:=clued_private.candidate_transition_v1(p_user_id,v_tier,v_id,v_outcome,v_receipt.id,
      case when v_outcome='promoted' then v_token.record_id end,
      case when v_outcome='promoted' then v_record_version end);
    update clued_private.candidate_confirmation_tokens set consumed_at=clock_timestamp(),
      consumed_receipt_id=v_receipt.id,consume_outcome=v_outcome where id=v_token.id;
    -- System refs only: Record refs on an audit Event could reach Currentness.
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system',
        'id',(case when v_tier='information' then 'information_candidate:' else 'knowledge_candidate:' end)||v_id::text))
      ||coalesce((select jsonb_agg(jsonb_build_object('role','evidence','kind','evidence','id',e::text))
        from unnest(v_evidence) e),'[]'::jsonb);
    v_event_id:=clued_private.m1_append_event_row(p_user_id,null,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:candidate_'||v_outcome,v_refs,
      case when v_outcome='promoted' then v_body->>'scope' else v_candidate->>'scope' end,null,
      jsonb_build_object('candidate_id',v_id,'tier',v_tier,'outcome',v_outcome,'candidate_version',v_version,
        'record_id',case when v_outcome='promoted' then v_token.record_id end,'record_version',v_record_version,
        'record_receipt_id',v_record_receipt,'origin_principal',v_candidate->>'source_kind',
        'token_id',v_token.id,'reason',v_reason),
      'candidate_promote:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only',
      v_evidence,'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,
      jsonb_build_object(v_id::text,v_version-1),jsonb_build_object(v_id::text,v_version),
      array[v_event_id],v_evidence,null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object(
      'outcome',v_outcome,'promoted',v_outcome='promoted','tier',v_tier,'candidate_id',v_id,
      'candidate_version',v_version,'record_id',case when v_outcome='promoted' then v_token.record_id end,
      'record_version',v_record_version,'record_receipt_id',v_record_receipt,
      'authority',case when v_outcome='promoted' then v_body->>'authority' end,'reason',v_reason));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use (D4): any attempt that presented a live token burns it. The
    -- block's subtransaction has rolled back, so this update persists.
    if v_token_id is not null and v_error not in ('confirmation_token_reused','confirmation_token_revoked') then
      update clued_private.candidate_confirmation_tokens set consumed_at=clock_timestamp(),
        consumed_receipt_id=v_receipt.id,consume_outcome='rejected'
        where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','23514','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

-- pending -> rejected by the Native owner (4.3.4, Owner decision D2: no
-- token). Revokes live tokens; the S1/S2 digest guards then refuse a silent
-- re-submission or re-proposal.
create function clued_private.candidate_reject_core_v1(
  p_user_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_tier text:=p_input->>'tier'; v_id uuid;
  v_candidate jsonb; v_version integer; v_refs jsonb; v_event_id text; v_result jsonb; v_error text; v_state text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,null,'candidate_reject',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('idempotency_key','request_hash','tier','candidate_id','base_version','reason')) then
      raise exception 'candidate_reject_unknown_field' using errcode='22023';
    end if;
    if v_tier is null or v_tier not in ('information','knowledge')
      or coalesce(p_input->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]{0,8}$'
      or (p_input ? 'reason' and (not clued_private.intake_is_str_v1(p_input->'reason',1,1000)
        or btrim(p_input->>'reason')='')) then
      raise exception 'invalid_reject_input' using errcode='22023';
    end if;
    v_id:=(p_input->>'candidate_id')::uuid;
    v_candidate:=clued_private.candidate_lock_v1(p_user_id,v_tier,v_id);
    if v_candidate is null then raise exception 'candidate_not_found' using errcode='P0002'; end if;
    if (v_candidate->>'version')::integer<>(p_input->>'base_version')::integer then
      raise exception 'candidate_version_conflict' using errcode='40001';
    end if;
    if v_candidate->>'status'<>'pending' then raise exception 'candidate_not_pending' using errcode='55000'; end if;
    v_version:=clued_private.candidate_transition_v1(p_user_id,v_tier,v_id,'rejected',v_receipt.id,null,null);
    update clued_private.candidate_confirmation_tokens set revoked_at=clock_timestamp()
      where candidate_tier=v_tier and candidate_id=v_id and consumed_at is null and revoked_at is null;
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system',
      'id',(case when v_tier='information' then 'information_candidate:' else 'knowledge_candidate:' end)||v_id::text));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,null,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:candidate_rejected',v_refs,v_candidate->>'scope',null,
      jsonb_build_object('candidate_id',v_id,'tier',v_tier,'candidate_version',v_version,'reason',p_input->>'reason'),
      'candidate_reject:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only','{}','[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,
      jsonb_build_object(v_id::text,v_version-1),jsonb_build_object(v_id::text,v_version),array[v_event_id],'{}',null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object(
      'outcome','rejected','tier',v_tier,'candidate_id',v_id,'candidate_version',v_version));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','23514','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

revoke all on function clued_private.candidate_confirmation_token_guard_v1(),
  clued_private.promotion_marker_immutable_v1(),
  clued_private.native_auth_time_v1(),
  clued_private.native_session_fresh_v1(),
  clued_private.native_direct_session_v1(),
  clued_private.native_write_marker_v1(uuid,jsonb,text),
  clued_private.record_human_confirmed_v1(uuid,uuid,bigint),
  clued_private.candidate_observed_evidence_ok_v1(uuid,uuid),
  clued_private.knowledge_lineage_ok_v1(uuid,jsonb),
  clued_private.candidate_record_body_v1(uuid,text,uuid,jsonb,uuid),
  clued_private.candidate_lock_v1(uuid,text,uuid),
  clued_private.candidate_transition_v1(uuid,text,uuid,text,uuid,uuid,bigint),
  clued_private.candidate_confirmation_issue_core_v1(uuid,jsonb),
  clued_private.candidate_promote_core_v1(uuid,jsonb,text),
  clued_private.candidate_reject_core_v1(uuid,jsonb,text)
  from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- S1 cores: 23514 classification, the Information rejected-digest guard
-- (4.3.4, D14) and token revocation on withdraw. The S1 bodies are patched in
-- place; an unexpected upstream definition stops the migration.
-- ---------------------------------------------------------------------------
do $migration$
declare body text;
  submit_class text:=$a$      case when v_state in ('22023','23505','42501','P0002') then 'rejected' else 'failed' end,$a$;
  submit_class_new text:=$a$      case when v_state in ('22023','23505','23514','40001','42501','P0002','55000') then 'rejected' else 'failed' end,$a$;
  submit_anchor text:=$a$    v_evidence:=clued_private.evidence_ingest_core(p_user_id,p_binding_id,jsonb_build_object($a$;
  submit_guard text:=$a$    -- Contract 4.3.4 (S3): a rejected candidate is never silently re-submitted
    -- with the same digest; the whole submission is refused.
    if exists(select 1 from jsonb_array_elements(v_document->'items') i(v)
        join clued_private.information_candidates c on c.user_id=p_user_id and c.status='rejected'
         and c.input_digest=clued_private.m1_sha256(jsonb_build_object('segment_sha256',v_segment_sha,'item',i.v))) then
      raise exception 'candidate_previously_rejected' using errcode='55000';
    end if;
$a$;
  withdraw_class text:=$a$      case when v_state in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end,$a$;
  withdraw_class_new text:=$a$      case when v_state in ('22023','23505','23514','40001','42501','P0002','55000') then 'rejected' else 'failed' end,$a$;
  withdraw_anchor text:=$a$    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id','information_candidate:'||v_id));$a$;
  withdraw_revoke text:=$a$    update clued_private.candidate_confirmation_tokens set revoked_at=clock_timestamp()
      where candidate_tier='information' and candidate_id=v_id and consumed_at is null and revoked_at is null;
$a$;
begin
  body:=pg_get_functiondef('clued_private.intake_submit_core_v1(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,submit_class,'')))/length(submit_class)<>1
    or (length(body)-length(replace(body,submit_anchor,'')))/length(submit_anchor)<>1
    or strpos(body,'candidate_previously_rejected')>0 then
    raise exception 'intake_submit_core_definition_mismatch';
  end if;
  execute replace(replace(body,submit_class,submit_class_new),submit_anchor,submit_guard||submit_anchor);

  body:=pg_get_functiondef('clued_private.intake_withdraw_core_v1(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,withdraw_class,'')))/length(withdraw_class)<>1
    or (length(body)-length(replace(body,withdraw_anchor,'')))/length(withdraw_anchor)<>1 then
    raise exception 'intake_withdraw_core_definition_mismatch';
  end if;
  execute replace(replace(body,withdraw_class,withdraw_class_new),withdraw_anchor,withdraw_revoke||withdraw_anchor);
end $migration$;

-- ---------------------------------------------------------------------------
-- Native account-session entries
-- ---------------------------------------------------------------------------

-- /v1/records: additive marker write; the result is returned unchanged.
-- CREATE OR REPLACE keeps the authenticated-only grant.
create or replace function public.clued_user_record_mutate(
  p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_result jsonb;
begin
  v_result:=clued_private.record_mutation_with_terminal_guard(v_owner,null,p_input,p_received_payload_hash);
  perform clued_private.native_write_marker_v1(v_owner,v_result,'record_mutate');
  return v_result;
end $$;

-- /v1/decisions/supersede keeps its M1 owner resolution (auth.uid(); D7). Only
-- a direct human session gets a marker; a delegated OAuth write gets none.
create or replace function public.clued_user_decision_supersede(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=(select auth.uid()); v_result jsonb;
begin
  v_result:=clued_private.decision_supersede_core(v_owner,null,p_input,p_received_payload_hash);
  if clued_private.native_direct_session_v1() then
    perform clued_private.native_write_marker_v1(v_owner,v_result,'decision_supersede');
  end if;
  return v_result;
end $$;

create function public.clued_candidate_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_confirmation_input' using errcode='22023';
  end if;
  -- Same lock order as promotion: currentness -> candidate -> token.
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.candidate_confirmation_issue_core_v1(v_owner,p_input);
end $$;

create function public.clued_candidate_promote_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  -- First, as in the M1 wrapper: currentness -> receipt -> rows.
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.candidate_promote_core_v1(v_owner,p_input,p_received_payload_hash);
end $$;

create function public.clued_candidate_reject_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.candidate_reject_core_v1(v_owner,p_input,p_received_payload_hash);
end $$;

revoke all on function public.clued_candidate_confirmation_issue_v1(jsonb),
  public.clued_candidate_promote_v1(jsonb,text),public.clued_candidate_reject_v1(jsonb,text)
  from public,anon,service_role;
grant execute on function public.clued_candidate_confirmation_issue_v1(jsonb),
  public.clued_candidate_promote_v1(jsonb,text),public.clued_candidate_reject_v1(jsonb,text)
  to authenticated;

notify pgrst,'reload schema';
