-- Owner Decision b7053465 (Task a72a4d0c): the confirmation page's default
-- choice follows the action's risk, which Clued registers per action; the
-- Agent cannot declare it. A high-risk action (production release, production
-- migration, and any action registered later unless it is marked routine)
-- opens on "approve once"; a routine action opens on "grant for a while" with
-- the Agent's suggested duration, else 4 hours. The Owner can still change the
-- choice; what is approved is still the view the two-step token binds.

alter table clued_private.owner_grant_actions
  add column risk text not null default 'high' check (risk in ('high','routine'));
update clued_private.owner_grant_actions set risk='routine' where action='work_claim.extra_claims';

-- Same as 20261003190000 plus default_choice and suggested_expires_seconds;
-- the view is rendered for the default choice ("once": 24 hours, one use, as
-- clued_owner_grant_confirmation_issue_v1 renders it).
create or replace function public.clued_owner_request_view_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_req clued_private.owner_requests_v1%rowtype;
  v_choice text; v_seconds integer:=14400;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'request_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'owner_request_id_invalid' using errcode='22023'; end if;
  select * into v_req from clued_private.owner_requests_v1 where id=(p_input->>'request_id')::uuid and user_id=v_owner;
  if not found then return jsonb_build_object('status','rejected','error_code','owner_request_not_found'); end if;
  select case when a.risk='routine' then 'grant' else 'once' end into v_choice
    from clued_private.owner_grant_actions a where a.action=v_req.action;
  v_choice:=coalesce(v_choice,'once');
  v_seconds:=coalesce(v_req.suggested_expires_seconds,14400);
  return jsonb_build_object('status','ok','request',clued_private.owner_request_public_v1(v_req),
    'default_choice',v_choice,'suggested_expires_seconds',v_seconds,
    'resource_options',clued_private.owner_request_scope_options_v1(v_req.resources),
    'view',clued_private.owner_grant_view_v1(v_owner,jsonb_build_object('request_id',v_req.id,'action',v_req.action,
      'resources',to_jsonb(v_req.resources),'task_id',v_req.task_id,'grantee_binding_id',v_req.binding_id,
      'choice',v_choice,
      'expires_seconds',case when v_choice='once' then 86400 else v_seconds end,
      'max_uses',case when v_choice='once' then 1 else v_req.suggested_max_uses end)));
end $$;
