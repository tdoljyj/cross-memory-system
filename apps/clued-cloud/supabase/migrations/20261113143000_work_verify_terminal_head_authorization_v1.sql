-- The terminal admission and the reply name the same head authorization (field 2026-11-13).
--
-- 20261108204157 records a terminal admission whose head_authorization_id falls back to
-- claim_binding.head_authorization_id when the reply's own head_authorization_id is null
-- (execution policy staged, claim without a lease key). The resident's
-- terminalAdmissionFromVerification (scripts/ci/clued-pr-task-binding.mjs) requires that id to be
-- a UUID equal to the reply's head_authorization_id, so every authorized head failed stage 1 with
-- full_admission_unavailable from 06:01Z and the executor's breaker opened.
--
-- The reply now carries the id its terminal admission names; with no head authorization at all
-- there is no terminal admission (the client then has none to check).

do $patch$
declare body text:=pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  anchor text:=$a$  head_id:=coalesce(nullif(result->>'head_authorization_id',''),result#>>'{claim_binding,head_authorization_id}')::uuid;
$a$;
  replacement text:=$r$  head_id:=coalesce(nullif(result->>'head_authorization_id',''),result#>>'{claim_binding,head_authorization_id}')::uuid;
  if head_id is null then return result; end if;
  result:=result||jsonb_build_object('head_authorization_id',head_id);
$r$;
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'work_verify_terminal_head_authorization_anchor_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $patch$;
