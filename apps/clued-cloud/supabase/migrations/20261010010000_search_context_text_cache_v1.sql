-- clued_mcp_search_context within the anon role's 3 s statement timeout
-- (Task 775a2292).
--
-- On 2026-10-09 at 07:24 UTC search_context returned 500 code 57014. It
-- scores every record, checkpoint and event of the account: per row it casts
-- jsonb to text, lower-cases the whole text and runs the PL/pgSQL scorer. In
-- production (1,839 records, 2,350 checkpoints, 7,453 events, about 7 MB of
-- text; read-only timing, every page in memory) building the lower-cased
-- texts alone takes about 330 ms of the 340 ms scoring time per search, and
-- with include_history, a fresh PostgREST backend and the per-row
-- currentness fence the call came close to or over 3 s.
--
-- The lower-cased search text of each row is now kept in
-- clued_private.search_text_v1, written by triggers on the three tables and
-- backfilled here. Search reads it (building it only for a row without one)
-- and scores it with search_score_lc_v1, the same scorer without its
-- lower(), so results, scores, order, paging, caps and authorization are
-- unchanged. On the stored texts a pass over every row takes about 60 ms.
-- The search text stays out of the source rows, whose whole-row JSON other
-- functions read. The three tables are locked together up front, with a
-- lock timeout, so the triggers and the backfill cannot deadlock with
-- writers or queue them behind a long wait.

set local lock_timeout = '5s';
lock table public.clued_memories, public.clued_context_checkpoints, public.clued_context_events in share row exclusive mode;

create table clued_private.search_text_v1 (
  user_id uuid not null,
  source text not null check (source in ('record','checkpoint','event')),
  source_id text not null,
  text_lc text not null,
  primary key (user_id, source, source_id)
);
alter table clued_private.search_text_v1 enable row level security;
revoke all on table clued_private.search_text_v1 from public,anon,authenticated,service_role;

-- The text each source scores, exactly as search_context built it.
create or replace function clued_private.search_text_record_v1(p_title text,p_content text,p_type_fields jsonb)
returns text language sql immutable set search_path='' as $$
  select lower(coalesce(p_title,'')||E'\n'||coalesce(p_content,'')||E'\n'||coalesce(p_type_fields::text,''))
$$;
create or replace function clued_private.search_text_checkpoint_v1(p_summary text,p_next_action text,p_snapshot jsonb)
returns text language sql immutable set search_path='' as $$
  select lower(coalesce(p_summary,'')||E'\n'||coalesce(p_next_action,'')||E'\n'||coalesce(p_snapshot::text,''))
$$;
create or replace function clued_private.search_text_event_v1(p_payload jsonb)
returns text language sql immutable set search_path='' as $$
  select lower(p_payload::text)
$$;

create or replace function clued_private.search_text_sync_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_source text:=tg_argv[0]; v_text text;
begin
  if tg_op='TRUNCATE' then
    delete from clued_private.search_text_v1 where source=v_source;
    return null;
  end if;
  -- A deleted row, or the old key of a row whose id or user changed, loses its text.
  if tg_op='DELETE' or (tg_op='UPDATE' and (old.id is distinct from new.id or old.user_id is distinct from new.user_id)) then
    delete from clued_private.search_text_v1 where user_id=old.user_id and source=v_source and source_id=old.id::text;
    if tg_op='DELETE' then return old; end if;
  end if;
  -- One branch per source: each reads only its own table's columns.
  if v_source='record' then
    v_text:=clued_private.search_text_record_v1(new.title,new.content,new.type_fields);
  elsif v_source='checkpoint' then
    v_text:=clued_private.search_text_checkpoint_v1(new.summary,new.next_action,new.snapshot);
  else
    v_text:=clued_private.search_text_event_v1(new.payload);
  end if;
  insert into clued_private.search_text_v1(user_id,source,source_id,text_lc)
  values (new.user_id,v_source,new.id::text,v_text)
  on conflict (user_id,source,source_id) do update set text_lc=excluded.text_lc;
  return new;
end $$;

create trigger clued_memories_search_text_v1
  after insert or update of id,user_id,title,content,type_fields or delete on public.clued_memories
  for each row execute function clued_private.search_text_sync_v1('record');
create trigger clued_memories_search_text_truncate_v1
  after truncate on public.clued_memories for each statement execute function clued_private.search_text_sync_v1('record');
create trigger clued_context_checkpoints_search_text_v1
  after insert or update of id,user_id,summary,next_action,snapshot or delete on public.clued_context_checkpoints
  for each row execute function clued_private.search_text_sync_v1('checkpoint');
create trigger clued_context_checkpoints_search_text_truncate_v1
  after truncate on public.clued_context_checkpoints for each statement execute function clued_private.search_text_sync_v1('checkpoint');
create trigger clued_context_events_search_text_v1
  after insert or update of id,user_id,payload or delete on public.clued_context_events
  for each row execute function clued_private.search_text_sync_v1('event');
create trigger clued_context_events_search_text_truncate_v1
  after truncate on public.clued_context_events for each statement execute function clued_private.search_text_sync_v1('event');

insert into clued_private.search_text_v1(user_id,source,source_id,text_lc)
  select m.user_id,'record',m.id::text,clued_private.search_text_record_v1(m.title,m.content,m.type_fields) from public.clued_memories m
  union all
  select c.user_id,'checkpoint',c.id::text,clued_private.search_text_checkpoint_v1(c.summary,c.next_action,c.snapshot) from public.clued_context_checkpoints c
  union all
  select e.user_id,'event',e.id::text,clued_private.search_text_event_v1(e.payload) from public.clued_context_events e
on conflict (user_id,source,source_id) do nothing;

-- search_score_v1 on a text that is already lower-cased (search_score_v1 is
-- kept, unused, for a rollback of the function).
create or replace function clued_private.search_score_lc_v1(p_hay_lc text,p_query text,p_terms text[])
returns numeric language plpgsql immutable set search_path='' as $$
declare v_hay text:=coalesce(p_hay_lc,''); v_hit integer:=0; v_miss integer:=0;
  v_term text; v_n integer:=coalesce(cardinality(p_terms),0); v_max_miss integer;
begin
  if strpos(v_hay,p_query)>0 then return 1; end if;
  if v_n=0 then return 0; end if;
  v_max_miss:=v_n-ceil(v_n*clued_private.search_min_score_v1(p_terms))::integer;
  foreach v_term in array p_terms loop
    if strpos(v_hay,v_term)>0 then v_hit:=v_hit+1;
    else
      v_miss:=v_miss+1;
      if v_miss>v_max_miss then return 0; end if;
    end if;
  end loop;
  return least(round(v_hit::numeric/v_n,4),0.9999);
end $$;

revoke all on function clued_private.search_text_record_v1(text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function clued_private.search_text_checkpoint_v1(text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function clued_private.search_text_event_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function clued_private.search_text_sync_v1() from public,anon,authenticated,service_role;
revoke all on function clued_private.search_score_lc_v1(text,text,text[]) from public,anon,authenticated,service_role;

-- search_context is rewritten in place, as 20261008210000 rewrote it: the
-- three scoring joins are replaced in the current definition, each exactly
-- once, so the credential verifier and every later change are kept.
do $rewrite$
declare
  body text := pg_catalog.pg_get_functiondef('public.clued_mcp_search_context(text,jsonb)'::regprocedure);
  r record;
  n int;
begin
  -- A second run finds the joins already replaced.
  if strpos(body, 'clued_private.search_score_lc_v1(') > 0 then return; end if;
  for r in select * from (values
    ($o$    cross join lateral (select clued_private.search_score_v1(
      coalesce(m.title,'')||E'\n'||coalesce(m.content,'')||E'\n'||coalesce(m.type_fields::text,''),
      v_query_lc,v_terms) score offset 0) sc$o$,
     $n$    left join clued_private.search_text_v1 st on st.user_id=m.user_id and st.source='record' and st.source_id=m.id::text
    cross join lateral (select coalesce(st.text_lc,clued_private.search_text_record_v1(m.title,m.content,m.type_fields)) hay offset 0) t
    cross join lateral (select clued_private.search_score_lc_v1(t.hay,v_query_lc,v_terms) score offset 0) sc$n$),
    ($o$    cross join lateral (select clued_private.search_score_v1(
      coalesce(c.summary,'')||E'\n'||coalesce(c.next_action,'')||E'\n'||coalesce(c.snapshot::text,''),
      v_query_lc,v_terms) score offset 0) sc$o$,
     $n$    left join clued_private.search_text_v1 st on st.user_id=c.user_id and st.source='checkpoint' and st.source_id=c.id::text
    cross join lateral (select coalesce(st.text_lc,clued_private.search_text_checkpoint_v1(c.summary,c.next_action,c.snapshot)) hay offset 0) t
    cross join lateral (select clued_private.search_score_lc_v1(t.hay,v_query_lc,v_terms) score offset 0) sc$n$),
    ($o$    cross join lateral (select clued_private.search_score_v1(e.payload::text,v_query_lc,v_terms) score offset 0) sc$o$,
     $n$    left join clued_private.search_text_v1 st on st.user_id=e.user_id and st.source='event' and st.source_id=e.id::text
    cross join lateral (select coalesce(st.text_lc,clued_private.search_text_event_v1(e.payload)) hay offset 0) t
    cross join lateral (select clued_private.search_score_lc_v1(t.hay,v_query_lc,v_terms) score offset 0) sc$n$)) v(old_text, new_text) loop
    n := (length(body) - length(replace(body, r.old_text, ''))) / length(r.old_text);
    if n <> 1 then
      raise exception 'search_context_rewrite_mismatch' using detail = format('%s occurrences of %s', n, left(r.old_text, 80));
    end if;
    body := replace(body, r.old_text, r.new_text);
  end loop;
  execute body;
end $rewrite$;
