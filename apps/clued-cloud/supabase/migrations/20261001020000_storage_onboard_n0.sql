-- StorageNormalUse.v0.1 N0: self-service onboarding (§8.1, §10 N0 row).
--
-- * clued_private.storage_onboard_attempts_v1: one row per page confirmation.
--   It holds the root choice (new folder or a folder picked with Google
--   Picker), the tracks, both pre-ticked options, the rendered disclosure and
--   its SHA-256, a reserved connection ID, the staged credential envelope (until
--   activation or expiry), the idempotent Drive directory effects and any
--   orphans. begin creates NO canonical row.
-- * storage_oauth_attempts_v1.connection_id becomes nullable; purpose='onboard'
--   attempts carry onboard_attempt_id and no connection
--   ((purpose='onboard') = (connection_id is null)).
-- * The outermost wrapper public.clued_storage_oauth_v1 (N1a) dispatches the
--   claim / complete of an onboard attempt to clued_private.storage_onboard_oauth_v1.
--   It never enters the 083521 / 145426 wrappers, so it repeats their final
--   session / issuer / expiry check and the one-shot claim itself (§8.1.9 item
--   2); the claim is counted in the refresh-token ledger (§2.4 item 8).
-- * public.clued_storage_onboard_v1(issuer secret, input): begin /
--   stage_credential / resume / effect_intent / effect_result / activate / fail /
--   status / list. activate creates, in ONE transaction, Project -> Decision
--   (user_explicit, user_confirmed) -> profile + root artifact -> track artifacts
--   -> cloud_runtime -> connection -> account policy (native_connection) -> read
--   access (normal/1 only when normal use was requested AND Google granted
--   normal, otherwise {read} text/1) -> default refresh delegation (same shape
--   as 145426). Each step has its own receipt and event; any failure raises and
--   rolls every step back.
-- * Gate (§2.5, Q9): until Google verification passes, only owners on
--   clued_private.storage_onboard_allowlist_v1 may begin; storage_oauth_apps_v1
--   .onboard_open is the operator switch after verification. Nothing is seeded.
-- * Host profile_register refuses the /clued-cloud/ managed-root prefix, which
--   only onboarding uses ('/clued-cloud/google-drive/<root_folder_id>').
-- * Profiles gain display_name (the Drive folder name shown on the page).

alter table clued_private.storage_oauth_apps_v1 add column onboard_open boolean not null default false;

create table clued_private.storage_onboard_allowlist_v1 (
  owner_id uuid primary key references auth.users(id),
  added_at timestamptz not null default clock_timestamp(),
  note text check (note is null or length(note) between 1 and 200)
);
alter table clued_private.storage_onboard_allowlist_v1 enable row level security;
revoke all on clued_private.storage_onboard_allowlist_v1 from public,anon,authenticated,service_role;

alter table clued_private.resource_center_profiles_v1 add column display_name text
  constraint resource_center_profiles_display_name_v1 check (display_name is null or length(display_name) between 1 and 120);

create table clued_private.storage_onboard_attempts_v1 (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  session_id uuid not null,
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  oauth_attempt_id uuid not null unique,
  connection_id uuid not null unique,
  root_mode text not null check (root_mode in ('new','picked')),
  root_name text not null check (length(root_name) between 1 and 120 and root_name=btrim(root_name) and root_name !~ '[\x01-\x1f\x7f]'),
  picked_folder_id text check (picked_folder_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  tracks jsonb not null check (jsonb_typeof(tracks)='array' and jsonb_array_length(tracks) between 1 and 32),
  normal_use_requested boolean not null,
  default_refresh_requested boolean not null,
  disclosure_version text not null check (disclosure_version='clued.storage-onboard-disclosure/1'),
  disclosure_text text not null check (length(disclosure_text) between 1 and 8000),
  disclosure_sha256 text not null check (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'begun' check (state in ('begun','credential_staged','completed','failed','expired')),
  provider_subject text check (provider_subject ~ '^[A-Za-z0-9_-]{1,255}$'),
  granted_scope_profile text check (granted_scope_profile in ('legacy','normal')),
  credential_envelope jsonb,
  effects jsonb not null default '{}'::jsonb check (jsonb_typeof(effects)='object'),
  orphans jsonb not null default '[]'::jsonb check (jsonb_typeof(orphans)='array'),
  failure_code text check (failure_code ~ '^[a-z_]{1,64}$'),
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((root_mode='picked')=(picked_folder_id is not null)),
  check (credential_envelope is null or state in ('credential_staged','failed')),
  check (state not in ('credential_staged','completed') or (provider_subject is not null and granted_scope_profile is not null)),
  check ((state='completed')=(result is not null))
);
create index storage_onboard_attempt_owner_v1 on clued_private.storage_onboard_attempts_v1(owner_id,state);
alter table clued_private.storage_onboard_attempts_v1 enable row level security;
revoke all on clued_private.storage_onboard_attempts_v1 from public,anon,authenticated,service_role;

alter table clued_private.storage_oauth_attempts_v1 alter column connection_id drop not null,
  add column onboard_attempt_id uuid references clued_private.storage_onboard_attempts_v1(id),
  drop constraint storage_oauth_purpose_v1,
  add constraint storage_oauth_purpose_v1 check (
    (purpose='connection' and recovery_job_id is null and recovery_binding is null and recovery_refresh_snapshot is null
      and onboard_attempt_id is null) or
    (purpose='credential_recovery' and recovery_job_id is not null and recovery_binding is not null
      and recovery_binding ~ '^[0-9a-f]{64}$' and recovery_refresh_snapshot is not null
      and jsonb_typeof(recovery_refresh_snapshot)='array' and not default_refresh_consent and onboard_attempt_id is null) or
    (purpose='onboard' and onboard_attempt_id is not null and recovery_job_id is null and recovery_binding is null
      and recovery_refresh_snapshot is null and not default_refresh_consent and not auto_settle_original)),
  add constraint storage_oauth_onboard_connection_v1 check ((purpose='onboard')=(connection_id is null));
create unique index storage_oauth_onboard_attempt_v1 on clued_private.storage_oauth_attempts_v1(onboard_attempt_id) where onboard_attempt_id is not null;

-- The 145426 default-refresh eligibility predicate (`:77-82`), verbatim, for the
-- N0 activation (the 145426 wrapper itself is not changed). Equivalence with
-- the wrapper's describe answer is a database test.
create function clued_private.storage_default_refresh_eligible_v1(p_owner uuid,p_connection uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; root text;
begin
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner;
  select p.root_folder_id into root from clued_private.resource_center_profiles_v1 p where p.id=c.profile_id and p.user_id=p_owner;
  if c.id is null or root is null then return false; end if;
  return c.state='awaiting_provider' and c.credential_version=0 and not exists (
    select 1 from clued_private.storage_connections_v1 history
      join clued_private.resource_center_profiles_v1 hp on hp.id=history.profile_id
      left join clued_private.storage_refresh_delegations_v1 d on d.connection_id=history.id
      where history.owner_id=p_owner and hp.root_folder_id=root and history.provider=c.provider
        and (history.refresh_default_blocked or history.revoked_at is not null or history.state<>'awaiting_provider'
          or history.credential_version>0 or d.connection_id is not null));
end $$;

-- Expired attempts lose their staged credential; created directories stay
-- recorded as orphans (the token is already counted as a possible orphan).
create function clued_private.storage_onboard_expire_v1(p_owner uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update clued_private.storage_onboard_attempts_v1 o set state='expired',credential_envelope=null,updated_at=clock_timestamp(),
    orphans=case when o.state='failed' then o.orphans else coalesce((select jsonb_agg(jsonb_build_object('role',e.key,
      'provider_file_id',e.value->>'provider_file_id','recorded_at',coalesce(e.value->>'result_at',e.value->>'intent_at')) order by e.key)
      from jsonb_each(o.effects) e where coalesce((e.value->>'created')::boolean,true) and (e.value ? 'intent_at')),'[]'::jsonb) end
    where o.owner_id=p_owner and o.state in ('begun','credential_staged','failed') and o.expires_at<=clock_timestamp();
end $$;

-- Track names: the 104436 qualification rule.
create function clued_private.storage_onboard_tracks_valid_v1(p_tracks jsonb) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_tracks)='array' and jsonb_array_length(p_tracks) between 1 and 32
    and not exists(select 1 from jsonb_array_elements(p_tracks) x where jsonb_typeof(x) is distinct from 'string'
      or length(x#>>'{}') not between 1 and 160 or (x#>>'{}') ~ '[/\\]' or (x#>>'{}') ~ '[\x01-\x1f\x7f]' or (x#>>'{}') in ('.','..','00_从这里开始')
      or btrim(x#>>'{}')<>(x#>>'{}'))
    and (select count(distinct x) from jsonb_array_elements(p_tracks) x)=jsonb_array_length(p_tracks),false)
$$;

create function clued_private.storage_onboard_active_roots_v1(p_owner uuid,p_subject text) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(distinct p.root_folder_id),'[]'::jsonb)
  from clued_private.resource_center_profiles_v1 p
  where p.user_id=p_owner and p.state='active' and (p_subject is null or exists(select 1 from clued_private.storage_connections_v1 c
    where c.profile_id=p.id and c.owner_id=p_owner and c.revoked_at is null and c.provider_subject=p_subject))
$$;

-- Public descriptor of an attempt for the Worker (never the envelope).
create function clued_private.storage_onboard_view_v1(o clued_private.storage_onboard_attempts_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('onboard_attempt_id',o.id,'connection_id',o.connection_id,'state',o.state,
    'root',jsonb_strip_nulls(jsonb_build_object('mode',o.root_mode,'name',o.root_name,'folder_id',o.picked_folder_id)),
    'tracks',o.tracks,'normal_use_requested',o.normal_use_requested,'default_refresh_requested',o.default_refresh_requested,
    'requested_scope_profile',case when o.normal_use_requested then 'normal' else 'legacy' end,
    'granted_scope_profile',o.granted_scope_profile,'effects',o.effects,'orphans',o.orphans,'failure_code',o.failure_code,
    'expires_at',o.expires_at,'execution_permitted',false)
$$;

-- claim / complete (= stage the credential) of an onboard OAuth attempt.
-- Reached only from the outermost wrapper and public.clued_storage_onboard_v1.
create function clued_private.storage_onboard_oauth_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  a clued_private.storage_oauth_apps_v1; x clued_private.storage_oauth_attempts_v1; o clued_private.storage_onboard_attempts_v1;
  requested text; result jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('claim','complete')
    or coalesce(p_input->>'state_hash','') !~ '^[0-9a-f]{64}$' then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  select * into a from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash' and owner_id=u
    and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=a.issuer_hash and purpose='onboard';
  if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  -- Lock order: onboard row -> OAuth attempt.
  select * into o from clued_private.storage_onboard_attempts_v1 where id=x.onboard_attempt_id and owner_id=u for update;
  select * into x from clued_private.storage_oauth_attempts_v1 where id=x.id for update;
  if o.id is null or o.oauth_attempt_id<>x.id or o.session_id<>x.session_id or o.issuer_hash<>x.issuer_hash then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  requested:=case when o.normal_use_requested then 'normal' else 'legacy' end;
  if op='claim' then
    if p_input<>jsonb_build_object('action','claim','state_hash',x.state_hash) then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    if o.state='completed' then
      -- A replay after a lost reply reads the committed result only.
      result:=o.result||jsonb_build_object('status','completed','purpose','onboard');
    elsif x.status='prepared' and o.state='begun' and x.expires_at>clock_timestamp() and o.expires_at>clock_timestamp() then
      -- One-shot claim; the trigger counts it before any token exchange.
      update clued_private.storage_oauth_attempts_v1 set status='claimed' where id=x.id;
      result:=jsonb_build_object('status','claimed','purpose','onboard','attempt_id',x.id,'verifier_envelope',x.verifier_envelope,
        'owner_id',u,'connection_id',o.connection_id,'credential_version',1,'provider_subject',null,
        'oauth_client_id',a.oauth_client_id,'redirect_uri',a.redirect_uri,'requested_scope_profile',requested,
        'onboard_attempt_id',o.id);
    else raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  else
    if x.status<>'claimed' or o.state<>'begun' or x.expires_at<=clock_timestamp() or o.expires_at<=clock_timestamp()
      or (p_input-array['action','state_hash','credential_envelope','provider_subject','provider_scope_profile'])<>'{}'::jsonb
      or coalesce(p_input->>'provider_subject','') !~ '^[A-Za-z0-9_-]{1,255}$'
      or p_input->>'provider_scope_profile' is null or p_input->>'provider_scope_profile' not in (requested,'legacy')
      or not clued_private.storage_envelope_valid_v1(p_input->'credential_envelope') then
      raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    update clued_private.storage_onboard_attempts_v1 set state='credential_staged',provider_subject=p_input->>'provider_subject',
      granted_scope_profile=p_input->>'provider_scope_profile',credential_envelope=p_input->'credential_envelope',updated_at=clock_timestamp()
      where id=o.id returning * into o;
    update clued_private.storage_refresh_token_issuance_v1 set provider_subject=o.provider_subject
      where oauth_attempt_id=x.id and provider_subject is null;
    result:=clued_private.storage_onboard_view_v1(o)||jsonb_build_object('status','credential_staged','purpose','onboard',
      'active_roots',clued_private.storage_onboard_active_roots_v1(u,null));
  end if;
  -- §8.1.9 item 2: lock waits can cross session, issuer or attempt expiry.
  perform clued_private.storage_owner_v1();
  if o.state<>'completed' and not exists(select 1 from clued_private.storage_oauth_attempts_v1 x0
      join clued_private.storage_oauth_apps_v1 a0 on a0.issuer_hash=x0.issuer_hash and a0.revoked_at is null
    where x0.id=x.id and x0.state_hash=p_input->>'state_hash' and x0.owner_id=u and x0.session_id=(auth.jwt()->>'session_id')::uuid
      and x0.issuer_hash=p_issuer_hash and x0.expires_at>clock_timestamp()) then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  return result;
end $$;

create function clued_private.storage_onboard_receipt_v1(p_owner uuid,p_operation text,p_req jsonb) returns public.clued_audit_receipts
language plpgsql security definer set search_path='' as $$
declare r public.clued_audit_receipts;
begin
  r:=clued_private.m1_begin_receipt(p_owner,null,p_operation,p_req,clued_private.m1_sha256(p_req));
  if r.status<>'pending' then raise exception 'storage_onboard_activation_conflict' using errcode='40001'; end if;
  return r;
end $$;

create function clued_private.storage_onboard_finish_v1(p_owner uuid,p_r public.clued_audit_receipts,p_project uuid,p_event text,
  p_target uuid,p_summary jsonb,p_base jsonb,p_committed jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare refs jsonb:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',p_target)); ev text; result jsonb;
begin
  ev:=clued_private.m1_append_event_row(p_owner,null,p_r.id,p_r.canonical_version,p_event,refs,'project:'||p_project::text,null,
    p_summary,p_r.idempotency_key,p_r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(p_r.id,'committed',refs,p_base,p_committed,array[ev],'{}'::uuid[],null);
  if result->>'status' is distinct from 'committed' then raise exception 'storage_onboard_activation_failed' using errcode='40001'; end if;
  return result;
end $$;

-- §8.1 step 6. The caller holds the onboard row FOR UPDATE and has checked
-- session, issuer, expiry, state and effects.
create function clued_private.storage_onboard_activate_v1(p_owner uuid,o clued_private.storage_onboard_attempts_v1,
  a clued_private.storage_oauth_apps_v1,p_ancestors jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=p_owner; root text:=o.effects->'root'->>'provider_file_id'; parent text:=o.effects->'root'->'parents'->>0;
  root_version text:=o.effects->'root'->>'version'; tracks jsonb:=o.tracks; track text; tid text; tversion text;
  project uuid:=gen_random_uuid(); decision uuid:=gen_random_uuid(); input jsonb; outcome jsonb; dv bigint;
  p clued_private.resource_center_profiles_v1; c clued_private.storage_connections_v1;
  policy clued_private.storage_account_policies_v2; r public.clued_audit_receipts; consent public.clued_audit_receipts;
  connection_receipt uuid; managed text; digest text; eligible boolean; normal boolean; runtime jsonb; result jsonb;
  read_result jsonb; refresh_receipt uuid; details text; key text:=o.id::text; done jsonb;
begin
  managed:='/clued-cloud/google-drive/'||root;
  -- 1. Project (current entry, native Owner: no Binding).
  input:=jsonb_build_object('operation','create','project_schema_version',2,'canonical_project_id',project,
    'idempotency_key','storage-onboard-project:'||key,
    'mutation',jsonb_build_object('name',left('Clued 资料中心：'||o.root_name,120),
      'summary','Google Drive 资料根「'||o.root_name||'」，由存储连接页自助接入创建。'));
  outcome:=clued_private.project_mutation_core_v2(u,null,input,clued_private.m1_sha256(input));
  if outcome->>'status' is distinct from 'committed' then
    raise exception 'storage_onboard_project_failed' using errcode='40001'; end if;
  -- 2. Decision: the page click is user_confirmed (§8.1 step 1).
  details:=E'\n\n根目录：'||o.root_name||'（Google Drive ID '||root||E'）\n子目录：'||
    (select string_agg(x,'、' order by n) from jsonb_array_elements_text(tracks) with ordinality t(x,n))||
    E'\n正常使用：'||case when o.normal_use_requested then '勾选' else '未勾选' end||
    E'\n后台自动续期授权：'||case when o.default_refresh_requested then '勾选' else '未勾选' end;
  input:=jsonb_build_object('operation','create','id',decision,'scope','project:'||project,'record_type','decision',
    'record_schema_version',1,'authority','user_explicit','user_confirmed',true,
    'confidence_reason','The Owner confirmed the storage onboarding disclosure on the native connection page.',
    'source_refs','[]'::jsonb,'source_unavailable_reason','Native Owner confirmation on the Clued storage connection page.',
    'idempotency_key','storage-onboard-decision:'||key,
    'mutation',jsonb_build_object('title',left('使用 Google Drive「'||o.root_name||'」作为 Clued 资料根',200),
      'content',o.disclosure_text||details,
      'type_fields',jsonb_build_object('rationale','Owner self-service storage onboarding (StorageNormalUse §8.1).',
        'onboard_attempt_id',o.id,'disclosure_version',o.disclosure_version,'disclosure_sha256',o.disclosure_sha256,
        'root_folder_id',root,'root_name',o.root_name,'root_mode',o.root_mode,'tracks',tracks,
        'normal_use_requested',o.normal_use_requested,'default_refresh_requested',o.default_refresh_requested)));
  outcome:=clued_private.record_mutation_with_terminal_guard(u,null,input,clued_private.m1_sha256(input));
  if outcome->>'status' is distinct from 'committed' then
    raise exception 'storage_onboard_decision_failed' using errcode='40001'; end if;
  perform clued_private.native_write_marker_v1(u,outcome,'storage_onboard');
  select version into dv from public.clued_memories where id=decision and user_id=u for share;
  if dv is null or not clued_private.resource_center_decision_current_v1(u,project,decision) then
    raise exception 'storage_onboard_decision_failed' using errcode='40001'; end if;
  -- 3. Profile and root artifact (134500:140-151 shape).
  r:=clued_private.storage_onboard_receipt_v1(u,'storage_onboard_profile',jsonb_build_object('idempotency_key','storage-onboard-profile:'||key,
    'onboard_attempt_id',o.id,'project_id',project,'decision_id',decision,'root_folder_id',root,'root_parent_id',parent));
  insert into clued_private.resource_center_profiles_v1(user_id,project_id,profile_version,policy_version,managed_root,
    root_folder_id,root_parent_id,source_decision_id,receipt_id,display_name)
  values(u,project,'clued.storage-onboard/1','clued.resource-center-mutation-policy/1',managed,root,parent,decision,r.id,o.root_name)
  returning * into p;
  insert into clued_private.resource_center_artifacts_v1(user_id,profile_id,path,provider_file_id,provider_file_version,
    target_kind,governance_class,delete_authority,source_decision_id,receipt_id)
  values(u,p.id,managed,root,root_version,'directory','governance',false,decision,r.id);
  perform clued_private.storage_onboard_finish_v1(u,r,project,'extension:storage:onboard_profile',p.id,
    jsonb_build_object('onboard_attempt_id',o.id,'profile_id',p.id,'managed_root',managed),'{}'::jsonb,jsonb_build_object(p.id::text,p.version));
  -- 4. Track artifacts.
  r:=clued_private.storage_onboard_receipt_v1(u,'storage_onboard_tracks',jsonb_build_object('idempotency_key','storage-onboard-tracks:'||key,
    'onboard_attempt_id',o.id,'profile_id',p.id,'tracks',tracks));
  for track in select x from jsonb_array_elements_text(tracks) x loop
    tid:=o.effects->('track:'||track)->>'provider_file_id'; tversion:=o.effects->('track:'||track)->>'version';
    insert into clued_private.resource_center_artifacts_v1(user_id,profile_id,path,provider_file_id,provider_file_version,
      target_kind,governance_class,delete_authority,source_decision_id,receipt_id)
    values(u,p.id,managed||'/'||track,tid,tversion,'directory','ordinary',false,decision,r.id);
  end loop;
  perform clued_private.storage_onboard_finish_v1(u,r,project,'extension:storage:onboard_tracks',p.id,
    jsonb_build_object('onboard_attempt_id',o.id,'profile_id',p.id,'track_count',jsonb_array_length(tracks)),'{}'::jsonb,'{}'::jsonb);
  -- 5. cloud_runtime (104436:38-54 checks: every track is a registered directory).
  if not clued_private.storage_onboard_tracks_valid_v1(tracks) or exists(select 1 from jsonb_array_elements_text(tracks) x
      where not exists(select 1 from clued_private.resource_center_artifacts_v1 ar where ar.profile_id=p.id and ar.user_id=u
        and ar.path=managed||'/'||x and ar.state='active' and ar.target_kind='directory')) then
    raise exception 'storage_cloud_tracks_unregistered' using errcode='42501'; end if;
  r:=clued_private.storage_onboard_receipt_v1(u,'storage_onboard_cloud_runtime',jsonb_build_object('idempotency_key','storage-onboard-runtime:'||key,
    'onboard_attempt_id',o.id,'profile_id',p.id,'allowed_root_children',tracks));
  runtime:=jsonb_build_object('contract','clued.storage-cloud-runtime/1','profile_version',p.version,
    'allowed_root_children',tracks,'source_decision_id',decision,'decision_version',dv);
  update clued_private.resource_center_profiles_v1 set cloud_runtime=runtime||jsonb_build_object('receipt_id',r.id) where id=p.id returning * into p;
  perform clued_private.storage_onboard_finish_v1(u,r,project,'extension:storage:cloud_qualified',p.id,
    jsonb_build_object('profile_id',p.id,'runtime_digest',clued_private.m1_sha256(runtime),'onboard_attempt_id',o.id),'{}'::jsonb,'{}'::jsonb);
  -- 6. Connection: reserved ID, awaiting_provider, eligibility, then active.
  r:=clued_private.storage_onboard_receipt_v1(u,'storage_onboard_connection',jsonb_build_object('idempotency_key','storage-onboard-connection:'||key,
    'onboard_attempt_id',o.id,'connection_id',o.connection_id,'profile_id',p.id,'credential_version',1,
    'provider_scope_profile',o.granted_scope_profile,'credential_digest',clued_private.m1_sha256(o.credential_envelope)));
  connection_receipt:=r.id;
  insert into clued_private.storage_connections_v1(id,owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,receipt_id)
    values(o.connection_id,u,p.id,p.version,decision,dv,'google-drive',r.id);
  eligible:=clued_private.storage_default_refresh_eligible_v1(u,o.connection_id);
  update clued_private.storage_connections_v1 set state='active',provider_subject=o.provider_subject,oauth_client_id=a.oauth_client_id,
    credential_version=1,credential_envelope=o.credential_envelope,provider_scope_profile=o.granted_scope_profile,version=version+1
    where id=o.connection_id returning * into c;
  perform clued_private.storage_onboard_finish_v1(u,r,project,'extension:storage:oauth_activate',c.id,
    jsonb_build_object('connection_id',c.id,'credential_version',c.credential_version,'onboard_attempt_id',o.id,
      'provider_scope_profile',c.provider_scope_profile),'{}'::jsonb,jsonb_build_object(c.id::text,c.version));
  -- 7. Account policy (native_connection): consent receipt, then activation.
  digest:=clued_private.storage_policy_scope_digest_v2(c.id);
  if digest is null then raise exception 'storage_onboard_scope_digest_unavailable' using errcode='42501'; end if;
  consent:=clued_private.storage_onboard_receipt_v1(u,'storage_onboard_consent',jsonb_build_object('idempotency_key','storage-onboard-consent:'||key,
    'onboard_attempt_id',o.id,'connection_id',c.id,'decision_id',decision,'disclosure_version',o.disclosure_version,
    'disclosure_sha256',o.disclosure_sha256,'scope_digest',digest));
  perform clued_private.storage_onboard_finish_v1(u,consent,project,'extension:storage:onboard_consent',c.id,
    jsonb_build_object('onboard_attempt_id',o.id,'disclosure_version',o.disclosure_version,'disclosure_sha256',o.disclosure_sha256),
    '{}'::jsonb,'{}'::jsonb);
  r:=clued_private.storage_onboard_receipt_v1(u,'storage_onboard_policy',jsonb_build_object('idempotency_key','storage-onboard-policy:'||key,
    'onboard_attempt_id',o.id,'connection_id',c.id,'scope_digest',digest,'consent_receipt_id',consent.id));
  insert into clued_private.storage_account_policies_v2(owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
    scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,
    activation_receipt_id,state)
  values(u,c.id,c.provider,c.provider_subject,root,p.id,digest,1,decision,dv,'native_connection',o.disclosure_version,consent.id,r.id,'active')
  returning * into policy;
  update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=policy.id,auth_generation=auth_generation+1
    where id=c.id returning * into c;
  perform clued_private.storage_onboard_finish_v1(u,r,project,'extension:storage:onboard_policy',c.id,
    jsonb_build_object('onboard_attempt_id',o.id,'policy_id',policy.id,'policy_generation',1,'auth_generation',c.auth_generation),
    '{}'::jsonb,jsonb_build_object(policy.id::text,1));
  -- 8. Read access: normal/1 only if requested AND granted (m-c); else {read} text/1.
  normal:=o.normal_use_requested and o.granted_scope_profile='normal' and c.provider_scope_profile='normal';
  r:=clued_private.storage_onboard_receipt_v1(u,'storage_normal_use_v1',jsonb_build_object('idempotency_key','storage-onboard-read:'||key,
    'action',case when normal then 'enable' else 'read' end,'connection_id',c.id,'onboard_attempt_id',o.id,
    'disclosure_version',case when normal then 'clued.storage-normal-use-disclosure/1' else 'clued.storage-read-disclosure/1' end,'base_generation',0));
  read_result:=clued_private.storage_normal_use_write_v1(u,c.id,policy.id,project,normal,
    case when normal then 'clued.storage-normal-use-disclosure/1' end,r,r.idempotency_key,'onboard');
  -- 9. Default refresh delegation, 145426:101-119 shape.
  if o.default_refresh_requested and eligible then
    r:=clued_private.storage_onboard_receipt_v1(u,'storage_default_refresh',jsonb_build_object('idempotency_key','oauth-default-refresh:'||o.oauth_attempt_id::text,
      'connection_id',c.id,'oauth_attempt_id',o.oauth_attempt_id,'oauth_receipt_id',connection_receipt,
      'session_id',o.session_id,'issuer_hash',a.issuer_hash,'until_revoked',true));
    insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id)
      values(c.id,a.issuer_hash,true,r.id);
    perform clued_private.storage_onboard_finish_v1(u,r,project,'extension:storage:default_refresh_enable',c.id,
      jsonb_build_object('connection_id',c.id,'oauth_attempt_id',o.oauth_attempt_id,'oauth_receipt_id',connection_receipt,'until_revoked',true),
      '{}'::jsonb,'{}'::jsonb);
    refresh_receipt:=r.id;
  end if;
  -- 10. Drop the staged envelope; attempt and OAuth attempt complete.
  done:=jsonb_build_object('status','completed','purpose','onboard','onboard_attempt_id',o.id,'receipt_id',connection_receipt,
    'connection_id',c.id,'project_id',project,'decision_id',decision,'profile_id',p.id,'policy_id',policy.id,
    'provider_scope_profile',c.provider_scope_profile,'requested_scope_profile',case when o.normal_use_requested then 'normal' else 'legacy' end,
    'content_profile',case when normal then 'normal/1' else 'text/1' end,'normal_use_enabled',normal,
    'read_receipt_id',read_result->>'receipt_id','refresh_enabled',refresh_receipt is not null,
    'refresh_eligible',eligible,'refresh_receipt_id',refresh_receipt,'execution_permitted',false);
  update clued_private.storage_onboard_attempts_v1 set state='completed',credential_envelope=null,result=done,updated_at=clock_timestamp()
    where id=o.id;
  update clued_private.storage_oauth_attempts_v1 set status='completed',receipt_id=connection_receipt where id=o.oauth_attempt_id;
  update clued_private.storage_refresh_token_issuance_v1 set connection_id=c.id,provider_subject=coalesce(provider_subject,c.provider_subject)
    where oauth_attempt_id=o.oauth_attempt_id;
  return done;
end $$;

create function public.clued_storage_onboard_v1(p_issuer_secret text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action'; issuer text;
  a clued_private.storage_oauth_apps_v1; o clued_private.storage_onboard_attempts_v1; result jsonb;
  role text; effect jsonb; root text; track text; ancestors jsonb; tokens integer;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  id_re constant text:='^[A-Za-z0-9_-]{1,160}$';
begin
  if coalesce(length(p_issuer_secret),0)<32 or jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(op,'') not in ('begin','stage_credential','resume','effect_intent','effect_result','activate','fail','status','list') then
    raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  issuer:=encode(sha256(convert_to(p_issuer_secret,'UTF8')),'hex');
  select * into a from clued_private.storage_oauth_apps_v1 where issuer_hash=issuer and revoked_at is null for share;
  if not found then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  perform clued_private.storage_onboard_expire_v1(u);
  if op='list' then
    if p_input<>jsonb_build_object('action','list') then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
    return jsonb_build_object('attempts',coalesce((select jsonb_agg(clued_private.storage_onboard_view_v1(x) order by x.created_at desc)
      from (select * from clued_private.storage_onboard_attempts_v1 where owner_id=u and (state<>'completed' or orphans<>'[]'::jsonb)
        order by created_at desc limit 20) x),'[]'::jsonb),
      'allowed',exists(select 1 from clued_private.storage_onboard_allowlist_v1 where owner_id=u) or a.onboard_open,
      'refresh_token_count',clued_private.storage_refresh_token_count_v1(u,null,a.oauth_client_id));
  end if;
  if op='stage_credential' then
    return clued_private.storage_onboard_oauth_v1(issuer,(p_input-'action')||jsonb_build_object('action','complete'));
  end if;
  if op='begin' then
    if (p_input-array['action','owner_id','onboard_attempt_id','oauth_attempt_id','connection_id','state_hash','verifier_envelope',
          'root','tracks','normal_use_requested','default_refresh_requested','disclosure_version','disclosure_text','disclosure_sha256'])<>'{}'::jsonb
      or not (p_input ?& array['owner_id','onboard_attempt_id','oauth_attempt_id','connection_id','state_hash','verifier_envelope',
          'root','tracks','normal_use_requested','default_refresh_requested','disclosure_version','disclosure_text','disclosure_sha256'])
      or p_input->>'owner_id' is distinct from u::text
      or coalesce(p_input->>'onboard_attempt_id','') !~ uuid_re or coalesce(p_input->>'oauth_attempt_id','') !~ uuid_re
      or coalesce(p_input->>'connection_id','') !~ uuid_re
      or coalesce(p_input->>'state_hash','') !~ '^[0-9a-f]{64}$' or not clued_private.storage_envelope_valid_v1(p_input->'verifier_envelope')
      or jsonb_typeof(p_input->'root') is distinct from 'object' or jsonb_typeof(p_input->'root'->'name') is distinct from 'string'
      or not ((p_input->'root'->>'mode'='new' and ((p_input->'root')-array['mode','name'])='{}'::jsonb)
        or (p_input->'root'->>'mode'='picked' and ((p_input->'root')-array['mode','name','folder_id'])='{}'::jsonb
          and coalesce(p_input->'root'->>'folder_id','') ~ id_re))
      or not clued_private.storage_onboard_tracks_valid_v1(p_input->'tracks')
      or jsonb_typeof(p_input->'normal_use_requested') is distinct from 'boolean'
      or jsonb_typeof(p_input->'default_refresh_requested') is distinct from 'boolean'
      or jsonb_typeof(p_input->'disclosure_text') is distinct from 'string' then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    if p_input->>'disclosure_version' is distinct from 'clued.storage-onboard-disclosure/1' then
      raise exception 'storage_onboard_disclosure_changed' using errcode='40001'; end if;
    if p_input->>'disclosure_sha256' is distinct from encode(sha256(convert_to(p_input->>'disclosure_text','UTF8')),'hex')
      or strpos(p_input->>'disclosure_text','「'||(p_input->'root'->>'name')||'」')=0 then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    -- §2.5 / Q9: Google verification is the gate for everyone else.
    if not (a.onboard_open or exists(select 1 from clued_private.storage_onboard_allowlist_v1 where owner_id=u)) then
      raise exception 'storage_onboard_not_allowed' using errcode='42501'; end if;
    if not (a.execution_enabled and a.read_enabled) then raise exception 'storage_onboard_unavailable' using errcode='42501'; end if;
    -- §2.4 item 8 (b): the Google account is unknown yet, so every claim of
    -- this owner and client counts (conservative).
    tokens:=clued_private.storage_refresh_token_count_v1(u,null,a.oauth_client_id);
    if tokens>=90 then raise exception 'storage_refresh_token_limit' using errcode='42501'; end if;
    if p_input->'root'->>'mode'='picked' and (p_input->'root'->>'folder_id') in
        (select x from jsonb_array_elements_text(clued_private.storage_onboard_active_roots_v1(u,null)) x) then
      raise exception 'storage_onboard_root_overlaps_existing' using errcode='42501'; end if;
    if exists(select 1 from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid) then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    insert into clued_private.storage_onboard_attempts_v1(id,owner_id,session_id,issuer_hash,oauth_attempt_id,connection_id,root_mode,root_name,
      picked_folder_id,tracks,normal_use_requested,default_refresh_requested,disclosure_version,disclosure_text,disclosure_sha256,expires_at)
    values((p_input->>'onboard_attempt_id')::uuid,u,(auth.jwt()->>'session_id')::uuid,issuer,(p_input->>'oauth_attempt_id')::uuid,
      (p_input->>'connection_id')::uuid,p_input->'root'->>'mode',p_input->'root'->>'name',p_input->'root'->>'folder_id',p_input->'tracks',
      (p_input->>'normal_use_requested')::boolean,(p_input->>'default_refresh_requested')::boolean,p_input->>'disclosure_version',
      p_input->>'disclosure_text',p_input->>'disclosure_sha256',clock_timestamp()+interval '30 minutes')
    returning * into o;
    insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,state_hash,
      verifier_envelope,expires_at,purpose,onboard_attempt_id)
    values(o.oauth_attempt_id,null,u,o.session_id,issuer,0,p_input->>'state_hash',p_input->'verifier_envelope',o.expires_at,'onboard',o.id);
    perform clued_private.storage_owner_v1();
    return clued_private.storage_onboard_view_v1(o)||jsonb_build_object('status','begun','owner_id',u,
      'oauth_client_id',a.oauth_client_id,'redirect_uri',a.redirect_uri,'refresh_token_count',tokens,'refresh_token_warning',tokens>=50);
  end if;
  if coalesce(p_input->>'onboard_attempt_id','') !~ uuid_re then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  select * into o from clued_private.storage_onboard_attempts_v1 where id=(p_input->>'onboard_attempt_id')::uuid and owner_id=u for update;
  if not found then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  if op='status' then
    if (p_input-array['action','onboard_attempt_id'])<>'{}'::jsonb then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
    return clued_private.storage_onboard_view_v1(o)||coalesce(o.result,'{}'::jsonb)||jsonb_build_object('state',o.state);
  end if;
  -- Every other action: the Worker of the SAME native session that began it.
  if o.session_id is distinct from (auth.jwt()->>'session_id')::uuid or o.issuer_hash<>issuer then
    raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  if op='fail' then
    if (p_input-array['action','onboard_attempt_id','code'])<>'{}'::jsonb or coalesce(p_input->>'code','') !~ '^[a-z_]{1,64}$' then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    if o.state in ('completed','expired') then return clued_private.storage_onboard_view_v1(o); end if;
    -- Clued never deletes or trashes: every created object is an orphan.
    update clued_private.storage_onboard_attempts_v1 set state='failed',failure_code=p_input->>'code',updated_at=clock_timestamp(),
      orphans=coalesce((select jsonb_agg(jsonb_build_object('role',e.key,'provider_file_id',e.value->>'provider_file_id',
        'recorded_at',coalesce(e.value->>'result_at',e.value->>'intent_at')) order by e.key)
        from jsonb_each(o.effects) e where coalesce((e.value->>'created')::boolean,true) and (e.value ? 'intent_at')),'[]'::jsonb)
      where id=o.id returning * into o;
    return clued_private.storage_onboard_view_v1(o);
  end if;
  if o.expires_at<=clock_timestamp() then raise exception 'storage_onboard_expired' using errcode='42501'; end if;
  if op='resume' then
    -- Retry within 30 minutes reuses the staged credential and every effect.
    if (p_input-array['action','onboard_attempt_id'])<>'{}'::jsonb or o.state not in ('credential_staged','failed')
      or o.credential_envelope is null then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
    update clued_private.storage_onboard_attempts_v1 set state='credential_staged',failure_code=null,orphans='[]'::jsonb,updated_at=clock_timestamp()
      where id=o.id returning * into o;
    return clued_private.storage_onboard_view_v1(o)||jsonb_build_object('status','credential_staged','purpose','onboard',
      'owner_id',u,'provider_subject',o.provider_subject,'oauth_client_id',a.oauth_client_id,'credential_version',1,
      'credential_envelope',o.credential_envelope,'active_roots',clued_private.storage_onboard_active_roots_v1(u,null));
  end if;
  if o.state<>'credential_staged' then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  role:=p_input->>'role';
  if op in ('effect_intent','effect_result') then
    if coalesce(role,'') not in (select 'root' union all select 'track:'||x from jsonb_array_elements_text(o.tracks) x) then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    effect:=o.effects->role;
  end if;
  if op='effect_intent' then
    if (p_input-array['action','onboard_attempt_id','role'])<>'{}'::jsonb or (role='root' and o.root_mode='picked')
      or (role<>'root' and not coalesce(o.effects->'root' ? 'provider_file_id',false)) then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    if effect is null then
      update clued_private.storage_onboard_attempts_v1 set effects=effects||jsonb_build_object(role,jsonb_build_object('intent_at',clock_timestamp())),
        updated_at=clock_timestamp() where id=o.id returning * into o;
    end if;
    return jsonb_build_object('status','intent','role',role,'effect',o.effects->role);
  end if;
  if op='effect_result' then
    if (p_input-array['action','onboard_attempt_id','role','provider_file_id','version','parents','created'])<>'{}'::jsonb
      or coalesce(p_input->>'provider_file_id','') !~ id_re or coalesce(p_input->>'version','') !~ '^[0-9]{1,40}$'
      or jsonb_typeof(p_input->'created') is distinct from 'boolean' or jsonb_typeof(p_input->'parents') is distinct from 'array'
      or jsonb_array_length(p_input->'parents')<>1 or coalesce(p_input->'parents'->>0,'') !~ id_re
      or ((p_input->>'created')::boolean and (effect is null or not (effect ? 'intent_at')))
      or (role='root' and o.root_mode='picked' and ((p_input->>'created')::boolean or p_input->>'provider_file_id'<>o.picked_folder_id))
      or (role='root' and o.root_mode='new' and not (p_input->>'created')::boolean)
      or (role<>'root' and p_input->'parents'->>0 is distinct from o.effects->'root'->>'provider_file_id')
      or (role='root' and p_input->>'provider_file_id'=p_input->'parents'->>0) then
      raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
    if effect ? 'provider_file_id' then
      if effect->>'provider_file_id'<>p_input->>'provider_file_id' then
        raise exception 'storage_onboard_effect_ambiguous' using errcode='40001'; end if;
      return jsonb_build_object('status','recorded','role',role,'effect',effect);
    end if;
    if exists(select 1 from jsonb_each(o.effects) e where e.value->>'provider_file_id'=p_input->>'provider_file_id') then
      raise exception 'storage_onboard_effect_ambiguous' using errcode='40001'; end if;
    update clued_private.storage_onboard_attempts_v1 set effects=effects||jsonb_build_object(role,coalesce(effect,'{}'::jsonb)||jsonb_build_object(
        'provider_file_id',p_input->>'provider_file_id','version',p_input->>'version','parents',p_input->'parents',
        'created',(p_input->>'created')::boolean,'result_at',clock_timestamp())),updated_at=clock_timestamp()
      where id=o.id returning * into o;
    return jsonb_build_object('status','recorded','role',role,'effect',o.effects->role);
  end if;
  -- activate
  if (p_input-array['action','onboard_attempt_id','ancestors'])<>'{}'::jsonb or jsonb_typeof(p_input->'ancestors') is distinct from 'array'
    or jsonb_array_length(p_input->'ancestors') not between 1 and 32
    or exists(select 1 from jsonb_array_elements(p_input->'ancestors') x where jsonb_typeof(x)<>'string' or (x#>>'{}') !~ id_re) then
    raise exception 'storage_onboard_input_invalid' using errcode='22023'; end if;
  root:=o.effects->'root'->>'provider_file_id'; ancestors:=p_input->'ancestors';
  if root is null or o.credential_envelope is null or ancestors->>0 is distinct from o.effects->'root'->'parents'->>0
    or exists(select 1 from jsonb_array_elements_text(o.tracks) x where not coalesce(o.effects->('track:'||x) ? 'provider_file_id',false)) then
    raise exception 'storage_onboard_effect_incomplete' using errcode='42501'; end if;
  if not (a.execution_enabled and a.read_enabled) then raise exception 'storage_onboard_unavailable' using errcode='42501'; end if;
  -- Same owner||root advisory key as the existing wrappers, then recheck.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  select * into o from clued_private.storage_onboard_attempts_v1 where id=o.id for update;
  if o.state<>'credential_staged' then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  if exists(select 1 from jsonb_array_elements_text(clued_private.storage_onboard_active_roots_v1(u,null)) x
      where x=root or ancestors ? x) then
    raise exception 'storage_onboard_root_overlaps_existing' using errcode='42501'; end if;
  result:=clued_private.storage_onboard_activate_v1(u,o,a,ancestors);
  -- Lock waits can cross session or attempt expiry: check them LAST.
  perform clued_private.storage_owner_v1();
  if not exists(select 1 from clued_private.storage_onboard_attempts_v1 where id=o.id and expires_at>clock_timestamp()) then
    raise exception 'storage_onboard_expired' using errcode='42501'; end if;
  return result;
end $$;

-- Anchored patches on the latest definitions (every edit of one function
-- first, then one CREATE OR REPLACE), as in 20260930140000 / 20260930160000.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Outermost wrapper: onboard claim / complete never enter the inner wrappers.
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=p_issuer_hash;
  end if;
$a$,
     $r$      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=p_issuer_hash;
  end if;
  -- StorageNormalUse N0 (§8.1 step 4): onboard attempts go to their own path.
  if op in ('claim','complete') and x.purpose='onboard' then
    return clued_private.storage_onboard_oauth_v1(p_issuer_hash,p_input);
  end if;
$r$,1),
    -- The one writer of normal-use read access also serves the N0 activation.
    ('clued_private.storage_normal_use_write_v1(uuid,uuid,uuid,uuid,boolean,text,public.clued_audit_receipts,text,text)',
     $a$p_source not in ('owner','oauth_reconsent')$a$,
     $r$p_source not in ('owner','oauth_reconsent','onboard')$r$,1),
    -- Host registration never takes the onboarding namespace.
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$      v_root:=p_input->>'managed_root';
$a$,
     $r$      v_root:=p_input->>'managed_root';
      if lower(coalesce(v_root,''))='/clued-cloud' or lower(left(coalesce(v_root,''),13))='/clued-cloud/' then
        raise exception 'resource_center_profile_root_reserved' using errcode='22023';
      end if;
$r$,1),
    -- The page shows the Drive folder name of an onboarded root.
    ('public.clued_storage_owner_manage_v2(jsonb)',
     $a$'root_name',pr.managed_root,$a$,
     $r$'root_name',coalesce(pr.display_name,pr.managed_root),$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_onboard_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_default_refresh_eligible_v1(uuid,uuid),
  clued_private.storage_onboard_expire_v1(uuid),
  clued_private.storage_onboard_tracks_valid_v1(jsonb),
  clued_private.storage_onboard_active_roots_v1(uuid,text),
  clued_private.storage_onboard_view_v1(clued_private.storage_onboard_attempts_v1),
  clued_private.storage_onboard_oauth_v1(text,jsonb),
  clued_private.storage_onboard_receipt_v1(uuid,text,jsonb),
  clued_private.storage_onboard_finish_v1(uuid,public.clued_audit_receipts,uuid,text,uuid,jsonb,jsonb,jsonb),
  clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_onboard_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_onboard_v1(text,jsonb) to authenticated;
