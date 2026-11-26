-- Same-node connection replacement. Native account session only; never restores
-- an old token, changes a duty holder, or widens a Binding's authorization.

create function clued_private.ci_binding_expires_at_v1(b public.clued_agent_bindings) returns timestamptz
language sql stable security definer set search_path='' as $$
  select least((to_jsonb(b)->>'expires_at')::timestamptz,
    (select a.expires_at from clued_private.authorizations_v12 a where a.binding_id=b.id and a.owner_id=b.user_id),
    (select r.retire_at from clued_private.binding_retirements_v1 r where r.binding_id=b.id and r.owner_id=b.user_id))
$$;

-- Append-only business receipt ledger also supplies operation-key idempotency.
create table clued_private.ci_node_binding_rebinds_v1 (
  user_id uuid not null references auth.users(id), project_id uuid not null references public.clued_projects(id),
  node_id uuid not null references clued_private.ci_nodes_v1(node_id), idempotency_key text not null,
  request_digest text not null, receipt_id uuid not null references public.clued_audit_receipts(id),
  result jsonb not null, created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,idempotency_key)
);
alter table clued_private.ci_node_binding_rebinds_v1 enable row level security;
revoke all on clued_private.ci_node_binding_rebinds_v1 from public,anon,authenticated,service_role,clued_worker_gateway;
create trigger ci_node_binding_rebinds_permanent_v1 before update or delete on clued_private.ci_node_binding_rebinds_v1
  for each row execute function clued_private.ci_append_only_guard_v1();
create trigger ci_node_rebind_receipts_permanent_v1 before update or delete on public.clued_audit_receipts
  for each row when (old.operation in ('ci_node_binding_rebind','ci_node_binding_rebind_rejected') or old.object_type='ci_connection_expiry')
  execute function clued_private.ci_append_only_guard_v1();

-- Phase changes lock work, pool, then role; handovers lock role before bindings.
-- Readers may already hold a binding when they enter CI. Never wait on those
-- rows while holding the CI locks. A busy rebind can retry the same confirmation.
create function clued_private.ci_node_rebind_lock_v1(u uuid,p uuid,c jsonb) returns void
language plpgsql volatile security definer set search_path='' as $$ declare b uuid; begin
  perform clued_private.authorization_writer_guard_v2(u);
  perform clued_private.work_claim_lock(u);
  perform pg_advisory_xact_lock(hashtextextended('ci-pool:'||u||':'||p,0));
  if not pg_try_advisory_xact_lock(hashtextextended('clued-binding-role:'||u::text||':ci-admission',0)) then
    raise exception 'CI_REBIND_BUSY' using errcode='55P03'; end if;
  for b in select x.id from public.clued_agent_bindings x where x.user_id=u and
    (x.id in ((c->>'old_binding_id')::uuid,(c->>'new_binding_id')::uuid)
      or x.id in (select k.heartbeat_binding_id from clued_private.ci_node_heartbeat_link_v1 k
        where k.user_id=u and k.node_binding_id=(c->>'old_binding_id')::uuid and k.revoked_at is null)) order by x.id for update nowait loop
    perform 1 from clued_private.authorizations_v12 a where a.owner_id=u and a.binding_id=b for update nowait;
  end loop;
  perform 1 from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  perform 1 from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=(c->>'node_id')::uuid for update;
exception when lock_not_available then
  raise exception 'CI_REBIND_BUSY' using errcode='55P03';
end $$;

create function clued_private.ci_node_rebind_view_v1(u uuid,p uuid,c jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; old public.clued_agent_bindings; fresh public.clued_agent_bindings;
  a clued_private.authorizations_v12; links jsonb; roles jsonb; members jsonb; expiry timestamptz;
begin
  select * into n from clued_private.ci_nodes_v1 where node_id=(c->>'node_id')::uuid and user_id=u and project_id=p;
  if not found then raise exception 'CI_NODE_NOT_FOUND' using errcode='42501'; end if;
  if n.state in ('revoked','retired') then raise exception 'CI_NODE_TRANSITION_INVALID' using errcode='42501'; end if;
  if n.version<>(c->>'base_version')::bigint or n.binding_generation<>(c->>'binding_generation')::bigint
      or n.binding_id<>(c->>'old_binding_id')::uuid then raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  select * into old from public.clued_agent_bindings where id=n.binding_id and user_id=u;
  if exists(select 1 from clued_private.ci_nodes_v1 x where x.binding_id=old.id and x.node_id<>n.node_id
      and x.state not in ('revoked','retired'))
    or exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.heartbeat_binding_id=old.id and k.revoked_at is null) then
    raise exception 'CI_REBIND_OLD_CONNECTION_SHARED' using errcode='55000'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=old.id and owner_id=u;
  -- No ambiguous revocation: only a proved authorization/retirement expiry
  -- at/before the sweep's recorded revocation, matching audit, no explicit revoke.
  if old.id is null or exists(select 1 from clued_private.authorization_audit_v12 x
      where x.owner_id=u and x.binding_id=old.id and (x.operation ~* '(revok|compromis|leak)'
        or old.revoked_at is not null and x.recorded_at>=old.revoked_at and x.operation<>'expired'))
    or (old.revoked_at is not null or a.revoked_at is not null) and not coalesce((
      old.revoked_at is not null and (a.binding_id is null or a.revoked_at=old.revoked_at)
      and clued_private.ci_binding_expires_at_v1(old)<=old.revoked_at and exists(select 1 from clued_private.authorization_audit_v12 x
        where x.owner_id=u and x.binding_id=old.id and x.operation='expired' and x.recorded_at>=old.revoked_at)),false) then
    raise exception 'CI_REBIND_OLD_REVOCATION_UNSAFE' using errcode='42501'; end if;
  select * into fresh from public.clued_agent_bindings where id=(c->>'new_binding_id')::uuid and user_id=u;
  expiry:=clued_private.ci_binding_expires_at_v1(fresh);
  if fresh.id is null or fresh.id=old.id or not clued_private.binding_live_v1(fresh)
      or expiry<=clock_timestamp() or not ('context:read'=any(fresh.scopes))
      or not ('*'=any(fresh.context_keys) or ('project:'||p)=any(fresh.context_keys)) then
    raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  perform clued_private.authorization_assert_entry_v12(fresh.id,'scope','project:'||p,'canonical','read');
  if exists(select 1 from clued_private.ci_nodes_v1 x where x.binding_id=fresh.id and x.state not in ('revoked','retired'))
    or exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.revoked_at is null
      and (k.heartbeat_binding_id=fresh.id or k.node_binding_id=fresh.id))
    or exists(select 1 from clued_private.ci_failover_members_v1 m where m.binding_id=fresh.id)
    or exists(select 1 from clued_private.binding_roles_v1 r where r.binding_id=fresh.id and r.revoked_at is null) then
    raise exception 'CI_REBIND_TARGET_IN_USE' using errcode='55000'; end if;
  -- A CI connection may carry only its explicitly marked resident-node use.
  -- Release and upgrade doors remain separate connections; never copy them.
  if exists(select 1 from clued_private.binding_roles_v1 r where r.binding_id=old.id and r.revoked_at is null
      and (r.role<>'ci-admission' or r.purpose<>'resident-node')) then
    raise exception 'CI_REBIND_ROLE_UNSAFE' using errcode='55000'; end if;
  if exists(select 1 from clued_private.ci_duty_holder_v1(u,p) h where h.binding_id=old.id or h.node_id=n.node_id)
    or (clued_private.ci_duty_phase_v1(u,p)<4 and clued_private.binding_role_in_force_v1(u,old.id,'ci-admission')) then
    raise exception 'CI_REBIND_DUTY_HANDOVER_REQUIRED' using errcode='55000'; end if;
  if exists(select 1 from clued_private.ci_train_lease_v1 l where l.user_id=u and l.project_id=p
      and (l.holder_node_id=n.node_id or l.holder_binding_id=old.id) and l.state not in ('unheld','silence'))
    or exists(select 1 from clued_private.ci_job_leases_v1 l where l.holder_node_id=n.node_id and l.state='current')
    or exists(select 1 from clued_private.ci_jobs_v1 j join clued_private.ci_job_leases_v1 l on l.job_id=j.job_id
      where l.holder_node_id=n.node_id and l.generation=j.current_generation
        and j.state in ('leased','started','result_ready','publication_pending','uncertain'))
    or exists(select 1 from clued_private.ci_publish_keys_v1 k where k.publisher_node_id=n.node_id and k.state in ('reserved','proposed','unknown'))
    or exists(select 1 from clued_private.ci_green_ledger_v1 g where g.publisher_node_id=n.node_id
      and g.state not in ('abandoned','revoke_confirmed','merged'))
    or exists(select m.effect_key from clued_private.ci_green_mirror_v1 m where m.publisher_node_id=n.node_id
      group by m.effect_key having bool_and(m.phase in ('intent','posted','settled'))) then
    raise exception 'CI_REBIND_NOT_DRAINED' using errcode='55000'; end if;
  select coalesce(jsonb_agg(to_jsonb(k)||jsonb_build_object('heartbeat_authorization',to_jsonb(ha),
    'heartbeat_connection',to_jsonb(h)-'token_hash'-'last_used_at') order by k.link_id),'[]') into links
    from clued_private.ci_node_heartbeat_link_v1 k join public.clued_agent_bindings h on h.id=k.heartbeat_binding_id
    left join clued_private.authorizations_v12 ha on ha.binding_id=h.id
    where k.user_id=u and k.node_binding_id=old.id and k.revoked_at is null;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into roles from clued_private.binding_roles_v1 r
    where r.user_id=u and r.revoked_at is null;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.rank),'[]') into members from clued_private.ci_failover_members_v1 m where m.user_id=u;
  return jsonb_build_object('schema','clued.ci-node-binding-rebind/1','choices',c,'node',
    to_jsonb(n)-'last_heartbeat_at'-'heartbeat_sequence'-'clock_skew_ms',
    'old_connection',to_jsonb(old)-'token_hash'-'last_used_at','old_authorization',to_jsonb(a),
    'new_connection',to_jsonb(fresh)-'token_hash'-'last_used_at',
    'new_authorization',(select to_jsonb(x) from clued_private.authorizations_v12 x where x.binding_id=fresh.id),
    'new_entries',(select coalesce(jsonb_agg(to_jsonb(e) order by e.resource_kind,e.resource_id,e.environment),'[]')
      from clued_private.authorization_entries_v12 e where e.binding_id=fresh.id),
    'connection_expires_at',expiry,'heartbeat_links',links,'roles',roles,'failover_members',members,
    'failover_setting',(select to_jsonb(s) from clued_private.ci_failover_settings_v1 s where s.user_id=u),
    'pool',clued_private.ci_pool_view_v1(u,p),'node_list',clued_private.ci_node_list_view_v1(u,p),
    'liveness',(select to_jsonb(l) from clued_private.ci_node_liveness_v1 l where l.node_id=n.node_id),
    'unconsumed_nonces',(select coalesce(jsonb_agg(to_jsonb(x) order by x.nonce_id),'[]') from clued_private.ci_nonce_ledger_v1 x
      where x.user_id=u and x.node_id=n.node_id and x.consumed_at is null),
    'effects',jsonb_build_object('duty','unchanged; current holder must hand over first',
      'qualification','invalidate; a new signed qualification is required','liveness','new heartbeat required',
      'local_activation','Owner must activate matching credential generation on the node'));
end $$;

create function public.clued_ci_node_binding_rebind_confirmation_issue_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; p uuid; v jsonb; d text; raw text; tid uuid; until_at timestamptz; prior clued_private.ci_node_binding_rebinds_v1;
begin
  perform clued_private.ci_input_v1(p_input,array['project_id','node_id','old_binding_id','new_binding_id','base_version','binding_generation','accepted_ref','idempotency_key'],
    array['project_id','node_id','old_binding_id','new_binding_id','base_version','binding_generation','accepted_ref','idempotency_key']);
  perform clued_private.ci_public_metadata_v1(p_input);
  if jsonb_typeof(p_input->'base_version') is distinct from 'number' or p_input->>'base_version' !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_input->'binding_generation') is distinct from 'number' or p_input->>'binding_generation' !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_input->'accepted_ref') is distinct from 'string' or length(btrim(p_input->>'accepted_ref')) not between 1 and 512
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string' or length(p_input->>'idempotency_key') not between 1 and 120 then
    raise exception 'CI_INPUT_INVALID' using errcode='22023'; end if;
  p:=(p_input->>'project_id')::uuid;
  -- Acquire the authorization lock before project or other business row locks.
  u:=clued_private.authorization_writer_storage_native_hint_v2();
  perform clued_private.ci_node_rebind_lock_v1(u,p,p_input);
  u:=clued_private.ci_native_owner_v1(true,p);
  select * into prior from clued_private.ci_node_binding_rebinds_v1 x where x.user_id=u and x.idempotency_key=p_input->>'idempotency_key';
  if found then
    if prior.request_digest<>clued_private.m1_sha256(p_input) then raise exception 'CI_IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
    return prior.result||jsonb_build_object('status','committed','replayed',true,'receipt_id',prior.receipt_id);
  end if;
  v:=clued_private.ci_node_rebind_view_v1(u,p,p_input); d:=clued_private.m1_sha256(v);
  update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp() where user_id=u and action='ci_node_binding_rebind'
    and subject_key=((p_input->>'node_id')::uuid)::text and consumed_at is null and revoked_at is null;
  raw:='clued_ci_'||encode(extensions.gen_random_bytes(32),'hex'); until_at:=clock_timestamp()+interval '5 minutes';
  insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,confirmation_view,
    view_digest,token_hash,session_id,auth_time,expires_at)
    values(u,'ci_node_binding_rebind',((p_input->>'node_id')::uuid)::text,(p_input->>'base_version')::bigint,p_input,v,d,
      encode(extensions.digest(convert_to(raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      clued_private.native_auth_time_v1(),until_at) returning id into tid;
  return jsonb_build_object('status','issued','confirmation_token',raw,'view_digest',d,'confirmation_view',v,'token_id',tid,'expires_at',until_at);
end $$;

create function public.clued_ci_node_binding_rebind_apply_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; p uuid; tok clued_private.native_confirmation_tokens; c jsonb; v jsonb; r uuid; t timestamptz;
  n clued_private.ci_nodes_v1; b public.clued_agent_bindings; prior clued_private.ci_node_binding_rebinds_v1;
begin
  perform clued_private.ci_input_v1(p_input,array['confirmation_token','view_digest'],array['confirmation_token','view_digest']);
  u:=clued_private.authorization_writer_storage_native_hint_v2();
  select * into tok from clued_private.native_confirmation_tokens x where x.user_id=u and x.action='ci_node_binding_rebind'
    and x.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
  if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
  c:=tok.native_choices; p:=(c->>'project_id')::uuid;
  perform clued_private.ci_node_rebind_lock_v1(u,p,c);
  u:=clued_private.ci_native_owner_v1(true,p);
  select * into tok from clued_private.native_confirmation_tokens x where x.id=tok.id for update;
  perform clued_private.ci_native_recheck_v1(u,clued_private.native_session_id_v1());
  if tok.session_id is distinct from clued_private.native_session_id_v1() or tok.view_digest is distinct from p_input->>'view_digest' then
    raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
  if tok.consume_outcome='committed' then
    select * into prior from clued_private.ci_node_binding_rebinds_v1 x where x.user_id=u and x.idempotency_key=c->>'idempotency_key';
    return prior.result||jsonb_build_object('status','committed','replayed',true,'receipt_id',prior.receipt_id);
  end if;
  if tok.consume_outcome='rejected' then
    return (select jsonb_build_object('status','rejected','error_code',x.metadata->>'error_code','receipt_id',x.id,
      'authoritative',false,'replayed',true) from public.clued_audit_receipts x where x.user_id=u and x.id=tok.consumed_receipt_id);
  end if;
  if tok.revoked_at is not null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_revoked','authoritative',false);
  end if;
  begin
    if tok.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if tok.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if tok.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    select * into prior from clued_private.ci_node_binding_rebinds_v1 x where x.user_id=u and x.idempotency_key=c->>'idempotency_key';
    if found then raise exception 'CI_IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
    v:=clued_private.ci_node_rebind_view_v1(u,p,c);
    if clued_private.m1_sha256(v)<>tok.view_digest then raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    t:=clock_timestamp();
    select * into b from public.clued_agent_bindings where id=(c->>'new_binding_id')::uuid and user_id=u;
    perform clued_private.ci_native_recheck_v1(u,tok.session_id);
    if tok.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if clued_private.ci_binding_expires_at_v1(b)<=clock_timestamp() then raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
    perform clued_private.authorization_assert_entry_v12(b.id,'scope','project:'||p,'canonical','read');
    -- Preserve the approved identity/list; qualification and health must be
    -- re-established under the new generation. No old credential is revived.
    update clued_private.ci_nodes_v1 set binding_id=b.id,binding_generation=binding_generation+1,version=version+1,
      connection_expires_at=clued_private.ci_binding_expires_at_v1(b),qualification_status='unverified',
      qualification_verified_at=null,qualification_expires_at=null,qualification_receipt_ref=null,eligible_until=null,
      hardening_observed=false,last_heartbeat_at=null,heartbeat_sequence=0,clock_skew_ms=null,updated_at=t
      where node_id=(c->>'node_id')::uuid and user_id=u and project_id=p
        and version=(c->>'base_version')::bigint and binding_generation=(c->>'binding_generation')::bigint
        and binding_id=(c->>'old_binding_id')::uuid returning * into n;
    if not found then raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
    v:=jsonb_build_object('node_id',n.node_id,'project_id',p,'old_binding_id',c->>'old_binding_id','binding_id',n.binding_id,
      'binding_generation',n.binding_generation,'version',n.version,'state',n.state,'qualification_status',n.qualification_status,
      'connection_expires_at',n.connection_expires_at,'local_activation_required',true);
    r:=clued_private.ci_receipt_v1(u,p,'ci_node_binding_rebind',n.node_id::text,
      jsonb_build_object('receipt_kind','CI_NODE_BINDING_REBOUND','principal','native_account_session',
        'accepted_ref',c->>'accepted_ref','view_digest',tok.view_digest,'result',v,
        'before',jsonb_build_object('binding_id',c->>'old_binding_id','binding_generation',c->'binding_generation',
          'version',c->'base_version','liveness',tok.confirmation_view->'liveness',
          'qualification_status',tok.confirmation_view->'node'->'qualification_status')));
    update clued_private.ci_node_heartbeat_link_v1 set revoked_at=t,revoked_receipt_id=r
      where user_id=u and node_binding_id=(c->>'old_binding_id')::uuid and revoked_at is null;
    insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id)
      select u,k.heartbeat_binding_id,n.binding_id,t,r from clued_private.ci_node_heartbeat_link_v1 k
      where k.user_id=u and k.node_binding_id=(c->>'old_binding_id')::uuid and k.revoked_receipt_id=r;
    update clued_private.binding_roles_v1 set revoked_at=t,revoked_receipt_id=r
      where user_id=u and binding_id=(c->>'old_binding_id')::uuid and revoked_at is null;
    insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      select u,n.binding_id,x.role,x.granted_at,r,x.effective_at,x.purpose from clued_private.binding_roles_v1 x
      where x.user_id=u and x.binding_id=(c->>'old_binding_id')::uuid and x.revoked_receipt_id=r;
    update clued_private.ci_failover_members_v1 set binding_id=n.binding_id,receipt_id=r
      where user_id=u and binding_id=(c->>'old_binding_id')::uuid;
    if tok.confirmation_view->'heartbeat_links'<>'[]'::jsonb or exists(
        select 1 from clued_private.ci_failover_members_v1 m where m.user_id=u and m.binding_id=n.binding_id) then
      insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)
        values(u,false,null,1,t,r) on conflict(user_id) do update
          set version=clued_private.ci_failover_settings_v1.version+1,updated_at=t,receipt_id=r;
    end if;
    -- A new pair of heartbeats is required, including the failover quiet window.
    delete from clued_private.ci_node_liveness_v1 where node_id=n.node_id and user_id=u;
    update clued_private.ci_nonce_ledger_v1 set consumed_at=t,
      request_digest=clued_private.m1_sha256(jsonb_build_object('operation','ci_node_binding_rebind','receipt_id',r)),consume_receipt_id=r
      where user_id=u and node_id=n.node_id and consumed_at is null;
    update clued_private.ci_result_index_v1 set state='invalidated',receipt_id=r
      where user_id=u and project_id=p and producer_node_id=n.node_id and state='available';
    perform clued_private.ci_node_list_refresh_v1(u,p,n.node_id,'binding_rebind');
    update clued_private.ci_nodes_v1 set receipt_id=r where node_id=n.node_id;
    insert into clued_private.ci_node_binding_rebinds_v1(user_id,project_id,node_id,idempotency_key,request_digest,receipt_id,result)
      values(u,p,n.node_id,c->>'idempotency_key',clued_private.m1_sha256(c),r,v);
    update clued_private.native_confirmation_tokens set consumed_at=t,consumed_receipt_id=r,consume_outcome='committed' where id=tok.id;
    return v||jsonb_build_object('status','committed','replayed',false,'receipt_id',r);
  exception when others then
    r:=clued_private.ci_receipt_v1(u,p,'ci_node_binding_rebind_rejected',tok.subject_key,jsonb_build_object('error_code',sqlerrm));
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=r,consume_outcome='rejected'
      where id=tok.id and consumed_at is null and revoked_at is null;
    return jsonb_build_object('status','rejected','error_code',sqlerrm,'receipt_id',r,'authoritative',false);
  end;
end $$;

revoke all on function clued_private.ci_binding_expires_at_v1(public.clued_agent_bindings),
  clued_private.ci_node_rebind_lock_v1(uuid,uuid,jsonb),clued_private.ci_node_rebind_view_v1(uuid,uuid,jsonb),
  public.clued_ci_node_binding_rebind_confirmation_issue_v1(jsonb),public.clued_ci_node_binding_rebind_apply_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_ci_node_binding_rebind_confirmation_issue_v1(jsonb),
  public.clued_ci_node_binding_rebind_apply_v1(jsonb) to authenticated;

-- CI, linked heartbeat and explicitly marked upgrade connections, including
-- offline nodes. Expiry comes from authorization/retirement, never a node cache.
create function clued_private.ci_connection_expiry_targets_v1(p_owner uuid default null) returns table
  (user_id uuid,node_id uuid,project_id uuid,binding_id uuid,connection_kind text,expires_at timestamptz)
language sql stable security definer set search_path='' as $$
  select n.user_id,n.node_id,n.project_id,b.id,'ci',clued_private.ci_binding_expires_at_v1(b)
    from clued_private.ci_nodes_v1 n join public.clued_agent_bindings b on b.id=n.binding_id
    where (p_owner is null or n.user_id=p_owner) and n.state not in ('retired','revoked') and b.revoked_at is null
  union
  select n.user_id,n.node_id,n.project_id,b.id,'heartbeat',clued_private.ci_binding_expires_at_v1(b)
    from clued_private.ci_nodes_v1 n join clued_private.ci_node_heartbeat_link_v1 k on k.node_binding_id=n.binding_id and k.revoked_at is null
    join public.clued_agent_bindings b on b.id=k.heartbeat_binding_id and b.user_id=n.user_id
    where (p_owner is null or n.user_id=p_owner) and n.state not in ('retired','revoked') and b.revoked_at is null
  union
  select r.user_id,null::uuid,null::uuid,b.id,'upgrade',clued_private.ci_binding_expires_at_v1(b)
    from clued_private.binding_roles_v1 r join public.clued_agent_bindings b on b.id=r.binding_id and b.user_id=r.user_id
    where (p_owner is null or r.user_id=p_owner) and r.role='resident-upgrade' and r.revoked_at is null and b.revoked_at is null
$$;

create table clued_private.ci_connection_expiry_reminders_v1 (
  user_id uuid not null references auth.users(id), binding_id uuid not null references public.clued_agent_bindings(id),
  connection_kind text not null check(connection_kind in ('ci','heartbeat','upgrade')),
  expires_at timestamptz not null, threshold_days integer not null check(threshold_days in (21,14,7,1)),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,binding_id,connection_kind,expires_at,threshold_days)
);
alter table clued_private.ci_connection_expiry_reminders_v1 enable row level security;
revoke all on clued_private.ci_connection_expiry_reminders_v1 from public,anon,authenticated,service_role,clued_worker_gateway;
create trigger ci_connection_expiry_reminders_permanent_v1 before update or delete on clued_private.ci_connection_expiry_reminders_v1
  for each row execute function clued_private.ci_append_only_guard_v1();

create function clued_private.ci_connection_expiry_remind_v1() returns integer
language plpgsql volatile security definer set search_path='' as $$
declare x record; d integer; r uuid; total integer:=0; v_now timestamptz:=clock_timestamp();
begin
  -- The existing five-minute expiry sweep calls this. A delayed first sweep
  -- emits only the most urgent threshold, not a burst of obsolete reminders.
  for x in select * from clued_private.ci_connection_expiry_targets_v1()
    where expires_at>v_now and expires_at<=v_now+interval '21 days' order by user_id,binding_id,connection_kind loop
    d:=case when x.expires_at<=v_now+interval '1 day' then 1 when x.expires_at<=v_now+interval '7 days' then 7
      when x.expires_at<=v_now+interval '14 days' then 14 else 21 end;
    if exists(select 1 from clued_private.ci_connection_expiry_reminders_v1 m where m.user_id=x.user_id
      and m.binding_id=x.binding_id and m.connection_kind=x.connection_kind and m.expires_at=x.expires_at and m.threshold_days=d) then continue; end if;
    -- A reminder is eligible again on the next tick. Do not wait for another
    -- owner's account/binding writer while the sweep holds earlier expiry locks.
    perform 1 from auth.users a join public.clued_agent_bindings b on b.user_id=a.id
      where a.id=x.user_id and b.id=x.binding_id and b.revoked_at is null for key share of a,b skip locked;
    if not found then continue; end if;
    -- The failover page already reads these immutable server alert receipts.
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(x.user_id,x.binding_id,'global','ci_admission_failover_alert','ci_connection_expiry',x.binding_id::text,1,
        jsonb_build_object('receipt_kind','CI_CONNECTION_EXPIRING','principal','server_watchdog','node_id',x.node_id,
          'project_id',x.project_id,'binding_id',x.binding_id,'connection_kind',x.connection_kind,'expires_at',x.expires_at,
          'threshold_days',d,'reason',x.connection_kind||'_expires_within_'||d||'_days',
          'next_url',case when x.project_id is null then '/bindings' else '/ci-nodes?project_id='||x.project_id end)) returning id into r;
    insert into clued_private.ci_connection_expiry_reminders_v1(user_id,binding_id,connection_kind,expires_at,threshold_days,receipt_id)
      values(x.user_id,x.binding_id,x.connection_kind,x.expires_at,d,r);
    total:=total+1;
  end loop;
  return total;
end $$;

-- Additive, anchored changes preserve the existing functions' OIDs, privileges
-- and all successor logic. No cron registration, service or production toggle.
do $patch$
declare body text; anchor text;
begin
  body:=pg_get_functiondef('clued_private.binding_expiry_sweep_v1()'::regprocedure);
  -- Historical authorization replays can install the predecessor sweep first.
  -- Both implementations have one outer block and one return; retain the
  -- installed expiry query, its locking, and its original return expression.
  anchor:=E'\nbegin\n';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_EXPIRY_SWEEP_ANCHOR'; end if;
  -- Serialize sweeps before their owner locks. Reminder inserts acquire FK
  -- locks on bindings; do them after expiry has taken its owner/binding locks.
  body:=replace(body,anchor,anchor||E'  perform pg_advisory_xact_lock(hashtextextended(''ci-connection-expiry-reminders'',0));\n');
  anchor:=E'\n  return ';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_EXPIRY_RETURN_ANCHOR'; end if;
  execute replace(body,anchor,$r$
  begin
    perform clued_private.ci_connection_expiry_remind_v1();
  exception when others then
    raise warning 'CI expiry reminder failed (SQLSTATE %)',sqlstate;
  end;
  return $r$);
  body:=pg_get_functiondef('clued_private.ci_node_view_v1(clued_private.ci_nodes_v1)'::regprocedure);
  -- n is a composite function argument; keep all existing public fields.
  anchor:='to_jsonb(n)';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_NODE_VIEW_ANCHOR'; end if;
  execute replace(body,anchor,$r$(to_jsonb(n)||jsonb_build_object('connection_expires_at',
    (select clued_private.ci_binding_expires_at_v1(b) from public.clued_agent_bindings b where b.id=n.binding_id)))$r$);
  body:=pg_get_functiondef('clued_private.ci_gateway_snapshot_v1(clued_private.ci_nodes_v1)'::regprocedure);
  anchor:='(to_jsonb(b)->>''expires_at'')::timestamptz';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_GATEWAY_EXPIRY_ANCHOR'; end if;
  execute replace(body,anchor,'clued_private.ci_binding_expires_at_v1(b)');
  body:=pg_get_functiondef('public.clued_ci_nodes_v1(jsonb)'::regprocedure);
  anchor:='''pool'',clued_private.ci_pool_view_v1(u,p),';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_LISTING_ANCHOR'; end if;
  execute replace(body,anchor,$r$'connection_reminders',coalesce((select jsonb_agg(r.metadata||jsonb_build_object('receipt_id',r.id,
        'node_id',x.node_id,'project_id',x.project_id,'next_url',case when x.project_id is null then '/bindings' else '/ci-nodes?project_id='||p end)
      order by m.created_at desc,x.node_id) from clued_private.ci_connection_expiry_targets_v1(u) x
      join lateral (select a.receipt_id,a.created_at from clued_private.ci_connection_expiry_reminders_v1 a
        where a.user_id=u and a.binding_id=x.binding_id and a.connection_kind=x.connection_kind and a.expires_at=x.expires_at
        order by a.threshold_days limit 1) m on true join public.clued_audit_receipts r on r.id=m.receipt_id
      where x.user_id=u and (x.project_id=p or x.connection_kind='upgrade') and x.expires_at>clock_timestamp()), '[]'::jsonb),
    'pool',clued_private.ci_pool_view_v1(u,p),$r$);
  body:=pg_get_functiondef('public.clued_resident_failover_v1(jsonb)'::regprocedure);
  anchor:='''receipt_kind'',r.metadata->''receipt_kind'',''reason'',r.metadata->''reason'',''holder'',r.metadata->''holder'',';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_ALERT_VIEW_ANCHOR'; end if;
  execute replace(body,anchor,$r$'receipt_kind',r.metadata->'receipt_kind','reason',r.metadata->'reason',
    'connection_kind',r.metadata->'connection_kind','binding_id',r.metadata->'binding_id',
    'expires_at',r.metadata->'expires_at','threshold_days',r.metadata->'threshold_days','next_url',r.metadata->'next_url',
    'holder',r.metadata->'holder',$r$);
end $patch$;

revoke all on function clued_private.ci_connection_expiry_targets_v1(uuid),clued_private.ci_connection_expiry_remind_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
