-- StorageNormalUse.v0.1 §7 read budget for N1b (images, extracted Office text).
--
-- P2 (20260930060000) admitted a content read with a flat 256 KiB reservation
-- and settled it to the delivered bytes. N1b delivers images of up to 5 MiB, so
-- many concurrent image reads could all pass admission and together exceed the
-- window. This migration:
-- * adds storage_read_receipts_v1.reserved_bytes: the reservation of an
--   unfinalized read_content receipt (NULL = the admission default, 256 KiB);
-- * adds action `reserve` to public.clued_storage_read_v1: the Worker calls it
--   on the SAME receipt after metadata classification and BEFORE any body or
--   media request, with the call's maximum delivered bytes (image: file size,
--   at most 5 MiB; text/Office: at most 256 KiB, already covered by admission).
--   It takes the same per-Binding transaction advisory lock as admission, sums
--   every other receipt of the window (finalized: byte_count; unfinalized: its
--   reservation) and either raises the reservation or raises
--   storage_read_budget_exhausted. A reservation only grows; finalize still
--   settles to the delivered bytes, which releases the unused part;
-- * raises the hourly delivered-content budget from 8 MiB to 256 MiB per
--   Binding (Owner decision: read 256 MiB per hour; §7.1 default). The value is
--   still fixed; Owner-adjustable budgets remain N4 (§7.3).
-- Legacy / text/1 reads are unchanged: they never call reserve and keep the
-- 256 KiB admission reservation. Reads still create no job, journal row or
-- provider fence.

alter table clued_private.storage_read_receipts_v1
  add column reserved_bytes bigint
    constraint storage_read_receipts_reserved_bytes_v1 check (reserved_bytes between 262145 and 5242880),
  add constraint storage_read_receipts_reserved_class_v1 check (reserved_bytes is null or class='read_content');

-- Delivered bytes a Binding has used or reserved in the rolling hour, without
-- p_except (the receipt being extended).
create function clued_private.storage_read_budget_used_v1(p_binding uuid,p_except uuid) returns bigint
language sql security definer set search_path='' as $$
  select coalesce(sum(case when rc.state='finalized' then rc.byte_count else coalesce(rc.reserved_bytes,262144) end),0)::bigint
  from clued_private.storage_read_receipts_v1 rc
  where rc.binding_id=p_binding and rc.class='read_content'
    and rc.created_at>clock_timestamp()-interval '1 hour' and rc.id is distinct from p_except
$$;

-- Worker-only: extend the reservation of one unfinalized read_content receipt
-- of the calling Binding. Same issuer and Binding checks as finalize; the
-- budget lock is the admission lock, taken before the receipt row lock.
create function clued_private.storage_read_reserve_v1(p_issuer_hash text,p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; b public.clued_agent_bindings; rr clued_private.storage_read_receipts_v1;
  wanted bigint;
begin
  if (p_input-array['action','connection_id','receipt_id','max_bytes'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','receipt_id','max_bytes'])
    or coalesce(p_input->>'receipt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'max_bytes') is distinct from 'number' or p_input->>'max_bytes' !~ '^(0|[1-9][0-9]{0,7})$' then
    raise exception 'storage_read_input_invalid' using errcode='22023'; end if;
  wanted:=(p_input->>'max_bytes')::bigint;
  if wanted>5242880 then raise exception 'storage_read_input_invalid' using errcode='22023'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null and read_enabled for share;
  if not found then raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash;
  if b.id is null then raise exception 'storage_read_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-read-budget:'||b.id::text,0));
  select * into rr from clued_private.storage_read_receipts_v1 where id=(p_input->>'receipt_id')::uuid for update;
  -- Only a fresh intent: a receipt near the end of the window must not carry
  -- a reservation out of it (a Worker call lasts at most seconds).
  if rr.id is null or rr.binding_id<>b.id or rr.owner_id<>b.user_id or rr.connection_id<>(p_input->>'connection_id')::uuid
    or rr.class<>'read_content' or rr.state<>'intent' or rr.created_at<=clock_timestamp()-interval '10 minutes' then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  if wanted<=coalesce(rr.reserved_bytes,262144) then
    return jsonb_build_object('contract','clued.storage-read-reservation/1','receipt_id',rr.id,
      'reserved_bytes',coalesce(rr.reserved_bytes,262144),'extended',false);
  end if;
  if clued_private.storage_read_budget_used_v1(b.id,rr.id)+wanted>268435456 then
    raise exception 'storage_read_budget_exhausted' using errcode='42501'; end if;
  update clued_private.storage_read_receipts_v1 set reserved_bytes=wanted where id=rr.id returning * into rr;
  return jsonb_build_object('contract','clued.storage-read-reservation/1','receipt_id',rr.id,'reserved_bytes',rr.reserved_bytes,'extended',true);
end $$;

-- Anchored patches on the latest definitions (every edit of one function
-- first, then one CREATE OR REPLACE), as in 20260930160000.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- The immutability guard allows exactly one more transition: an intent
    -- read_content receipt raising its reservation, nothing else changed.
    ('clued_private.storage_read_rows_guard_v1()',
     $a$  elsif tg_table_name='storage_read_receipts_v1' then
    if old.state<>'intent' or new.state<>'finalized'$a$,
     $r$  elsif tg_table_name='storage_read_receipts_v1' then
    if old.state='intent' and new.state='intent' and old.class='read_content'
      and new.reserved_bytes>coalesce(old.reserved_bytes,262144)
      and (to_jsonb(new)-'reserved_bytes') is not distinct from (to_jsonb(old)-'reserved_bytes') then
      return new;
    end if;
    if old.state<>'intent' or new.state<>'finalized'$r$,1),
    -- Transport: the reserve action.
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$coalesce(op,'') not in ('admit','finalize')$a$,
     $r$coalesce(op,'') not in ('admit','reserve','finalize')$r$,1),
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$  if (p_input-array['action','connection_id','receipt_id','item_count','byte_count','complete'])<>'{}'::jsonb$a$,
     $r$  if op='reserve' then
    return clued_private.storage_read_reserve_v1(p_issuer_hash,p_token_hash,p_input);
  end if;
  if (p_input-array['action','connection_id','receipt_id','item_count','byte_count','complete'])<>'{}'::jsonb$r$,1),
    -- Admission: 256 MiB per Binding per rolling hour; unfinalized receipts
    -- count their reservation (default 256 KiB, or as extended by reserve).
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$    if wanted='read_content' and (select coalesce(sum(case when rc.state='finalized' then rc.byte_count else 262144 end),0)
        from clued_private.storage_read_receipts_v1 rc
        where rc.binding_id=(evaluated->>'binding_id')::uuid and rc.class='read_content'
          and rc.created_at>clock_timestamp()-interval '1 hour')>8388608-262144 then$a$,
     $r$    if wanted='read_content'
        and clued_private.storage_read_budget_used_v1((evaluated->>'binding_id')::uuid,null)>268435456-262144 then$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_read_budget_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_read_budget_used_v1(uuid,uuid),
  clued_private.storage_read_reserve_v1(text,text,jsonb)
  from public,anon,authenticated,service_role;
