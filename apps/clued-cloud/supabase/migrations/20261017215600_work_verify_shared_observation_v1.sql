-- Ordinary claim observation does not admit/bind/meter execution. Let those
-- readers coexist while retaining the same Owner lock domains and order,
-- a claim row lock, both Binding checks and every final authority check.
-- PR, dispatch, malformed-dispatch and action routes retain their old path.
-- This removes a known source of reader serialization; it does not establish
-- the cause of every observed 57014 or replace production qualification.

do $migration$
declare
  target regprocedure := 'public.clued_work_verify_v1(text,jsonb)'::regprocedure;
  original text;
  changed text;
  before_catalog jsonb;
  after_catalog jsonb;
  anchor text;
  replacement text;
  expected record;
  occurrences integer;
begin
  -- These unchanged helpers define the reviewed key order, authentication
  -- and delegated no-action behavior. A different predecessor needs review.
  for expected in select * from (values
    ('public.clued_work_verify_v1(text,jsonb)', 'aa9a127a335b1d9bfff025ce3f7ae548'),
    ('clued_private.currentness_user_lock(uuid)', '198bb4aa628325921e671be12e86d903'),
    ('clued_private.work_claim_lock(uuid)', 'e2ead0eb36efea12e0433e6951572470'),
    ('clued_private.resolve_binding(text,text,text)', '52d92fefbaee3d51b840f78ad41f7af5'),
    ('clued_private.work_claim_verify_before_execution_v1(text,jsonb)', '199a46b975c21168ec7978e1e500b5d4')
  ) inputs(signature, body_md5)
  loop
    if not exists(select 1 from pg_proc p where p.oid=expected.signature::regprocedure
        and md5(p.prosrc)=expected.body_md5) then
      raise exception 'work_verify_shared_observation_predecessor_mismatch: %', expected.signature;
    end if;
  end loop;

  select pg_get_functiondef(p.oid), jsonb_build_object(
    'oid',p.oid,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
    'volatile',p.provolatile,'definer',p.prosecdef,'result',p.prorettype,
    'language',p.prolang,'arguments',p.proargtypes::text)
    into original,before_catalog from pg_proc p where p.oid=target;
  changed := original;

  anchor := '  result jsonb; executing boolean;';
  replacement := $source$  result jsonb; executing boolean;
  ordinary_observation boolean := coalesce(jsonb_typeof(p_input)='object'
    and not(p_input ? 'action') and not(p_input ? 'pr_ref')
    and (not(p_input ? 'ci_dispatch') or p_input->'ci_dispatch'='false'::jsonb),false);$source$;
  occurrences := (length(changed)-length(replace(changed,anchor,''))) / length(anchor);
  if occurrences<>1 then raise exception 'work_verify_shared_observation_declaration_mismatch'; end if;
  changed := replace(changed,anchor,replacement);

  anchor := '  perform clued_private.work_claim_lock(b.user_id);';
  replacement := $source$  if ordinary_observation then
    perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
      'clued-currentness-user:'||b.user_id::text,0));
    perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
      'clued-work-claim:'||b.user_id::text,0));
  else
    perform clued_private.work_claim_lock(b.user_id);
  end if;$source$;
  occurrences := (length(changed)-length(replace(changed,anchor,''))) / length(anchor);
  if occurrences<>1 then raise exception 'work_verify_shared_observation_owner_lock_mismatch'; end if;
  changed := replace(changed,anchor,replacement);

  anchor := $source$  select * into c from clued_private.work_claims_v1 where user_id=b.user_id
    and context_key=coalesce(p_input->>'scope','global') and claim_id=(p_input->>'claim_id')::uuid for update;$source$;
  replacement := $source$  if ordinary_observation then
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id
      and context_key=coalesce(p_input->>'scope','global') and claim_id=(p_input->>'claim_id')::uuid for share;
  else
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id
      and context_key=coalesce(p_input->>'scope','global') and claim_id=(p_input->>'claim_id')::uuid for update;
  end if;$source$;
  occurrences := (length(changed)-length(replace(changed,anchor,''))) / length(anchor);
  if occurrences<>1 then raise exception 'work_verify_shared_observation_claim_lock_mismatch'; end if;
  changed := replace(changed,anchor,replacement);

  execute changed;
  select jsonb_build_object(
    'oid',p.oid,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
    'volatile',p.provolatile,'definer',p.prosecdef,'result',p.prorettype,
    'language',p.prolang,'arguments',p.proargtypes::text)
    into after_catalog from pg_proc p where p.oid=target;
  if before_catalog is distinct from after_catalog then
    raise exception 'work_verify_shared_observation_catalog_changed';
  end if;
end $migration$;
