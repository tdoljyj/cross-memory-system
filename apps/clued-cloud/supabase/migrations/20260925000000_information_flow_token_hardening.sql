-- Information Flow confirmation-token hardening (M0-D follow-up; B09 round 3
-- F01, A03 register L29 and L30). Additive: the merged S3/S4/S5 migrations
-- are not edited. Each function is patched from its effective definition
-- (pg_get_functiondef) by replacing exact anchors; every anchor must occur
-- exactly once and the patch must not already be present, otherwise the
-- migration fails. CREATE OR REPLACE keeps owners, grants and revokes.
--
-- F01 (S3 candidate_promote_core_v1): a presented confirmation_token is
--   looked up by hash for this user before the unknown-field and input-shape
--   checks, so the existing exception handler burns a live token on a
--   malformed request, as S4 accept and S5 withdraw already do. Failures in
--   m1_begin_receipt still abort the transaction without burning (S3 D4, L11).
-- L29 (S3/S4/S5 issue and consume): a token is issued only to a JWT with a
--   non-empty string session_id claim (confirmation_token_session_id_required,
--   42501, returned as a rejection); consume requires a non-null token
--   session_id equal to the JWT's, normalized by the same helper as issue.
-- L30 (S4 accept, S5 withdraw): the locking token lookup filters by action,
--   so a token issued for one action is invisible to (and never burned by)
--   the other action's RPC. A same-action token presented for another subject
--   is still found and burned as confirmation_token_binding_mismatch, the
--   same single-use rule S3 applies to a token for another candidate.

-- The session_id claim of the current JWT when it is a non-blank string;
-- NULL otherwise. Read-only; used by the token issue and consume cores.
create function clued_private.native_session_id_v1()
returns text language sql stable set search_path='' as $$
  select case when jsonb_typeof(auth.jwt()->'session_id')='string' and btrim(auth.jwt()->>'session_id')<>''
    then auth.jwt()->>'session_id' end
$$;
revoke all on function clued_private.native_session_id_v1() from public,anon,authenticated,service_role;

do $migration$
declare body text;
  -- Issue cores (S3, S4, S5): the early re-authentication return.
  issue_anchor text:=$a$    return jsonb_build_object('status','rejected','error_code','reauthentication_required','authoritative',false);
  end if;
$a$;
  issue_guard text:=$a$  -- L29: the token is bound to a real session; a JWT without a
  -- session_id claim cannot obtain one.
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required',
      'authoritative',false);
  end if;
$a$;
  -- Consume cores (S3, S4, S5): the session binding clause.
  consume_anchor text:=$a$      or v_token.session_id is distinct from nullif(auth.jwt()->>'session_id','') then$a$;
  consume_new text:=$a$      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then$a$;
  -- F01: S3 promote pre-lookup before the shape checks.
  promote_anchor text:=$a$    -- Authority, record type, Evidence and confirmation flags are never
    -- caller input here: they come only from the token-bound confirmation.
$a$;
  promote_lookup text:=$a$    -- Single use (F01): locate a presented live token before any shape
    -- check, so a malformed request also burns it (the handler below).
    if jsonb_typeof(p_input->'confirmation_token')='string' then
      select t.id into v_token_id from clued_private.candidate_confirmation_tokens t
        where t.user_id=p_user_id
          and t.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    end if;
$a$;
  -- L30: the S4/S5 locking lookups.
  lookup_tail text:=$a$
        and t.token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex')
      for update;$a$;
  accept_anchor text;
  withdraw_anchor text;
  f text;
begin
  accept_anchor:=$a$    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=p_user_id$a$||lookup_tail;
  withdraw_anchor:=accept_anchor;

  -- Issue cores.
  foreach f in array array[
      'clued_private.candidate_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.context_policy_confirmation_issue_core_v1(uuid,jsonb)',
      'clued_private.evidence_withdrawal_confirmation_issue_core_v1(uuid,jsonb)'] loop
    body:=pg_get_functiondef(f::regprocedure);
    if (length(body)-length(replace(body,issue_anchor,'')))/length(issue_anchor)<>1
      or strpos(body,'native_session_id_v1')>0 then
      raise exception 'token_hardening_issue_definition_mismatch: %',f;
    end if;
    execute replace(body,issue_anchor,issue_anchor||issue_guard);
  end loop;

  -- S3 promote: F01 pre-lookup and the L29 consume check.
  body:=pg_get_functiondef('clued_private.candidate_promote_core_v1(uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,promote_anchor,'')))/length(promote_anchor)<>1
    or (length(body)-length(replace(body,consume_anchor,'')))/length(consume_anchor)<>1
    or strpos(body,'Single use (F01)')>0 then
    raise exception 'token_hardening_promote_definition_mismatch';
  end if;
  execute replace(replace(body,promote_anchor,promote_lookup||promote_anchor),consume_anchor,consume_new);

  -- S4 accept: L30 action filter and the L29 consume check.
  body:=pg_get_functiondef('clued_private.context_policy_accept_core_v1(uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,accept_anchor,'')))/length(accept_anchor)<>1
    or (length(body)-length(replace(body,consume_anchor,'')))/length(consume_anchor)<>1 then
    raise exception 'token_hardening_accept_definition_mismatch';
  end if;
  execute replace(replace(body,accept_anchor,
      $a$    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=p_user_id and t.action='context_policy_accept'$a$||lookup_tail),
    consume_anchor,consume_new);

  -- S5 withdraw: L30 action filter and the L29 consume check.
  body:=pg_get_functiondef('clued_private.evidence_withdraw_core_v1(uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,withdraw_anchor,'')))/length(withdraw_anchor)<>1
    or (length(body)-length(replace(body,consume_anchor,'')))/length(consume_anchor)<>1 then
    raise exception 'token_hardening_withdraw_definition_mismatch';
  end if;
  execute replace(replace(body,withdraw_anchor,
      $a$    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=p_user_id and t.action='evidence_withdraw'$a$||lookup_tail),
    consume_anchor,consume_new);
end $migration$;

notify pgrst,'reload schema';
