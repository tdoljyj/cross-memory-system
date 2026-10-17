-- Narrow incoming-message candidates before the existing authority check.
-- The two recipient indexes already exist. This is a statement-local
-- superset, not authorization: include every claim held by this Binding,
-- irrespective of status, expiry or session; keep addressed() final.
-- In particular, an expired/transferred claim can fall back to the original
-- Binding. Do not cache a live-only claim set across statements or RPCs.
-- Thread participation/whole-thread output, sent mail, mark-read, Owner
-- answers, feature switches, roles and timeouts remain byte-for-byte intact.

do $migration$
declare
  item record;
  definition text;
  before_catalog jsonb;
  after_catalog jsonb;
  selector text;
  replacement text;
  occurrences integer;
begin
  for item in
    select * from (values
      ('public.clued_agent_inbox_v1(text,jsonb)'::regprocedure, 10, 1),
      ('public.clued_agent_inbox_summary_v1(text,jsonb)'::regprocedure, 8, 2)
    ) targets(target, indentation, expected)
  loop
    select pg_get_functiondef(p.oid), jsonb_build_object(
      'oid',p.oid,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
      'volatile',p.provolatile,'definer',p.prosecdef,'result',p.prorettype,
      'arguments',p.proargtypes::text)
      into definition,before_catalog from pg_proc p where p.oid=item.target;

    selector := $source$and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))$source$
      || E'\n' || repeat(' ',item.indentation)
      || 'and clued_private.agent_message_addressed(m,v_binding.id,v_session)';
    replacement := $source$and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))$source$
      || E'\n' || repeat(' ',item.indentation)
      || $source$and (m.to_binding_id=v_binding.id or m.to_claim_id=any(array(
            select c.claim_id from clued_private.work_claims_v1 c
            where c.user_id=v_binding.user_id and c.holder_binding_id=v_binding.id)))$source$
      || E'\n' || repeat(' ',item.indentation)
      || 'and clued_private.agent_message_addressed(m,v_binding.id,v_session)';

    occurrences := (length(definition)-length(replace(definition,selector,''))) / length(selector);
    if occurrences <> item.expected then
      raise exception 'agent_inbox_recipient_prefilter_definition_mismatch: % has %, expected %',
        item.target,occurrences,item.expected;
    end if;
    execute replace(definition,selector,replacement);

    select jsonb_build_object(
      'oid',p.oid,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
      'volatile',p.provolatile,'definer',p.prosecdef,'result',p.prorettype,
      'arguments',p.proargtypes::text)
      into after_catalog from pg_proc p where p.oid=item.target;
    if before_catalog is distinct from after_catalog then
      raise exception 'agent_inbox_recipient_prefilter_catalog_changed: %',item.target;
    end if;
  end loop;
end $migration$;
