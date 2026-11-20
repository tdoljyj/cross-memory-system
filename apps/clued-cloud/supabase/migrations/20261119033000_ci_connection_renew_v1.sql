-- Node self-renewal, Owner Decision 26490bf6. Install only; no fleet data or switches changed.
-- Both callers keep their own authentication; share the revocation rule and rebind writes.
create or replace function clued_private.ci_assert_renewable_revocation_v1(u uuid,old public.clued_agent_bindings,a clued_private.authorizations_v12)
returns void language plpgsql stable security definer set search_path='' as $$ begin
  if old.id is null or exists(select 1 from clued_private.authorization_audit_v12 x
      where x.owner_id=u and x.binding_id=old.id and (x.operation ~* '(revok|compromis|leak)'
        or old.revoked_at is not null and x.recorded_at>=old.revoked_at and x.operation<>'expired'))
    or (old.revoked_at is not null or a.revoked_at is not null) and not coalesce((
      old.revoked_at is not null and (a.binding_id is null or a.revoked_at=old.revoked_at)
      and clued_private.ci_binding_expires_at_v1(old)<=old.revoked_at and exists(select 1 from clued_private.authorization_audit_v12 x
        where x.owner_id=u and x.binding_id=old.id and x.operation='expired' and x.recorded_at>=old.revoked_at)),false) then
    raise exception 'CI_REBIND_OLD_REVOCATION_UNSAFE' using errcode='42501'; end if;
end $$;

create or replace function clued_private.ci_rebind_unshared_v1(n clued_private.ci_nodes_v1,old public.clued_agent_bindings)
returns void language plpgsql volatile security definer set search_path='' as $$ begin
  if exists(select 1 from clued_private.ci_nodes_v1 x where x.binding_id=old.id and x.node_id<>n.node_id
      and x.state not in ('revoked','retired'))
    or exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.heartbeat_binding_id=old.id and k.revoked_at is null) then
    raise exception 'CI_REBIND_OLD_CONNECTION_SHARED' using errcode='55000'; end if;
end $$;
create or replace function clued_private.ci_rebind_ready_v1(u uuid,p uuid,n clued_private.ci_nodes_v1,old public.clued_agent_bindings)
returns void language plpgsql volatile security definer set search_path='' as $$ begin
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
end $$;

create or replace function clued_private.ci_node_rebind_view_v1(u uuid,p uuid,c jsonb,same_authority_renewal boolean) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; old public.clued_agent_bindings; fresh public.clued_agent_bindings;
  a clued_private.authorizations_v12; links jsonb; roles jsonb; members jsonb; expiry timestamptz;
  required_scope text:='project:'||p;
begin
  select * into n from clued_private.ci_nodes_v1 where node_id=(c->>'node_id')::uuid and user_id=u and project_id=p;
  if not found then raise exception 'CI_NODE_NOT_FOUND' using errcode='42501'; end if;
  if n.state in ('revoked','retired') then raise exception 'CI_NODE_TRANSITION_INVALID' using errcode='42501'; end if;
  if n.version<>(c->>'base_version')::bigint or n.binding_generation<>(c->>'binding_generation')::bigint
      or n.binding_id<>(c->>'old_binding_id')::uuid then raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  select * into old from public.clued_agent_bindings where id=n.binding_id and user_id=u;
  perform clued_private.ci_rebind_unshared_v1(n,old);
  select * into a from clued_private.authorizations_v12 where binding_id=old.id and owner_id=u;
  perform clued_private.ci_assert_renewable_revocation_v1(u,old,a);
  select * into fresh from public.clued_agent_bindings where id=(c->>'new_binding_id')::uuid and user_id=u;
  if same_authority_renewal and old.context_keys=array['global'] and fresh.context_keys=old.context_keys
    and fresh.scopes=old.scopes then required_scope:='global'; end if;
  expiry:=clued_private.ci_binding_expires_at_v1(fresh);
  if fresh.id is null or fresh.id=old.id or not clued_private.binding_live_v1(fresh)
      or expiry<=clock_timestamp() or not ('context:read'=any(fresh.scopes))
      or not ('*'=any(fresh.context_keys) or required_scope=any(fresh.context_keys)) then
    raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  perform clued_private.authorization_assert_entry_v12(fresh.id,'scope',required_scope,'canonical','read');
  if exists(select 1 from clued_private.ci_nodes_v1 x where x.binding_id=fresh.id and x.state not in ('revoked','retired'))
    or exists(select 1 from clued_private.ci_node_heartbeat_link_v1 k where k.revoked_at is null
      and (k.heartbeat_binding_id=fresh.id or k.node_binding_id=fresh.id))
    or exists(select 1 from clued_private.ci_failover_members_v1 m where m.binding_id=fresh.id)
    or exists(select 1 from clued_private.binding_roles_v1 r where r.binding_id=fresh.id and r.revoked_at is null) then
    raise exception 'CI_REBIND_TARGET_IN_USE' using errcode='55000'; end if;
  perform clued_private.ci_rebind_ready_v1(u,p,n,old);
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

-- Native callers choose a target and must always prove project read.
create or replace function clued_private.ci_node_rebind_view_v1(u uuid,p uuid,c jsonb) returns jsonb
language sql volatile security definer set search_path='' as $$
  select clued_private.ci_node_rebind_view_v1(u,p,c,false)
$$;

create or replace function clued_private.ci_node_rebind_commit_v1(u uuid,p uuid,c jsonb,b public.clued_agent_bindings,
  t timestamptz,confirmed jsonb,view_digest text,actor text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; v jsonb; r uuid;
begin
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
      jsonb_build_object('receipt_kind','CI_NODE_BINDING_REBOUND','principal',actor,
        'accepted_ref',c->>'accepted_ref','view_digest',view_digest,'result',v,
        'before',jsonb_build_object('binding_id',c->>'old_binding_id','binding_generation',c->'binding_generation',
          'version',c->'base_version','liveness',confirmed->'liveness',
          'qualification_status',confirmed->'node'->'qualification_status')) ||
        case when actor='node_self_renew' then jsonb_build_object('approval',c->'approval') else '{}'::jsonb end);
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
    if confirmed->'heartbeat_links'<>'[]'::jsonb or exists(
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
    return v||jsonb_build_object('receipt_id',r);
end $$;
create or replace function public.clued_ci_node_binding_rebind_apply_v1(p_input jsonb) returns jsonb
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
    v:=clued_private.ci_node_rebind_commit_v1(u,p,c,b,t,tok.confirmation_view,tok.view_digest,'native_account_session');
    r:=(v->>'receipt_id')::uuid;
    v:=v-'receipt_id';
    update clued_private.native_confirmation_tokens set consumed_at=t,consumed_receipt_id=r,consume_outcome='committed' where id=tok.id;
    return v||jsonb_build_object('status','committed','replayed',false,'receipt_id',r);
  exception when others then
    r:=clued_private.ci_receipt_v1(u,p,'ci_node_binding_rebind_rejected',tok.subject_key,jsonb_build_object('error_code',sqlerrm));
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=r,consume_outcome='rejected'
      where id=tok.id and consumed_at is null and revoked_at is null;
    return jsonb_build_object('status','rejected','error_code',sqlerrm,'receipt_id',r,'authoritative',false);
  end;
end $$;

-- Discovery is account-wide. The project selector cannot disambiguate two
-- live registrations of the same machine identity in different projects.
create index if not exists ci_renew_live_identity_v1 on clued_private.ci_nodes_v1(user_id,identity_fingerprint)
  where state not in ('revoked','retired') and revoked_at is null;
create index if not exists ci_renew_trust_fingerprint_v1 on clued_private.ci_nodes_v1(identity_fingerprint)
  where state not in ('revoked','retired') and revoked_at is null;
create or replace function clued_private.ci_renew_discover_nodes_v1(owner_id uuid,fingerprint text)
returns setof clued_private.ci_nodes_v1 language sql stable set search_path='' as $$
  select n from clued_private.ci_nodes_v1 n where n.user_id=owner_id and n.identity_fingerprint=fingerprint
    and n.state not in ('revoked','retired') and n.revoked_at is null
$$;

create or replace function public.clued_ci_connection_renew_trust_v1(p_project_id uuid,p_node_id uuid,p_fingerprint text,p_source text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare jwk jsonb; matches uuid[];
begin
  if p_source is null or p_source !~ '^[0-9a-f]{64}$' or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    return '{"status":"rejected"}'; end if;
  if p_project_id is null and p_node_id is null then
    -- Only a public key crosses this pre-signature boundary. Its thumbprint
    -- fixes its signing material; the token determines the account after verification.
    select n.identity_public_jwk into jwk from clued_private.ci_nodes_v1 n where n.identity_fingerprint=p_fingerprint
      and n.state not in ('retired','revoked') and n.revoked_at is null
      and clued_private.ci_jwk_fingerprint_v1(n.identity_public_jwk)=p_fingerprint limit 1;
  else
    if p_node_id is null then
      select array(select n.node_id from clued_private.ci_renew_discover_nodes_v1(
        (select p.user_id from public.clued_projects p where p.id=p_project_id),p_fingerprint) n limit 2) into matches;
      if cardinality(matches)=1 then p_node_id:=matches[1]; end if;
    end if;
    select n.identity_public_jwk into jwk from clued_private.ci_nodes_v1 n
      where n.project_id=p_project_id and n.node_id=p_node_id and n.identity_fingerprint=p_fingerprint
        and n.state not in ('revoked','retired') and n.revoked_at is null;
  end if;
  if jwk is null then return '{"status":"rejected"}'; end if;
  return jsonb_build_object('status','ok','identity_public_jwk',jwk);
end $$;

create table if not exists clued_private.ci_connection_renewals_v1 (
  old_binding_id uuid primary key references public.clued_agent_bindings(id),
  binding_id uuid not null unique references public.clued_agent_bindings(id),
  node_id uuid not null references clued_private.ci_nodes_v1(node_id), kind text not null check(kind in ('ci','upgrade')),
  generation bigint not null, receipt_id uuid not null references public.clued_audit_receipts(id),
  replacement_verifier text not null, automatic boolean not null, result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create index if not exists ci_connection_renew_history_v1 on clued_private.ci_connection_renewals_v1(node_id,kind,created_at);
alter table clued_private.ci_connection_renewals_v1 enable row level security;
-- Resolve the brief's abbreviated Decision once, before any future record
-- can acquire a similar ID. Test/empty tenants have no standing authority.
do $standing_decision$
declare candidates uuid[];
begin
  -- Bootstrap exactly once. A later replay cannot restore removed authority.
  if to_regclass('clued_private.ci_renew_standing_decision_v1') is not null then return; end if;
  create table clued_private.ci_renew_standing_decision_v1 (
    singleton boolean primary key default true check(singleton),
    decision_id uuid not null references public.clued_memories(id) on delete cascade
  );
  alter table clued_private.ci_renew_standing_decision_v1 enable row level security;
  lock table clued_private.ci_nodes_v1 in share mode;
  select array_agg(m.id) into candidates from public.clued_memories m
    where m.id between '26490bf6-0000-0000-0000-000000000000' and '26490bf6-ffff-ffff-ffff-ffffffffffff'
      and m.record_type='decision' and m.authority='user_explicit' and m.lifecycle_status='active'
      and clued_private.record_currentness_fence(m.user_id,m.id,array[m.canonical_scope])='CURRENT'
      and not exists(select 1 from clued_private.ci_nodes_v1 n where n.user_id<>m.user_id
        or m.canonical_scope is null or m.canonical_scope not in ('global','project:'||n.project_id));
  if cardinality(candidates)=1 then
    insert into clued_private.ci_renew_standing_decision_v1(decision_id) values(candidates[1]);
  elsif exists(select 1 from clued_private.ci_nodes_v1) or cardinality(candidates)>1 then
    raise exception 'CI_RENEW_STANDING_DECISION_UNRESOLVED';
  end if;
end $standing_decision$;
create or replace trigger ci_connection_renewals_permanent before update or delete on clued_private.ci_connection_renewals_v1
  for each row execute function clued_private.ci_append_only_guard_v1();

insert into clued_private.work_claim_resource_kinds(kind,doors,note)
 values('ci-node',array['ci-connection-renew'],'Registered node, connection kind and replacement generation') on conflict(kind) do nothing;
insert into clued_private.owner_grant_actions(action,doors,title,risk,auto_approvable)
 values('ci.connection_renew',array['ci-connection-renew'],'续期本节点同权限连接','high',false) on conflict(action) do nothing;
do $constraints$ begin
  if not exists(select 1 from pg_constraint where conrelid='clued_private.owner_requests_v1'::regclass and conname='ci_renew_request_resource') then
    alter table clued_private.owner_requests_v1 add constraint ci_renew_request_resource check(action<>'ci.connection_renew' or
 (cardinality(resources)=1 and resources[1] ~ '^ci-node:[0-9a-f-]{36}/(ci|upgrade)/[1-9][0-9]*$'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='clued_private.owner_grants_v1'::regclass and conname='ci_renew_grant_resource') then
    alter table clued_private.owner_grants_v1 add constraint ci_renew_grant_resource check(action<>'ci.connection_renew' or
 (cardinality(resources)=1 and resources[1] ~ '^ci-node:[0-9a-f-]{36}/(ci|upgrade)/[1-9][0-9]*$'
  and max_uses is not distinct from 1 and grantee_binding_id is not null and request_id is not null and auto_approve_id is null
  and expires_at<=granted_at+interval '24 hours'));
  end if;
end $constraints$;

-- Use the existing exact-resource, request-only Grant page. Bindings cannot
-- create this request through the general request or bundle RPC.
do $grant_page$
declare sig text; body text; anchor text; addition text;
begin
  for sig,anchor,addition in values
    ('public.clued_owner_request_v1(text,jsonb)', 'in (''repo.protected_change'',''ci.resident_upgrade'')','in (''repo.protected_change'',''ci.resident_upgrade'',''ci.connection_renew'')'),
    ('public.clued_owner_request_bundle_v1(text,jsonb)', '''connection.permission'',''repo.protected_change'',''ci.resident_upgrade''','''connection.permission'',''repo.protected_change'',''ci.resident_upgrade'',''ci.connection_renew'''),
    ('public.clued_owner_request_view_v1(jsonb)', 'in (''repo.protected_change'',''ci.resident_upgrade'')','in (''repo.protected_change'',''ci.resident_upgrade'',''ci.connection_renew'')'),
    ('public.clued_owner_grant_confirmation_issue_v1(jsonb)', 'in (''repo.protected_change'',''ci.resident_upgrade'')','in (''repo.protected_change'',''ci.resident_upgrade'',''ci.connection_renew'')'),
    ('public.clued_owner_grant_confirmation_issue_v1(jsonb)', 'v_req.action in (''connection.permission'',''ci.resident_upgrade'')','v_req.action in (''connection.permission'',''ci.resident_upgrade'',''ci.connection_renew'')'),
    ('public.clued_owner_grant_confirmation_issue_v1(jsonb)', 'p_input->>''action'' in (''connection.permission'',''ci.resident_upgrade'')','p_input->>''action'' in (''connection.permission'',''ci.resident_upgrade'',''ci.connection_renew'')')
  loop
    body:=pg_get_functiondef(sig::regprocedure);
    if strpos(body,addition)>0 then
      if length(body)-length(replace(body,addition,''))=length(addition)
        and strpos(replace(body,addition,''),anchor)=0 then continue; end if;
      raise exception 'CI_RENEW_GRANT_PAGE_CHANGED: %',sig;
    end if;
    if length(body)-length(replace(body,anchor,''))<>length(anchor) then raise exception 'CI_RENEW_GRANT_PAGE_CHANGED: %',sig; end if;
    execute replace(body,anchor,addition);
  end loop;
end $grant_page$;

create or replace function clued_private.ci_renew_decision_v1(n clued_private.ci_nodes_v1)
returns uuid language sql volatile set search_path='' as $$
  select m.id from clued_private.ci_renew_standing_decision_v1 d join public.clued_memories m on m.id=d.decision_id
    where m.user_id=n.user_id and m.record_type='decision' and m.authority='user_explicit'
      and m.lifecycle_status='active' and m.canonical_scope in ('global','project:'||n.project_id)
      and clued_private.record_currentness_fence(n.user_id,m.id,array[m.canonical_scope])='CURRENT' for share of m,d
$$;

-- The durable standing decision covers routine same-authority renewals. Only
-- exceptions enter the existing once-only Native approval flow. A pending
-- request remains manual across a seven-day threshold or a client restart.
create or replace function clued_private.ci_renew_approval_v1(n clued_private.ci_nodes_v1,old_id uuid,k text,g bigint,expiry timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare resource text:='ci-node:'||n.node_id||'/'||k||'/'||(g+1); decision uuid;
  req clued_private.owner_requests_v1; receipt uuid; t timestamptz;
  base text:='ci-renew:'||old_id||':'||resource;
begin
  perform clued_private.owner_grant_lock_v1(n.user_id);
  select * into req from clued_private.owner_requests_v1 r where r.user_id=n.user_id and r.binding_id=old_id
    and r.action='ci.connection_renew' and r.resources=array[resource] order by created_at desc limit 1 for update;
  decision:=clued_private.ci_renew_decision_v1(n);
  t:=clock_timestamp();
  if decision is not null and req.id is null and expiry>=t-interval '30 days' and not exists(select 1 from clued_private.ci_connection_renewals_v1 h
      where h.node_id=n.node_id and h.kind=k and h.created_at>t-interval '7 days') then
    return jsonb_build_object('status','automatic','decision_id',decision);
  end if;
  if req.id is not null then
    if req.status='rejected' then raise exception 'RENEW_GRANT_REJECTED'; end if;
    if req.status in ('approved_once','granted') then
      update clued_private.owner_grants_v1 set uses=uses+1 where id=req.grant_id and request_id=req.id and user_id=n.user_id
        and grantee_binding_id=old_id and action=req.action and resources=array[resource] and auto_approve_id is null
        and revoked_at is null and expires_at>t and uses=0 and max_uses=1;
      if found then return jsonb_build_object('status','approved','grant_id',req.grant_id); end if;
      if exists(select 1 from clued_private.owner_grants_v1 where id=req.grant_id and revoked_at is not null) then
        raise exception 'RENEW_GRANT_REVOKED'; end if;
    elsif req.expires_at>t then
      return jsonb_build_object('status','pending_approval','request_id',req.id);
    end if;
  end if;
  receipt:=clued_private.ci_receipt_v1(n.user_id,n.project_id,'owner_request_create',n.node_id::text,
    jsonb_build_object('receipt_kind','OWNER_REQUEST_CREATED','action','ci.connection_renew','principal','node_self_renew','resources',array[resource]));
  insert into clued_private.owner_requests_v1(user_id,binding_id,idempotency_key,action,resources,suggested_max_uses,agent_note,expires_at,receipt_id)
    values(n.user_id,old_id,base||coalesce(':'||req.id,''),'ci.connection_renew',array[resource],1,
      '节点申请续期同权限连接，已验证节点签名及原连接凭据。',t+interval '24 hours',receipt) returning * into req;
  return jsonb_build_object('status','pending_approval','request_id',req.id);
end $$;


-- Preserve the rotation machinery for source policies, ceilings, overrides and
-- qualified grants. A lifetime tied to the old authorization follows renewal;
-- independently shorter grants retain their deadline.
create or replace function clued_private.ci_renew_clone_sources_v1(p_old uuid,p_new uuid,p_expected jsonb,p_receipt uuid,previous_expiry timestamptz)
returns void language plpgsql volatile security definer set search_path='' as $$
declare old_b public.clued_agent_bindings; new_b public.clued_agent_bindings; a clued_private.authorizations_v12;
 s record; o record; g clued_private.development_grants_v14; sid uuid; receipt uuid;
begin
 select * into old_b from public.clued_agent_bindings where id=p_old;
 select * into new_b from public.clued_agent_bindings where id=p_new;
 perform clued_private.authorization_writer_require_v2(old_b.user_id);
 if old_b.user_id is distinct from new_b.user_id then raise exception 'owned_binding_required' using errcode='42501'; end if;
 if clued_private.authorization_source_snapshot_v2(p_old) is distinct from p_expected then
   raise exception 'headless_binding_source_snapshot_conflict' using errcode='40001'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=p_new for update;
 insert into clued_private.authorization_source_bindings_v2(binding_id,source_protocol) values(p_new,true);
 receipt:=p_receipt;
 if receipt is null then
   insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
     values(new_b.user_id,p_new,'global','authorization_source_rotation','agent_binding',p_new::text,1,
       jsonb_build_object('receipt_kind','AUTHORIZATION_SOURCE_ROTATION','previous_binding_id',p_old,'source_snapshot',p_expected))
     returning id into receipt;
 end if;
 for s in select * from clued_private.authorization_sources_v2 where binding_id=p_old order by id loop
   insert into clued_private.authorization_sources_v2(binding_id,owner_id,kind,version,actions,scope_ceiling,expires_at,revoked_at,receipt_id,consent_ref)
     values(p_new,new_b.user_id,s.kind,s.version,s.actions,s.scope_ceiling,case when s.expires_at=previous_expiry then a.expires_at else least(s.expires_at,a.expires_at) end,s.revoked_at,
       s.receipt_id,'rotation:'||s.id||':'||s.consent_ref) returning id into sid;
   insert into clued_private.authorization_contributions_v2(source_id,resource_kind,resource_id,environment,qualification_id,actions)
     select sid,resource_kind,resource_id,environment,qualification_id,actions from clued_private.authorization_contributions_v2 where source_id=s.id;
 end loop;
 for g in select * from clued_private.development_grants_v14 where binding_id=p_old order by context_id loop
   insert into clued_private.development_grants_v14(context_id,binding_id,grantor,actions,history_policy,version_policy,
     freeze_cursor,since_cursor,explicit_record_ids,allowed_fields,expires_at,revoked_at,version)
     values(g.context_id,p_new,g.grantor,g.actions,g.history_policy,g.version_policy,g.freeze_cursor,g.since_cursor,
       g.explicit_record_ids,g.allowed_fields,case when g.expires_at=previous_expiry then a.expires_at else least(g.expires_at,a.expires_at) end,g.revoked_at,g.version);
 end loop;
 for o in select * from clued_private.authorization_resource_overrides_v2 where binding_id=p_old order by id loop
   select * into g from clued_private.development_grants_v14 where binding_id=p_new and context_id::text=o.resource_id;
   insert into clued_private.authorization_resource_overrides_v2(binding_id,resource_kind,resource_id,environment,qualification_id,
      version,denied_actions,allowed_ceiling,limits,receipt_id,reason)
     values(p_new,o.resource_kind,o.resource_id,o.environment,o.qualification_id,o.version,o.denied_actions,o.allowed_ceiling,
       case when g.id is null then o.limits else o.limits||jsonb_build_object('grant_id',g.id,'grant_version',g.version,
         'expires_at',g.expires_at,'revoked_at',g.revoked_at) end,receipt,'rotation:'||o.id||':'||o.reason);
 end loop;
 perform clued_private.authorization_rebuild_projection_v2(p_new);
end $$;

-- Ordinary rotations keep their independent expiry ceilings. Historical replay
-- installs the authorization successor later, with its original four arguments.
do $rotation$
begin
  if to_regprocedure('clued_private.authorization_clone_sources_v2(uuid,uuid,jsonb,uuid)') is not null then
    execute $wrapper$create or replace function clued_private.authorization_clone_sources_v2(p_old uuid,p_new uuid,p_expected jsonb,p_receipt uuid)
      returns void language sql volatile security definer set search_path='' as $body$
        select clued_private.ci_renew_clone_sources_v1(p_old,p_new,p_expected,p_receipt,null)
      $body$ $wrapper$;
  end if;
end $rotation$;

create or replace function clued_private.ci_renew_entries_match_v1(old_id uuid,new_id uuid)
returns boolean language sql stable set search_path='' as $$
  with old_entries as (
    select resource_kind,resource_id,environment,qualification_id,actions
    from clued_private.authorization_entries_v12 where binding_id=old_id
  ), new_entries as (
    select resource_kind,resource_id,environment,qualification_id,actions
    from clued_private.authorization_entries_v12 where binding_id=new_id
  )
  select exists(select from new_entries)
    and not exists(table old_entries except table new_entries)
    and not exists(table new_entries except table old_entries)
$$;

create or replace function clued_private.ci_renew_binding_v1(old public.clued_agent_bindings,a clued_private.authorizations_v12,proof text,t timestamptz)
returns public.clued_agent_bindings language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys,oauth_client_id)
    values(old.user_id,old.vendor,old.agent_name,clued_private.credential_verifier_v1(proof),old.scopes,old.context_keys,null)
    returning * into b;
  insert into clued_private.authorizations_v12(binding_id,owner_id,client_id,client_name,resource,expires_at,issuance)
    values(b.id,a.owner_id,a.client_id,a.client_name,a.resource,t+interval '30 days','headless');
  perform clued_private.authorization_initialize_sources_v2(old.id,true);
  perform clued_private.ci_renew_clone_sources_v1(old.id,b.id,clued_private.authorization_source_snapshot_v2(old.id),null,a.expires_at);
  select * into b from public.clued_agent_bindings where id=b.id;
  if not (old.scopes @> b.scopes and old.scopes <@ b.scopes and old.context_keys @> b.context_keys and old.context_keys <@ b.context_keys)
    or not clued_private.ci_renew_entries_match_v1(old.id,b.id)
    then raise exception 'RENEW_AUTHORITY_CHANGED'; end if;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation,version)
    values(b.user_id,b.id,'node_self_renew',1);
  return b;
end $$;

-- The read counterpart of authorization_account_v12, which locks the account
-- row for writes. Native and connection probes also work in READ ONLY.
create or replace function clued_private.ci_renew_account_available_v1(u uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from auth.users a where a.id=u and to_jsonb(a)->>'deleted_at' is null
    and not coalesce((to_jsonb(a)->>'banned_until')::timestamptz>clock_timestamp(),false))
$$;

create or replace function clued_private.authorization_account_v12(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from auth.users where id=p_owner for share;
  if not found or not clued_private.ci_renew_account_available_v1(p_owner) then
    raise exception 'account_not_available' using errcode='42501';
  end if;
end $$;

-- One opening instant serves both node probes and the locked handover check.
create or replace function clued_private.ci_renew_window_opens_v1(expiry timestamptz) returns timestamptz
language sql immutable strict set search_path='' as $$ select expiry-interval '240 hours' $$;

create index if not exists ci_renewal_handover_history_v1 on public.clued_audit_receipts(user_id,(metadata->>'node_id'),created_at desc)
  where operation='binding_role_handover' and metadata->>'receipt_kind'='CI_ADMISSION_RENEWAL_HANDOVER';

-- The watchdog and planned handover share the alert and notification channels.
-- The reason separates their hourly suppression and identifies this server-side caller.
create or replace function clued_private.ci_failover_alert_v1(p_owner uuid,p_kind text,p_reason text,p_meta jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid;
begin
  if exists(select 1 from public.clued_audit_receipts r where r.user_id=p_owner and r.context_key='global'
      and r.operation='ci_admission_failover_alert' and r.metadata->>'receipt_kind'=p_kind
      and r.metadata->>'reason' is not distinct from p_reason and r.created_at>now()-interval '1 hour') then
    return null; end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(p_owner,null,'global','ci_admission_failover_alert','ci_admission_failover',p_owner::text,1,
      coalesce(p_meta,'{}'::jsonb)||jsonb_build_object('receipt_kind',p_kind,'reason',p_reason,'principal',
        case when p_kind='CI_ADMISSION_FAILOVER_NO_TARGET' and p_reason='node_self_renew' then 'node_self_renew' else 'server_watchdog' end))
    returning id into receipt;
  return receipt;
end $$;

-- Caller holds the same rebind, pool, role and source-binding locks as renewal.
create or replace function clued_private.ci_renewal_handover_v1(n clued_private.ci_nodes_v1,b public.clued_agent_bindings,
  a clued_private.authorizations_v12,expiry timestamptz,signed_at timestamptz) returns jsonb
language plpgsql volatile set search_path='' as $$
declare t timestamptz:=clock_timestamp(); decision uuid; holder clued_private.ci_node_liveness_v1;
  candidates jsonb; target uuid; alert uuid; result jsonb;
begin
  perform clued_private.ci_rebind_unshared_v1(n,b);
  if expiry is null or expiry<=t or not clued_private.binding_live_v1(b) or a.revoked_at is not null then
    raise exception 'RENEW_HANDOVER_CONNECTION_INACTIVE'; end if;
  if t<clued_private.ci_renew_window_opens_v1(expiry) then raise exception 'RENEW_HANDOVER_OUTSIDE_WINDOW'; end if;
  if clued_private.ci_duty_account_phase_v1(n.user_id)>=4 or not exists(
    select 1 from clued_private.ci_failover_settings_v1 where user_id=n.user_id and enabled) then
    raise exception 'RENEW_HANDOVER_DISABLED'; end if;
  if not exists(select 1 from clued_private.ci_duty_holder_v1(n.user_id,n.project_id) h where h.binding_id=b.id and h.node_id=n.node_id)
    then raise exception 'RENEW_HANDOVER_NOT_HOLDER'; end if;
  if not exists(select 1 from clued_private.ci_failover_members_v1 where user_id=n.user_id and binding_id=b.id)
    then raise exception 'RENEW_HANDOVER_DISABLED'; end if;
  if exists(select 1 from public.clued_audit_receipts r where r.user_id=n.user_id and r.operation='binding_role_handover'
    and r.metadata->>'receipt_kind'='CI_ADMISSION_RENEWAL_HANDOVER' and r.metadata->>'node_id'=n.node_id::text
    and r.created_at>t-interval '24 hours') then raise exception 'RENEW_HANDOVER_RATE_LIMITED'; end if;
  decision:=clued_private.ci_renew_decision_v1(n);
  if decision is null then raise exception 'RENEW_HANDOVER_DECISION_UNAVAILABLE'; end if;

  perform 1 from clued_private.ci_nodes_v1 x join clued_private.ci_node_liveness_v1 l using(node_id)
    join clued_private.ci_failover_members_v1 m on m.binding_id=x.binding_id and m.user_id=x.user_id
    where x.user_id=n.user_id and x.state not in ('retired','revoked') order by x.node_id for share of x,l nowait;
  holder:=clued_private.ci_failover_node_v1(n.user_id,b.id);
  t:=clock_timestamp();
  if abs(extract(epoch from t-signed_at))>300 then raise exception 'RENEW_TIME_INVALID'; end if;
  if t>=expiry then raise exception 'RENEW_HANDOVER_CONNECTION_INACTIVE'; end if;
  candidates:=clued_private.ci_failover_candidates_v1(n.user_id,b.id,holder.reported_source_sha256,
    case when holder.last_heartbeat_at<=t-make_interval(mins=>(clued_private.ci_failover_rules_v1()->>'silence_minutes')::int)
      then holder.last_heartbeat_at end,t);
  select (c->>'binding_id')::uuid into target from jsonb_array_elements(candidates) c
    where (c->>'eligible')::boolean order by (c->>'rank')::int limit 1;
  if target is null then
    alert:=clued_private.ci_failover_alert_v1(n.user_id,'CI_ADMISSION_FAILOVER_NO_TARGET','node_self_renew',
      jsonb_build_object('holder',b.id,'switch',true,'candidates',candidates));
    if alert is not null then
      perform clued_private.ci_failover_note_v1(n.user_id,alert,'CI_ADMISSION_FAILOVER_NO_TARGET','CI 续期让班没有可接班节点',
        '当班节点 '||clued_private.ci_failover_name_v1(n.user_id,b.id)||' 继续当班。候选及原因见回执 '||alert||'。');
    end if;
    return '{"status":"rejected","error_code":"RENEW_HANDOVER_NO_CANDIDATE"}';
  end if;

  perform 1 from public.clued_agent_bindings where id=target for update nowait;
  t:=clock_timestamp();
  if abs(extract(epoch from t-signed_at))>300 then raise exception 'RENEW_TIME_INVALID'; end if;
  if t>=expiry then raise exception 'RENEW_HANDOVER_CONNECTION_INACTIVE'; end if;
  result:=clued_private.binding_role_handover_core_v1(n.user_id,b.id,target,null,jsonb_build_object(
    'receipt_kind','CI_ADMISSION_RENEWAL_HANDOVER','principal','node_self_renew','decision_id',decision,
    'node_id',n.node_id,'project_id',n.project_id,'binding_generation',n.binding_generation,'candidates',candidates));
  return result||jsonb_build_object('status','committed');
end $$;

create or replace function public.clued_ci_connection_renew_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; old public.clued_agent_bindings; fresh public.clued_agent_bindings;
  a clued_private.authorizations_v12; prior clued_private.ci_connection_renewals_v1; u uuid; p uuid;
  old_id uuid; k text:=p_input->>'kind'; g bigint; next_proof text:=p_input->>'new_token_hash'; expiry timestamptz;
  choices jsonb; approval jsonb; result jsonb; view_before jsonb; receipt uuid; t timestamptz;
  no_prior boolean:=false; code text; matches uuid[];
  yielding boolean:=p_input ? 'action';
  keys text[]:=array['contract','project_id','node_id','kind','identity_fingerprint','old_binding_id','old_token_hash','generation','new_token_hash','issued_at'];
begin
  if yielding then
    if p_input->>'action' is distinct from 'yield' or k is distinct from 'ci'
      or p_input->'new_token_hash' is distinct from 'null'::jsonb
      or p_input->>'project_id' is null or p_input->>'node_id' is null
      or p_input->>'old_binding_id' is null or p_input->>'generation' is null then
      raise exception 'RENEW_INPUT_INVALID'; end if;
    keys:=array_append(keys,'action');
  end if;
  if not (p_input ?& keys) or p_input-keys<>'{}'::jsonb then raise exception 'RENEW_INPUT_INVALID'; end if;
  if p_input->>'contract' is distinct from 'clued.ci-connection-renew/1' or coalesce(k,'') not in ('ci','upgrade')
    or jsonb_typeof(p_input->'old_token_hash')<>'string' or jsonb_typeof(p_input->'identity_fingerprint')<>'string'
    or jsonb_typeof(p_input->'new_token_hash') not in ('string','null')
    or coalesce(p_input->>'identity_fingerprint','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_input->>'old_token_hash','') !~ '^[0-9a-f]{64}$'
    or (next_proof is not null and (next_proof !~ '^[0-9a-f]{64}$' or next_proof=p_input->>'old_token_hash'))
    or coalesce(p_input->>'issued_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,7})?Z$'
    then raise exception 'RENEW_INPUT_INVALID'; end if;
  -- Resolve the signed null selectors using the account of the proved old binding.
  if p_input->'new_token_hash'='null'::jsonb and p_input->'node_id'='null'::jsonb
    and p_input->'old_binding_id'='null'::jsonb and p_input->'generation'='null'::jsonb then
    select * into old from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1(p_input->>'old_token_hash');
    if not found then raise exception 'RENEW_PROOF_REFUSED'; end if;
    old_id:=old.id;
    select array(select d.node_id from clued_private.ci_renew_discover_nodes_v1(old.user_id,p_input->>'identity_fingerprint') d limit 2) into matches;
    if cardinality(matches)>1 and p_input->'project_id'='null'::jsonb then
      -- A discovery conflict is public only after the normal time, account,
      -- binding and ownership proofs. A conflict never opens a grant.
      if abs(extract(epoch from clock_timestamp()-(p_input->>'issued_at')::timestamptz))>300 then raise exception 'RENEW_TIME_INVALID'; end if;
      if not clued_private.ci_renew_account_available_v1(old.user_id) then raise exception 'RENEW_ACCOUNT_UNAVAILABLE'; end if;
      select * into a from clued_private.authorizations_v12 where binding_id=old.id and owner_id=old.user_id and issuance='headless';
      if not found or old.oauth_client_id is not null or exists(select 1 from clued_private.binding_retirements_v1 where binding_id=old.id) then
        raise exception 'RENEW_BINDING_UNAVAILABLE'; end if;
      perform clued_private.ci_assert_renewable_revocation_v1(old.user_id,old,a);
      if not exists(select 1 from clued_private.ci_renew_discover_nodes_v1(old.user_id,p_input->>'identity_fingerprint') d
        where (k='ci' and d.binding_id=old.id) or (k='upgrade' and lower(d.name)=lower(old.agent_name)
          and clued_private.binding_role_in_force_v1(old.user_id,old.id,'resident-upgrade'))) then
        raise exception 'RENEW_PROOF_REFUSED'; end if;
      raise exception 'RENEW_DISCOVERY_AMBIGUOUS';
    end if;
    select * into n from clued_private.ci_nodes_v1 where cardinality(matches)=1 and node_id=matches[1]
      and (p_input->'project_id'='null'::jsonb or project_id=(p_input->>'project_id')::uuid);
    if not found then raise exception 'RENEW_IDENTITY_REFUSED'; end if;
    select case when k='ci' then n.binding_generation else coalesce((select h.generation+1
      from clued_private.ci_connection_renewals_v1 h where h.binding_id=old_id and h.node_id=n.node_id and h.kind=k),1) end into g;
    p_input:=p_input||jsonb_build_object('project_id',n.project_id,'node_id',n.node_id,'old_binding_id',old_id,'generation',g);
  end if;
  perform clued_private.ci_input_v1(p_input,keys,array_remove(keys,'new_token_hash'));
  if jsonb_typeof(p_input->'generation') is distinct from 'number' or p_input->>'generation' !~ '^[1-9][0-9]{0,15}$' then
    raise exception 'RENEW_INPUT_INVALID'; end if;
  old_id:=(p_input->>'old_binding_id')::uuid; p:=(p_input->>'project_id')::uuid;
  select user_id into u from clued_private.ci_nodes_v1 where node_id=(p_input->>'node_id')::uuid and project_id=p;
  if u is null then raise exception 'RENEW_IDENTITY_REFUSED'; end if;
  -- Order matches existing rebind/role writers. Serialize two attempts even if
  -- they arrive at different Workers; re-read every identity fact under lock.
  if yielding or next_proof is not null then
    perform clued_private.ci_node_rebind_lock_v1(u,p,p_input);
    if k='upgrade' and not pg_try_advisory_xact_lock(hashtextextended('clued-binding-role:'||u||':resident-upgrade',0)) then
      raise exception 'CI_REBIND_BUSY'; end if;
    perform clued_private.authorization_account_v12(u);
    perform 1 from public.clued_projects x where x.id=p and x.user_id=u for share;
  elsif not clued_private.ci_renew_account_available_v1(u) then raise exception 'RENEW_ACCOUNT_UNAVAILABLE';
  end if;
  t:=clock_timestamp();
  if abs(extract(epoch from t-(p_input->>'issued_at')::timestamptz))>300 then raise exception 'RENEW_TIME_INVALID'; end if;
  select * into n from clued_private.ci_nodes_v1 where node_id=(p_input->>'node_id')::uuid and user_id=u and project_id=p
    and identity_fingerprint=p_input->>'identity_fingerprint' and state not in ('revoked','retired') and revoked_at is null;
  if not found or clued_private.ci_jwk_fingerprint_v1(n.identity_public_jwk) is distinct from n.identity_fingerprint then
    raise exception 'RENEW_IDENTITY_REFUSED'; end if;
  if clued_private.project_effective_active_v2(u,p) is distinct from p then raise exception 'CI_PROJECT_UNAVAILABLE'; end if;
  select * into old from public.clued_agent_bindings where id=old_id and user_id=u
    and token_hash=clued_private.credential_verifier_v1(p_input->>'old_token_hash');
  if not found then raise exception 'RENEW_PROOF_REFUSED'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=old.id and owner_id=u and issuance='headless';
  if not found or old.oauth_client_id is not null or exists(select 1 from clued_private.binding_retirements_v1 where binding_id=old.id)
    then raise exception 'RENEW_BINDING_UNAVAILABLE'; end if;
  select * into prior from clued_private.ci_connection_renewals_v1 where old_binding_id=old_id;
  if found then
    if next_proof is not null and prior.replacement_verifier<>clued_private.credential_verifier_v1(next_proof) then
      return '{"status":"rejected","error_code":"RENEW_SUPERSEDED","renewed":false}';
    end if;
    select * into fresh from public.clued_agent_bindings where id=prior.binding_id and user_id=u;
    if prior.node_id=n.node_id and prior.kind=k and prior.generation=(p_input->>'generation')::bigint
      and next_proof is not null and fresh.token_hash=clued_private.credential_verifier_v1(next_proof)
      and clued_private.binding_live_v1(fresh) and clued_private.ci_binding_expires_at_v1(fresh)>t
      and exists(select 1 from clued_private.authorizations_v12 where binding_id=fresh.id and revoked_at is null)
      and not exists(select 1 from clued_private.authorization_audit_v12 au where au.owner_id=u and au.binding_id in (old.id,fresh.id)
        and au.operation ~* '(revok|compromis|leak)' and au.operation<>'revoked_by_node_self_renew')
      and (k='ci' and n.binding_id=fresh.id and n.binding_generation=prior.generation+1 or k='upgrade'
        and lower(fresh.agent_name)=lower(n.name) and clued_private.binding_role_in_force_v1(u,fresh.id,'resident-upgrade'))
      then return prior.result; end if;
    raise exception 'RENEW_REPLACEMENT_UNUSABLE';
  end if;
  -- Only a signed write holds the rebind locks while deciding absence.
  no_prior:=next_proof is not null;
  perform clued_private.ci_assert_renewable_revocation_v1(u,old,a);
  expiry:=clued_private.ci_binding_expires_at_v1(old);
  if k='ci' then
    if old.id<>n.binding_id then raise exception 'RENEW_BINDING_UNAVAILABLE'; end if;
    g:=n.binding_generation;
  else
    if lower(old.agent_name)<>lower(n.name) or old.scopes<>array['context:read'] or
      not clued_private.binding_role_in_force_v1(u,old.id,'resident-upgrade')
      or exists(select 1 from clued_private.binding_roles_v1 r where r.binding_id=old.id and r.revoked_at is null and r.role<>'resident-upgrade')
      or exists(select 1 from clued_private.ci_nodes_v1 x where x.user_id=u and x.state not in ('retired','revoked') and
        (x.binding_id=old.id or (lower(x.name)=lower(n.name) and x.node_id<>n.node_id)))
      or exists(select 1 from clued_private.ci_node_heartbeat_link_v1 where revoked_at is null and old.id in (heartbeat_binding_id,node_binding_id))
      then raise exception 'RENEW_UPGRADE_ROLE_REFUSED'; end if;
    select coalesce((select h.generation+1 from clued_private.ci_connection_renewals_v1 h where h.binding_id=old.id and h.node_id=n.node_id and h.kind=k),1) into g;
  end if;
  if g<>(p_input->>'generation')::bigint then raise exception 'CI_STALE_VERSION'; end if;
  if yielding then
    return clued_private.ci_renewal_handover_v1(n,old,a,expiry,(p_input->>'issued_at')::timestamptz);
  end if;
  if next_proof is null then
    return jsonb_build_object('status','ok','node_id',n.node_id,'kind',k,'binding_id',old.id,'binding_generation',g,
      'project_id',p,'identity_fingerprint',n.identity_fingerprint,'connection_expires_at',expiry,
      'renewal_window_opens_at',clued_private.ci_renew_window_opens_v1(expiry),
      'on_duty',k='ci' and exists(select 1 from clued_private.ci_duty_holder_v1(u,p) h where h.node_id=n.node_id and h.binding_id=old.id));
  end if;
  if k='ci' then
    perform clued_private.ci_rebind_unshared_v1(n,old);
    perform clued_private.ci_rebind_ready_v1(u,p,n,old);
  end if;
  approval:=clued_private.ci_renew_approval_v1(n,old.id,k,g,expiry);
  -- A concurrent Native grant decision can hold the Owner lock. Recheck the
  -- signed clock after that wait, including before persisting a pending request.
  t:=clock_timestamp();
  if abs(extract(epoch from t-(p_input->>'issued_at')::timestamptz))>300 then raise exception 'RENEW_TIME_INVALID'; end if;
  if approval->>'status'='pending_approval' then return approval; end if;
  fresh:=clued_private.ci_renew_binding_v1(old,a,next_proof,t);
  if k='ci' then
    choices:=jsonb_build_object('project_id',p,'node_id',n.node_id,'old_binding_id',old.id,'new_binding_id',fresh.id,
      'base_version',n.version,'binding_generation',g,'accepted_ref','26490bf6','approval',approval,'idempotency_key','ci-renew:'||old.id);
    view_before:=clued_private.ci_node_rebind_view_v1(u,p,choices,true);
    result:=clued_private.ci_node_rebind_commit_v1(u,p,choices,fresh,t,view_before,clued_private.m1_sha256(view_before),'node_self_renew');
    receipt:=(result->>'receipt_id')::uuid;
  else
    result:=jsonb_build_object('project_id',p,'node_id',n.node_id,'old_binding_id',old.id,'binding_id',fresh.id,
      'binding_generation',g+1,'connection_expires_at',clued_private.ci_binding_expires_at_v1(fresh));
    receipt:=clued_private.ci_receipt_v1(u,p,'ci_connection_renew',n.node_id::text,jsonb_build_object(
      'principal','node_self_renew','accepted_ref','26490bf6','kind',k,'result',result,'approval',approval));
    with ended as (
      update clued_private.binding_roles_v1 set revoked_at=t,revoked_receipt_id=receipt
        where user_id=u and binding_id=old.id and role='resident-upgrade' and revoked_at is null returning *)
    insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      select u,fresh.id,role,granted_at,receipt,effective_at,purpose from ended;
  end if;
  update public.clued_agent_bindings set revoked_at=t where id=old.id and revoked_at is null;
  update clued_private.authorizations_v12 set revoked_at=t,version=version+1 where binding_id=old.id and revoked_at is null;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation) values(u,old.id,'revoked_by_node_self_renew');
  result:=result||jsonb_build_object('status','committed','kind',k,'receipt_id',receipt,'identity_fingerprint',n.identity_fingerprint);
  insert into clued_private.ci_connection_renewals_v1(old_binding_id,binding_id,node_id,kind,generation,receipt_id,replacement_verifier,automatic,result)
    values(old.id,fresh.id,n.node_id,k,g,receipt,fresh.token_hash,approval->>'status'='automatic',result);
  return result;
exception when query_canceled or others then
  -- The subtransaction rolled back. A transport error, an internal error or a
  -- refusal before the locked history read cannot settle the client's intent.
  code:=case when sqlerrm ~ '^(CI_|RENEW_)[A-Z_]+$' then sqlerrm
    when sqlerrm in ('authorization_empty_projection_requires_binding_revoke','authorization_no_effective_source_permission') then 'RENEW_AUTHORITY_CHANGED'
    when sqlerrm='account_not_available' then 'RENEW_ACCOUNT_UNAVAILABLE'
    when yielding and sqlstate='22023' and sqlerrm ~ '^ci_admission_target_[a-z_]+$' then upper(sqlerrm)
    when sqlstate='55P03' then 'CI_REBIND_BUSY'
    when sqlstate='23505' then 'RENEW_CONFLICT' else 'RENEW_INTERNAL_RETRY' end;
  return jsonb_build_object('status','rejected','error_code',code) ||
    case when no_prior then '{"renewed":false}'::jsonb else '{}'::jsonb end;
end $$;

-- Read the same Native session and authentication time as the write guards.
create or replace function public.clued_native_session_probe_v1() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare remaining integer; reason text; deadline timestamptz; owner_id uuid;
begin
  begin
    owner_id:=clued_private.authorization_writer_storage_native_hint_v2();
  exception when insufficient_privilege then
    -- Explain the writer's refusal only for the caller's own Native session.
    -- The writer's guard remains the authority for every successful probe.
    owner_id:=auth.uid();
    if owner_id is not null and nullif(auth.jwt()->>'client_id','') is null
      and clued_private.ci_renew_account_available_v1(owner_id) then
      select (to_jsonb(s)->>'not_after')::timestamptz into deadline from auth.sessions s
        where s.id=(auth.jwt()->>'session_id')::uuid and s.user_id=owner_id;
      if not found then reason:='replaced';
      elsif deadline<=clock_timestamp() then reason:='expired';
      end if;
    end if;
    return jsonb_build_object('session_valid',false,'fresh_seconds',0,'reason',reason);
  end;
  if not clued_private.ci_renew_account_available_v1(owner_id) then raise insufficient_privilege; end if;
  remaining:=greatest(0,least(900,floor(extract(epoch from
    clued_private.native_auth_time_v1()+interval '15 minutes'-clock_timestamp()))::integer));
  return jsonb_build_object('session_valid',true,'fresh_seconds',case when clued_private.native_session_fresh_v1() then remaining else 0 end,'reason',null);
exception when insufficient_privilege or invalid_text_representation then
  return '{"session_valid":false,"fresh_seconds":0,"reason":null}';
end $$;

revoke all on table clued_private.ci_connection_renewals_v1,clued_private.ci_renew_standing_decision_v1 from public,anon,authenticated,service_role,clued_worker_gateway;
revoke all on function
  clued_private.ci_assert_renewable_revocation_v1(uuid,public.clued_agent_bindings,clued_private.authorizations_v12),
  clued_private.ci_node_rebind_commit_v1(uuid,uuid,jsonb,public.clued_agent_bindings,timestamptz,jsonb,text,text),
  clued_private.ci_node_rebind_view_v1(uuid,uuid,jsonb,boolean),
  clued_private.ci_rebind_ready_v1(uuid,uuid,clued_private.ci_nodes_v1,public.clued_agent_bindings),
  clued_private.ci_rebind_unshared_v1(clued_private.ci_nodes_v1,public.clued_agent_bindings),
  clued_private.ci_renew_account_available_v1(uuid),
  clued_private.ci_renew_window_opens_v1(timestamptz),
  clued_private.ci_renewal_handover_v1(clued_private.ci_nodes_v1,public.clued_agent_bindings,clued_private.authorizations_v12,timestamptz,timestamptz),
  clued_private.ci_renew_entries_match_v1(uuid,uuid),clued_private.ci_renew_discover_nodes_v1(uuid,text),
  clued_private.ci_renew_decision_v1(clued_private.ci_nodes_v1),
  clued_private.ci_renew_approval_v1(clued_private.ci_nodes_v1,uuid,text,bigint,timestamptz),
  clued_private.ci_renew_clone_sources_v1(uuid,uuid,jsonb,uuid,timestamptz),
  clued_private.ci_renew_binding_v1(public.clued_agent_bindings,clued_private.authorizations_v12,text,timestamptz),
  public.clued_ci_connection_renew_trust_v1(uuid,uuid,text,text),public.clued_ci_connection_renew_v1(jsonb),public.clued_native_session_probe_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_ci_connection_renew_trust_v1(uuid,uuid,text,text),public.clued_ci_connection_renew_v1(jsonb) to clued_worker_gateway;
grant execute on function public.clued_native_session_probe_v1() to authenticated;
notify pgrst,'reload schema';
