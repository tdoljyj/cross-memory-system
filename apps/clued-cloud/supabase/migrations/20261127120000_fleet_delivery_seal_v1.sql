-- Fleet delivery evidence stays private to the current release identity.
alter table clued_private.fleet_accepted_v1
  add column sealed_at timestamptz,
  add column acceptance_sha256 text check (acceptance_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint fleet_accept_seal_pair_v1 check ((sealed_at is null) = (acceptance_sha256 is null));

create table clued_private.fleet_node_delivery_evidence_v1 (
  node_id uuid primary key references clued_private.ci_nodes_v1(node_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  registration_version bigint not null,
  binding_generation bigint not null,
  heartbeat_sequence bigint not null,
  observed_at timestamptz not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null check (octet_length(evidence::text) <= 4096)
);
alter table clued_private.fleet_node_delivery_evidence_v1 enable row level security;
revoke all on clued_private.fleet_node_delivery_evidence_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.fleet_package_generation_v1(p_version text)
returns integer language sql immutable set search_path='' as $$
  select case when p_version ~ '^g[0-9]{6}$' then substr(p_version,2)::integer else 0 end
$$;

create function clued_private.fleet_delivery_evidence_ok_v1(e jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare field text;
begin
  if jsonb_typeof(e) is distinct from 'object' or octet_length(e::text)>4096
      or e-'schemaVersion'-'nodeId'-'bindingGeneration'-'packageGeneration'-'installGeneration'
        -'installReceiptSha256'-'windowsSourceSha256'-'linuxSourceSha256'-'linuxObservedAt'-'brokerObservedAt'
        -'upgraderSha256'-'linuxToolSha256'-'supervisorSourceSha256'-'sourceRefsSha256'-'brokerEvidenceSha256'
        -'linuxFactsSha256'-'linuxReady'-'linuxConsistent'-'acl'-'connectionCarry'-'operations'-'processClearance' <> '{}'::jsonb
      or e->'schemaVersion' is distinct from '1'::jsonb
      or coalesce(e->>'nodeId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    return false;
  end if;
  foreach field in array array['bindingGeneration','installGeneration','packageGeneration'] loop
    if (field<>'packageGeneration' or e->field is distinct from 'null'::jsonb)
      and (jsonb_typeof(e->field) is distinct from 'number' or e->>field !~ '^[1-9][0-9]{0,14}$') then return false; end if;
  end loop;
  foreach field in array array['installReceiptSha256','windowsSourceSha256','linuxSourceSha256','upgraderSha256','linuxToolSha256',
    'supervisorSourceSha256','sourceRefsSha256','brokerEvidenceSha256','linuxFactsSha256'] loop
    if (field not in ('upgraderSha256','linuxToolSha256','supervisorSourceSha256','sourceRefsSha256') or e->field is distinct from 'null'::jsonb)
      and (jsonb_typeof(e->field) is distinct from 'string' or e->>field !~ '^[0-9a-f]{64}$') then return false; end if;
  end loop;
  foreach field in array array['brokerObservedAt','linuxObservedAt'] loop
    if jsonb_typeof(e->field) is distinct from 'string' or e->>field !~ '^[0-9T:.Z+-]{20,40}$' then return false; end if;
  end loop;
  foreach field in array array['linuxReady','linuxConsistent','acl','connectionCarry','operations','processClearance'] loop
    if coalesce(jsonb_typeof(e->field),'') not in ('boolean','null') then return false; end if;
  end loop;
  return true;
end $$;

-- Preserve the existing heartbeat's token/link checks and its liveness update.
-- Store only validated evidence for exactly one node in the same transaction.
do $patch$
declare sig regprocedure:='clued_private.ci_node_heartbeat_v1(public.clued_agent_bindings,jsonb)'::regprocedure;
  body text:=pg_get_functiondef(sig); item record;
begin
  for item in select * from (values
    ($a$v_node_binding uuid;$a$, $r$v_node_binding uuid; v_delivery jsonb:=p_input->'fleet_delivery';$r$),
    ($a$  if p_input-array['action'$a$, $r$  if v_delivery is not null and not clued_private.fleet_delivery_evidence_ok_v1(v_delivery) then
    raise exception 'fleet_delivery_evidence_invalid' using errcode='22023'; end if;
  p_input:=p_input-'fleet_delivery';
  if p_input-array['action'$r$),
    ($a$  return jsonb_build_object('status','ok','received_at',v_now,'node_ids',to_jsonb(v_nodes),$a$,
     $r$  if v_delivery is not null and cardinality(v_nodes)=1 then
    insert into clued_private.fleet_node_delivery_evidence_v1 as existing
      (node_id,user_id,registration_version,binding_generation,heartbeat_sequence,observed_at,evidence_sha256,evidence)
    select n.node_id,b.user_id,n.version,n.binding_generation,l.heartbeat_sequence,v_now,
      encode(extensions.digest(v_delivery::text,'sha256'),'hex'),v_delivery
      from clued_private.ci_nodes_v1 n join clued_private.ci_node_liveness_v1 l using (node_id,user_id)
      where n.node_id=v_nodes[1] and n.user_id=b.user_id and n.binding_id=v_node_binding and n.revoked_at is null
        and n.node_id::text=v_delivery->>'nodeId' and n.binding_generation::text=v_delivery->>'bindingGeneration'
        and v_source=v_delivery->>'windowsSourceSha256'
    on conflict (node_id) do update set registration_version=excluded.registration_version,
      binding_generation=excluded.binding_generation, heartbeat_sequence=excluded.heartbeat_sequence,
      observed_at=excluded.observed_at, evidence_sha256=excluded.evidence_sha256, evidence=excluded.evidence
      where existing.registration_version is distinct from excluded.registration_version
        or existing.binding_generation is distinct from excluded.binding_generation
        or existing.heartbeat_sequence<excluded.heartbeat_sequence;
  end if;
  return jsonb_build_object('status','ok','received_at',v_now,'node_ids',to_jsonb(v_nodes),$r$)
  ) as replacements(anchor,replacement) loop
    if length(body)-length(replace(body,item.anchor,'')) <> length(item.anchor) then
      raise exception 'fleet_delivery_heartbeat_patch_anchor_mismatch'; end if;
    body:=replace(body,item.anchor,item.replacement);
  end loop;
  execute body;
end $patch$;

create function clued_private.fleet_delivery_registry_v1(c jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare identity clued_private.release_identity_v1%rowtype;
  now_at timestamptz:=statement_timestamp();
  result jsonb;
begin
  select * into identity from clued_private.release_identity_v1;
  if not found or not exists(select 1 from public.clued_agent_bindings b
      where b.id=identity.anchor_binding_id and b.user_id=identity.user_id and b.revoked_at is not null) then
    raise exception 'release_door_identity_invalid' using errcode='55000'; end if;
  if not clued_private.ci_renew_account_available_v1(identity.user_id) then
    raise exception 'account_not_available' using errcode='42501'; end if;
  if c->>'repository' is distinct from identity.repository or c->>'scope' is distinct from 'global'
    or clued_private.fleet_package_generation_v1(c->>'version')<25
    or coalesce(c->>'commit','') !~ '^[0-9a-f]{40}$'
    or exists(select 1 from unnest(array['archiveSha256','sourceSha256','requestSha256','kitSha256']) k
      where coalesce(c->>k,'') !~ '^[0-9a-f]{64}$') then
    raise exception 'fleet_delivery_subject_invalid' using errcode='22023'; end if;

  with duty as materialized (select * from clued_private.ci_duty_holder_v1(identity.user_id)),
  roster as (
    select n.node_id, jsonb_build_object('id',n.node_id,'name',n.name,
      'state',case when n.revoked_at is not null then 'revoked' else n.state end,
      'registrationVersion',n.version,'bindingGeneration',n.binding_generation,'identityFingerprint',n.identity_fingerprint,
      'bindingLive',coalesce(clued_private.binding_live_v1(b),false),
      'onDuty',exists(select 1 from duty h where h.node_id=n.node_id and h.binding_id=n.binding_id),
      'rebindPending',exists(select 1 from clued_private.native_confirmation_tokens t
        where t.user_id=n.user_id and t.action='ci_node_binding_rebind' and t.subject_key=n.node_id::text
          and t.consumed_at is null and t.revoked_at is null and t.expires_at>now_at),
      'heartbeatAt',l.last_heartbeat_at,'heartbeatSequence',l.heartbeat_sequence,'reportedSourceSha256',l.reported_source_sha256,
      'mode',l.reported_mode,'reportedState',l.reported_state,'serviceRunning',l.reported_service_running,
      'evidence',case when e.node_id is not null then e.evidence||jsonb_build_object(
        'registrationVersion',e.registration_version,'evidenceSha256',e.evidence_sha256,'observedAt',e.observed_at,
        'currentHeartbeat',e.heartbeat_sequence=l.heartbeat_sequence and e.observed_at=l.last_heartbeat_at)
      end) as node,
      coalesce(l.last_heartbeat_at between now_at-interval '15 minutes' and now_at,false) as heartbeat_fresh,
      coalesce(e.observed_at between now_at-interval '15 minutes' and now_at,false) as evidence_fresh
    from clued_private.ci_nodes_v1 n
    left join public.clued_agent_bindings b on b.user_id=n.user_id and b.id=n.binding_id
    left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id and l.user_id=n.user_id
    left join clued_private.fleet_node_delivery_evidence_v1 e on e.node_id=n.node_id and e.user_id=n.user_id
    where n.user_id=identity.user_id
  )
  select jsonb_build_object('repository',identity.repository,'scope','global','candidate',c,
    'observedAt',now_at,'complete',true,'nodes',coalesce(jsonb_agg(node order by node_id),'[]'::jsonb),
    'snapshotToken',encode(extensions.digest((c||jsonb_build_object('nodes',coalesce(
      jsonb_agg((node-'heartbeatAt'-'heartbeatSequence'-'evidence')||jsonb_build_object(
        'heartbeatFresh',heartbeat_fresh,'evidenceFresh',evidence_fresh,
        'evidence',case when jsonb_typeof(node->'evidence')='object' then (node->'evidence')-'observedAt'-'brokerObservedAt'-'linuxObservedAt'
          -'brokerEvidenceSha256'-'linuxFactsSha256'-'evidenceSha256' end) order by node_id),'[]'::jsonb)))::text,'sha256'),'hex'))
  into result from roster;
  return result;
end $$;

create function clued_private.fleet_delivery_require_snapshot_v1(c jsonb, token text)
returns void language plpgsql stable set search_path='' as $$
declare fresh jsonb:=clued_private.fleet_delivery_registry_v1(c);
begin
  if token is null or token is distinct from fresh->>'snapshotToken' then
    raise exception 'fleet_delivery_registry_changed' using errcode='40001'; end if;
end $$;

-- The existing workflow is the only caller. Its release login attests to the
-- exact attached asset after checking the public Release's bytes.
create function clued_private.fleet_delivery_seal_v1(p_input jsonb)
returns jsonb language plpgsql volatile set search_path='' as $$
declare candidate jsonb:=p_input->'candidate'; at_time timestamptz;
  d text:=p_input->>'acceptanceSha256'; a clued_private.fleet_accepted_v1%rowtype;
begin
  if coalesce(d,'') !~ '^[0-9a-f]{64}$' or clued_private.fleet_package_generation_v1(candidate->>'version')<25 then
    raise exception 'fleet_delivery_seal_invalid' using errcode='22023'; end if;
  select accepted.* into a from clued_private.fleet_accepted_v1 accepted
    join clued_private.release_identity_v1 r using (user_id,repository)
    where accepted.version=candidate->>'version' and accepted.repository=candidate->>'repository'
      and accepted.request_sha256=candidate->>'requestSha256' and accepted.archive_sha256=candidate->>'archiveSha256'
      and accepted.grant_id::text=p_input->>'grantId' and accepted.receipt_id::text=p_input->>'receiptId'
      and date_trunc('second',accepted.accepted_at)=(p_input->>'acceptedAt')::timestamptz
    for update of accepted;
  if not found then raise exception 'fleet_delivery_acceptance_changed' using errcode='22023'; end if;
  if a.sealed_at is not null then
    if a.acceptance_sha256 is distinct from d then raise exception 'fleet_delivery_seal_conflict' using errcode='22023'; end if;
    at_time:=a.sealed_at;
  else
    perform clued_private.fleet_delivery_require_snapshot_v1(candidate,p_input->>'snapshotToken');
    at_time:=clock_timestamp();
    update clued_private.fleet_accepted_v1 set sealed_at=at_time,acceptance_sha256=d where grant_id=a.grant_id;
  end if;
  return jsonb_build_object('status','sealed','grantId',a.grant_id,'receiptId',a.receipt_id,'acceptanceSha256',d,'sealedAt',at_time);
end $$;

do $patch$
declare item record; body text;
begin
  for item in select * from (values
    ('clued_private.fleet_accept_answer_v1(uuid,uuid,text)',
      $a$'accepted_at',v_row.accepted_at,$a$,
      $r$'accepted_at',v_row.accepted_at,'sealed_acceptance_sha256',v_row.acceptance_sha256,$r$),
    ('clued_private.fleet_accept_door_v1(jsonb)',
      $a$k not in ('action','resources','run_id','run_attempt')$a$,
      $r$k not in ('action','resources','run_id','run_attempt','delivery')$r$),
    ('clued_private.fleet_accept_door_v1(jsonb)',
      $a$  v_req:=clued_private.owner_grant_door_request_v1(v_anchor,'fleet.accept',array[v_resource]);$a$,
      $r$  if clued_private.fleet_package_generation_v1(v_parts[2])>=25 then
    if p_input->'delivery'->'candidate'->>'repository' is distinct from v_parts[1]
        or p_input->'delivery'->'candidate'->>'version' is distinct from v_parts[2]
        or p_input->'delivery'->'candidate'->>'archiveSha256' is distinct from v_parts[3]
        or p_input->'delivery'->'candidate'->>'requestSha256' is distinct from v_parts[4] then
      raise exception 'fleet_delivery_subject_invalid' using errcode='22023'; end if;
    perform clued_private.fleet_delivery_require_snapshot_v1(p_input->'delivery'->'candidate',p_input->'delivery'->>'snapshotToken');
  end if;
  v_req:=clued_private.owner_grant_door_request_v1(v_anchor,'fleet.accept',array[v_resource]);$r$),
    ('clued_private.fleet_node_target_v1(uuid,uuid)',
      $a$  select jsonb_build_object('repository', a.repository, 'version', a.version,$a$,
      $r$  select case when clued_private.fleet_package_generation_v1(a.version)>=25 and a.sealed_at is null
    then jsonb_build_object('status','pending_seal')
    else jsonb_build_object('repository', a.repository, 'version', a.version,
    'acceptance_sha256',a.acceptance_sha256,$r$),
    ('clued_private.fleet_node_target_v1(uuid,uuid)',
      $a$    ), '[]'::jsonb))$a$,
      $r$    ), '[]'::jsonb)) end$r$),
    ('clued_private.fleet_node_target_v1(uuid,uuid)',
      $a$  order by a.accepted_at desc, a.recorded_at desc, a.grant_id desc$a$,
      $r$  order by case when clued_private.fleet_package_generation_v1(a.version)>=25
    then clued_private.fleet_package_generation_v1(a.version) else 0 end desc,
    a.accepted_at desc, a.recorded_at desc, a.grant_id desc$r$)
  ) as replacements(signature,anchor,replacement) loop
    body:=pg_get_functiondef(item.signature::regprocedure);
    if length(body)-length(replace(body,item.anchor,'')) <> length(item.anchor) then
      raise exception 'fleet_delivery_seal_patch_anchor_mismatch: %',item.signature; end if;
    execute replace(body,item.anchor,item.replacement);
  end loop;
end $patch$;

revoke all on function clued_private.fleet_package_generation_v1(text),
  clued_private.fleet_delivery_evidence_ok_v1(jsonb),
  clued_private.fleet_delivery_registry_v1(jsonb),
  clued_private.fleet_delivery_require_snapshot_v1(jsonb,text),
  clued_private.fleet_delivery_seal_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
