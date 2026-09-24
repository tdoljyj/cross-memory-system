-- Information Flow M0-D slice S4: Context Policy, service Compiler and MSCP
-- manifests. Contract: development/contracts/information-flow/M0DCloseout.v0.1.md
-- (frozen, Decision 825aa822-7cb2-4239-a3a1-0989200ef068), sections 6.1-6.3, 8.
--
-- A Context Policy is accepted only through a Native two-step confirmation
-- (receipt-core family context_policy_accept). The approving Decision is
-- written only through clued_private.record_mutation_with_terminal_guard with
-- binding_id=null, and the policy is usable only while that exact Decision
-- version is current, CURRENT and Native-marked. The Compiler is a definer
-- function: it authorizes before retrieval, serializes byte-compatibly with
-- scripts/phase2-qualification/minimum-context-compiler serialize(), and
-- stores only derived manifests (digests and source versions, never bodies).
-- The Worker measures tokens; it never assembles or digests a pack.
-- Additive only: no existing table is altered.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Generic Native two-step confirmation tokens. S4 uses
-- action='context_policy_accept'; S5 reuses the table for Evidence withdrawal.
-- Only the sha256 of the raw token is stored.
create table clued_private.native_confirmation_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action ~ '^[a-z_]{1,40}$'),
  subject_key text not null check (char_length(subject_key) between 1 and 160),
  subject_version bigint not null check (subject_version>=0),
  native_choices jsonb not null,
  confirmation_view jsonb not null,
  view_digest text not null check (view_digest ~ '^[0-9a-f]{64}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  session_id text,
  auth_time timestamptz not null,
  issued_xact xid8 not null default pg_current_xact_id(),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_receipt_id uuid references public.clued_audit_receipts(id),
  consume_outcome text check (consume_outcome in ('committed','rejected')),
  check ((consumed_at is null)=(consumed_receipt_id is null)),
  check ((consumed_at is null)=(consume_outcome is null)),
  check (expires_at>issued_at)
);
create unique index native_confirmation_tokens_live_uidx
  on clued_private.native_confirmation_tokens(user_id,action,subject_key)
  where consumed_at is null and revoked_at is null;
-- The S3 guard is generic over these column names.
create trigger native_confirmation_tokens_guard before update
  on clued_private.native_confirmation_tokens for each row
  execute function clued_private.candidate_confirmation_token_guard_v1();

-- Accepted Context Policies. One lineage per (user, task_class); each accepted
-- version is its own row, bound to the approving Decision id, version and
-- Receipt. Rows are immutable except for the single active->superseded step.
create table clued_private.context_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_class text not null check (task_class ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  policy_version integer not null check (policy_version>=1),
  schema_version text not null check (schema_version='clued.context-policy.v1'),
  policy jsonb not null,
  policy_digest text not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  decision_record_id uuid not null,
  decision_version bigint not null check (decision_version>=1),
  decision_receipt_id uuid not null references public.clued_audit_receipts(id),
  acceptance_receipt_id uuid not null unique references public.clued_audit_receipts(id),
  token_id uuid not null unique references clued_private.native_confirmation_tokens(id),
  accepted_session_id text,
  accepted_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','superseded')),
  -- Deferred: the superseding row is inserted after the old row is retired.
  superseded_by uuid references clued_private.context_policies(id) deferrable initially deferred,
  superseded_at timestamptz,
  version integer not null default 1 check (version>=1),
  check ((status='superseded')=(superseded_by is not null and superseded_at is not null)),
  unique (user_id,task_class,policy_version),
  unique (decision_record_id,decision_version)
);
create unique index context_policies_active_uidx
  on clued_private.context_policies(user_id,task_class) where status='active';

-- Derived compile manifests: digests and source versions only. Pack bodies
-- are recomputed on demand and never stored (contract 6.3).
create table clued_private.context_pack_manifests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  principal_kind text not null check (principal_kind in ('native_account_session','agent_binding')),
  -- No FK: provenance survives Binding deletion, as in the candidate store.
  binding_id uuid,
  policy_id uuid not null references clued_private.context_policies(id),
  policy_digest text not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  request jsonb not null check (jsonb_typeof(request)='object'),
  effective_scopes text[] not null,
  inputs_digest text not null check (inputs_digest ~ '^[0-9a-f]{64}$'),
  pack_digest text not null check (pack_digest ~ '^[0-9a-f]{64}$'),
  sources jsonb not null check (jsonb_typeof(sources)='array'),
  stale boolean not null default false,
  stale_reason text,
  stale_at timestamptz,
  compiled_at timestamptz not null default now(),
  last_compiled_at timestamptz not null default now(),
  last_revalidated_at timestamptz,
  version integer not null default 1 check (version>=1),
  check ((principal_kind='agent_binding')=(binding_id is not null)),
  check (stale=(stale_reason is not null and stale_at is not null))
);
create unique index context_pack_manifests_live_uidx
  on clued_private.context_pack_manifests(user_id,principal_kind,
    coalesce(binding_id,'00000000-0000-0000-0000-000000000000'::uuid),inputs_digest)
  where not stale;
create index context_pack_manifests_policy_idx
  on clued_private.context_pack_manifests(user_id,policy_id);
create index context_pack_manifests_sources_gin
  on clued_private.context_pack_manifests using gin (sources jsonb_path_ops);

alter table clued_private.native_confirmation_tokens enable row level security;
alter table clued_private.context_policies enable row level security;
alter table clued_private.context_pack_manifests enable row level security;
revoke all on table clued_private.native_confirmation_tokens,
  clued_private.context_policies, clued_private.context_pack_manifests
  from public, anon, authenticated, service_role;

create function clued_private.context_policy_guard_v1()
returns trigger language plpgsql set search_path='' as $$
declare v_mutable text[]:=array['status','superseded_by','superseded_at','version'];
begin
  if old.status='active' and new.status='superseded'
    and new.superseded_by is not null and new.superseded_at is not null
    and new.version=old.version+1
    and (to_jsonb(new)-v_mutable) is not distinct from (to_jsonb(old)-v_mutable) then
    return new;
  end if;
  raise exception 'context_policy_immutable' using errcode='55000';
end $$;
create trigger context_policies_guard before update
  on clued_private.context_policies for each row
  execute function clued_private.context_policy_guard_v1();

create function clued_private.context_pack_manifest_guard_v1()
returns trigger language plpgsql set search_path='' as $$
declare v_mutable text[]:=array['stale','stale_reason','stale_at','last_compiled_at','last_revalidated_at','version'];
begin
  if (to_jsonb(new)-v_mutable) is distinct from (to_jsonb(old)-v_mutable) then
    raise exception 'context_pack_manifest_immutable' using errcode='55000';
  end if;
  -- A stale manifest never becomes valid again.
  if old.stale and (new.stale,new.stale_reason,new.stale_at) is distinct from (old.stale,old.stale_reason,old.stale_at) then
    raise exception 'context_pack_manifest_immutable' using errcode='55000';
  end if;
  if not old.stale and new.stale and new.version<>old.version+1 then
    raise exception 'context_pack_manifest_immutable' using errcode='55000';
  end if;
  return new;
end $$;
create trigger context_pack_manifests_guard before update
  on clued_private.context_pack_manifests for each row
  execute function clued_private.context_pack_manifest_guard_v1();

-- ---------------------------------------------------------------------------
-- Canonical serialization (byte-compatible with minimum-context-compiler
-- serialize(): JSON.stringify of a recursively key-sorted value; unsafe
-- numbers refused). Keys are sorted by code point (C collation); every key
-- this slice emits is ASCII, where UTF-8 byte order equals UTF-16 order.
-- PostgreSQL escape_json and JSON.stringify escape the same characters.
-- ---------------------------------------------------------------------------
create function clued_private.context_canonical_json_v1(p_value jsonb)
returns text language plpgsql immutable strict set search_path='' as $$
declare v_type text:=jsonb_typeof(p_value); v_out text; v_num numeric;
begin
  if v_type='object' then
    select '{'||coalesce(string_agg(to_jsonb(e.k)::text||':'||clued_private.context_canonical_json_v1(e.v),','
      order by e.k collate "C"),'')||'}' into v_out from jsonb_each(p_value) e(k,v);
    return v_out;
  elsif v_type='array' then
    select '['||coalesce(string_agg(clued_private.context_canonical_json_v1(a.v),',' order by a.o),'')||']'
      into v_out from jsonb_array_elements(p_value) with ordinality a(v,o);
    return v_out;
  elsif v_type='number' then
    v_num:=(p_value#>>'{}')::numeric;
    if v_num<>trunc(v_num) or abs(v_num)>9007199254740991 then
      raise exception 'context_unsafe_number' using errcode='22023';
    end if;
    return trunc(v_num)::text;
  end if;
  return p_value::text;
end $$;

create function clued_private.context_sha256_text_v1(p_text text)
returns text language sql immutable strict set search_path='' as $$
  select encode(extensions.digest(convert_to(p_text,'UTF8'),'sha256'),'hex')
$$;

-- sha256 of the canonical text with its trailing newline (serialize()).
create function clued_private.context_digest_v1(p_value jsonb)
returns text language sql immutable strict set search_path='' as $$
  select clued_private.context_sha256_text_v1(clued_private.context_canonical_json_v1(p_value)||E'\n')
$$;

-- ---------------------------------------------------------------------------
-- Policy schema clued.context-policy.v1 (contract 6.1)
-- ---------------------------------------------------------------------------
create function clued_private.context_policy_tokenizer_v1()
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('package','js-tiktoken','version','1.0.21','encoding','o200k_base',
    'model_mapping','gpt-4.1-2025-04-14')
$$;

create function clued_private.context_policy_uint_v1(p_value jsonb,p_min integer,p_max integer)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='number' and (p_value#>>'{}') ~ '^[0-9]{1,9}$'
    and (p_value#>>'{}')::integer between p_min and p_max,false)
$$;

-- Closed string set, non-empty (unless p_allow_empty), unique; returns the
-- sorted array or NULL when invalid.
create function clued_private.context_policy_set_v1(p_value jsonb,p_allowed text[],p_allow_empty boolean)
returns text[] language plpgsql immutable set search_path='' as $$
declare v_out text[];
begin
  if jsonb_typeof(p_value) is distinct from 'array' then return null; end if;
  if jsonb_array_length(p_value)=0 then return case when p_allow_empty then '{}'::text[] end; end if;
  if exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'string'
      or not ((x#>>'{}')=any(p_allowed))) then
    return null;
  end if;
  select array_agg(x order by x collate "C") into v_out from jsonb_array_elements_text(p_value) x;
  if cardinality(v_out)<>(select count(distinct x) from unnest(v_out) x) then return null; end if;
  return v_out;
end $$;

-- One allowed scope, resolved to its effective canonical form.
create function clued_private.context_scope_resolve_v1(p_user_id uuid,p_scope text)
returns text language plpgsql stable security definer set search_path='' as $$
begin
  if p_scope in ('global','profile') then return p_scope; end if;
  if p_scope ~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 'project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(p_scope));
  end if;
  raise exception 'context_policy_scope_invalid' using errcode='22023';
end $$;

-- Validates a policy document and returns the normalized form (every key
-- present, sets sorted, defaults filled). Unknown keys are refused at every
-- level.
create function clued_private.context_policy_normalize_v1(p_user_id uuid,p_doc jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_fields_closed text[]:=array['closure_summary','content','rationale','title'];
  v_scopes text[]:='{}'; v_x jsonb; v_s text; v_types text[]; v_tiers text[]; v_required text[];
  v_optional text[]; v_constraints jsonb; v_mode text; v_reason jsonb; v_fresh jsonb;
begin
  if jsonb_typeof(p_doc) is distinct from 'object' then
    raise exception 'context_policy_invalid' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_doc) k where k not in ('schema','task_class','allowed_scopes',
      'allowed_record_types','allowed_tiers','allow_agent_authored','require_evidence','fields',
      'verbatim_constraints','max_items','token_budget','tokenizer','freshness')) then
    raise exception 'context_policy_unknown_field' using errcode='22023';
  end if;
  if p_doc->'schema' is distinct from '"clued.context-policy.v1"'::jsonb then
    raise exception 'context_policy_schema_invalid' using errcode='22023';
  end if;
  if jsonb_typeof(p_doc->'task_class') is distinct from 'string'
    or (p_doc->>'task_class') !~ '^[a-z0-9][a-z0-9._:-]{0,119}$' then
    raise exception 'context_policy_task_class_invalid' using errcode='22023';
  end if;
  -- Scopes: 1..20 unique entries, resolved through project redirects.
  if jsonb_typeof(p_doc->'allowed_scopes') is distinct from 'array'
    or jsonb_array_length(p_doc->'allowed_scopes') not between 1 and 20 then
    raise exception 'context_policy_scopes_invalid' using errcode='22023';
  end if;
  for v_x in select value from jsonb_array_elements(p_doc->'allowed_scopes') loop
    if jsonb_typeof(v_x)<>'string' then raise exception 'context_policy_scopes_invalid' using errcode='22023'; end if;
    v_s:=clued_private.context_scope_resolve_v1(p_user_id,v_x#>>'{}');
    if v_s=any(v_scopes) then raise exception 'context_policy_scopes_invalid' using errcode='22023'; end if;
    v_scopes:=array_append(v_scopes,v_s);
  end loop;
  select array_agg(s order by s collate "C") into v_scopes from unnest(v_scopes) s;
  v_types:=clued_private.context_policy_set_v1(p_doc->'allowed_record_types',
    array['decision','note','profile_fact','state','task'],false);
  if v_types is null then raise exception 'context_policy_record_types_invalid' using errcode='22023'; end if;
  v_tiers:=case when p_doc ? 'allowed_tiers' then clued_private.context_policy_set_v1(p_doc->'allowed_tiers',
      array['authority_information','authority_knowledge','candidate_information','candidate_knowledge'],false)
    else array['authority_information','authority_knowledge'] end;
  if v_tiers is null then raise exception 'context_policy_tiers_invalid' using errcode='22023'; end if;
  if p_doc ? 'allow_agent_authored' and jsonb_typeof(p_doc->'allow_agent_authored')<>'boolean' then
    raise exception 'context_policy_allow_agent_authored_invalid' using errcode='22023';
  end if;
  if jsonb_typeof(p_doc->'require_evidence') is distinct from 'boolean' then
    raise exception 'context_policy_require_evidence_invalid' using errcode='22023';
  end if;
  -- Fields: required (>=1) and optional, disjoint, from the closed set.
  if jsonb_typeof(p_doc->'fields') is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_doc->'fields') k where k not in ('required','optional')) then
    raise exception 'context_policy_fields_invalid' using errcode='22023';
  end if;
  v_required:=clued_private.context_policy_set_v1(p_doc->'fields'->'required',v_fields_closed,false);
  v_optional:=case when p_doc->'fields' ? 'optional'
    then clued_private.context_policy_set_v1(p_doc->'fields'->'optional',v_fields_closed,true) else '{}'::text[] end;
  if v_required is null or v_optional is null or v_required&&v_optional then
    raise exception 'context_policy_fields_invalid' using errcode='22023';
  end if;
  -- Verbatim constraints: 0..100 exact quotations of a selected field.
  v_constraints:=coalesce(p_doc->'verbatim_constraints','[]'::jsonb);
  if jsonb_typeof(v_constraints)<>'array' or jsonb_array_length(v_constraints)>100 then
    raise exception 'context_policy_constraints_invalid' using errcode='22023';
  end if;
  for v_x in select value from jsonb_array_elements(v_constraints) loop
    if not clued_private.intake_keys_exact_v1(v_x,'["record_id","field","exact_text"]')
      or jsonb_typeof(v_x->'record_id')<>'string'
      or (v_x->>'record_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(v_x->'field')<>'string'
      or not clued_private.intake_is_str_v1(v_x->'exact_text',1,2000) then
      raise exception 'context_policy_constraints_invalid' using errcode='22023';
    end if;
    if not ((v_x->>'field')=any(v_required||v_optional)) then
      raise exception 'context_policy_constraint_field_not_selected' using errcode='22023';
    end if;
  end loop;
  select coalesce(jsonb_agg(c order by c->>'record_id' collate "C",c->>'field' collate "C",
      c->>'exact_text' collate "C"),'[]'::jsonb) into v_constraints
    from (select jsonb_build_object('record_id',lower(x->>'record_id'),'field',x->>'field',
      'exact_text',x->>'exact_text') c from jsonb_array_elements(v_constraints) x) y;
  if jsonb_array_length(v_constraints)<>(select count(distinct c) from jsonb_array_elements(v_constraints) c) then
    raise exception 'context_policy_constraints_invalid' using errcode='22023';
  end if;
  if not clued_private.context_policy_uint_v1(p_doc->'max_items',1,200) then
    raise exception 'context_policy_max_items_invalid' using errcode='22023';
  end if;
  if not clued_private.context_policy_uint_v1(p_doc->'token_budget',1,32768) then
    raise exception 'context_policy_token_budget_invalid' using errcode='22023';
  end if;
  if p_doc->'tokenizer' is distinct from clued_private.context_policy_tokenizer_v1() then
    raise exception 'context_policy_tokenizer_unsupported' using errcode='22023';
  end if;
  -- Freshness (6.1): current, or historical/degraded with an explicit reason.
  v_fresh:=p_doc->'freshness';
  if jsonb_typeof(v_fresh) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(v_fresh) k where k not in ('mode','reason')) then
    raise exception 'context_policy_freshness_invalid' using errcode='22023';
  end if;
  v_mode:=case when jsonb_typeof(v_fresh->'mode')='string' then v_fresh->>'mode' end;
  v_reason:=coalesce(v_fresh->'reason','null'::jsonb);
  if v_mode='current' then
    if v_reason<>'null'::jsonb then raise exception 'context_policy_freshness_invalid' using errcode='22023'; end if;
  elsif v_mode in ('historical','degraded') then
    if not clued_private.intake_is_str_v1(v_reason,1,500) or btrim(v_reason#>>'{}')='' then
      raise exception 'context_policy_freshness_reason_required' using errcode='22023';
    end if;
  else
    raise exception 'context_policy_freshness_invalid' using errcode='22023';
  end if;
  return jsonb_build_object('schema','clued.context-policy.v1','task_class',p_doc->>'task_class',
    'allowed_scopes',to_jsonb(v_scopes),'allowed_record_types',to_jsonb(v_types),'allowed_tiers',to_jsonb(v_tiers),
    'allow_agent_authored',coalesce(p_doc->'allow_agent_authored','false'::jsonb),
    'require_evidence',p_doc->'require_evidence',
    'fields',jsonb_build_object('required',to_jsonb(v_required),'optional',to_jsonb(v_optional)),
    'verbatim_constraints',v_constraints,'max_items',(p_doc->>'max_items')::integer,
    'token_budget',(p_doc->>'token_budget')::integer,'tokenizer',clued_private.context_policy_tokenizer_v1(),
    'freshness',jsonb_build_object('mode',v_mode,'reason',v_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Usability, writer principal and the read lock
-- ---------------------------------------------------------------------------

-- NULL when the policy is usable, else a reason code (contract 6.1): the
-- exact approving Decision version is current, CURRENT, Native-marked by this
-- acceptance and still carries this policy's digest.
create function clued_private.context_policy_usable_v1(p_user_id uuid,p_policy_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare v_policy clued_private.context_policies%rowtype; v_record public.clued_memories%rowtype;
begin
  select * into v_policy from clued_private.context_policies where id=p_policy_id and user_id=p_user_id;
  if not found then return 'policy_not_found'; end if;
  if v_policy.status<>'active' then return 'policy_superseded'; end if;
  if clued_private.context_digest_v1(v_policy.policy) is distinct from v_policy.policy_digest then
    return 'policy_digest_mismatch';
  end if;
  select * into v_record from public.clued_memories where id=v_policy.decision_record_id and user_id=p_user_id;
  if not found or v_record.record_type is distinct from 'decision'
    or v_record.version is distinct from v_policy.decision_version then
    return 'policy_decision_changed';
  end if;
  if v_record.receipt_id is distinct from v_policy.decision_receipt_id or not exists(
      select 1 from public.clued_audit_receipts r where r.id=v_policy.decision_receipt_id and r.user_id=p_user_id
        and r.status='committed' and r.binding_id is null
        and (r.committed_versions->>v_record.id::text)::bigint=v_policy.decision_version) then
    return 'policy_decision_receipt_mismatch';
  end if;
  if clued_private.record_currentness_fence(p_user_id,v_record.id,null) is distinct from 'CURRENT' then
    return 'policy_decision_not_current';
  end if;
  if clued_private.record_human_confirmed_v1(p_user_id,v_record.id,v_policy.decision_version) is not true
    or not exists(select 1 from clued_private.native_write_markers n
      where n.receipt_id=v_policy.decision_receipt_id and n.record_id=v_record.id and n.user_id=p_user_id
        and n.record_version=v_policy.decision_version and n.entry='context_policy_accept') then
    return 'policy_decision_not_native_marked';
  end if;
  if v_record.type_fields->'context_policy'->>'policy_digest' is distinct from v_policy.policy_digest
    or v_record.type_fields->'context_policy'->>'task_class' is distinct from v_policy.task_class then
    return 'policy_decision_digest_mismatch';
  end if;
  return null;
end $$;

-- writer_principal (contract 6.3) from the Receipt that wrote this exact
-- version. The Binding id itself is never exposed.
create function clued_private.record_writer_principal_v1(p_user_id uuid,p_record_id uuid,p_version bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype;
begin
  select r.* into v_receipt from public.clued_memories m
    join public.clued_audit_receipts r on r.id=m.receipt_id and r.user_id=p_user_id
    where m.id=p_record_id and m.user_id=p_user_id and m.version=p_version;
  if not found or v_receipt.status is distinct from 'committed'
    or (v_receipt.committed_versions->>p_record_id::text)::bigint is distinct from p_version then
    return jsonb_build_object('writer_principal','unknown','writer_receipt_id',null);
  end if;
  return jsonb_build_object('writer_principal',
    case when v_receipt.binding_id is not null then 'agent_binding'
      when clued_private.record_human_confirmed_v1(p_user_id,p_record_id,p_version) then 'native_account_session'
      else 'unknown' end,
    'writer_receipt_id',v_receipt.id);
end $$;

-- Shared twin of currentness_user_lock: compiles read a consistent state
-- against writers without serializing with each other.
create function clued_private.context_pack_read_lock_v1(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('clued-currentness-user:'||p_user_id::text,0));
end $$;

-- The closed S3 item_type -> record_type mapping (candidate_record_body_v1).
create function clued_private.context_candidate_record_type_v1(p_item_type text)
returns text language sql immutable set search_path='' as $$
  select case p_item_type when 'preference' then 'profile_fact' when 'decision' then 'decision'
    when 'task' then 'task' when 'status' then 'state'
    when 'fact' then 'note' when 'event' then 'note' when 'artifact' then 'note'
    when 'issue' then 'note' when 'unclassified' then 'note' end
$$;

-- Evidence binding, ported from the evidence-context-binding source reader:
-- same-owner Evidence id/hash/size ordered by id. Returns NULL (and the first
-- unavailable id in p_missing) when any cited Evidence is unavailable.
create function clued_private.context_evidence_v1(p_user_id uuid,p_ids uuid[],out p_evidence jsonb,out p_missing uuid)
language plpgsql stable security definer set search_path='' as $$
begin
  select r.id into p_missing from unnest(coalesce(p_ids,'{}'::uuid[])) r(id)
    where not exists(select 1 from public.clued_evidence e where e.id=r.id and e.user_id=p_user_id)
    order by r.id limit 1;
  if p_missing is not null then p_evidence:=null; return; end if;
  select coalesce(jsonb_agg(jsonb_build_object('evidence_id',e.id,'content_hash',e.content_hash,
      'size_bytes',e.size_bytes) order by e.id),'[]'::jsonb) into p_evidence
    from public.clued_evidence e where e.user_id=p_user_id and e.id=any(coalesce(p_ids,'{}'::uuid[]));
end $$;

create function clued_private.context_pack_rejection_v1(p_code text,p_reason text)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('status','rejected','error_code',p_code,'authoritative',false,
    'execution_authorization','NOT_GRANTED','model_extraction','NOT_EVALUATED')
    ||case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason',p_reason) end
$$;

-- ---------------------------------------------------------------------------
-- Compiler (contract 6.2): pure compute, no writes.
-- ---------------------------------------------------------------------------
create function clued_private.context_pack_compile_v1(
  p_user_id uuid,p_binding_id uuid,p_policy_id uuid,p_request jsonb,p_read_scopes text[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_policy clued_private.context_policies%rowtype; v_doc jsonb; v_reason text; v_scope text;
  v_task_class text; v_allowed text[]:='{}'; v_effective text[]; v_s text; v_mode text;
  v_types text[]; v_tiers text[]; v_agent boolean; v_max integer; v_rows jsonb; v_row jsonb;
  v_items jsonb:='[]'; v_item jsonb; v_rec public.clued_memories%rowtype;
  v_info clued_private.information_candidates%rowtype; v_know clued_private.knowledge_candidates%rowtype;
  v_ev jsonb; v_missing uuid; v_fields jsonb; v_field text; v_value text; v_labels jsonb;
  v_required text[]; v_selected text[]; v_c jsonb; v_body jsonb; v_text text; v_inputs jsonb;
  v_sources jsonb:='[]'; v_authoritative boolean; v_writer jsonb; v_lineage text;
begin
  -- 1. Resolve the policy: the caller never supplies it. A foreign or unknown
  -- id resolves to nothing, exactly like no policy (no existence oracle).
  v_task_class:=p_request->>'task_class';
  if p_policy_id is not null then
    select * into v_policy from clued_private.context_policies where id=p_policy_id and user_id=p_user_id;
    if found and v_task_class is not null and v_task_class<>v_policy.task_class then
      return clued_private.context_pack_rejection_v1('CONTEXT_POLICY_REQUIRED','policy_task_class_mismatch');
    end if;
  elsif v_task_class is not null then
    select * into v_policy from clued_private.context_policies
      where user_id=p_user_id and task_class=v_task_class and status='active';
  end if;
  if v_policy.id is null then
    return clued_private.context_pack_rejection_v1('CONTEXT_POLICY_REQUIRED',null);
  end if;
  -- 2. Usability of the exact approving Decision version.
  v_reason:=clued_private.context_policy_usable_v1(p_user_id,v_policy.id);
  if v_reason is not null then
    return clued_private.context_pack_rejection_v1('CONTEXT_POLICY_REQUIRED',v_reason);
  end if;
  v_doc:=v_policy.policy;
  v_mode:=v_doc->'freshness'->>'mode';
  v_types:=array(select jsonb_array_elements_text(v_doc->'allowed_record_types'));
  v_tiers:=array(select jsonb_array_elements_text(v_doc->'allowed_tiers'));
  v_agent:=(v_doc->>'allow_agent_authored')::boolean;
  v_max:=(v_doc->>'max_items')::integer;
  v_required:=array(select jsonb_array_elements_text(v_doc->'fields'->'required'));
  v_selected:=array(select x from (select jsonb_array_elements_text(v_doc->'fields'->'required') x
    union select jsonb_array_elements_text(v_doc->'fields'->'optional')) y order by x collate "C");
  -- 3. Scopes, re-resolved through project redirects; unresolvable ones drop.
  for v_s in select jsonb_array_elements_text(v_doc->'allowed_scopes') loop
    begin
      v_s:=clued_private.context_scope_resolve_v1(p_user_id,v_s);
      if not (v_s=any(v_allowed)) then v_allowed:=array_append(v_allowed,v_s); end if;
    exception when others then null;
    end;
  end loop;
  begin
    v_scope:=clued_private.context_scope_resolve_v1(p_user_id,coalesce(p_request->>'scope','global'));
  exception when others then v_scope:=null;
  end;
  if v_scope is null or not (v_scope=any(v_allowed)) then
    return clued_private.context_pack_rejection_v1('CONTEXT_POLICY_SCOPE_MISMATCH',null);
  end if;
  select coalesce(array_agg(s order by s collate "C"),'{}'::text[]) into v_effective from unnest(v_allowed) s
    where p_read_scopes is null or s=any(p_read_scopes);

  -- 4. Authorize before retrieval: one statement, every predicate before the
  -- ORDER BY ... LIMIT max_items+1.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.scope collate "C",x.tier_rank,x.record_type,
      x.id::text collate "C"),'[]'::jsonb) into v_rows
  from (
    select * from (
      select 'record' kind,m.id,m.version::bigint version,d.scope,d.tier,
        case d.tier when 'authority_information' then 1 else 2 end tier_rank,m.record_type,d.fence,
        c.human_confirmed,c.writer->>'writer_principal' writer_principal,c.writer->>'writer_receipt_id' writer_receipt_id
      from public.clued_memories m
      cross join lateral (select coalesce(m.canonical_scope,case when m.project_id is not null
          then 'project:'||m.project_id::text else m.scope end) scope,
        case when m.record_type='note' and m.type_fields->>'note_kind'='knowledge' and m.type_fields ? 'knowledge'
          then 'authority_knowledge' else 'authority_information' end tier,
        case when m.record_type in ('state','task','decision')
          then clued_private.record_currentness_fence(p_user_id,m.id,p_read_scopes) else 'NOT_APPLICABLE' end fence) d
      cross join lateral (select clued_private.record_human_confirmed_v1(p_user_id,m.id,m.version) human_confirmed,
        clued_private.record_writer_principal_v1(p_user_id,m.id,m.version) writer) c
      where m.user_id=p_user_id
        and m.record_schema_version=1
        and d.scope=any(v_effective)
        and m.record_type=any(v_types)
        and d.tier=any(v_tiers)
        and not (coalesce(m.type_fields,'{}'::jsonb) ? 'context_policy')
        and case when m.record_type in ('state','task','decision') then
            d.fence='CURRENT' or (v_mode='historical' and d.fence='HISTORY')
              or (v_mode='degraded' and d.fence in ('STALE','SHADOWED_BY_ACTIVE_EVENT','UNKNOWN'))
          else v_mode='historical' or (m.lifecycle_status='active' and m.archived_at is null
              and m.merged_into_record_id is null) end
        and clued_private.record_evidence_unflagged_v1(p_user_id,m.id,m.version)
        and (d.tier<>'authority_knowledge'
          or clued_private.knowledge_lineage_ok_v1(p_user_id,m.type_fields->'knowledge'->'sources') is null)
        and (c.human_confirmed or (v_agent and c.writer->>'writer_principal'='agent_binding'))
      union all
      select 'candidate_information',ci.id,ci.version::bigint,ci.scope,'candidate_information',3,
        clued_private.context_candidate_record_type_v1(ci.payload->>'item_type'),'NOT_APPLICABLE',false,
        case when ci.source_kind='agent_binding' then 'agent_binding' else 'native_ui' end,null
      from clued_private.information_candidates ci
      where ci.user_id=p_user_id and 'candidate_information'=any(v_tiers)
        and ci.status='pending' and ci.expires_at>now()
        and ci.scope=any(v_effective)
        and clued_private.context_candidate_record_type_v1(ci.payload->>'item_type')=any(v_types)
        and (p_binding_id is null or ci.binding_id=p_binding_id or ci.source_kind='native_ui')
        and (ci.source_kind='native_ui' or v_agent)
      union all
      select 'candidate_knowledge',ck.id,ck.version::bigint,ck.scope,'candidate_knowledge',4,'note',
        'NOT_APPLICABLE',false,case when ck.source_kind='agent_binding' then 'agent_binding' else 'native_ui' end,null
      from clued_private.knowledge_candidates ck
      where ck.user_id=p_user_id and 'candidate_knowledge'=any(v_tiers)
        and ck.status='pending' and ck.expires_at>now()
        and ck.scope=any(v_effective)
        and 'note'=any(v_types)
        and (p_binding_id is null or ck.binding_id=p_binding_id or ck.source_kind='native_ui')
        and (ck.source_kind='native_ui' or v_agent)
    ) u
    order by u.scope collate "C",u.tier_rank,u.record_type,u.id::text collate "C"
    limit v_max+1
  ) x;

  -- 6. Fail closed: never truncate, drop or summarize.
  if jsonb_array_length(v_rows)=0 then
    return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','no_eligible_sources');
  end if;
  if jsonb_array_length(v_rows)>v_max then
    return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','max_items_exceeded');
  end if;

  -- 5. Build each item's complete Source Envelope.
  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_fields:='{}'; v_lineage:=null;
    if v_row->>'kind'='record' then
      select * into v_rec from public.clued_memories where id=(v_row->>'id')::uuid and user_id=p_user_id;
      select e.p_evidence,e.p_missing into v_ev,v_missing from clued_private.context_evidence_v1(p_user_id,v_rec.source_refs) e;
      if v_row->>'tier'='authority_knowledge' then v_lineage:='OK'; end if;
      foreach v_field in array v_selected loop
        v_value:=case v_field when 'title' then v_rec.title when 'content' then v_rec.content
          when 'rationale' then v_rec.type_fields->>'rationale' when 'closure_summary' then v_rec.closure_summary end;
        v_fields:=v_fields||jsonb_build_object(v_field,v_value);
      end loop;
      v_labels:=case when (v_row->>'human_confirmed')::boolean then '[]'::jsonb else '["AGENT_AUTHORED"]'::jsonb end;
      v_item:=jsonb_build_object('canonical_id',v_rec.id,'version',v_rec.version,'scope',v_row->>'scope',
        'record_type',v_rec.record_type,'tier',v_row->>'tier','labels',v_labels,
        'writer_principal',v_row->>'writer_principal','writer_receipt_id',v_row->'writer_receipt_id',
        'human_confirmed',(v_row->>'human_confirmed')::boolean,
        'source_unavailable_reason',v_rec.source_unavailable_reason,
        'status',jsonb_build_object('currentness',v_row->>'fence','lifecycle_status',v_rec.lifecycle_status,
          'lineage',v_lineage));
    elsif v_row->>'kind'='candidate_information' then
      select * into v_info from clued_private.information_candidates where id=(v_row->>'id')::uuid and user_id=p_user_id;
      select e.p_evidence,e.p_missing into v_ev,v_missing from clued_private.context_evidence_v1(p_user_id,v_info.evidence_ids) e;
      foreach v_field in array v_selected loop
        v_value:=case v_field when 'title' then v_info.payload->>'summary' when 'content' then v_info.payload->>'claim' end;
        v_fields:=v_fields||jsonb_build_object(v_field,v_value);
      end loop;
      v_labels:=case when v_info.source_kind='agent_binding' then '["AGENT_AUTHORED","CANDIDATE"]'::jsonb
        else '["CANDIDATE"]'::jsonb end;
      v_item:=jsonb_build_object('canonical_id',v_info.id,'version',v_info.version,'scope',v_info.scope,
        'record_type',v_row->>'record_type','tier','candidate_information','labels',v_labels,
        'writer_principal',v_row->>'writer_principal','writer_receipt_id',null,'human_confirmed',false,
        'source_unavailable_reason',null,
        'status',jsonb_build_object('currentness','NOT_APPLICABLE','lifecycle_status',v_info.status,'lineage',null));
    else
      select * into v_know from clued_private.knowledge_candidates where id=(v_row->>'id')::uuid and user_id=p_user_id;
      select e.p_evidence,e.p_missing into v_ev,v_missing from clued_private.context_evidence_v1(p_user_id,v_know.evidence_ids) e;
      v_lineage:=coalesce(clued_private.knowledge_lineage_ok_v1(p_user_id,v_know.sources),'OK');
      foreach v_field in array v_selected loop
        v_value:=case v_field when 'title' then left(v_know.assertion,120) when 'content' then v_know.assertion end;
        v_fields:=v_fields||jsonb_build_object(v_field,v_value);
      end loop;
      v_labels:=case when v_know.source_kind='agent_binding' then '["AGENT_AUTHORED","CANDIDATE"]'::jsonb
        else '["CANDIDATE"]'::jsonb end;
      v_item:=jsonb_build_object('canonical_id',v_know.id,'version',v_know.version,'scope',v_know.scope,
        'record_type','note','tier','candidate_knowledge','labels',v_labels,
        'writer_principal',v_row->>'writer_principal','writer_receipt_id',null,'human_confirmed',false,
        'source_unavailable_reason',null,
        'status',jsonb_build_object('currentness','NOT_APPLICABLE','lifecycle_status',v_know.status,
          'lineage',v_lineage));
    end if;
    if v_missing is not null then
      return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','source_evidence_unavailable:'||v_missing);
    end if;
    foreach v_field in array v_required loop
      if coalesce(v_fields->>v_field,'')='' then
        return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','required_field_missing:'||(v_row->>'id'));
      end if;
    end loop;
    if (v_doc->>'require_evidence')::boolean and jsonb_array_length(v_ev)=0 then
      return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','evidence_required:'||(v_row->>'id'));
    end if;
    v_items:=v_items||jsonb_build_array(v_item||jsonb_build_object('evidence',v_ev,'fields',v_fields));
    v_sources:=v_sources||jsonb_build_array(jsonb_build_object('tier',v_row->>'tier','id',v_row->>'id',
      'version',(v_row->>'version')::bigint,'evidence',coalesce((select jsonb_agg(jsonb_build_object(
        'evidence_id',e->'evidence_id','content_hash',e->'content_hash') order by ord)
        from jsonb_array_elements(v_ev) with ordinality a(e,ord)),'[]'::jsonb)));
  end loop;

  -- Verbatim constraints must be grounded in a packed field, exactly.
  for v_c in select value from jsonb_array_elements(v_doc->'verbatim_constraints') loop
    if not exists(select 1 from jsonb_array_elements(v_items) i
        where i->>'canonical_id'=v_c->>'record_id'
          and strpos(coalesce(i->'fields'->>(v_c->>'field'),''),v_c->>'exact_text')>0) then
      return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','constraint_not_grounded:'||(v_c->>'record_id'));
    end if;
  end loop;

  -- 7./8. authoritative, compile inputs and the MSCP body.
  v_authoritative:=v_mode<>'degraded' and not exists(select 1 from jsonb_array_elements(v_items) i
    where i->'labels' ? 'CANDIDATE' or i->'labels' ? 'AGENT_AUTHORED');
  v_inputs:=jsonb_build_object('policy_id',v_policy.id,'policy_digest',v_policy.policy_digest,
    'request',jsonb_build_object('scope',v_scope,'task_class',v_policy.task_class),
    'freshness_mode',v_mode,'scopes',to_jsonb(v_effective),'sources',v_sources);
  begin
    v_body:=jsonb_build_object('schema','clued.context-pack.v1',
      'policy',jsonb_build_object('id',v_policy.id,'task_class',v_policy.task_class,'version',v_policy.policy_version,
        'digest',v_policy.policy_digest,'decision',jsonb_build_object('id',v_policy.decision_record_id,
          'version',v_policy.decision_version,'receipt_id',v_policy.decision_receipt_id)),
      'request',jsonb_build_object('scope',v_scope,'task_class',v_policy.task_class),
      'freshness',v_doc->'freshness','scopes',to_jsonb(v_effective),'items',v_items,
      'constraints',v_doc->'verbatim_constraints','authoritative',v_authoritative,
      'execution_authorization','NOT_GRANTED','model_extraction','NOT_EVALUATED',
      'compile_inputs_digest',clued_private.context_digest_v1(v_inputs),
      'token_budget',(v_doc->>'token_budget')::integer,
      'tokenizer',clued_private.context_policy_tokenizer_v1()||jsonb_build_object('status','offline_target'));
    v_text:=clued_private.context_canonical_json_v1(v_body)||E'\n';
  exception when sqlstate '22023' then
    return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','unsafe_number');
  end;
  if octet_length(v_text)>1048576 then
    return clued_private.context_pack_rejection_v1('CONTEXT_INSUFFICIENT','pack_byte_limit');
  end if;
  return jsonb_build_object('status','ok','pack',v_body,'pack_text',v_text,
    'pack_digest',clued_private.context_sha256_text_v1(v_text),
    'compile_inputs_digest',v_body->>'compile_inputs_digest',
    'authoritative',v_authoritative,'execution_authorization','NOT_GRANTED','model_extraction','NOT_EVALUATED',
    '_policy',jsonb_build_object('id',v_policy.id,'digest',v_policy.policy_digest),
    '_request',jsonb_build_object('scope',v_scope,'task_class',v_policy.task_class),
    '_scopes',to_jsonb(v_effective),
    '_sources',(select coalesce(jsonb_agg(jsonb_build_object('tier',s->'tier','id',s->'id','version',s->'version')
      order by ord),'[]'::jsonb) from jsonb_array_elements(v_sources) with ordinality a(s,ord)));
end $$;

-- ---------------------------------------------------------------------------
-- Pack entry core (replaces the S2 placeholder): compile + manifest, or
-- Native-only manifest revalidation. No Receipt, no Canonical write.
-- ---------------------------------------------------------------------------
create or replace function clued_private.context_pack_core_v1(p_user_id uuid,p_binding_id uuid,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_policy_id uuid; v_result jsonb; v_principal text:=case when p_binding_id is null
    then 'native_account_session' else 'agent_binding' end;
  v_read_scopes text[]; v_manifest clued_private.context_pack_manifests%rowtype; v_id uuid; v_reused boolean:=false;
  v_reason text; v_binding public.clued_agent_bindings%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'invalid_context_pack_input' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','policy_id','task_class','manifest_id')) then
    raise exception 'context_pack_unknown_field' using errcode='22023';
  end if;
  if (p_input ? 'scope' and jsonb_typeof(p_input->'scope')<>'null' and (jsonb_typeof(p_input->'scope')<>'string'
      or not ((p_input->>'scope') in ('global','profile') or (p_input->>'scope') ~ '^project:[0-9a-f-]{36}$')))
    or (p_input ? 'policy_id' and coalesce(p_input->>'policy_id','')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (p_input ? 'task_class' and not clued_private.intake_is_str_v1(p_input->'task_class',1,120))
    or (p_input ? 'manifest_id' and (coalesce(p_input->>'manifest_id','')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_input ?| array['scope','policy_id','task_class'])) then
    raise exception 'invalid_context_pack_input' using errcode='22023';
  end if;
  perform clued_private.context_pack_read_lock_v1(p_user_id);

  if p_input ? 'manifest_id' then
    -- Revalidation is Native-only and runs under the manifest's recorded
    -- principal. A pack is never an online fallback: no body is returned.
    if p_binding_id is not null then
      return clued_private.context_pack_rejection_v1('manifest_revalidation_native_only',null);
    end if;
    select * into v_manifest from clued_private.context_pack_manifests
      where id=(p_input->>'manifest_id')::uuid and user_id=p_user_id for update;
    if not found then
      return clued_private.context_pack_rejection_v1('CONTEXT_MANIFEST_NOT_FOUND',null);
    end if;
    if v_manifest.stale then
      return jsonb_build_object('status','stale','revalidation','STALE','manifest_id',v_manifest.id,
        'reason',v_manifest.stale_reason,'authoritative',false,'execution_authorization','NOT_GRANTED');
    end if;
    if exists(select 1 from jsonb_array_elements(v_manifest.sources) s
        join public.clued_memories m on m.id=(s->>'id')::uuid and m.user_id=p_user_id
        where s->>'tier' like 'authority_%' and m.record_type in ('state','task','decision')
          and clued_private.record_currentness_fence(p_user_id,m.id,null) in ('STALE','UNKNOWN')) then
      return jsonb_build_object('status','stale','revalidation','PROJECTION_REQUIRED','manifest_id',v_manifest.id,
        'reason','projection_required','authoritative',false,'execution_authorization','NOT_GRANTED');
    end if;
    if v_manifest.principal_kind='agent_binding' then
      select * into v_binding from public.clued_agent_bindings b
        where b.id=v_manifest.binding_id and b.user_id=p_user_id;
      if not found or v_binding.revoked_at is not null
        or (to_jsonb(v_binding)->>'expires_at')::timestamptz<=clock_timestamp()
        or not ('context:read'=any(v_binding.scopes)) then
        v_reason:='binding_revoked_or_reduced';
      else
        v_read_scopes:=clued_private.binding_read_scopes_v2(p_user_id,v_manifest.binding_id);
      end if;
    end if;
    if v_reason is null then
      v_result:=clued_private.context_pack_compile_v1(p_user_id,v_manifest.binding_id,v_manifest.policy_id,
        v_manifest.request,v_read_scopes);
      if v_result->>'status'<>'ok' then
        v_reason:=case when v_result->>'error_code'='CONTEXT_POLICY_REQUIRED'
            then 'policy_unusable:'||coalesce(v_result->>'reason','unknown')
          else lower(v_result->>'error_code')||coalesce(':'||(v_result->>'reason'),'') end;
      elsif v_result->>'compile_inputs_digest' is distinct from v_manifest.inputs_digest then
        v_reason:='inputs_changed';
      elsif v_result->>'pack_digest' is distinct from v_manifest.pack_digest then
        v_reason:='pack_changed';
      end if;
    end if;
    if v_reason is not null then
      update clued_private.context_pack_manifests set stale=true,stale_reason=left(v_reason,200),
          stale_at=clock_timestamp(),version=version+1
        where id=v_manifest.id and version=v_manifest.version and not stale;
      return jsonb_build_object('status','stale','revalidation','STALE','manifest_id',v_manifest.id,
        'reason',left(v_reason,200),'authoritative',false,'execution_authorization','NOT_GRANTED');
    end if;
    update clued_private.context_pack_manifests set last_revalidated_at=clock_timestamp() where id=v_manifest.id;
    return jsonb_build_object('status','ok','revalidation','VALID','manifest_id',v_manifest.id,
      'pack_digest',v_manifest.pack_digest,'authoritative',false,'execution_authorization','NOT_GRANTED');
  end if;

  v_policy_id:=nullif(p_input->>'policy_id','')::uuid;
  if p_binding_id is not null then
    v_read_scopes:=clued_private.binding_read_scopes_v2(p_user_id,p_binding_id);
  end if;
  v_result:=clued_private.context_pack_compile_v1(p_user_id,p_binding_id,v_policy_id,
    jsonb_build_object('scope',coalesce(nullif(p_input->>'scope',''),'global'))
      ||case when p_input ? 'task_class' then jsonb_build_object('task_class',p_input->>'task_class') else '{}'::jsonb end,
    v_read_scopes);
  if v_result->>'status'<>'ok' then return v_result; end if;
  -- Upsert the derived manifest; identical inputs must give identical bytes.
  insert into clued_private.context_pack_manifests(user_id,principal_kind,binding_id,policy_id,policy_digest,request,
    effective_scopes,inputs_digest,pack_digest,sources)
  values(p_user_id,v_principal,p_binding_id,(v_result->'_policy'->>'id')::uuid,v_result->'_policy'->>'digest',
    v_result->'_request',array(select jsonb_array_elements_text(v_result->'_scopes')),
    v_result->>'compile_inputs_digest',v_result->>'pack_digest',v_result->'_sources')
  on conflict (user_id,principal_kind,(coalesce(binding_id,'00000000-0000-0000-0000-000000000000'::uuid)),inputs_digest)
    where not stale do nothing
  returning id into v_id;
  if v_id is null then
    select * into v_manifest from clued_private.context_pack_manifests
      where user_id=p_user_id and principal_kind=v_principal
        and coalesce(binding_id,'00000000-0000-0000-0000-000000000000'::uuid)
          =coalesce(p_binding_id,'00000000-0000-0000-0000-000000000000'::uuid)
        and inputs_digest=v_result->>'compile_inputs_digest' and not stale
      for update;
    if v_manifest.pack_digest is distinct from v_result->>'pack_digest' then
      raise exception 'context_pack_nondeterministic' using errcode='XX000';
    end if;
    update clued_private.context_pack_manifests set last_compiled_at=clock_timestamp() where id=v_manifest.id;
    v_id:=v_manifest.id; v_reused:=true;
  end if;
  return (v_result-'_policy'-'_request'-'_scopes'-'_sources')||jsonb_build_object(
    'manifest',jsonb_build_object('id',v_id,'reused',v_reused,'stale',false),
    'measurement',jsonb_build_object('status','not_measured'));
end $$;

-- ---------------------------------------------------------------------------
-- Policy acceptance (Native two-step; receipt-core family context_policy_accept)
-- ---------------------------------------------------------------------------

-- The confirmation view: the normalized policy, its digest and the exact M1
-- Decision body the acceptance will write. Recomputed at consume time; any
-- drift makes the confirmed view stale. p_choices is the token's
-- native_choices {policy, rationale, create_record_id}.
create function clued_private.context_policy_view_v1(p_user_id uuid,p_choices jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_policy jsonb:=p_choices->'policy'; v_task_class text:=v_policy->>'task_class';
  v_active clued_private.context_policies%rowtype; v_decision public.clued_memories%rowtype;
  v_version integer; v_operation text; v_base bigint; v_id uuid; v_text text; v_digest text; v_body jsonb;
begin
  select * into v_active from clued_private.context_policies
    where user_id=p_user_id and task_class=v_task_class and status='active';
  v_version:=coalesce(v_active.policy_version,0)+1;
  if v_active.id is not null then
    select * into v_decision from public.clued_memories m
      where m.id=v_active.decision_record_id and m.user_id=p_user_id and m.record_schema_version is not null;
    if found and v_decision.record_type='decision' and v_decision.lifecycle_status='active'
      and v_decision.canonical_scope='global'
      and not exists(select 1 from public.clued_memories s where s.user_id=p_user_id and s.supersedes_id=v_decision.id) then
      v_operation:='update'; v_id:=v_decision.id; v_base:=v_decision.version;
    end if;
  end if;
  if v_operation is null then
    v_operation:='create'; v_id:=(p_choices->>'create_record_id')::uuid; v_base:=null;
  end if;
  v_text:=clued_private.context_canonical_json_v1(v_policy)||E'\n';
  v_digest:=clued_private.context_sha256_text_v1(v_text);
  v_body:=jsonb_build_object('operation',v_operation,'id',v_id,'record_type','decision','record_schema_version',1,
    'lifecycle_status','active','scope','global','authority','user_explicit','confidence',null,
    'confidence_reason','Native two-step Context Policy acceptance','source_refs','[]'::jsonb,
    'source_unavailable_reason','Context Policy acceptance; policy stored in clued_private.context_policies',
    'mutation',jsonb_build_object('title','Accept Context Policy '||v_task_class||' v'||v_version,'content',v_text,
      'type_fields',jsonb_build_object('rationale',p_choices->>'rationale','context_policy',jsonb_build_object(
        'schema','clued.context-policy.v1','task_class',v_task_class,'policy_version',v_version,'policy_digest',v_digest)),
      'relations','{}'::jsonb))
    ||case when v_operation='update' then jsonb_build_object('base_version',v_base) else '{}'::jsonb end;
  return jsonb_build_object('action','context_policy_accept','task_class',v_task_class,'policy_version',v_version,
    'policy',v_policy,'policy_digest',v_digest,'decision_operation',v_operation,'decision_base_version',v_base,
    'decision_body',v_body);
end $$;

create function clued_private.context_policy_lineage_lock_v1(p_user_id uuid,p_task_class text)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued-context-policy:'||p_user_id::text||':'||p_task_class,0));
end $$;

-- Step 1: issue a single-use token bound to user, action, task_class, lineage
-- version, session and the view digest. No Receipt: issuing is not a
-- Canonical write; the token row (hash only) is the audit.
create function clued_private.context_policy_confirmation_issue_core_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_policy jsonb; v_task_class text; v_active clued_private.context_policies%rowtype; v_base integer;
  v_choices jsonb; v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz;
  v_auth_time timestamptz:=clued_private.native_auth_time_v1(); v_now timestamptz; v_error text;
begin
  if v_auth_time is null or v_auth_time<clock_timestamp()-interval '15 minutes' then
    return jsonb_build_object('status','rejected','error_code','reauthentication_required','authoritative',false);
  end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('policy','rationale','base_policy_version')) then
      raise exception 'context_policy_confirmation_unknown_field' using errcode='22023';
    end if;
    if not clued_private.intake_is_str_v1(p_input->'rationale',1,2000) or btrim(p_input->>'rationale')='' then
      raise exception 'context_policy_rationale_required' using errcode='22023';
    end if;
    if not clued_private.context_policy_uint_v1(p_input->'base_policy_version',0,1000000000) then
      raise exception 'invalid_base_policy_version' using errcode='22023';
    end if;
    v_base:=(p_input->>'base_policy_version')::integer;
    v_policy:=clued_private.context_policy_normalize_v1(p_user_id,p_input->'policy');
    v_task_class:=v_policy->>'task_class';
    perform clued_private.context_policy_lineage_lock_v1(p_user_id,v_task_class);
    select * into v_active from clued_private.context_policies
      where user_id=p_user_id and task_class=v_task_class and status='active' for update;
    if coalesce(v_active.policy_version,0)<>v_base then
      raise exception 'context_policy_version_conflict' using errcode='40001';
    end if;
    v_choices:=jsonb_build_object('policy',v_policy,'rationale',p_input->>'rationale',
      'create_record_id',gen_random_uuid());
    v_view:=clued_private.context_policy_view_v1(p_user_id,v_choices);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=p_user_id and action='context_policy_accept' and subject_key=v_task_class
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_cpt_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(p_user_id,'context_policy_accept',v_task_class,v_base,v_choices,v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
      nullif(auth.jwt()->>'session_id',''),v_auth_time,v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,
      'expires_at',v_expires,'task_class',v_task_class,'base_policy_version',v_base,
      'policy_version',(v_view->>'policy_version')::integer,'policy_digest',v_view->>'policy_digest',
      'confirmation_view',v_view,'view_digest',v_digest,'decision_record_id',v_view->'decision_body'->>'id',
      'decision_operation',v_view->>'decision_operation','authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '40001' or sqlstate '42501'
      or sqlstate 'P0002' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2: consume the token, write the approving Decision through the M1
-- wrapper, mark it Native and store the policy row in one transaction.
create function clued_private.context_policy_accept_core_v1(
  p_user_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_task_class text:=p_input->>'task_class';
  v_base integer; v_token clued_private.native_confirmation_tokens%rowtype; v_token_id uuid;
  v_active clued_private.context_policies%rowtype; v_view jsonb; v_body jsonb; v_rec jsonb;
  v_record_id uuid; v_record_version bigint; v_record_receipt uuid; v_new_id uuid:=gen_random_uuid();
  v_refs jsonb; v_event_id text; v_result jsonb; v_error text; v_state text; v_code text; v_stale integer;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,null,'context_policy_accept',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then
    -- Single use also covers an idempotency rejection (S3 D4).
    if v_receipt.status='rejected' and v_receipt.error_code in ('IDEMPOTENCY_KEY_CONFLICT','REQUEST_HASH_MISMATCH')
        and jsonb_typeof(p_input->'confirmation_token')='string' then
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
          consumed_receipt_id=v_receipt.id,consume_outcome='rejected'
        where user_id=p_user_id and action='context_policy_accept'
          and token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
          and consumed_at is null and revoked_at is null;
    end if;
    return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
      ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null);
  end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in
        ('idempotency_key','request_hash','task_class','base_policy_version','confirmation_token','view_digest')) then
      raise exception 'context_policy_accept_unknown_field' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'task_class') is distinct from 'string'
      or v_task_class !~ '^[a-z0-9][a-z0-9._:-]{0,119}$'
      or not clued_private.context_policy_uint_v1(p_input->'base_policy_version',0,1000000000)
      or coalesce(p_input->>'view_digest','') !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid_context_policy_accept_input' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501';
    end if;
    v_base:=(p_input->>'base_policy_version')::integer;
    -- Lock order: currentness (entry) -> Receipt -> lineage -> token.
    perform clued_private.context_policy_lineage_lock_v1(p_user_id,v_task_class);
    select * into v_active from clued_private.context_policies
      where user_id=p_user_id and task_class=v_task_class and status='active' for update;
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=p_user_id
        and t.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
      for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then
      raise exception 'confirmation_token_same_request' using errcode='42501';
    end if;
    if v_token.action<>'context_policy_accept' or v_token.subject_key<>v_task_class
      or v_token.subject_version<>v_base or v_token.view_digest<>p_input->>'view_digest'
      or v_token.session_id is distinct from nullif(auth.jwt()->>'session_id','') then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501';
    end if;
    if not clued_private.native_session_fresh_v1() then
      raise exception 'reauthentication_required' using errcode='42501';
    end if;
    if coalesce(v_active.policy_version,0)<>v_base then
      raise exception 'context_policy_version_conflict' using errcode='40001';
    end if;
    -- Recompute the view from the token's stored choices: any drift in the
    -- lineage or the approving Decision makes the confirmed view stale.
    v_view:=clued_private.context_policy_view_v1(p_user_id,v_token.native_choices);
    if clued_private.m1_sha256(v_view)<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001';
    end if;
    v_body:=v_view->'decision_body';
    v_record_id:=(v_body->>'id')::uuid;
    -- The one Record write: the M1 wrapper, binding_id=null, user_explicit.
    v_rec:=clued_private.record_mutation_with_terminal_guard(p_user_id,null,
      v_body||jsonb_build_object('idempotency_key','context-policy-accept:'||v_receipt.id::text),
      clued_private.m1_sha256(jsonb_build_object('operation','record_mutation','payload',v_body)));
    if v_rec->>'status'='failed' then
      raise exception 'policy_decision_failed:%',coalesce(v_rec->>'error_code','unknown') using errcode='XX000';
    elsif v_rec->>'status' is distinct from 'committed' or coalesce((v_rec->>'replayed')::boolean,false) then
      v_code:=coalesce(v_rec->>'error_code','unknown');
      raise exception 'policy_decision_rejected:%',v_code
        using errcode=case when v_code ~ 'CONFLICT|VERSION' then '40001' else '22023' end;
    end if;
    v_record_version:=(v_rec->'committed_versions'->>v_record_id::text)::bigint;
    v_record_receipt:=(v_rec->>'receipt_id')::uuid;
    if v_record_version is null then raise exception 'policy_decision_version_missing' using errcode='XX000'; end if;
    perform clued_private.native_write_marker_v1(p_user_id,v_rec,'context_policy_accept');
    if v_active.id is not null then
      update clued_private.context_policies set status='superseded',superseded_by=v_new_id,
          superseded_at=clock_timestamp(),version=version+1
        where id=v_active.id and version=v_active.version;
      -- Policy version change (6.4; pulled forward from S5): every live
      -- manifest compiled under the retired version is stale.
      update clued_private.context_pack_manifests set stale=true,stale_reason='policy_version_changed',
          stale_at=clock_timestamp(),version=version+1
        where user_id=p_user_id and policy_id=v_active.id and not stale;
      get diagnostics v_stale=row_count;
    end if;
    insert into clued_private.context_policies(id,user_id,task_class,policy_version,schema_version,policy,policy_digest,
      decision_record_id,decision_version,decision_receipt_id,acceptance_receipt_id,token_id,accepted_session_id)
    values(v_new_id,p_user_id,v_task_class,(v_view->>'policy_version')::integer,'clued.context-policy.v1',
      v_view->'policy',v_view->>'policy_digest',v_record_id,v_record_version,v_record_receipt,v_receipt.id,v_token.id,
      nullif(auth.jwt()->>'session_id',''));
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
      consumed_receipt_id=v_receipt.id,consume_outcome='committed' where id=v_token.id;
    -- System refs only: Record refs on an audit Event could reach Currentness.
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id','context_policy:'||v_new_id::text));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,null,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:context_policy_accepted',v_refs,'global',null,
      jsonb_build_object('policy_id',v_new_id,'task_class',v_task_class,
        'policy_version',(v_view->>'policy_version')::integer,'policy_digest',v_view->>'policy_digest',
        'previous_policy_id',v_active.id,'decision_record_id',v_record_id,'decision_version',v_record_version,
        'decision_receipt_id',v_record_receipt,'token_id',v_token.id,'stale_manifests',coalesce(v_stale,0)),
      'context_policy_accept:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only',
      '{}','[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,
      jsonb_build_object('context_policy:'||v_task_class,v_base),
      jsonb_build_object('context_policy:'||v_task_class,(v_view->>'policy_version')::integer),
      array[v_event_id],'{}',null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object(
      'outcome','accepted','policy_id',v_new_id,'task_class',v_task_class,
      'policy_version',(v_view->>'policy_version')::integer,'policy_digest',v_view->>'policy_digest',
      'decision_record_id',v_record_id,'decision_version',v_record_version,'decision_receipt_id',v_record_receipt,
      'previous_policy_id',v_active.id,'stale_manifests',coalesce(v_stale,0)));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: any attempt that presented a live token burns it. The
    -- block's subtransaction has rolled back, so this update persists.
    if v_token_id is not null and v_error not in ('confirmation_token_reused','confirmation_token_revoked') then
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
        consumed_receipt_id=v_receipt.id,consume_outcome='rejected'
        where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','23514','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

revoke all on function clued_private.context_policy_guard_v1(),
  clued_private.context_pack_manifest_guard_v1(),
  clued_private.context_canonical_json_v1(jsonb),
  clued_private.context_sha256_text_v1(text),
  clued_private.context_digest_v1(jsonb),
  clued_private.context_policy_tokenizer_v1(),
  clued_private.context_policy_uint_v1(jsonb,integer,integer),
  clued_private.context_policy_set_v1(jsonb,text[],boolean),
  clued_private.context_scope_resolve_v1(uuid,text),
  clued_private.context_policy_normalize_v1(uuid,jsonb),
  clued_private.context_policy_usable_v1(uuid,uuid),
  clued_private.record_writer_principal_v1(uuid,uuid,bigint),
  clued_private.context_pack_read_lock_v1(uuid),
  clued_private.context_candidate_record_type_v1(text),
  clued_private.context_evidence_v1(uuid,uuid[]),
  clued_private.context_pack_rejection_v1(text,text),
  clued_private.context_pack_compile_v1(uuid,uuid,uuid,jsonb,text[]),
  clued_private.context_pack_core_v1(uuid,uuid,jsonb),
  clued_private.context_policy_view_v1(uuid,jsonb),
  clued_private.context_policy_lineage_lock_v1(uuid,text),
  clued_private.context_policy_confirmation_issue_core_v1(uuid,jsonb),
  clued_private.context_policy_accept_core_v1(uuid,jsonb,text)
  from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Entries
-- ---------------------------------------------------------------------------

-- The Binding pack entry gains the payload cap; CREATE OR REPLACE keeps the
-- anon-only grant.
create or replace function public.clued_context_pack(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',clued_private.intake_context_key_v1(p_input));
  perform clued_private.intake_payload_cap_v1(p_input);
  return clued_private.context_pack_core_v1(b.user_id,b.id,coalesce(p_input,'{}'::jsonb));
end $$;

create function public.clued_context_policy_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_context_policy_input' using errcode='22023';
  end if;
  -- Same lock order as acceptance: currentness -> lineage -> token.
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.context_policy_confirmation_issue_core_v1(v_owner,p_input);
end $$;

create function public.clued_context_policy_accept_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_context_policy_input' using errcode='22023';
  end if;
  -- First, as in the M1 wrapper: currentness -> receipt -> rows.
  perform clued_private.currentness_user_lock(v_owner);
  return clued_private.context_policy_accept_core_v1(v_owner,p_input,p_received_payload_hash);
end $$;

revoke all on function public.clued_context_policy_confirmation_issue_v1(jsonb),
  public.clued_context_policy_accept_v1(jsonb,text)
  from public,anon,service_role;
grant execute on function public.clued_context_policy_confirmation_issue_v1(jsonb),
  public.clued_context_policy_accept_v1(jsonb,text)
  to authenticated;

notify pgrst,'reload schema';
