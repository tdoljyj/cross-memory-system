-- Unaccepted scratch candidate; fixed Task1502 and original af1/4970 only.
-- A claim selects the proposed grantee, never approves Bootstrap. Only the
-- unchanged Native Owner token/writer/revoke protocol creates the successor.
-- Original request Binding/key/plan and original token/Receipt remain intact.
-- No new public function, writer change, ACL change or any-agent permission.

do $PATCH$
declare
  context_src text := pg_get_functiondef(
    'clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)'::regprocedure);
  link_src text := pg_get_functiondef(
    'clued_private.dataset_split_grant_correction_link_v1(uuid,jsonb,uuid)'::regprocedure);
  context_expected constant text := 'b95e8ddba5b4400078ae6143735b80aa306bdf44ba6c43c42cbe602b1e98ecf1';
  link_expected constant text := '68a93c873c547ff17bfa09ddde117276511eaa430425b713f2104ad7c204ca94';
  declaration_marker constant text :=
    '  b public.clued_agent_bindings; m public.clued_memories; installed jsonb; plan jsonb;';
  binding_marker constant text := $OLD_BINDING$
  select * into b from public.clued_agent_bindings where id=r.binding_id and user_id=p_owner for update;
  if not found or b.revoked_at is not null or
    (to_jsonb(b)->>'expires_at' is not null and (to_jsonb(b)->>'expires_at')::timestamptz<=now_at) then
    raise exception 'dataset_split_correction_binding_not_current' using errcode='42501'; end if;
$OLD_BINDING$;
  task_marker constant text :=
    '  select * into m from public.clued_memories where id=r.task_id and user_id=p_owner for update;';
  permission_marker constant text :=
    '  installed:=clued_private.model_domain_bootstrap_exact_plan_candidate();';
  target_marker constant text := '  plan:=(installed->>''raw_utf8'')::jsonb;';
  return_marker constant text := '  return jsonb_build_object(''choices'',choices,''view'',view);';
  snapshot_marker constant text := $OLD_SNAPSHOT$
  snapshot:=clued_private.m1_sha256(jsonb_build_object('request',to_jsonb(r),'grant',to_jsonb(g),
    'binding',jsonb_build_object('id',b.id,'user_id',b.user_id,'vendor',b.vendor,'agent_name',b.agent_name,
      'revoked_at',b.revoked_at,'expires_at',to_jsonb(b)->'expires_at','scopes',b.scopes,
      'context_keys',to_jsonb(b)->'context_keys'),
    'task',jsonb_build_object('id',m.id,'title',m.title,'record_type',m.record_type,
      'lifecycle_status',m.lifecycle_status,'canonical_scope',m.canonical_scope),
    'token',to_jsonb(t),'receipt',to_jsonb(a)));
$OLD_SNAPSHOT$;
  grantee_marker constant text :=
    '''task_id'',r.task_id,''grantee_binding_id'',r.binding_id,''choice'',''grant'',''expires_seconds'',3600,''max_uses'',1,';
  view_marker constant text := $OLD_VIEW$
      'previous_expires_at',g.expires_at,'snapshot',snapshot,
      'effect','REPLACE_UNUSED_GRANT_WITH_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY'));
$OLD_VIEW$;
  link_marker constant text :=
    'new_g.task_id is distinct from old_g.task_id or new_g.grantee_binding_id is distinct from old_g.grantee_binding_id or';
  marker text;
begin
  -- Both entire predecessor definitions are checked before any replacement.
  if encode(extensions.digest(convert_to(context_src,'UTF8'),'sha256'),'hex')
      is distinct from context_expected or
    encode(extensions.digest(convert_to(link_src,'UTF8'),'sha256'),'hex')
      is distinct from link_expected then
    raise exception 'dataset_split_binding_successor_source_changed';
  end if;
  foreach marker in array array[declaration_marker,binding_marker,task_marker,
      permission_marker,target_marker,return_marker,snapshot_marker,grantee_marker,view_marker] loop
    if (length(context_src)-length(replace(context_src,marker,'')))/length(marker) <> 1 then
      raise exception 'dataset_split_binding_successor_context_marker_changed';
    end if;
  end loop;
  if (length(link_src)-length(replace(link_src,link_marker,'')))/length(link_marker) <> 1 then
    raise exception 'dataset_split_binding_successor_link_marker_changed';
  end if;
  context_src := replace(context_src,declaration_marker,declaration_marker || E'\n'
    || '  old_b public.clued_agent_bindings; c clued_private.work_claims_v1; live_claims bigint;');
  context_src := replace(context_src,binding_marker,$NEW_BINDING$
  -- The unchanged writer already owns the Owner-grant advisory lock. The
  -- Bootstrap path locks currentness/work-claim before Owner-grant, so taking
  -- those locks with a blocking call here would invert the order. Try the same
  -- existing keys without waiting; contention fails and burns the Native token
  -- through the unchanged writer's normal rejection protocol.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'clued-currentness-user:'||p_owner::text,0)) or
    not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'clued-work-claim:'||p_owner::text,0)) then
    raise exception 'dataset_split_correction_claim_lock_busy' using errcode='40001'; end if;
  select * into old_b from public.clued_agent_bindings
    where id=r.binding_id and user_id=p_owner for share nowait;
  if not found then
    raise exception 'dataset_split_correction_original_binding_missing' using errcode='42501'; end if;
  -- Old Binding liveness is deliberately not an execution qualification.
  -- Its identity and the original signed approval remain immutable history.
  select count(*) into live_claims from clued_private.work_claims_v1 w
    where w.user_id=p_owner and w.task_id=r.task_id and w.status in ('ACTIVE','DRAINING')
      and w.expires_at>clock_timestamp() and w.hard_deadline_at>clock_timestamp();
  if live_claims is distinct from 1 or exists(select 1
    from clued_private.work_claim_task_modes_v1 x where x.user_id=p_owner
      and x.task_id=r.task_id and x.adopted_claim_id is null) then
    raise exception 'dataset_split_correction_unique_claim_required' using errcode='42501'; end if;
  select * into c from clued_private.work_claims_v1 w
    where w.user_id=p_owner and w.task_id=r.task_id and w.context_key=s
      and w.status='ACTIVE' and w.copy_index is null and w.outcome is distinct from 'not_adopted'
      and w.expires_at>clock_timestamp() and w.hard_deadline_at>clock_timestamp()
    for update nowait;
  if not found or c.fence is distinct from (select max(x.fence)
    from clued_private.work_claims_v1 x where x.user_id=p_owner and x.task_id=r.task_id) then
    raise exception 'dataset_split_correction_current_claim_required' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings
    where id=c.holder_binding_id and user_id=p_owner for share nowait;
  if not found or b.revoked_at is not null or
    (to_jsonb(b)->>'expires_at' is not null and (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()) or
    not ('context:read'=any(b.scopes) and 'context:write'=any(b.scopes)) or
    not ('*'=any(b.context_keys) or s=any(b.context_keys)) then
    raise exception 'dataset_split_correction_binding_not_current' using errcode='42501'; end if;
$NEW_BINDING$);
  context_src := replace(context_src,task_marker,
    '  select * into m from public.clued_memories where id=r.task_id and user_id=p_owner for share nowait;');
  context_src := replace(context_src,permission_marker,$PERMISSIONS$
  -- Reuse the actual v12 authorization checks without taking, borrowing or
  -- reconstructing the proposed grantee's credential. These reads add no
  -- permission; the later Bootstrap call still resolves its own actual token.
  perform 1 from auth.users x where x.id=p_owner for share nowait;
  perform 1 from public.clued_projects x
    where x.id='0597aa60-9b98-4da6-a4ab-63d7705b632f'::uuid and x.user_id=p_owner for share nowait;
  if not found then
    raise exception 'dataset_split_correction_project_owner_mismatch' using errcode='42501'; end if;
  perform 1 from clued_private.authorizations_v12 x where x.binding_id=b.id for share nowait;
  perform 1 from clued_private.authorization_entries_v12 x where x.binding_id=b.id for share nowait;
  perform 1 from clued_private.raw_binding_grants_v1 x where x.binding_id=b.id for share nowait;
  if exists(select 1 from clued_private.authorizations_v12 x
      where x.binding_id=b.id and x.owner_id is distinct from p_owner) then
    raise exception 'dataset_split_correction_binding_owner_mismatch' using errcode='42501'; end if;
  perform clued_private.authorization_assert_entry_v12(b.id,'scope',s,'canonical','read');
  perform clued_private.authorization_assert_entry_v12(b.id,'scope',s,'canonical','write');
  if m.type_fields->'execution_intent'->>'source_scope'='global' then
    if not ('*'=any(b.context_keys) or 'global'=any(b.context_keys)) then
      raise exception 'dataset_split_correction_global_read_required' using errcode='42501'; end if;
    perform clued_private.authorization_assert_entry_v12(b.id,'scope','global','canonical','read');
  end if;
  installed:=clued_private.model_domain_bootstrap_exact_plan_candidate();
$PERMISSIONS$);
  context_src := replace(context_src,target_marker,target_marker || $TARGETS$
  if exists(select 1 from jsonb_each_text(plan->'targets') x
    where not clued_private.work_claim_resource_covered_v1('record:'||x.value,c.write_set)) then
    raise exception 'dataset_split_correction_target_paths_not_covered' using errcode='42501'; end if;
$TARGETS$);
  context_src := replace(context_src,snapshot_marker,$SNAPSHOT$
  -- Complete private snapshots bind version/content, lease/fence, identities
  -- and effective permission metadata. Only the digest enters the view.
  snapshot:=clued_private.m1_sha256(jsonb_build_object('request',to_jsonb(r),'grant',to_jsonb(g),
    'original_binding',to_jsonb(old_b),'binding',to_jsonb(b),'claim',to_jsonb(c),'task',to_jsonb(m),
    'account',(select to_jsonb(x) from auth.users x where x.id=p_owner),
    'project',(select to_jsonb(x) from public.clued_projects x
      where x.id='0597aa60-9b98-4da6-a4ab-63d7705b632f'::uuid and x.user_id=p_owner),
    'authorization',(select to_jsonb(x) from clued_private.authorizations_v12 x where x.binding_id=b.id),
    'authorization_entries',(select coalesce(jsonb_agg(to_jsonb(x)
      order by x.resource_kind,x.resource_id,x.environment),'[]'::jsonb)
      from clued_private.authorization_entries_v12 x where x.binding_id=b.id),
    'raw_grant',(select to_jsonb(x) from clued_private.raw_binding_grants_v1 x where x.binding_id=b.id),
    'token',to_jsonb(t),'receipt',to_jsonb(a)));
$SNAPSHOT$);
  context_src := replace(context_src,grantee_marker,
    '''task_id'',r.task_id,''grantee_binding_id'',b.id,''choice'',''grant'',''expires_seconds'',3600,''max_uses'',1,');
  context_src := replace(context_src,view_marker,$VIEW$
      'previous_expires_at',g.expires_at,'snapshot',snapshot,
      'previous_binding_id',old_b.id,'new_binding_id',b.id,
      'binding_continuation',jsonb_build_object(
        'schema','clued.dataset-split-native-binding-continuation.v1',
        'binding_changed',b.id is distinct from old_b.id,
        'previous_binding',jsonb_build_object('binding_id',old_b.id,'agent_name',old_b.agent_name,
          'vendor',old_b.vendor,'revoked',old_b.revoked_at is not null,'session_ref',to_jsonb(r)->>'session_ref'),
        'current_binding',jsonb_build_object('binding_id',b.id,'agent_name',b.agent_name,'vendor',b.vendor,
          'session_ref',c.holder_session_ref),
        'execution_claim',jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
          'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
          'holder_label_self_reported',c.holder_label,'fence',c.fence,'lease_version',c.lease_version,
          'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at),
        'task',jsonb_build_object('task_id',m.id,'title',m.title,'version',m.version,
          'content_hash',clued_private.m1_sha256(to_jsonb(m)))),
      'effect',case when b.id=old_b.id then
        'REPLACE_UNUSED_GRANT_WITH_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY' else
        'REAUTHORIZE_CURRENT_CLAIM_HOLDER_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY' end));
$VIEW$);
  context_src := replace(context_src,return_marker,return_marker || $LOCK_ERROR$
exception when lock_not_available then
  raise exception 'dataset_split_correction_source_lock_busy' using errcode='40001';
$LOCK_ERROR$);
  link_src := replace(link_src,link_marker,
    'new_g.task_id is distinct from old_g.task_id or new_g.grantee_binding_id is distinct from (c->>''grantee_binding_id'')::uuid or');
  execute context_src;
  execute link_src;
end $PATCH$;

notify pgrst,'reload schema';
