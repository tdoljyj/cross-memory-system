-- Merge train, step 2b, server side: automatic ci-admission failover
-- (work/independent-ci-resident-v1/DESIGN.md §41.6a; Task a3701d3d; Decision
-- 199cf3de; the coordinator's 2026-10-31 rulings on node identity, eligibility,
-- the watchdog and the CI8 surface).
--
-- 1. Node identity and heartbeat: unified scheduling stage 1's
--    clued_private.ci_nodes_v1 is the only node record (20261023092957). A
--    node is the live row (not retired or revoked) of the CI connection the
--    heartbeat's token belongs to; a name in the payload is never used. Stage 1
--    has no heartbeat writer and no self-report. Heartbeats and self-reports
--    live in a separate table, clued_private.ci_node_liveness_v1 (one row per
--    stage-1 node id), written only by the heartbeat action of the existing CI
--    command door: no stage-1 column, function or row is changed, so stage 1's
--    node view (ci_node_view_v1) and its pending Owner confirmations do not
--    move when a node reports. Its columns:
--      last_heartbeat_at,       the latest heartbeat, the one before it (so "Y
--      heartbeat_previous_at,   sent at least 2 heartbeats while X was silent"
--      heartbeat_sequence       is heartbeat_previous_at > X's last heartbeat),
--                               and how many arrived;
--      reported_*               the latest self-report: mode, role probe
--                               result, state (NORMAL, HALTED, PAUSED,
--                               INTAKE_PAUSED, UNKNOWN), intake pause end
--                               (clamped by the server to now + 200 minutes),
--                               halt detail for the Owner, service running,
--                               status snapshot age, and the latest Source
--                               (ciSourceManifestSha256) the node reported;
--      readable_*               the latest report that was not UNKNOWN (the
--                               look-back of §41.6a);
--      unhealthy_since          start of the current run of reports saying
--                               "service not running" or "snapshot older than
--                               30 minutes"; a report with the service running
--                               and a fresh snapshot ends it; a report that
--                               says neither (snapshot age unknown) leaves it.
--    The time is the server's (clock_timestamp()); a payload cannot carry one.
-- 2. Eligibility, order and the master switch: Owner-only Native settings
--    with the two-step confirmation of the one-click handover
--    (native_confirmation_tokens, same session, view digest, single use). The
--    Owner confirms a whole ordered list of connections at once (marking,
--    unmarking and reordering are one kind of change; a connection that stays
--    keeps its marked_at) or the switch (default off). Receipts record who,
--    when and the order.
-- 3. Handover core: clued_binding_role_handover_v1's body from the advisory
--    lock to the new row becomes clued_private.binding_role_handover_core_v1,
--    which takes the owner explicitly (pg_cron has no authorization_owner_v12),
--    the same lock hashtextextended('clued-binding-role:'||owner||':ci-admission',0),
--    binding_role_handover_check_v1 and the 5-minute start. The one-click
--    handover calls it with its token's digest and is otherwise unchanged
--    (same receipt fields, same results, same refusals).
-- 4. Watchdog: clued_private.ci_admission_failover_tick_v1(), every minute by
--    pg_cron (job clued-ci-admission-failover) where pg_cron is installed.
--    Each tick records its time; residents read it in every heartbeat answer.
--    Per account, under the role lock, it hands the resident-node holder X to
--    the first healthy marked connection Y in the Owner's order only when every
--    §41.6a condition holds; otherwise it does nothing, or writes an alert
--    receipt at most once per hour per kind and reason. Cooldown and "no
--    automatic hand-back" are read from handover receipts, and role holders
--    through binding_role_holders_v1, so the watchdog adds no direct reader of
--    the role table.
-- 5. CI8 is unchanged: no new anon or Worker RPC. The resident reads and
--    writes through the CI command door (clued_work_verify_v1 ->
--    work_claim_ci_command_v1): before the role check and the claim lock,
--    ci_node_heartbeat (every resident node, holder or not, and linked
--    heartbeat connections, item 9) and the refusal of every other action from
--    a linked heartbeat connection; after the role check,
--    ci_nodes_status and train_sweep_watermark for the role holder.
--    work_claim_ci_command_v1 is 2a's definition (20261031060000) plus these
--    branches.
-- 6. Every function redefined whole here is first checked against the md5 of
--    its expected predecessor body.
-- 7. Owner notice (§41.6a "审计与通知"): an automatic handover, and a
--    NO_TARGET alert that is actually written (at most once an hour), each
--    also write a KooYomi Note quoting the receipt id, through the same M1
--    record path the server's other own writes use
--    (record_mutation_with_terminal_guard, no Binding, authority observed;
--    as the storage onboarding and candidate promotion do). A Note that cannot
--    be written never undoes the handover: its outcome is returned and the
--    receipt stays the record.
-- 8. Full-sweep watermark (§41.1 step 2, §41.6): the ci-admission holder (a
--    resident node, as for keepalive) reports, once a full sweep in on mode is
--    complete and every revocation confirmed, the completion time, the GitHub
--    `updated` cursor and the main tip, per connection and repository
--    (CI command door action train_sweep_watermark; an older report never
--    replaces a newer one). The holder reads the latest per repository in
--    ci_nodes_status, so a node that takes over sweeps from it.
-- 9. Heartbeat connections (§41.6a "专用心跳"): the installer never uses a
--    node's CI token for heartbeats. The Owner links a separate connection of
--    the same account to a node's CI connection on /bindings/failover, in the
--    same two Native steps as the other settings (change heartbeat_link or
--    heartbeat_unlink; each leaves a receipt). The linked connection must be
--    live, have context:read (the CI command door resolves every caller with
--    it), hold no ci-admission row and not be a node's CI connection; it is
--    linked to one node at a time, and linking another one to a node replaces
--    that node's previous link. A heartbeat from it is recorded on its node
--    while the node's CI connection is live (the node's own CI connection
--    still works); it may call no other CI command door action
--    (heartbeat_connection_only), and it can be neither marked for nor handed
--    ci-admission (binding_role_change_check_v1 and
--    binding_role_handover_check_v1 refuse it, under the role lock that the
--    link change also takes). The watchdog, ci_nodes_status and the page keep
--    identifying a node by its CI connection. A holder whose CI connection is
--    no longer live sends no heartbeat that counts (direct or linked), so it
--    falls silent and the 30-minute rule decides as for any silence (Decision
--    199cf3de: only loss of contact switches); the Note then states that the
--    CI connection is no longer live. A connection that can only send
--    heartbeats (a scope without context:read) is later work: it needs the
--    connection scope list, issuance and consent outside this migration.
--
-- The production publisher runs this file and its ledger row in one
-- transaction, so CREATE INDEX CONCURRENTLY is unavailable. Ordinary index
-- creation (the receipt index at the end of this file) can block writes while
-- building. Bound lock acquisition locally, as 20261015144000 does; build
-- duration remains subject to the publisher's existing caller timeout.
set local lock_timeout = '5s';

do $predecessors$
declare expected record;
begin
  for expected in select * from (values
    ('clued_private.work_claim_ci_command_v1(text,jsonb)', '2106926771f3e1bbc5009725bde02c24'),
    ('public.clued_binding_role_handover_v1(jsonb)', '8aa49c237bb433aef8fba854c75596da'),
    ('clued_private.binding_role_handover_check_v1(public.clued_agent_bindings,public.clued_agent_bindings)', 'b785f17c22c2cd36cc89fb17d42836aa'),
    ('clued_private.binding_role_change_check_v1(public.clued_agent_bindings,text,boolean,jsonb)', 'b4cdabfa3f97e33dbbd8dce204d1695c')
  ) inputs(signature, body_md5)
  loop
    if not exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(expected.signature)
        and pg_catalog.md5(p.prosrc)=expected.body_md5) then
      raise exception 'merge_train_failover_predecessor_mismatch: %', expected.signature;
    end if;
  end loop;
end $predecessors$;

-- ---------------------------------------------------------------------------
-- Tables.

-- Heartbeats and self-reports, one row per stage-1 node (its first heartbeat
-- creates it). A node row stage 1 removes takes its row with it.
create table clued_private.ci_node_liveness_v1 (
  node_id uuid primary key references clued_private.ci_nodes_v1(node_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_heartbeat_at timestamptz not null,
  last_sender_binding_id uuid not null references public.clued_agent_bindings(id),
  heartbeat_previous_at timestamptz,
  heartbeat_sequence bigint not null check (heartbeat_sequence>=1),
  reported_mode text check (reported_mode in ('ACTIVE','STANDBY','UNCERTAIN')),
  reported_probe text check (reported_probe ~ '^[a-z][a-z-]{0,39}$'),
  reported_state text not null check (reported_state in ('NORMAL','HALTED','PAUSED','INTAKE_PAUSED','UNKNOWN')),
  reported_intake_until timestamptz,
  reported_halt jsonb check (jsonb_typeof(reported_halt)='object' and octet_length(reported_halt::text)<=2048),
  reported_service_running boolean not null,
  reported_snapshot_age_seconds integer check (reported_snapshot_age_seconds>=0),
  reported_source_sha256 text check (reported_source_sha256 ~ '^[0-9a-f]{64}$'),
  readable_state text check (readable_state in ('NORMAL','HALTED','PAUSED','INTAKE_PAUSED')),
  readable_intake_until timestamptz,
  readable_at timestamptz,
  unhealthy_since timestamptz,
  check (heartbeat_previous_at is null or heartbeat_previous_at<=last_heartbeat_at),
  check ((reported_state='INTAKE_PAUSED')=(reported_intake_until is not null)),
  check ((readable_state='INTAKE_PAUSED')=(readable_intake_until is not null)),
  check ((readable_state is null)=(readable_at is null))
);
create index ci_node_liveness_owner_v1 on clued_private.ci_node_liveness_v1(user_id,last_heartbeat_at desc);

-- A heartbeat connection linked to a node's CI connection. At most one live
-- link per heartbeat connection and one per node connection.
create table clued_private.ci_node_heartbeat_link_v1 (
  link_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  heartbeat_binding_id uuid not null references public.clued_agent_bindings(id),
  node_binding_id uuid not null references public.clued_agent_bindings(id),
  linked_at timestamptz not null,
  linked_receipt_id uuid not null,
  revoked_at timestamptz,
  revoked_receipt_id uuid,
  check (heartbeat_binding_id<>node_binding_id),
  check ((revoked_at is null)=(revoked_receipt_id is null))
);
create unique index ci_node_heartbeat_link_sender_v1 on clued_private.ci_node_heartbeat_link_v1(heartbeat_binding_id)
  where revoked_at is null;
create unique index ci_node_heartbeat_link_node_v1 on clued_private.ci_node_heartbeat_link_v1(node_binding_id)
  where revoked_at is null;

-- The latest full-sweep watermark each connection reported per repository.
create table clued_private.ci_sweep_watermark_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid not null references public.clued_agent_bindings(id),
  repository text not null check (repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  completed_at timestamptz not null,
  updated_cursor timestamptz not null,
  main_sha text not null check (main_sha ~ '^[0-9a-f]{40}$'),
  reported_at timestamptz not null,
  receipt_id uuid not null,
  primary key (user_id,binding_id,repository),
  check (updated_cursor<=completed_at)
);

-- The Owner's switch (no row: off, version 0). enabled_at is the latest time
-- it was turned on.
create table clued_private.ci_failover_settings_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  enabled_at timestamptz,
  version bigint not null check (version>=1),
  updated_at timestamptz not null,
  receipt_id uuid not null,
  check (enabled=(enabled_at is not null))
);

-- The connections the Owner marked for automatic takeover, in order (rank 1
-- first). An unmarked connection is never chosen.
create table clued_private.ci_failover_members_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  binding_id uuid not null references public.clued_agent_bindings(id),
  rank integer not null check (rank between 1 and 50),
  marked_at timestamptz not null,
  receipt_id uuid not null,
  primary key (user_id,binding_id),
  unique (user_id,rank)
);

-- The watchdog's own heartbeat.
create table clued_private.ci_failover_watchdog_v1 (
  singleton boolean primary key default true check (singleton),
  last_tick_at timestamptz not null,
  ticks bigint not null check (ticks>=1)
);

alter table clued_private.ci_failover_settings_v1 enable row level security;
alter table clued_private.ci_failover_members_v1 enable row level security;
alter table clued_private.ci_failover_watchdog_v1 enable row level security;
alter table clued_private.ci_node_liveness_v1 enable row level security;
alter table clued_private.ci_sweep_watermark_v1 enable row level security;
alter table clued_private.ci_node_heartbeat_link_v1 enable row level security;
revoke all on table clued_private.ci_failover_settings_v1,clued_private.ci_failover_members_v1,
  clued_private.ci_failover_watchdog_v1,clued_private.ci_node_liveness_v1,clued_private.ci_sweep_watermark_v1,
  clued_private.ci_node_heartbeat_link_v1
  from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Thresholds (§41.6a).

create function clued_private.ci_failover_rules_v1() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('silence_minutes',30,'unhealthy_minutes',30,'snapshot_stale_minutes',30,
    'target_heartbeat_minutes',20,'receiver_heartbeats',2,'cooldown_hours',6,'source_window_hours',24,
    'intake_pause_cap_minutes',200,'alert_every_minutes',60,'watchdog_stale_minutes',5,'activation_delay_minutes',
    (extract(epoch from clued_private.binding_role_activation_delay_v1())/60)::integer)
$$;

-- ---------------------------------------------------------------------------
-- The role checks of 20261023010000, plus: a heartbeat connection linked to a
-- node is never marked for nor handed ci-admission.

create or replace function clued_private.binding_role_change_check_v1(p_binding public.clued_agent_bindings,p_role text,
  p_enabled boolean,p_purpose jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare r clued_private.binding_roles_v1%rowtype;
begin
  select * into r from clued_private.binding_roles_v1 x
    where x.binding_id=p_binding.id and x.role=p_role and x.revoked_at is null;
  if p_enabled=found then raise exception 'binding_role_unchanged' using errcode='22023'; end if;
  if not p_enabled then
    if p_purpose is not null then raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;
    if r.purpose='parking' and not exists(select 1 from clued_private.binding_roles_v1 x
        where x.user_id=p_binding.user_id and x.role=p_role and x.revoked_at is null
          and x.purpose='parking' and x.id<>r.id) then
      raise exception 'binding_role_parking_protected' using errcode='22023'; end if;
    return r.purpose;
  end if;
  if p_role<>'ci-admission' then
    if p_purpose is not null then raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;
    return 'unspecified';
  end if;
  if exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.heartbeat_binding_id=p_binding.id
      and k.revoked_at is null) then
    raise exception 'binding_role_heartbeat_connection' using errcode='22023'; end if;
  if p_purpose is null then raise exception 'binding_role_purpose_required' using errcode='22023'; end if;
  if jsonb_typeof(p_purpose) is distinct from 'string'
      or p_purpose#>>'{}' not in ('resident-node','parking','other') then
    raise exception 'binding_role_purpose_invalid' using errcode='22023'; end if;
  if p_purpose#>>'{}'='resident-node'
      and clued_private.binding_role_resident_held_v1(p_binding.user_id,array[p_binding.id]) then
    raise exception 'binding_role_resident_holder_exists' using errcode='22023'; end if;
  return p_purpose#>>'{}';
end $$;

create or replace function clued_private.binding_role_handover_check_v1(p_from public.clued_agent_bindings,
  p_to public.clued_agent_bindings) returns void
language plpgsql stable security definer set search_path='' as $$
declare v_purpose text;
begin
  select r.purpose into v_purpose from clued_private.binding_roles_v1 r
    where r.binding_id=p_from.id and r.role='ci-admission' and r.revoked_at is null;
  if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
  if v_purpose='parking' then raise exception 'binding_role_parking_protected' using errcode='22023'; end if;
  if p_to.id=p_from.id or not clued_private.binding_live_v1(p_to) then
    raise exception 'binding_role_handover_target_invalid' using errcode='22023'; end if;
  if not ('context:read'=any(p_to.scopes)) then raise exception 'binding_role_scope_missing' using errcode='22023'; end if;
  if exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.heartbeat_binding_id=p_to.id
      and k.revoked_at is null) then
    raise exception 'binding_role_heartbeat_connection' using errcode='22023'; end if;
  if exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=p_to.id and r.role='ci-admission' and r.revoked_at is null) then
    raise exception 'binding_role_handover_target_holds_role' using errcode='22023'; end if;
  if clued_private.binding_role_resident_held_v1(p_from.user_id,array[p_from.id,p_to.id]) then
    raise exception 'binding_role_resident_holder_exists' using errcode='22023'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Handover core, shared by the one-click handover and the watchdog.

-- p_view_digest: the one-click handover's confirmed view, re-rendered and
-- compared under the lock (null for the watchdog). p_receipt: receipt fields
-- of the caller (receipt_kind, principal, token...); the handover's own fields
-- (role, from, to, purpose, start) always win.
create function clued_private.binding_role_handover_core_v1(p_owner uuid,p_from uuid,p_to uuid,
  p_view_digest text,p_receipt jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare f public.clued_agent_bindings%rowtype; t public.clued_agent_bindings%rowtype;
  v_receipt uuid; v_now timestamptz; v_start timestamptz;
begin
  if p_owner is null or p_from is null or p_to is null or jsonb_typeof(p_receipt) is distinct from 'object' then
    raise exception 'binding_role_handover_input_invalid' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||p_owner::text||':ci-admission',0));
  perform 1 from public.clued_agent_bindings x where x.user_id=p_owner
    and x.id in (p_from,p_to) order by x.id for update;
  select * into f from public.clued_agent_bindings x where x.id=p_from and x.user_id=p_owner;
  if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
  select * into t from public.clued_agent_bindings x where x.id=p_to and x.user_id=p_owner;
  if not found then raise exception 'binding_role_handover_target_invalid' using errcode='22023'; end if;
  perform clued_private.binding_role_handover_check_v1(f,t);
  if p_view_digest is not null
      and clued_private.m1_sha256(clued_private.binding_role_handover_view_v1(f,t))<>p_view_digest then
    raise exception 'confirmation_view_stale' using errcode='40001'; end if;
  v_now:=clock_timestamp();
  v_start:=clued_private.binding_role_start_v1('ci-admission','resident-node',v_now);
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_owner,null,'global','binding_role_handover','binding_role',t.id::text||':ci-admission',1,
    jsonb_build_object('receipt_kind',coalesce(p_receipt->>'receipt_kind','BINDING_ROLE_HANDED_OVER'))
      ||(p_receipt-'receipt_kind')
      ||jsonb_build_object('role','ci-admission','from_binding_id',f.id,'to_binding_id',t.id,
        'purpose','resident-node','effective_at',v_start))
  returning id into v_receipt;
  update clued_private.binding_roles_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
    where binding_id=f.id and role='ci-admission' and revoked_at is null;
  if not found then raise exception 'binding_role_handover_source_invalid' using errcode='22023'; end if;
  insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
  values(p_owner,t.id,'ci-admission',v_now,v_receipt,v_start,'resident-node');
  return jsonb_build_object('receipt_id',v_receipt,'at',v_now,'effective_at',v_start,
    'from_binding_id',f.id,'to_binding_id',t.id);
end $$;

-- Step 2 of the one-click handover (20261023010000), now through the core.
create or replace function public.clued_binding_role_handover_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; v_receipt uuid; v_now timestamptz; v_start timestamptz; v_error text; v_state text;
  c jsonb; v_done jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'binding_role_handover_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens x
      where x.user_id=v_owner and x.action='binding_role_handover' and x.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id,
        'from_binding_id',v_token.native_choices->>'from_binding_id','to_binding_id',v_token.native_choices->>'to_binding_id',
        'role','ci-admission','effective_at',(select r.metadata->'effective_at' from public.clued_audit_receipts r
          where r.id=v_token.consumed_receipt_id));
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    c:=v_token.native_choices;
    v_done:=clued_private.binding_role_handover_core_v1(v_owner,(c->>'from_binding_id')::uuid,
      (c->>'to_binding_id')::uuid,v_token.view_digest,
      jsonb_build_object('receipt_kind','BINDING_ROLE_HANDED_OVER','token_id',v_token.id,
        'view_digest',v_token.view_digest,'session_id',v_token.session_id,'principal','native_account_session'));
    v_receipt:=(v_done->>'receipt_id')::uuid;
    v_now:=(v_done->>'at')::timestamptz;
    v_start:=(v_done->>'effective_at')::timestamptz;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'role','ci-admission',
      'from_binding_id',(v_done->>'from_binding_id')::uuid,'to_binding_id',(v_done->>'to_binding_id')::uuid,
      'effective_at',v_start);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','binding_role_handover','binding_role',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','BINDING_ROLE_HANDOVER_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Reading nodes.

-- The liveness of a connection's node: of its live stage-1 rows, the one that
-- heard most recently (no row when none has ever reported).
create function clued_private.ci_failover_node_v1(p_owner uuid,p_binding uuid) returns clued_private.ci_node_liveness_v1
language sql stable security definer set search_path='' as $$
  select l.* from clued_private.ci_nodes_v1 n join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id
  where n.user_id=p_owner and n.binding_id=p_binding and n.state not in ('retired','revoked')
  order by l.last_heartbeat_at desc,n.created_at desc,n.node_id limit 1
$$;

-- A connection's node as the Owner and the holder see it (null: no live node).
create function clued_private.ci_failover_node_view_v1(p_owner uuid,p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('node_id',n.node_id,'name',n.name,
    'project_id',n.project_id,'stage1_state',n.state,'last_heartbeat_at',l.last_heartbeat_at,
    'heartbeat_previous_at',l.heartbeat_previous_at,'heartbeat_sequence',coalesce(l.heartbeat_sequence,0),
    'mode',l.reported_mode,'probe',l.reported_probe,'state',l.reported_state,
    'intake_paused_until',l.reported_intake_until,'halt',l.reported_halt,
    'service_running',l.reported_service_running,'snapshot_age_seconds',l.reported_snapshot_age_seconds,
    'ci_source_manifest_sha256',l.reported_source_sha256,'readable_state',l.readable_state,
    'readable_intake_until',l.readable_intake_until,'readable_at',l.readable_at,
    'unhealthy_since',l.unhealthy_since,'heartbeat_from_binding_id',l.last_sender_binding_id,
    'heartbeat_from_agent_name',s.agent_name,'heartbeat_via_link',l.last_sender_binding_id is distinct from n.binding_id)
  from clued_private.ci_nodes_v1 n left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id
  left join public.clued_agent_bindings s on s.id=l.last_sender_binding_id
  where n.user_id=p_owner and n.binding_id=p_binding and n.state not in ('retired','revoked')
  order by l.last_heartbeat_at desc nulls last,n.created_at desc,n.node_id limit 1
$$;

create function clued_private.ci_failover_watchdog_view_v1() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('last_tick_at',w.last_tick_at,
    'stale',w.last_tick_at is null or w.last_tick_at<=clock_timestamp()-interval '5 minutes')
  from (select (select last_tick_at from clued_private.ci_failover_watchdog_v1 where singleton) last_tick_at) w
$$;

-- Automatic handovers to one connection in the last 24 hours, for its
-- companion to relay to the Owner (one marked comment per receipt).
create function clued_private.ci_failover_received_v1(p_owner uuid,p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('receipt_id',r.id,'from_binding_id',r.metadata->'from_binding_id',
      'to_binding_id',r.metadata->'to_binding_id','effective_at',r.metadata->'effective_at',
      'trigger',r.metadata->'trigger','created_at',r.created_at) order by r.created_at,r.id),'[]'::jsonb)
  from public.clued_audit_receipts r where r.user_id=p_owner and r.context_key='global' and r.operation='binding_role_handover'
    and r.metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER' and r.metadata->>'to_binding_id'=p_binding::text
    and r.created_at>clock_timestamp()-interval '24 hours'
$$;

-- Marked connections and every connection whose node heard in 24 hours.
create function clued_private.ci_failover_nodes_v1(p_owner uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('binding_id',x.binding_id,'agent_name',b.agent_name,'vendor',b.vendor,
      'live',coalesce(clued_private.binding_live_v1(b),false),'rank',m.rank,'marked_at',m.marked_at,
      'node',clued_private.ci_failover_node_view_v1(p_owner,x.binding_id))
    order by m.rank nulls last,b.agent_name,x.binding_id),'[]'::jsonb)
  from (select binding_id from clued_private.ci_failover_members_v1 where user_id=p_owner
        union
        select n.binding_id from clued_private.ci_node_liveness_v1 l join clued_private.ci_nodes_v1 n on n.node_id=l.node_id
          where l.user_id=p_owner and n.state not in ('retired','revoked')
            and l.last_heartbeat_at>clock_timestamp()-interval '24 hours') x
  join public.clued_agent_bindings b on b.id=x.binding_id
  left join clued_private.ci_failover_members_v1 m on m.user_id=p_owner and m.binding_id=x.binding_id
$$;

-- ---------------------------------------------------------------------------
-- The heartbeat (CI command door action ci_node_heartbeat).
--
-- Input {action, scope, state, mode, probe, intake_paused_until, halt,
-- ci_source_manifest_sha256, service_running, snapshot_age_seconds,
-- node_name}: state NORMAL | HALTED | PAUSED | INTAKE_PAUSED | UNKNOWN; mode
-- ACTIVE | STANDBY | UNCERTAIN (may be absent only with UNKNOWN);
-- intake_paused_until exactly with INTAKE_PAUSED; node_name is accepted and
-- ignored. Any other field (a time, a node id) is refused. The caller is a
-- node's CI connection (its own node) or a heartbeat connection linked to one
-- (that node, while the node's CI connection is live); anyone else gets
-- ci_node_not_registered.
create function clued_private.ci_node_heartbeat_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_now timestamptz:=pg_catalog.clock_timestamp(); v_state text:=p_input->>'state';
  v_mode text:=p_input->>'mode'; v_probe text:=p_input->>'probe'; v_until timestamptz;
  v_source text:=p_input->>'ci_source_manifest_sha256'; v_running boolean; v_age integer;
  v_halt jsonb; v_unhealthy boolean; v_healthy boolean; v_nodes uuid[]; v_node_binding uuid;
begin
  if p_input-array['action','scope','state','mode','probe','intake_paused_until','halt',
        'ci_source_manifest_sha256','service_running','snapshot_age_seconds','node_name']<>'{}'::jsonb
      or jsonb_typeof(p_input->'state') is distinct from 'string'
      or v_state not in ('NORMAL','HALTED','PAUSED','INTAKE_PAUSED','UNKNOWN')
      or jsonb_typeof(p_input->'service_running') is distinct from 'boolean'
      or (p_input ? 'mode' and jsonb_typeof(p_input->'mode')<>'null'
        and (jsonb_typeof(p_input->'mode')<>'string' or v_mode not in ('ACTIVE','STANDBY','UNCERTAIN')))
      or (v_state<>'UNKNOWN' and v_mode is null)
      or (p_input ? 'probe' and jsonb_typeof(p_input->'probe')<>'null'
        and (jsonb_typeof(p_input->'probe')<>'string' or v_probe !~ '^[a-z][a-z-]{0,39}$'))
      or (p_input ? 'ci_source_manifest_sha256' and jsonb_typeof(p_input->'ci_source_manifest_sha256')<>'null'
        and (jsonb_typeof(p_input->'ci_source_manifest_sha256')<>'string' or v_source !~ '^[0-9a-f]{64}$'))
      or (p_input ? 'snapshot_age_seconds' and jsonb_typeof(p_input->'snapshot_age_seconds')<>'null'
        and (jsonb_typeof(p_input->'snapshot_age_seconds')<>'number' or p_input->>'snapshot_age_seconds' !~ '^[0-9]{1,9}$'))
      or (p_input ? 'halt' and jsonb_typeof(p_input->'halt')<>'null'
        and (jsonb_typeof(p_input->'halt')<>'object' or octet_length((p_input->'halt')::text)>2048))
      or (p_input ? 'node_name' and jsonb_typeof(p_input->'node_name') is distinct from 'string')
      or ((v_state='INTAKE_PAUSED') is distinct from (jsonb_typeof(p_input->'intake_paused_until') is not distinct from 'string'))
      or (v_state<>'INTAKE_PAUSED' and p_input ? 'intake_paused_until') then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if v_state='INTAKE_PAUSED' then
    begin
      v_until:=(p_input->>'intake_paused_until')::timestamptz;
    exception when others then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023';
    end;
    v_until:=least(v_until,v_now+interval '200 minutes');
  end if;
  v_running:=(p_input->>'service_running')::boolean;
  v_age:=(p_input->>'snapshot_age_seconds')::integer;
  v_halt:=case when v_state='HALTED' and jsonb_typeof(p_input->'halt')='object' then p_input->'halt' end;
  v_unhealthy:=not v_running or coalesce(v_age>1800,false);
  v_healthy:=v_running and coalesce(v_age<=1800,false);
  if exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id=b.user_id and n.binding_id=b.id
      and n.state not in ('retired','revoked')) then
    v_node_binding:=b.id;
  else
    select k.node_binding_id into v_node_binding from clued_private.ci_node_heartbeat_link_v1 k
      join public.clued_agent_bindings nb on nb.id=k.node_binding_id and nb.user_id=k.user_id
      where k.user_id=b.user_id and k.heartbeat_binding_id=b.id and k.revoked_at is null
        and clued_private.binding_live_v1(nb);
  end if;
  if v_node_binding is null then
    return jsonb_build_object('status','rejected','error_code','ci_node_not_registered'); end if;
  with heard as (
    insert into clued_private.ci_node_liveness_v1 as l(node_id,user_id,last_heartbeat_at,last_sender_binding_id,
      heartbeat_sequence,reported_mode,reported_probe,reported_state,reported_intake_until,reported_halt,
      reported_service_running,reported_snapshot_age_seconds,reported_source_sha256,readable_state,
      readable_intake_until,readable_at,unhealthy_since)
    select n.node_id,n.user_id,v_now,b.id,1,v_mode,v_probe,v_state,v_until,v_halt,v_running,v_age,v_source,
      case when v_state<>'UNKNOWN' then v_state end,case when v_state<>'UNKNOWN' then v_until end,
      case when v_state<>'UNKNOWN' then v_now end,case when v_unhealthy then v_now end
    from clued_private.ci_nodes_v1 n
    where n.user_id=b.user_id and n.binding_id=v_node_binding and n.state not in ('retired','revoked')
    on conflict (node_id) do update set heartbeat_previous_at=l.last_heartbeat_at,last_heartbeat_at=v_now,
      last_sender_binding_id=b.id,
      heartbeat_sequence=l.heartbeat_sequence+1,reported_mode=v_mode,reported_probe=v_probe,reported_state=v_state,
      reported_intake_until=v_until,reported_halt=v_halt,reported_service_running=v_running,
      reported_snapshot_age_seconds=v_age,reported_source_sha256=coalesce(v_source,l.reported_source_sha256),
      readable_state=case when v_state='UNKNOWN' then l.readable_state else v_state end,
      readable_intake_until=case when v_state='UNKNOWN' then l.readable_intake_until else v_until end,
      readable_at=case when v_state='UNKNOWN' then l.readable_at else v_now end,
      unhealthy_since=case when v_unhealthy then coalesce(l.unhealthy_since,v_now)
        when v_healthy then null else l.unhealthy_since end
    returning l.node_id)
  select array_agg(node_id order by node_id) into v_nodes from heard;
  if v_nodes is null then
    return jsonb_build_object('status','rejected','error_code','ci_node_not_registered'); end if;
  return jsonb_build_object('status','ok','received_at',v_now,'node_ids',to_jsonb(v_nodes),
    'node_binding_id',v_node_binding,'via_link',v_node_binding<>b.id,
    'intake_paused_until',v_until,'watchdog',clued_private.ci_failover_watchdog_view_v1(),
    'auto_handovers',clued_private.ci_failover_received_v1(b.user_id,v_node_binding));
end $$;

-- The latest full-sweep watermark per repository, whoever reported it.
create function clued_private.ci_failover_watermarks_v1(p_owner uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('repository',w.repository,'binding_id',w.binding_id,
      'completed_at',w.completed_at,'updated_cursor',w.updated_cursor,'main_sha',w.main_sha,
      'reported_at',w.reported_at,'receipt_id',w.receipt_id) order by w.repository),'[]'::jsonb)
  from (select distinct on (x.repository) x.* from clued_private.ci_sweep_watermark_v1 x where x.user_id=p_owner
        order by x.repository,x.completed_at desc,x.reported_at desc) w
$$;

-- The role holder's view of every node (CI command door action
-- ci_nodes_status, after the role check): Source, state and last heartbeat
-- of every marked connection and every node heard in 24 hours (§41.6), the
-- latest full-sweep watermark of each repository, and the watchdog's last tick.
create function clued_private.ci_failover_nodes_status_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if p_input-array['action','scope']<>'{}'::jsonb then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  return jsonb_build_object('status','ok','observed_at',clock_timestamp(),
    'watchdog',clued_private.ci_failover_watchdog_view_v1(),'nodes',clued_private.ci_failover_nodes_v1(b.user_id),
    'sweep_watermarks',clued_private.ci_failover_watermarks_v1(b.user_id));
end $$;

-- Full-sweep watermark (CI command door action train_sweep_watermark, after
-- the role check). Input {action, scope, repository, completed_at,
-- updated_cursor, main_sha}. Only a resident-node holder (as for keepalive);
-- the completion time may not be in the future and the cursor not after it.
create function clued_private.ci_sweep_watermark_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_repo text; v_done timestamptz; v_cursor timestamptz;
  w clued_private.ci_sweep_watermark_v1%rowtype; v_receipt uuid;
begin
  if p_input-array['action','scope','repository','completed_at','updated_cursor','main_sha']<>'{}'::jsonb
      or jsonb_typeof(p_input->'repository') is distinct from 'string'
      or p_input->>'repository' !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'
      or jsonb_typeof(p_input->'completed_at') is distinct from 'string'
      or jsonb_typeof(p_input->'updated_cursor') is distinct from 'string'
      or jsonb_typeof(p_input->'main_sha') is distinct from 'string' or p_input->>'main_sha' !~ '^[0-9a-f]{40}$' then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  begin
    v_done:=(p_input->>'completed_at')::timestamptz;
    v_cursor:=(p_input->>'updated_cursor')::timestamptz;
  exception when others then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023';
  end;
  if v_done>v_now+interval '5 minutes' or v_cursor>v_done then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if not clued_private.merge_slot_admits_v1(b) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  v_repo:=lower(p_input->>'repository');
  select * into w from clued_private.ci_sweep_watermark_v1 x
    where x.user_id=b.user_id and x.binding_id=b.id and x.repository=v_repo for update;
  if found and w.completed_at>=v_done then
    return jsonb_build_object('status','ok','recorded',false,'repository',v_repo,'completed_at',w.completed_at,
      'receipt_id',w.receipt_id);
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,'global','ci_train_sweep_watermark','ci_sweep_watermark',v_repo,1,
    jsonb_build_object('receipt_kind','CI_TRAIN_SWEEP_WATERMARK','repository',v_repo,'binding_id',b.id,
      'completed_at',v_done,'updated_cursor',v_cursor,'main_sha',p_input->>'main_sha','previous_completed_at',w.completed_at))
  returning id into v_receipt;
  insert into clued_private.ci_sweep_watermark_v1(user_id,binding_id,repository,completed_at,updated_cursor,main_sha,
    reported_at,receipt_id)
  values(b.user_id,b.id,v_repo,v_done,v_cursor,p_input->>'main_sha',v_now,v_receipt)
  on conflict (user_id,binding_id,repository) do update set completed_at=excluded.completed_at,
    updated_cursor=excluded.updated_cursor,main_sha=excluded.main_sha,reported_at=excluded.reported_at,
    receipt_id=excluded.receipt_id
    where excluded.completed_at>clued_private.ci_sweep_watermark_v1.completed_at;
  if not found then
    -- A newer report committed between the read above and this write: it stays.
    raise exception 'work_claim_ci_command_conflict' using errcode='40001';
  end if;
  return jsonb_build_object('status','ok','recorded',true,'repository',v_repo,'completed_at',v_done,'receipt_id',v_receipt);
end $$;

-- ---------------------------------------------------------------------------
-- The CI command door: 2a's definition plus the node actions.

CREATE OR REPLACE FUNCTION clued_private.work_claim_ci_command_v1(p_token_hash text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1;
  o clued_private.work_claim_revocation_outbox_v1; p clued_private.work_claim_publications_v1;
  op text:=p_input->>'action'; scope text:=coalesce(p_input->>'scope','global');
  epoch bigint; result jsonb; id uuid; verification_input jsonb; receipt uuid;
  contexts text[]:='{}'::text[]; context_row text; context_page text[]; outboxes uuid[]; publications uuid[];
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  -- Every resident node, holder or not (§41.6a), before the role check and the lock.
  if op='ci_node_heartbeat' then
    return clued_private.ci_node_heartbeat_v1(b,p_input);
  end if;
  -- A heartbeat connection linked to a node sends heartbeats and nothing else.
  if exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.user_id=b.user_id
      and k.heartbeat_binding_id=b.id and k.revoked_at is null) then
    return jsonb_build_object('status','rejected','error_code','heartbeat_connection_only'); end if;
  -- A role label supplied in a payload or a read-only Agent connection is
  -- never a CI principal. This is the existing Owner-designated CI Binding.
  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id
      and r.binding_id=b.id and r.role='ci-admission' and r.revoked_at is null
      and r.effective_at<=clock_timestamp()) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  if op='ci_nodes_status' then
    return clued_private.ci_failover_nodes_status_v1(b,p_input);
  end if;
  if op='train_sweep_watermark' then
    return clued_private.ci_sweep_watermark_v1(b,p_input);
  end if;
  perform clued_private.work_claim_lock(b.user_id);
  if op='merge_queue_keepalive' then
    return clued_private.work_claim_merge_queue_keepalive_v1(b,p_input);
  end if;
  if op='publication_begin_independent' then
    return clued_private.work_claim_independent_begin_v1(p_token_hash,p_input);
  end if;
  if op='publication_abort_independent' then
    return clued_private.work_claim_independent_abort_v1(p_token_hash,p_input);
  end if;
  if op in ('independent_revocation_heads','independent_legacy_drain_finish') then
    return clued_private.work_claim_independent_drain_command_v1(p_token_hash,p_input);
  end if;
  if op='revocations_contexts' then
    if p_input-array['action','scope','cursor']<>'{}'::jsonb or scope<>'global'
      or (p_input ? 'cursor' and (jsonb_typeof(p_input->'cursor') is distinct from 'string'
        or p_input->>'cursor' !~ '^(global|project:[0-9a-f-]{36})$')) then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select array_agg(x.context_key order by x.context_key) into context_page from (
      select context_key from (
        select context_key from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id and state='pending'
        union
        select claim_row.context_key from clued_private.work_claim_publications_v1 pubs
          join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
          where pubs.user_id=b.user_id and pubs.state='open' and (pubs.execution_epoch<claim_row.execution_epoch
            or claim_row.status<>'ACTIVE' or claim_row.expires_at<=clock_timestamp() or claim_row.execution_handover_pending)
      ) known where context_key>coalesce(p_input->>'cursor','') order by context_key limit 101
    ) x;
    foreach context_row in array coalesce(context_page[1:100],'{}'::text[]) loop
      begin
        perform clued_private.resolve_binding(p_token_hash,'context:read',context_row);
        contexts:=array_append(contexts,context_row);
      exception when insufficient_privilege then null;
      end;
    end loop;
    return jsonb_build_object('status','ok','context_keys',to_jsonb(contexts),
      'next_cursor',case when cardinality(context_page)>100 then context_page[100] else null end);
  end if;
  if op='revocations_list' then
    if p_input-array['action','scope','outbox_cursor','publication_cursor']<>'{}'::jsonb
      or (p_input ? 'outbox_cursor' and coalesce(p_input->>'outbox_cursor','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
      or (p_input ? 'publication_cursor' and coalesce(p_input->>'publication_cursor','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select array_agg(x.outbox_id order by x.outbox_id) into outboxes from (
      select outbox_id from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id
        and context_key=scope and state='pending'
        and (not(p_input ? 'outbox_cursor') or outbox_id>(p_input->>'outbox_cursor')::uuid)
      order by outbox_id limit 101) x;
    select array_agg(x.publication_id order by x.publication_id) into publications from (
      select pubs.publication_id from clued_private.work_claim_publications_v1 pubs
        join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
      where pubs.user_id=b.user_id and claim_row.context_key=scope and pubs.state='open'
        and (pubs.execution_epoch<claim_row.execution_epoch or claim_row.status<>'ACTIVE'
          or claim_row.expires_at<=clock_timestamp() or claim_row.execution_handover_pending)
        and (not(p_input ? 'publication_cursor') or pubs.publication_id>(p_input->>'publication_cursor')::uuid)
      order by pubs.publication_id limit 101) x;
    return jsonb_build_object('status','ok','revocations',coalesce((select jsonb_agg(to_jsonb(x))
      from (select outbox_id,claim_id,execution_epoch,repository,head_sha,pr_ref,workflow
        from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id
          and outbox_id=any(coalesce(outboxes[1:100],'{}'::uuid[])) order by outbox_id) x),'[]'::jsonb),
      'publications',coalesce((select jsonb_agg(to_jsonb(x)) from (
        select pubs.publication_id,pubs.claim_id,pubs.execution_epoch,pubs.repository,pubs.head_sha,pubs.pr_ref,pubs.run_id,pubs.check_run_id,pubs.independent_identity,pubs.started_receipt_id
        from clued_private.work_claim_publications_v1 pubs
          join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
        where pubs.user_id=b.user_id and claim_row.context_key=scope and pubs.state='open'
          and pubs.publication_id=any(coalesce(publications[1:100],'{}'::uuid[]))
        order by pubs.publication_id) x),'[]'::jsonb),
      'next_outbox_cursor',case when cardinality(outboxes)>100 then outboxes[100] else null end,
      'next_publication_cursor',case when cardinality(publications)>100 then publications[100] else null end);
  end if;
  if op='revocation_ack' then
    if p_input-array['action','scope','outbox_id','execution_epoch','evidence']<>'{}'::jsonb
      or jsonb_typeof(p_input->'evidence') is distinct from 'object' then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into o from clued_private.work_claim_revocation_outbox_v1
      where user_id=b.user_id and context_key=scope and outbox_id=(p_input->>'outbox_id')::uuid for update;
    if o.outbox_id is null or o.execution_epoch is distinct from (p_input->>'execution_epoch')::bigint then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
    select * into c from clued_private.work_claims_v1 where claim_id=o.claim_id and user_id=b.user_id;
    if c.execution_epoch<>o.execution_epoch then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
    if o.state='acknowledged' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',o.acknowledged_receipt_id,
        'outbox_id',o.outbox_id,'execution_epoch',o.execution_epoch); end if;
    if exists(select 1 from clued_private.work_claim_publications_v1 where claim_id=c.claim_id
        and execution_epoch<c.execution_epoch and state='open') then
      return jsonb_build_object('status','rejected','error_code','work_claim_publications_unresolved'); end if;
    if o.repository='tdoljyj/cross-memory-system' and exists(
      select 1 from clued_private.work_claim_independent_consumer_v1 policy where policy.singleton
        and policy.source_manifest_sha256 is not null and not exists(
          select 1 from clued_private.work_claim_independent_drains_v1 d where d.outbox_id=o.outbox_id
            and d.user_id=b.user_id and d.execution_epoch=o.execution_epoch
            and d.source_manifest_sha256=policy.source_manifest_sha256
            and jsonb_array_length(d.evidence->'stop_proof_refs')>0
            and not exists(select 1 from unnest(coalesce(c.admitted_heads,'{}'::text[])||array[o.head_sha]) h
              where h ~ '^[0-9a-f]{40}$' and not exists(
                select 1 from jsonb_array_elements_text(d.evidence->'heads') covered(head) where covered.head=h)))) then
      return jsonb_build_object('status','rejected','error_code','work_claim_independent_drain_required'); end if;
    if p_input->'evidence'->'checks_revoked' is distinct from 'true'::jsonb
      or p_input->'evidence'->'auto_merge_disabled' is distinct from 'true'::jsonb
      or p_input->'evidence'->'dispatch_revoked' is distinct from 'true'::jsonb then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_incomplete'); end if;
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_revocation_ack',c.claim_id,c.execution_epoch,
      jsonb_build_object('outbox_id',o.outbox_id,'repository',o.repository,'head_sha',o.head_sha,
        'pr_ref',o.pr_ref,'workflow',o.workflow,'evidence',p_input->'evidence'));
    update clued_private.work_claim_revocation_outbox_v1 set state='acknowledged',
      acknowledged_at=clock_timestamp(),evidence=p_input->'evidence',acknowledged_receipt_id=receipt where outbox_id=o.outbox_id;
    return jsonb_build_object('status','committed','receipt_id',receipt,'outbox_id',o.outbox_id,'execution_epoch',o.execution_epoch);
  end if;
  if op='publication_reconcile' or op='publication_finish' then
    if p_input-array['action','scope','publication_id','check_run_id','checks_revoked','publisher_stopped']<>'{}'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and publication_id=(p_input->>'publication_id')::uuid for update;
    if p.publication_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_publication_not_found'); end if;
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=p.claim_id and context_key=scope;
    if c.claim_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_publication_not_found'); end if;
    if p.check_run_id is not null and p.check_run_id is distinct from p_input->>'check_run_id' then
      return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
    if op='publication_reconcile' then
      if p_input->'checks_revoked' is distinct from 'true'::jsonb
        or p_input->'publisher_stopped' is distinct from 'true'::jsonb
        or coalesce(p_input->>'check_run_id','') !~ '^[0-9]{1,20}$'
        or (p.check_run_id is not null and p.check_run_id<>p_input->>'check_run_id') then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
      if p.state='reconciled' then
        return jsonb_build_object('status','committed','replayed',true,'receipt_id',p.finished_receipt_id,
          'execution_epoch',p.execution_epoch,'must_revoke',true); end if;
      update clued_private.work_claim_publications_v1 set state='reconciled',check_run_id=p_input->>'check_run_id',finished_at=clock_timestamp()
        where publication_id=p.publication_id;
    else
      if p.state='reconciled' then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_reconciled'); end if;
      if coalesce(p_input->>'check_run_id','') !~ '^[0-9]{1,20}$' then
        raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
      if p.finished_receipt_id is not null and p.check_run_id=p_input->>'check_run_id'
        and ((p.state='published' and p.execution_epoch=c.execution_epoch and not c.execution_handover_pending
          and c.status='ACTIVE' and c.expires_at>clock_timestamp()) or p.state='open') then
        return jsonb_build_object('status','committed','replayed',true,'receipt_id',p.finished_receipt_id,
          'execution_epoch',p.execution_epoch,'must_revoke',p.state='open'); end if;
      update clued_private.work_claim_publications_v1 set state=case
        when p.execution_epoch<>c.execution_epoch or c.execution_handover_pending
          or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then 'open' else 'published' end,
        check_run_id=p_input->>'check_run_id',finished_at=clock_timestamp() where publication_id=p.publication_id;
    end if;
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_'||op,c.claim_id,p.execution_epoch,
      jsonb_build_object('publication_id',p.publication_id,'repository',p.repository,'head_sha',p.head_sha,
        'pr_ref',p.pr_ref,'run_id',p.run_id,'check_run_id',p_input->>'check_run_id',
        'checks_revoked',p_input->'checks_revoked','publisher_stopped',p_input->'publisher_stopped'));
    update clued_private.work_claim_publications_v1 set finished_receipt_id=receipt where publication_id=p.publication_id;
    return jsonb_build_object('status','committed','receipt_id',receipt,'execution_epoch',p.execution_epoch,
      'must_revoke',p.execution_epoch<>c.execution_epoch or c.execution_handover_pending
        or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp());
  end if;
  if op='publication_abort' then
    if p_input-array['action','scope','publication_id','not_sent']<>'{}'::jsonb
      or p_input->'not_sent' is distinct from 'true'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and publication_id=(p_input->>'publication_id')::uuid for update;
    if p.publication_id is null or p.state<>'open' or p.check_run_id is not null
      or not exists(select 1 from clued_private.work_claims_v1 claim_row
        where claim_row.claim_id=p.claim_id and claim_row.context_key=scope) then
      return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
    update clued_private.work_claim_publications_v1 set state='reconciled',finished_at=clock_timestamp()
      where publication_id=p.publication_id;
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_publication_abort',p.claim_id,p.execution_epoch,
      jsonb_build_object('publication_id',p.publication_id,'repository',p.repository,'head_sha',p.head_sha,
        'pr_ref',p.pr_ref,'run_id',p.run_id,'not_sent',true));
    update clued_private.work_claim_publications_v1 set finished_receipt_id=receipt where publication_id=p.publication_id;
    return jsonb_build_object('status','committed','receipt_id',receipt,'publication_id',p.publication_id);
  end if;
  if op='publication_begin' then
    if coalesce(p_input->>'run_id','') !~ '^[0-9]{1,20}$'
      or coalesce(p_input->>'publication_key','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    verification_input:=p_input-array['action','run_id','publication_key'];
    if not(verification_input ? 'claim_id') then
      select * into c from clued_private.work_claims_v1 where user_id=b.user_id
        and bound_pr=p_input->>'pr_ref' and lease_key_required and status in ('ACTIVE','DRAINING')
        order by updated_at desc limit 1;
      if c.claim_id is null then
        return jsonb_build_object('status','ok','publication_required',false); end if;
      verification_input:=verification_input||jsonb_build_object('claim_id',c.claim_id,'scope',c.context_key);
    end if;
    result:=public.clued_work_verify_v1(p_token_hash,verification_input);
    if result->>'verdict'<>'ADMITTED' then return result; end if;
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and context_key=verification_input->>'scope'
      and claim_id=(verification_input->>'claim_id')::uuid;
    if not clued_private.work_claim_execution_enabled_v1() or not c.lease_key_required then
      return result||jsonb_build_object('publication_required',false); end if;
    if c.execution_handover_pending or coalesce(p_input->>'pr_ref','')='' then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_pending'); end if;
    insert into clued_private.work_claim_publications_v1(user_id,claim_id,execution_epoch,repository,
      head_sha,pr_ref,run_id,publication_key) values(b.user_id,c.claim_id,c.execution_epoch,
      lower(split_part(p_input->>'pr_ref','#',1)),p_input->>'head_sha',p_input->>'pr_ref',p_input->>'run_id',
      (p_input->>'publication_key')::uuid)
      on conflict(claim_id,execution_epoch,publication_key) do nothing
      returning publication_id into id;
    if id is null then
      select * into p from clued_private.work_claim_publications_v1 where claim_id=c.claim_id
        and execution_epoch=c.execution_epoch and publication_key=(p_input->>'publication_key')::uuid;
      if p.head_sha is distinct from p_input->>'head_sha' or p.pr_ref is distinct from p_input->>'pr_ref'
        or p.run_id is distinct from p_input->>'run_id' or p.state<>'open' then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_idempotency_conflict'); end if;
      id:=p.publication_id;
      receipt:=p.started_receipt_id;
    else
      receipt:=clued_private.work_claim_ci_receipt_v1(b,c.context_key,'work_claim_publication_begin',c.claim_id,c.execution_epoch,
        jsonb_build_object('publication_id',id,'repository',lower(split_part(p_input->>'pr_ref','#',1)),
          'head_sha',p_input->>'head_sha','pr_ref',p_input->>'pr_ref','run_id',p_input->>'run_id'));
      update clued_private.work_claim_publications_v1 set started_receipt_id=receipt where publication_id=id;
    end if;
    return result||jsonb_build_object('publication_required',true,'publication_id',id,'scope',c.context_key,'receipt_id',receipt);
  end if;
  raise exception 'work_claim_ci_command_invalid' using errcode='22023';
end $function$;

-- ---------------------------------------------------------------------------
-- The watchdog.

-- Why a marked connection cannot be chosen right now, from handover receipts:
-- auto_handed_out (an automatic handover took the role from it and no manual
-- handover to or from it, nor a hand mark, came after); cooldown (it handed
-- the role over, or the Owner ended its role, in the last 6 hours).
-- auto_handed_out has no time bound on purpose: §41.6a keeps the node out
-- until the Owner hands over to or from it by hand, however long that takes.
-- The read stays small: the account's handover and role receipts only
-- (clued_audit_receipts_ci_failover_v1).
create function clued_private.ci_failover_exclusion_v1(p_owner uuid,p_binding uuid,p_now timestamptz) returns text
language sql stable security definer set search_path='' as $$
  select case
    when exists(select 1 from public.clued_audit_receipts r where r.user_id=p_owner and r.context_key='global'
        and r.operation='binding_role_handover' and r.metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'
        and r.metadata->>'from_binding_id'=p_binding::text
        and not exists(select 1 from public.clued_audit_receipts m where m.user_id=p_owner and m.context_key='global'
          and m.operation in ('binding_role_handover','binding_role_set') and m.created_at>r.created_at
          and ((m.operation='binding_role_handover' and m.metadata->>'receipt_kind'='BINDING_ROLE_HANDED_OVER'
              and p_binding::text in (m.metadata->>'from_binding_id',m.metadata->>'to_binding_id'))
            or (m.operation='binding_role_set' and m.metadata->>'receipt_kind'='BINDING_ROLE_GRANTED'
              and m.metadata->>'role'='ci-admission' and m.metadata->>'binding_id'=p_binding::text))))
      then 'auto_handed_out'
    when exists(select 1 from public.clued_audit_receipts r where r.user_id=p_owner and r.context_key='global'
        and r.operation in ('binding_role_handover','binding_role_set') and r.created_at>p_now-interval '6 hours'
        and ((r.operation='binding_role_handover' and r.metadata->>'from_binding_id'=p_binding::text
            and r.metadata->>'receipt_kind' in ('BINDING_ROLE_HANDED_OVER','CI_ADMISSION_AUTO_HANDOVER'))
          or (r.operation='binding_role_set' and r.metadata->>'receipt_kind'='BINDING_ROLE_ENDED'
            and r.metadata->>'role'='ci-admission' and r.metadata->>'binding_id'=p_binding::text)))
      then 'cooldown'
  end
$$;

-- Every marked connection other than the holder, in the Owner's order, with
-- the reasons it cannot take over now (eligible when there are none).
-- p_silent_since: X's last heartbeat when X is silent (null otherwise); a
-- candidate must then have reached the server at least twice since
-- (too_few_heartbeats), so the first candidate meeting every condition wins.
create function clued_private.ci_failover_candidates_v1(p_owner uuid,p_holder uuid,p_holder_source text,
  p_silent_since timestamptz,p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m clued_private.ci_failover_members_v1%rowtype; b public.clued_agent_bindings%rowtype;
  n clued_private.ci_node_liveness_v1%rowtype; v_reasons text[]; v_out jsonb:='[]'::jsonb; v_holders jsonb; v_excluded text;
begin
  v_holders:=clued_private.binding_role_holders_v1(p_owner,'ci-admission','{}'::uuid[]);
  for m in select * from clued_private.ci_failover_members_v1 x where x.user_id=p_owner
      and x.binding_id is distinct from p_holder order by x.rank loop
    v_reasons:='{}'::text[];
    b:=null;
    select * into b from public.clued_agent_bindings x where x.id=m.binding_id and x.user_id=p_owner;
    if not found or not clued_private.binding_live_v1(b) or not ('context:read'=any(b.scopes)) then
      v_reasons:=v_reasons||'connection_unavailable'::text; end if;
    if exists(select 1 from jsonb_array_elements(v_holders) h where h->>'binding_id'=m.binding_id::text) then
      v_reasons:=v_reasons||'holds_role'::text; end if;
    n:=clued_private.ci_failover_node_v1(p_owner,m.binding_id);
    if n.node_id is null or n.last_heartbeat_at is null or n.last_heartbeat_at<=p_now-interval '20 minutes' then
      v_reasons:=v_reasons||'heartbeat_stale'::text;
    else
      if n.reported_mode is distinct from 'STANDBY' then v_reasons:=v_reasons||'not_standby'::text; end if;
      if n.reported_probe is distinct from 'not-held' then v_reasons:=v_reasons||'probe_not_clear'::text; end if;
      if n.reported_state is distinct from 'NORMAL' then
        v_reasons:=v_reasons||('state_'||lower(coalesce(n.reported_state,'unknown'))); end if;
      if n.unhealthy_since is not null then v_reasons:=v_reasons||'service_not_running'::text; end if;
      if n.reported_source_sha256 is null then v_reasons:=v_reasons||'source_unknown'::text;
      elsif p_holder_source is not null and n.reported_source_sha256<>p_holder_source then
        v_reasons:=v_reasons||'source_differs_from_holder'::text;
      elsif exists(select 1 from clued_private.ci_node_liveness_v1 ol join clued_private.ci_nodes_v1 o on o.node_id=ol.node_id
          where ol.user_id=p_owner and o.binding_id<>m.binding_id and o.state not in ('retired','revoked')
          and ol.last_heartbeat_at>p_now-interval '24 hours'
          and ol.reported_source_sha256 is not null and ol.reported_source_sha256<>n.reported_source_sha256) then
        v_reasons:=v_reasons||'source_differs'::text;
      end if;
      if p_silent_since is not null and not coalesce(n.heartbeat_previous_at>p_silent_since,false) then
        v_reasons:=v_reasons||'too_few_heartbeats'::text; end if;
    end if;
    v_excluded:=clued_private.ci_failover_exclusion_v1(p_owner,m.binding_id,p_now);
    if v_excluded is not null then v_reasons:=v_reasons||v_excluded; end if;
    v_out:=v_out||jsonb_build_array(jsonb_build_object('binding_id',m.binding_id,'rank',m.rank,
      'agent_name',b.agent_name,'eligible',cardinality(v_reasons)=0,'reasons',to_jsonb(v_reasons),
      'last_heartbeat_at',n.last_heartbeat_at,'heartbeat_previous_at',n.heartbeat_previous_at));
  end loop;
  return v_out;
end $$;

-- An alert receipt, at most one per account, kind and reason per hour.
create function clued_private.ci_failover_alert_v1(p_owner uuid,p_kind text,p_reason text,p_meta jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare v_receipt uuid;
begin
  if exists(select 1 from public.clued_audit_receipts r where r.user_id=p_owner and r.context_key='global'
      and r.operation='ci_admission_failover_alert' and r.metadata->>'receipt_kind'=p_kind
      and r.metadata->>'reason' is not distinct from p_reason and r.created_at>now()-interval '1 hour') then
    return null; end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_owner,null,'global','ci_admission_failover_alert','ci_admission_failover',p_owner::text,1,
    coalesce(p_meta,'{}'::jsonb)||jsonb_build_object('receipt_kind',p_kind,'reason',p_reason,'principal','server_watchdog'))
  returning id into v_receipt;
  return v_receipt;
end $$;

-- A KooYomi Note for the Owner quoting a watchdog receipt, through the M1
-- record path the server's own writes use. Never raises: a Note that cannot
-- be written is reported in the outcome and leaves the handover in place.
create function clued_private.ci_failover_note_v1(p_owner uuid,p_receipt uuid,p_kind text,p_title text,p_content text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_input jsonb; v_result jsonb; v_error text;
begin
  v_input:=jsonb_build_object('operation','create','scope','global','record_type','note','record_schema_version',1,
    'lifecycle_status','active','authority','observed',
    'confidence_reason','Written by the server watchdog from its own receipt '||p_receipt::text||'.',
    'source_refs','[]'::jsonb,
    'source_unavailable_reason','Server watchdog receipt '||p_receipt::text||' (clued_audit_receipts).',
    'idempotency_key','ci-failover-note:'||p_receipt::text,
    'mutation',jsonb_build_object('title',left(p_title,200),'content',p_content,
      'type_fields',jsonb_build_object('note_kind','ci_admission_failover','receipt_id',p_receipt,'receipt_kind',p_kind),
      'relations','{}'::jsonb));
  begin
    v_result:=clued_private.record_mutation_with_terminal_guard(p_owner,null,v_input,clued_private.m1_sha256(v_input));
  exception when others then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','failed','error_code',v_error);
  end;
  if v_result->>'status' is distinct from 'committed' then
    return jsonb_build_object('status',coalesce(v_result->>'status','failed'),'error_code',v_result->>'error_code');
  end if;
  return jsonb_build_object('status','committed','note_id',v_result->'target_refs'->0->'id',
    'receipt_id',v_result->'receipt_id');
end $$;

create function clued_private.ci_failover_name_v1(p_owner uuid,p_binding uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select b.agent_name from public.clued_agent_bindings b where b.id=p_binding and b.user_id=p_owner),
    p_binding::text)
$$;

-- One account's decision, under the role lock. Returns {outcome, ...}.
create function clued_private.ci_admission_failover_owner_v1(p_owner uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare s clued_private.ci_failover_settings_v1%rowtype; v_now timestamptz; v_holders uuid[]; v_holder uuid;
  mx clued_private.ci_failover_members_v1%rowtype; xn clued_private.ci_node_liveness_v1%rowtype; v_anchor timestamptz;
  v_holder_live boolean;
  v_silent boolean; v_stuck boolean; v_candidates jsonb; v_target jsonb; v_trigger text; v_meta jsonb;
  v_done jsonb; v_error text; v_alert uuid; v_note jsonb; v_why text;
begin
  perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||p_owner::text||':ci-admission',0));
  v_now:=clock_timestamp();
  select * into s from clued_private.ci_failover_settings_v1 x where x.user_id=p_owner;
  -- X: the one resident-node (or unspecified) holder, started or not, live or not.
  select array_agg((h->>'binding_id')::uuid order by h->>'binding_id') into v_holders
    from jsonb_array_elements(clued_private.binding_role_holders_v1(p_owner,'ci-admission','{}'::uuid[])) h
    where h->>'purpose' in ('resident-node','unspecified');
  if coalesce(cardinality(v_holders),0)<>1 then
    return jsonb_build_object('outcome','no_single_resident_holder','holders',to_jsonb(coalesce(v_holders,'{}'::uuid[])));
  end if;
  v_holder:=v_holders[1];
  v_holder_live:=coalesce((select clued_private.binding_live_v1(x) from public.clued_agent_bindings x
    where x.id=v_holder and x.user_id=p_owner),false);
  select * into mx from clued_private.ci_failover_members_v1 x where x.user_id=p_owner and x.binding_id=v_holder;
  if not found then return jsonb_build_object('outcome','holder_not_marked','holder',v_holder); end if;
  xn:=clued_private.ci_failover_node_v1(p_owner,v_holder);
  -- X must have heard after it was marked and after the switch was turned on.
  v_anchor:=greatest(mx.marked_at,case when s.enabled then s.enabled_at end);
  if xn.node_id is null or xn.last_heartbeat_at is null or xn.last_heartbeat_at<=v_anchor then
    if v_anchor<=v_now-interval '30 minutes' then
      v_alert:=clued_private.ci_failover_alert_v1(p_owner,'CI_ADMISSION_FAILOVER_WITHHELD','holder_never_heartbeated',
        jsonb_build_object('holder',v_holder,'since',v_anchor,'switch',coalesce(s.enabled,false)));
      return jsonb_build_object('outcome','holder_never_heartbeated','holder',v_holder,'alert_receipt_id',v_alert);
    end if;
    return jsonb_build_object('outcome','holder_not_heard_yet','holder',v_holder);
  end if;
  -- Only loss of contact switches (Decision 199cf3de): a holder whose CI
  -- connection is no longer live is not lost at once; its heartbeats are
  -- refused, so it falls silent and the same 30 minutes apply.
  v_silent:=xn.last_heartbeat_at<=v_now-interval '30 minutes';
  v_stuck:=not v_silent and xn.unhealthy_since is not null and xn.unhealthy_since<=v_now-interval '30 minutes';
  if not v_silent and not v_stuck then
    return jsonb_build_object('outcome','holder_alive','holder',v_holder);
  end if;
  v_trigger:=case when v_silent then 'silence' else 'service_not_running' end;
  v_why:=case when v_silent then '失联 30 分钟' else '连续 30 分钟报服务没在运行或状态快照过旧' end
    ||case when not v_holder_live then '（它的 CI 连接已失效）' else '' end;
  -- A HALTED, PAUSED or unexpired INTAKE_PAUSED holder is never handed out:
  -- its latest readable report decides (UNKNOWN looks back to it).
  if xn.readable_state in ('HALTED','PAUSED')
      or (xn.readable_state='INTAKE_PAUSED' and xn.readable_intake_until>v_now) then
    return jsonb_build_object('outcome','holder_halted_or_paused','holder',v_holder,'readable_state',xn.readable_state);
  end if;
  -- After 30 minutes of silence a candidate must have reached the server at
  -- least twice meanwhile (otherwise the server or the network may have been
  -- down): one of the candidate conditions, so the first that meets all wins.
  v_candidates:=clued_private.ci_failover_candidates_v1(p_owner,v_holder,xn.reported_source_sha256,
    case when v_silent then xn.last_heartbeat_at end,v_now);
  select c into v_target from jsonb_array_elements(v_candidates) c where (c->>'eligible')::boolean
    order by (c->>'rank')::integer limit 1;
  v_meta:=jsonb_build_object('holder',v_holder,'trigger',v_trigger,'holder_connection_live',v_holder_live,
    'holder_last_heartbeat_at',xn.last_heartbeat_at,
    'holder_unhealthy_since',xn.unhealthy_since,'candidates',v_candidates,'switch',coalesce(s.enabled,false));
  if v_target is null then
    -- Someone was fit but for the heartbeats during the silence: alert only.
    select c into v_target from jsonb_array_elements(v_candidates) c where c->'reasons'='["too_few_heartbeats"]'::jsonb
      order by (c->>'rank')::integer limit 1;
    if v_target is not null then
      v_alert:=clued_private.ci_failover_alert_v1(p_owner,'CI_ADMISSION_FAILOVER_WITHHELD','receiver_not_alive',
        v_meta||jsonb_build_object('target',v_target->'binding_id'));
      return jsonb_build_object('outcome','receiver_not_alive','holder',v_holder,'target',v_target->'binding_id',
        'candidates',v_candidates,'alert_receipt_id',v_alert);
    end if;
    v_alert:=clued_private.ci_failover_alert_v1(p_owner,'CI_ADMISSION_FAILOVER_NO_TARGET',null,v_meta);
    if v_alert is not null then
      v_note:=clued_private.ci_failover_note_v1(p_owner,v_alert,'CI_ADMISSION_FAILOVER_NO_TARGET',
        'CI 准入自动接班：没有可接班的节点',
        '当前持有 CI 准入的常驻节点 '||clued_private.ci_failover_name_v1(p_owner,v_holder)||' '||v_why
          ||'，但没有符合条件的接班节点，所以没有交接，请处理（例如在 /bindings 手动移交）。各节点不能接班的原因：'
          ||coalesce((select string_agg(coalesce(c->>'agent_name',c->>'binding_id')||'：'
              ||(select string_agg(r,'、') from jsonb_array_elements_text(c->'reasons') r),'；'
              order by (c->>'rank')::integer) from jsonb_array_elements(v_candidates) c),'没有其他标了资格的节点')
          ||'。回执 '||v_alert::text||'。');
    end if;
    return jsonb_build_object('outcome','no_target','holder',v_holder,'trigger',v_trigger,
      'candidates',v_candidates,'alert_receipt_id',v_alert,'note',v_note);
  end if;
  if not coalesce(s.enabled,false) then
    v_alert:=clued_private.ci_failover_alert_v1(p_owner,'CI_ADMISSION_FAILOVER_WITHHELD','switch_off',
      v_meta||jsonb_build_object('target',v_target->'binding_id'));
    return jsonb_build_object('outcome','switch_off','holder',v_holder,'target',v_target->'binding_id',
      'alert_receipt_id',v_alert);
  end if;
  begin
    v_done:=clued_private.binding_role_handover_core_v1(p_owner,v_holder,(v_target->>'binding_id')::uuid,null,
      jsonb_build_object('receipt_kind','CI_ADMISSION_AUTO_HANDOVER','principal','server_watchdog',
        'trigger',v_trigger,'holder_connection_live',v_holder_live,'holder_last_heartbeat_at',xn.last_heartbeat_at,
        'holder_unhealthy_since',xn.unhealthy_since,'candidates',v_candidates,
        'nodes',clued_private.ci_failover_nodes_v1(p_owner)));
  exception when others then
    get stacked diagnostics v_error=message_text;
    v_alert:=clued_private.ci_failover_alert_v1(p_owner,'CI_ADMISSION_FAILOVER_WITHHELD','handover_refused',
      v_meta||jsonb_build_object('target',v_target->'binding_id','error_code',v_error));
    return jsonb_build_object('outcome','handover_refused','holder',v_holder,'target',v_target->'binding_id',
      'error_code',v_error,'alert_receipt_id',v_alert);
  end;
  v_note:=clued_private.ci_failover_note_v1(p_owner,(v_done->>'receipt_id')::uuid,'CI_ADMISSION_AUTO_HANDOVER',
    'CI 准入已自动接班：'||clued_private.ci_failover_name_v1(p_owner,v_holder)||' → '
      ||clued_private.ci_failover_name_v1(p_owner,(v_target->>'binding_id')::uuid),
    '服务端看门狗因为 '||clued_private.ci_failover_name_v1(p_owner,v_holder)||' '||v_why||'，把 CI 准入自动移交给 '
      ||clued_private.ci_failover_name_v1(p_owner,(v_target->>'binding_id')::uuid)||'（按你在 /bindings 排的次序选出），新持有从 '
      ||(v_done->>'effective_at')||' 起生效（5 分钟后）。被交出的节点以后不会被自动选回，除非你手动移交一次。回执 '
      ||(v_done->>'receipt_id')||'。');
  return jsonb_build_object('outcome','handed_over','holder',v_holder,'target',v_target->'binding_id',
    'trigger',v_trigger,'candidates',v_candidates,'note',v_note)||v_done;
end $$;

-- The pg_cron job. Records its own time, then decides every account that has
-- marked connections; one account's failure never stops the others.
create function clued_private.ci_admission_failover_tick_v1() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid; v_out jsonb:='[]'::jsonb; v_result jsonb; v_error text; v_tick timestamptz:=clock_timestamp();
begin
  insert into clued_private.ci_failover_watchdog_v1(singleton,last_tick_at,ticks) values(true,v_tick,1)
  on conflict (singleton) do update set last_tick_at=excluded.last_tick_at,
    ticks=clued_private.ci_failover_watchdog_v1.ticks+1;
  for v_owner in select distinct m.user_id from clued_private.ci_failover_members_v1 m order by 1 loop
    begin
      v_result:=clued_private.ci_admission_failover_owner_v1(v_owner);
    exception when others then
      get stacked diagnostics v_error=message_text;
      v_result:=jsonb_build_object('outcome','error','error_code',v_error,'alert_receipt_id',
        clued_private.ci_failover_alert_v1(v_owner,'CI_ADMISSION_FAILOVER_WITHHELD','watchdog_error',
          jsonb_build_object('error_code',v_error)));
    end;
    v_out:=v_out||jsonb_build_array(jsonb_build_object('user_id',v_owner)||v_result);
  end loop;
  return jsonb_build_object('status','ok','tick_at',v_tick,'accounts',v_out);
end $$;

-- ---------------------------------------------------------------------------
-- The Owner's settings (/bindings, two Native steps).

create function clued_private.ci_failover_setting_view_v1(p_owner uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('enabled',s.enabled,'enabled_at',s.enabled_at,'version',s.version,
      'updated_at',s.updated_at,'receipt_id',s.receipt_id)
    from clued_private.ci_failover_settings_v1 s where s.user_id=p_owner),
    jsonb_build_object('enabled',false,'enabled_at',null,'version',0,'updated_at',null,'receipt_id',null))
$$;

-- Connections as the Owner sees them in a list, in the given order.
create function clued_private.ci_failover_list_view_v1(p_owner uuid,p_ids uuid[]) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('binding_id',i.id,'rank',i.ord,'agent_name',b.agent_name,
      'vendor',b.vendor,'live',coalesce(clued_private.binding_live_v1(b),false),
      'marked_at',m.marked_at) order by i.ord),'[]'::jsonb)
  from unnest(p_ids) with ordinality i(id,ord)
  left join public.clued_agent_bindings b on b.id=i.id and b.user_id=p_owner
  left join clued_private.ci_failover_members_v1 m on m.user_id=p_owner and m.binding_id=i.id
$$;

create function clued_private.ci_failover_member_ids_v1(p_owner uuid) returns uuid[]
language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(m.binding_id order by m.rank),'{}'::uuid[])
  from clued_private.ci_failover_members_v1 m where m.user_id=p_owner
$$;

-- A connection as a heartbeat-link view shows it.
create function clued_private.ci_failover_binding_view_v1(p_owner uuid,p_binding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,'vendor',b.vendor,'scopes',to_jsonb(b.scopes),
    'live',clued_private.binding_live_v1(b))
  from public.clued_agent_bindings b where b.id=p_binding and b.user_id=p_owner
$$;

-- The rules of a change, for both steps. p_choices: {change: members,
-- members: [binding ids in order], base_version}, {change: switch, enabled,
-- base_version}, {change: heartbeat_link, heartbeat_binding_id,
-- node_binding_id, base_version} or {change: heartbeat_unlink,
-- heartbeat_binding_id, base_version}. Returns the view the Owner confirms.
create function clued_private.ci_failover_change_view_v1(p_owner uuid,p_choices jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_setting jsonb:=clued_private.ci_failover_setting_view_v1(p_owner); v_ids uuid[]; v_current uuid[];
  b public.clued_agent_bindings%rowtype; v_id uuid; v_holders jsonb; v_hb uuid; v_node uuid;
  k clued_private.ci_node_heartbeat_link_v1%rowtype;
begin
  if jsonb_typeof(p_choices->'base_version') is distinct from 'number'
      or (p_choices->>'base_version') !~ '^[0-9]{1,18}$' then
    raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
  if (p_choices->>'base_version')::bigint<>(v_setting->>'version')::bigint then
    raise exception 'resident_failover_version_conflict' using errcode='40001'; end if;
  v_current:=clued_private.ci_failover_member_ids_v1(p_owner);
  if p_choices->>'change'='switch' then
    if jsonb_typeof(p_choices->'enabled') is distinct from 'boolean' then
      raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
    if (p_choices->>'enabled')::boolean=(v_setting->>'enabled')::boolean then
      raise exception 'resident_failover_unchanged' using errcode='22023'; end if;
    return jsonb_build_object('kind','resident_failover','change','switch','setting',v_setting,
      'enabled',(p_choices->>'enabled')::boolean,'members',clued_private.ci_failover_list_view_v1(p_owner,v_current),
      'rules',clued_private.ci_failover_rules_v1());
  end if;
  if p_choices->>'change' in ('heartbeat_link','heartbeat_unlink') then
    if jsonb_typeof(p_choices->'heartbeat_binding_id') is distinct from 'string'
        or p_choices->>'heartbeat_binding_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or (p_choices->>'change'='heartbeat_link' and (jsonb_typeof(p_choices->'node_binding_id') is distinct from 'string'
          or p_choices->>'node_binding_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or p_choices->>'node_binding_id'=p_choices->>'heartbeat_binding_id')) then
      raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
    v_hb:=(p_choices->>'heartbeat_binding_id')::uuid;
    select * into k from clued_private.ci_node_heartbeat_link_v1 x where x.user_id=p_owner
      and x.heartbeat_binding_id=v_hb and x.revoked_at is null;
    if p_choices->>'change'='heartbeat_unlink' then
      if k.link_id is null then raise exception 'resident_failover_heartbeat_not_linked' using errcode='22023'; end if;
      return jsonb_build_object('kind','resident_failover','change','heartbeat_unlink','setting',v_setting,
        'heartbeat',clued_private.ci_failover_binding_view_v1(p_owner,v_hb),
        'node',clued_private.ci_failover_binding_view_v1(p_owner,k.node_binding_id),
        'rules',clued_private.ci_failover_rules_v1());
    end if;
    v_node:=(p_choices->>'node_binding_id')::uuid;
    select * into b from public.clued_agent_bindings x where x.id=v_hb and x.user_id=p_owner;
    if not found or not clued_private.binding_live_v1(b) then
      raise exception 'resident_failover_binding_invalid' using errcode='22023'; end if;
    if not ('context:read'=any(b.scopes)) then
      raise exception 'resident_failover_scope_missing' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(clued_private.binding_role_holders_v1(p_owner,'ci-admission','{}'::uuid[])) h
        where h->>'binding_id'=v_hb::text) then
      raise exception 'resident_failover_heartbeat_holds_role' using errcode='22023'; end if;
    if exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id=p_owner and n.binding_id=v_hb
        and n.state not in ('retired','revoked')) then
      raise exception 'resident_failover_heartbeat_is_node' using errcode='22023'; end if;
    if k.node_binding_id=v_node then raise exception 'resident_failover_unchanged' using errcode='22023'; end if;
    if k.link_id is not null then raise exception 'resident_failover_heartbeat_linked' using errcode='22023'; end if;
    select * into b from public.clued_agent_bindings x where x.id=v_node and x.user_id=p_owner;
    if not found or not clued_private.binding_live_v1(b) or not exists(select 1 from clued_private.ci_nodes_v1 n
        where n.user_id=p_owner and n.binding_id=v_node and n.state not in ('retired','revoked')) then
      raise exception 'resident_failover_node_invalid' using errcode='22023'; end if;
    return jsonb_build_object('kind','resident_failover','change','heartbeat_link','setting',v_setting,
      'heartbeat',clued_private.ci_failover_binding_view_v1(p_owner,v_hb),
      'node',clued_private.ci_failover_binding_view_v1(p_owner,v_node),
      'replaces',(select clued_private.ci_failover_binding_view_v1(p_owner,x.heartbeat_binding_id)
        from clued_private.ci_node_heartbeat_link_v1 x where x.user_id=p_owner and x.node_binding_id=v_node
          and x.revoked_at is null),
      'rules',clued_private.ci_failover_rules_v1());
  end if;
  if p_choices->>'change' is distinct from 'members' or jsonb_typeof(p_choices->'members') is distinct from 'array'
      or jsonb_array_length(p_choices->'members')>50
      or exists(select 1 from jsonb_array_elements(p_choices->'members') x where jsonb_typeof(x) is distinct from 'string'
        or x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
  v_ids:=array(select (x#>>'{}')::uuid from jsonb_array_elements(p_choices->'members') with ordinality e(x,o) order by o);
  if cardinality(v_ids)<>(select count(distinct i) from unnest(v_ids) i) then
    raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
  if v_ids=v_current then raise exception 'resident_failover_unchanged' using errcode='22023'; end if;
  v_holders:=clued_private.binding_role_holders_v1(p_owner,'ci-admission','{}'::uuid[]);
  foreach v_id in array v_ids loop
    select * into b from public.clued_agent_bindings x where x.id=v_id and x.user_id=p_owner;
    if not found or not clued_private.binding_live_v1(b) then
      raise exception 'resident_failover_binding_invalid' using errcode='22023'; end if;
    if not ('context:read'=any(b.scopes)) then
      raise exception 'resident_failover_scope_missing' using errcode='22023'; end if;
    -- A parking spot or an "other" holder (the GitHub environment) is not a resident node.
    if exists(select 1 from jsonb_array_elements(v_holders) h where h->>'binding_id'=v_id::text
        and h->>'purpose' in ('parking','other')) then
      raise exception 'resident_failover_purpose_invalid' using errcode='22023'; end if;
  end loop;
  return jsonb_build_object('kind','resident_failover','change','members','setting',v_setting,
    'members_before',clued_private.ci_failover_list_view_v1(p_owner,v_current),
    'members',clued_private.ci_failover_list_view_v1(p_owner,v_ids),
    'removed',clued_private.ci_failover_list_view_v1(p_owner,
      array(select c from unnest(v_current) with ordinality u(c,o) where not (c=any(v_ids)) order by o)),
    'rules',clued_private.ci_failover_rules_v1());
end $$;

-- clued_resident_failover_v1: {} -> the switch, the marked connections in
-- order, the connections that can be marked, every node's last heartbeat and
-- self-report, the holder, the watchdog's last tick and recent alerts and
-- automatic handovers, and every live connection's id (binding_id, a public
-- identifier: the installer takes a heartbeat connection's by
-- -HeartbeatBindingId) with the node its heartbeats are linked to, if any.
-- VOLATILE although it only reads (the owner check).
create function public.clued_resident_failover_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_holders jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
  v_holders:=clued_private.binding_role_holders_v1(v_owner,'ci-admission','{}'::uuid[]);
  return jsonb_build_object('status','ok','observed_at',clock_timestamp(),
    'setting',clued_private.ci_failover_setting_view_v1(v_owner),
    'rules',clued_private.ci_failover_rules_v1(),
    'members',clued_private.ci_failover_list_view_v1(v_owner,clued_private.ci_failover_member_ids_v1(v_owner)),
    'holders',v_holders,
    'connections',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,
        'vendor',b.vendor,'created_at',b.created_at,
        'purpose',(select h->'purpose' from jsonb_array_elements(v_holders) h where h->>'binding_id'=b.id::text limit 1))
      order by b.created_at desc,b.id)
      from public.clued_agent_bindings b where b.user_id=v_owner and clued_private.binding_live_v1(b)
        and 'context:read'=any(b.scopes)),'[]'::jsonb),
    'bindings',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,
        'vendor',b.vendor,'scopes',to_jsonb(b.scopes),'created_at',b.created_at,
        'is_node',exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id=v_owner and n.binding_id=b.id
          and n.state not in ('retired','revoked')),
        'purpose',(select h->'purpose' from jsonb_array_elements(v_holders) h where h->>'binding_id'=b.id::text limit 1),
        'heartbeat_for',(select jsonb_build_object('node_binding_id',k.node_binding_id,'node_agent_name',n.agent_name,
            'linked_at',k.linked_at)
          from clued_private.ci_node_heartbeat_link_v1 k join public.clued_agent_bindings n on n.id=k.node_binding_id
          where k.user_id=v_owner and k.heartbeat_binding_id=b.id and k.revoked_at is null))
      order by b.created_at desc,b.id)
      from public.clued_agent_bindings b where b.user_id=v_owner and clued_private.binding_live_v1(b)),'[]'::jsonb),
    'nodes',clued_private.ci_failover_nodes_v1(v_owner),
    'watchdog',clued_private.ci_failover_watchdog_view_v1(),
    'alerts',coalesce((select jsonb_agg(jsonb_build_object('receipt_id',r.id,'created_at',r.created_at,
        'receipt_kind',r.metadata->'receipt_kind','reason',r.metadata->'reason','holder',r.metadata->'holder',
        'target',r.metadata->'target','from_binding_id',r.metadata->'from_binding_id',
        'to_binding_id',r.metadata->'to_binding_id','trigger',r.metadata->'trigger',
        'effective_at',r.metadata->'effective_at','candidates',r.metadata->'candidates') order by r.created_at desc,r.id)
      from (select * from public.clued_audit_receipts x where x.user_id=v_owner
          and x.created_at>clock_timestamp()-interval '7 days'
          and (x.operation='ci_admission_failover_alert'
            or (x.operation='binding_role_handover' and x.metadata->>'receipt_kind'='CI_ADMISSION_AUTO_HANDOVER'))
        order by x.created_at desc,x.id limit 20) r),'[]'::jsonb));
end $$;

-- Step 1. Input {change: members, members, base_version} or {change: switch,
-- enabled, base_version}. A newer issue revokes the older outstanding token.
create function public.clued_resident_failover_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_view jsonb; v_digest text; v_raw text;
  v_token_id uuid; v_expires timestamptz; v_now timestamptz; v_error text; v_choices jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or p_input->>'change' is null
        or p_input->>'change' not in ('members','switch','heartbeat_link','heartbeat_unlink')
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('change','base_version')
          and k<>all(case p_input->>'change' when 'members' then array['members'] when 'switch' then array['enabled']
            when 'heartbeat_link' then array['heartbeat_binding_id','node_binding_id']
            else array['heartbeat_binding_id'] end)) then
      raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
    v_choices:=p_input;
    v_view:=clued_private.ci_failover_change_view_v1(v_owner,v_choices);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='resident_failover' and subject_key='resident-failover:ci-admission'
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_rfo_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'resident_failover','resident-failover:ci-admission',(v_choices->>'base_version')::bigint,v_choices,
      v_view,v_digest,encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '40001' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2: consume the token, re-check under the role lock (the watchdog, the
-- role marks and the handovers take it too), re-render the view, then change
-- the list, the switch or a heartbeat link.
create function public.clued_resident_failover_set_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; v_receipt uuid; v_now timestamptz; v_error text; v_state text; c jsonb;
  v_view jsonb; v_version bigint; v_ids uuid[]; v_marked jsonb; v_kind text; v_setting jsonb; i integer;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'resident_failover_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens x
      where x.user_id=v_owner and x.action='resident_failover' and x.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id)
        ||clued_private.ci_failover_setting_view_v1(v_owner);
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    c:=v_token.native_choices;
    perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||v_owner::text||':ci-admission',0));
    perform 1 from clued_private.ci_failover_settings_v1 x where x.user_id=v_owner for update;
    v_view:=clued_private.ci_failover_change_view_v1(v_owner,c);
    if clued_private.m1_sha256(v_view)<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    v_setting:=clued_private.ci_failover_setting_view_v1(v_owner);
    v_version:=(v_setting->>'version')::bigint+1;
    v_kind:=case c->>'change' when 'members' then 'RESIDENT_FAILOVER_MEMBERS_SET'
      when 'heartbeat_link' then 'CI_NODE_HEARTBEAT_LINKED' when 'heartbeat_unlink' then 'CI_NODE_HEARTBEAT_UNLINKED'
      else case when (c->>'enabled')::boolean then 'RESIDENT_FAILOVER_ENABLED' else 'RESIDENT_FAILOVER_DISABLED' end end;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','resident_failover_set','resident_failover',v_owner::text,v_version,
      jsonb_build_object('receipt_kind',v_kind,'change',c->>'change','base_version',(c->>'base_version')::bigint,
        'enabled',case when c->>'change'='switch' then (c->>'enabled')::boolean else (v_setting->>'enabled')::boolean end,
        'members',v_view->'members','members_before',v_view->'members_before',
        'heartbeat',v_view->'heartbeat','node',v_view->'node','replaces',v_view->'replaces',
        'token_id',v_token.id,'view_digest',v_token.view_digest,
        'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    if c->>'change'='members' then
      v_ids:=array(select (x#>>'{}')::uuid from jsonb_array_elements(c->'members') with ordinality e(x,o) order by o);
      select coalesce(jsonb_object_agg(m.binding_id::text,m.marked_at),'{}'::jsonb) into v_marked
        from clued_private.ci_failover_members_v1 m where m.user_id=v_owner;
      delete from clued_private.ci_failover_members_v1 where user_id=v_owner;
      for i in 1..coalesce(cardinality(v_ids),0) loop
        insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id)
        values(v_owner,v_ids[i],i,coalesce((v_marked->>v_ids[i]::text)::timestamptz,v_now),v_receipt);
      end loop;
    elsif c->>'change'='heartbeat_link' then
      -- The node's previous link, if any, ends here.
      update clued_private.ci_node_heartbeat_link_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
        where user_id=v_owner and node_binding_id=(c->>'node_binding_id')::uuid and revoked_at is null;
      insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id)
      values(v_owner,(c->>'heartbeat_binding_id')::uuid,(c->>'node_binding_id')::uuid,v_now,v_receipt);
    elsif c->>'change'='heartbeat_unlink' then
      update clued_private.ci_node_heartbeat_link_v1 set revoked_at=v_now,revoked_receipt_id=v_receipt
        where user_id=v_owner and heartbeat_binding_id=(c->>'heartbeat_binding_id')::uuid and revoked_at is null;
      if not found then raise exception 'resident_failover_heartbeat_not_linked' using errcode='22023'; end if;
    end if;
    insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)
    values(v_owner,
      case when c->>'change'='switch' then (c->>'enabled')::boolean else (v_setting->>'enabled')::boolean end,
      case when c->>'change'='switch' then case when (c->>'enabled')::boolean then v_now end
        else (v_setting->>'enabled_at')::timestamptz end,
      v_version,v_now,v_receipt)
    on conflict (user_id) do update set enabled=excluded.enabled,enabled_at=excluded.enabled_at,
      version=excluded.version,updated_at=excluded.updated_at,receipt_id=excluded.receipt_id;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'change',c->>'change')
      ||clued_private.ci_failover_setting_view_v1(v_owner)
      ||jsonb_build_object('members',clued_private.ci_failover_list_view_v1(v_owner,clued_private.ci_failover_member_ids_v1(v_owner)));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','resident_failover_set','resident_failover',v_owner::text,1,
        jsonb_build_object('receipt_kind','RESIDENT_FAILOVER_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Schedule (where pg_cron is installed; schema-only fixtures have none) and
-- grants: the three Owner RPCs to authenticated; everything else to nobody.

do $schedule$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('clued-ci-admission-failover','* * * * *',
      'select clued_private.ci_admission_failover_tick_v1()');
  else
    raise warning 'ci_admission_failover_scheduler_absent: pg_cron is not installed; the failover watchdog does not run';
  end if;
end $schedule$;

revoke all on function
  clued_private.ci_failover_rules_v1(),
  clued_private.binding_role_handover_core_v1(uuid,uuid,uuid,text,jsonb),
  clued_private.ci_failover_node_v1(uuid,uuid),
  clued_private.ci_failover_node_view_v1(uuid,uuid),
  clued_private.ci_failover_watchdog_view_v1(),
  clued_private.ci_failover_received_v1(uuid,uuid),
  clued_private.ci_failover_nodes_v1(uuid),
  clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb),
  clued_private.ci_failover_nodes_status_v1(public.clued_agent_bindings,jsonb),
  clued_private.ci_failover_exclusion_v1(uuid,uuid,timestamptz),
  clued_private.ci_failover_candidates_v1(uuid,uuid,text,timestamptz,timestamptz),
  clued_private.ci_failover_note_v1(uuid,uuid,text,text,text),
  clued_private.ci_failover_name_v1(uuid,uuid),
  clued_private.ci_failover_watermarks_v1(uuid),
  clued_private.ci_sweep_watermark_v1(public.clued_agent_bindings,jsonb),
  clued_private.ci_failover_alert_v1(uuid,text,text,jsonb),
  clued_private.ci_admission_failover_owner_v1(uuid),
  clued_private.ci_admission_failover_tick_v1(),
  clued_private.ci_failover_setting_view_v1(uuid),
  clued_private.ci_failover_binding_view_v1(uuid,uuid),
  clued_private.ci_failover_list_view_v1(uuid,uuid[]),
  clued_private.ci_failover_member_ids_v1(uuid),
  clued_private.ci_failover_change_view_v1(uuid,jsonb),
  clued_private.work_claim_ci_command_v1(text,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_resident_failover_v1(jsonb),
  public.clued_resident_failover_confirmation_issue_v1(jsonb),
  public.clued_resident_failover_set_v1(jsonb),
  public.clued_binding_role_handover_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_resident_failover_v1(jsonb),
  public.clued_resident_failover_confirmation_issue_v1(jsonb),
  public.clued_resident_failover_set_v1(jsonb),
  public.clued_binding_role_handover_v1(jsonb) to authenticated;

-- The watchdog's receipt reads (handover and role receipts, alerts), all
-- written with context_key global. Last, so the write-blocking build is short
-- and comes after everything else in this transaction.
create index if not exists clued_audit_receipts_ci_failover_v1 on public.clued_audit_receipts(user_id,created_at desc)
  where context_key='global' and operation in ('binding_role_handover','binding_role_set','ci_admission_failover_alert');

notify pgrst,'reload schema';
