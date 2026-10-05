-- Work Claim admission, re-review 9 (Owner Decision 9dba872f, Task d811ab16;
-- OwnerCredential.v0.1.md §6.3).
--
-- 1. MAJOR-2: repo.protected_change is never bundled. One click must not
--    approve a protected change together with something else.
-- 2. MINOR-3: the confirmation page offers no wider scope for
--    repo.protected_change: the admission door admits only a grant that names
--    the commit itself (20261005120000), so a glob offered there would be a
--    grant that admits nothing.
-- 3. MAJOR-2: the confirmation view says who wrote a request's note. A note
--    the admission door wrote (its request receipt has origin ci-admission,
--    which only that door writes) is shown as the admission check's, with the
--    compare link of the pushed commits; any other note stays the Agent's,
--    unverified.
-- 4. Re-review 10, MAJOR-3: the admission door answers only a Binding the
--    Owner marked ci-admission. Before the Owner marks one, nobody can use it,
--    so no Agent can write a request that the page shows as the admission
--    check's (binding_role_admits_v1 lets anyone in while a role is unmarked).
-- 5. Re-review 10, MINOR-2: an Agent cannot open a repo.protected_change
--    request itself; only the admission door does, with its own note.
-- 6. Re-review 10, NIT: the confirmation step accepts, for this action, only
--    the request's own resources, as the page offers.
-- 7. Re-review 11, MINOR-3: a repo.protected_change request still pending
--    from before this migration may have been opened by any Binding (before
--    item 4) or by an Agent (before item 5), so it is closed as expired.
--    Grants already given stay; the Owner reviews them on /grants.
--
-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.

create function clued_private.owner_review_hardening_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'owner_review_hardening_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

select clued_private.owner_review_hardening_patch_v1('public.clued_owner_request_bundle_v1(text,jsonb)',
$a$          or x->>'action'='connection.permission')$a$,
$r$          or x->>'action' in ('connection.permission','repo.protected_change'))$r$);

select clued_private.owner_review_hardening_patch_v1('public.clued_owner_request_view_v1(jsonb)',
$a$    'resource_options',clued_private.owner_request_scope_options_v1(v_req.resources),$a$,
$r$    'resource_options',case when v_req.action='repo.protected_change' then
      (select coalesce(jsonb_agg(jsonb_build_object('resource',r,'options',jsonb_build_array(r)) order by n),'[]'::jsonb)
        from unnest(v_req.resources) with ordinality as t(r,n))
      else clued_private.owner_request_scope_options_v1(v_req.resources) end,$r$);

select clued_private.owner_review_hardening_patch_v1('clued_private.owner_grant_view_v1(uuid,jsonb)',
$a$        'agent_note_unverified',v_req.agent_note) end);$a$,
$r$        'agent_note_unverified',v_req.agent_note,
        'note_source',case when exists(select 1 from public.clued_audit_receipts rc
            where rc.id=v_req.receipt_id and rc.operation='owner_request_create'
              and rc.metadata->>'origin'='ci-admission') then 'ci-admission' else 'agent' end) end);$r$);

select clued_private.owner_review_hardening_patch_v1('public.clued_owner_grant_admission_door_v1(text,jsonb)',
$a$  if not clued_private.binding_role_admits_v1(v_binding,'ci-admission') then$a$,
$r$  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=v_binding.id and r.role='ci-admission' and r.revoked_at is null) then$r$);

select clued_private.owner_review_hardening_patch_v1('public.clued_owner_request_v1(text,jsonb)',
$a$    raise exception 'owner_grant_action_unknown' using errcode='22023'; end if;$a$,
$r$    raise exception 'owner_grant_action_unknown' using errcode='22023'; end if;
  if p_input->>'action'='repo.protected_change' then
    raise exception 'owner_request_action_door_only' using errcode='22023'; end if;$r$);

select clued_private.owner_review_hardening_patch_v1('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
$a$            from jsonb_array_elements(clued_private.owner_request_scope_options_v1(v_req.resources)) o))) then$a$,
$r$            from jsonb_array_elements(clued_private.owner_request_scope_options_v1(v_req.resources)) o))
            or (v_req.action='repo.protected_change' and not (v_resources <@ v_req.resources))) then$r$);

drop function clued_private.owner_review_hardening_patch_v1(text,text,text);

update clued_private.owner_requests_v1
  set expires_at=greatest(created_at+interval '1 millisecond',clock_timestamp())
  where action='repo.protected_change' and status='pending' and expires_at>clock_timestamp();

notify pgrst,'reload schema';
