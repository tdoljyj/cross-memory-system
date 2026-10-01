-- StorageNormalUse.v0.1 N4 (§7.1, §7.3, §8.2 item 4): Owner-adjustable hourly
-- storage budgets.
--
-- * clued_private.storage_budgets_v1: one active row per (owner_id,
--   connection_id). connection_id NOT NULL = the per-Binding budgets used on
--   that connection (read and upload, 32 MiB - 2 GiB each); connection_id NULL
--   = the account totals of the owner over all Bindings (read and upload,
--   32 MiB - 8 GiB each). Values are whole MiB. Rows are immutable: a change
--   revokes the active row and inserts the next budget_generation, both under
--   one Receipt. A missing row means the §7.1 default (per Binding 256 MiB
--   read / 256 MiB upload; account 1 GiB read / 1 GiB upload).
-- * public.clued_storage_budget_v1 (native Owner session only): `status` and
--   `set` (CAS on budget_generation, 0 = defaults). Every set writes one
--   Receipt and one Event (extension:storage:budget_v1). It never touches a
--   write policy, read access, connection, auth_generation, client grant, deny
--   or storage job.
-- * Read admission and the reserve action of public.clued_storage_read_v1
--   use the configured per-Binding read budget of the connection being read
--   and, new in N4 (§7.2 account totals, built here because N2 did not), the
--   owner's account read total: an owner advisory lock is taken before the
--   existing per-Binding lock (fixed order, §7.2). The per-Binding sum is the
--   same as before (all read_content receipts of the Binding in the rolling
--   hour); the account sum is all read_content receipts of the owner.
-- * The upload reservation at upload_begin (public.clued_storage_staging_v1)
--   calls storage_upload_budget_v2, which is v1 with the configured per-Binding
--   upload budget of the connection and the configured account upload total in
--   place of the fixed 256 MiB / 1 GiB. Row caps (60 per Binding, 200 per
--   owner) are unchanged. storage_upload_budget_v1 loses its only caller and is
--   dropped.
-- The check runs on every admission against the committed row, so a change
-- takes effect on the next admission. Lowering a budget below what was already
-- used or reserved refuses new admissions until the window frees up; existing
-- reservations, receipts and staging rows are never rewritten.
--
-- Not in this migration (see docs/maintenance/resource-center-account-connection.md):
-- the provider-download-bytes dimension (§7.1 row 2, derived as 2x the read
-- budget) needs Worker metering and receipt columns that do not exist yet;
-- image_transforms_per_month (§7.3) waits for the Cloudflare Images path,
-- which is deferred, so no column is added for it here.

create table clued_private.storage_budgets_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  connection_id uuid references clued_private.storage_connections_v1(id),
  read_bytes_per_hour bigint not null,
  upload_bytes_per_hour bigint not null,
  budget_generation bigint not null check(budget_generation>0),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  state text not null default 'active' check(state in ('active','revoked')),
  revoked_at timestamptz,
  revocation_receipt_id uuid references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  -- §7.1 hard bounds: per Binding 32 MiB - 2 GiB, account 32 MiB - 8 GiB, whole MiB.
  constraint storage_budgets_bounds_v1 check(
    read_bytes_per_hour % 1048576 = 0 and upload_bytes_per_hour % 1048576 = 0
    and read_bytes_per_hour >= 33554432 and upload_bytes_per_hour >= 33554432
    and read_bytes_per_hour <= case when connection_id is null then 8589934592 else 2147483648 end
    and upload_bytes_per_hour <= case when connection_id is null then 8589934592 else 2147483648 end),
  check((state='revoked')=(revoked_at is not null)),
  check(state<>'revoked' or revocation_receipt_id is not null)
);
create unique index storage_budgets_connection_active_v1 on clued_private.storage_budgets_v1(owner_id,connection_id)
  where state='active' and connection_id is not null;
create unique index storage_budgets_account_active_v1 on clued_private.storage_budgets_v1(owner_id)
  where state='active' and connection_id is null;
create unique index storage_budgets_generation_v1 on clued_private.storage_budgets_v1(
  owner_id,coalesce(connection_id,'00000000-0000-0000-0000-000000000000'::uuid),budget_generation);

-- Immutable rows: the only update is active -> revoked with its receipt.
create function clued_private.storage_budget_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare mutable constant text[]:=array['state','revoked_at','revocation_receipt_id'];
begin
  if tg_op='UPDATE' and old.state='active' and new.state='revoked'
    and (to_jsonb(new)-mutable) is not distinct from (to_jsonb(old)-mutable) then
    return new;
  end if;
  raise exception 'storage_budget_immutable' using errcode='42501';
end $$;
create trigger storage_budgets_immutable_v1 before update or delete on clued_private.storage_budgets_v1
  for each row execute function clued_private.storage_budget_guard_v1();
alter table clued_private.storage_budgets_v1 enable row level security;
revoke all on clued_private.storage_budgets_v1 from public,anon,authenticated,service_role;

-- Effective budget in bytes per rolling hour. p_connection NULL = account total.
create function clued_private.storage_budget_limit_v1(p_owner uuid,p_connection uuid,p_dimension text)
returns bigint language plpgsql stable security definer set search_path='' as $$
declare b clued_private.storage_budgets_v1;
begin
  if p_dimension not in ('read','upload') then raise exception 'storage_budget_dimension_invalid' using errcode='22023'; end if;
  if p_connection is null then
    select * into b from clued_private.storage_budgets_v1 where owner_id=p_owner and connection_id is null and state='active';
  else
    select * into b from clued_private.storage_budgets_v1 where owner_id=p_owner and connection_id=p_connection and state='active';
  end if;
  if b.id is null then
    return case when p_connection is null then 1073741824 else 268435456 end;
  end if;
  return case p_dimension when 'read' then b.read_bytes_per_hour else b.upload_bytes_per_hour end;
end $$;

-- Delivered bytes the owner has used or reserved in the rolling hour over all
-- Bindings (same rule as storage_read_budget_used_v1), without p_except.
create function clued_private.storage_read_owner_used_v1(p_owner uuid,p_except uuid) returns bigint
language sql security definer set search_path='' as $$
  select coalesce(sum(case when rc.state='finalized' then rc.byte_count else coalesce(rc.reserved_bytes,262144) end),0)::bigint
  from clued_private.storage_read_receipts_v1 rc
  where rc.owner_id=p_owner and rc.class='read_content'
    and rc.created_at>clock_timestamp()-interval '1 hour' and rc.id is distinct from p_except
$$;
create index storage_read_receipts_owner_recent_v1
  on clued_private.storage_read_receipts_v1(owner_id,created_at) where class='read_content';

-- Read budget locks: owner first, then the existing per-Binding key (§7.2).
create function clued_private.storage_read_budget_lock_v1(p_owner uuid,p_binding uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-read-budget-owner:'||p_owner::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-read-budget:'||p_binding::text,0));
end $$;

-- The caller holds both locks. p_wanted more bytes must fit the Binding budget
-- of p_connection and the account read total.
create function clued_private.storage_read_budget_check_v1(p_owner uuid,p_binding uuid,p_connection uuid,p_except uuid,p_wanted bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  if clued_private.storage_read_budget_used_v1(p_binding,p_except)+p_wanted
      >clued_private.storage_budget_limit_v1(p_owner,p_connection,'read')
    or clued_private.storage_read_owner_used_v1(p_owner,p_except)+p_wanted
      >clued_private.storage_budget_limit_v1(p_owner,null,'read') then
    raise exception 'storage_read_budget_exhausted' using errcode='42501'; end if;
end $$;

-- §7.1 / §7.2 upload reservation with the configured budgets (v1 otherwise unchanged).
create function clued_private.storage_upload_budget_v2(p_owner uuid,p_binding uuid,p_connection uuid,p_size bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-upload-budget-owner:'||p_owner::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-upload-budget:'||p_binding::text,0));
  if (select count(*) from clued_private.storage_staging_v1
        where binding_id=p_binding and created_at>clock_timestamp()-interval '1 hour')>=60
    or (select count(*) from clued_private.storage_staging_v1
        where owner_id=p_owner and created_at>clock_timestamp()-interval '1 hour')>=200 then
    raise exception 'storage_upload_budget_exhausted' using errcode='42501'; end if;
  if (select coalesce(sum(reserved_bytes),0) from clued_private.storage_staging_v1
        where binding_id=p_binding and released_at is null and created_at>clock_timestamp()-interval '1 hour')+p_size
        >clued_private.storage_budget_limit_v1(p_owner,p_connection,'upload')
    or (select coalesce(sum(reserved_bytes),0) from clued_private.storage_staging_v1
        where owner_id=p_owner and released_at is null and created_at>clock_timestamp()-interval '1 hour')+p_size
        >clued_private.storage_budget_limit_v1(p_owner,null,'upload') then
    raise exception 'storage_upload_budget_exhausted' using errcode='42501'; end if;
end $$;

-- Anchored patches on the latest definitions (every edit of one function
-- first, then one CREATE OR REPLACE), as in 20260930200000.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$    if wanted='read_content' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-read-budget:'||(evaluated->>'binding_id'),0));
    end if;
    if wanted='read_content'
        and clued_private.storage_read_budget_used_v1((evaluated->>'binding_id')::uuid,null)>268435456-262144 then
      raise exception 'storage_read_budget_exhausted' using errcode='42501'; end if;$a$,
     $r$    if wanted='read_content' then
      perform clued_private.storage_read_budget_lock_v1((evaluated->>'owner_id')::uuid,(evaluated->>'binding_id')::uuid);
      perform clued_private.storage_read_budget_check_v1((evaluated->>'owner_id')::uuid,(evaluated->>'binding_id')::uuid,
        (evaluated->>'connection_id')::uuid,null,262144);
    end if;$r$,1),
    ('clued_private.storage_read_reserve_v1(text,text,jsonb)',
     $a$  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-read-budget:'||b.id::text,0));$a$,
     $r$  perform clued_private.storage_read_budget_lock_v1(b.user_id,b.id);$r$,1),
    ('clued_private.storage_read_reserve_v1(text,text,jsonb)',
     $a$  if clued_private.storage_read_budget_used_v1(b.id,rr.id)+wanted>268435456 then
    raise exception 'storage_read_budget_exhausted' using errcode='42501'; end if;$a$,
     $r$  perform clued_private.storage_read_budget_check_v1(b.user_id,b.id,rr.connection_id,rr.id,wanted);$r$,1),
    ('public.clued_storage_staging_v1(text,text,jsonb)',
     $a$perform clued_private.storage_upload_budget_v1(c.owner_id,(snapshot->>'binding_id')::uuid,(p_input->>'size')::bigint);$a$,
     $r$perform clued_private.storage_upload_budget_v2(c.owner_id,(snapshot->>'binding_id')::uuid,c.id,(p_input->>'size')::bigint);$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_budget_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

drop function clued_private.storage_upload_budget_v1(uuid,uuid,bigint);

-- §7.3 native Owner control.
-- status {connection_id}: effective per-Binding budgets of that connection,
--   the account totals, their CAS generations (0 = defaults), defaults and bounds.
-- set {scope:'connection', connection_id | scope:'account', base_generation,
--   read_bytes_per_hour, upload_bytes_per_hour, idempotency_key}: both values,
--   whole MiB within the bounds of the scope; CAS on budget_generation.
create function public.clued_storage_budget_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; project uuid; prior clued_private.storage_budgets_v1; fresh clued_private.storage_budgets_v1;
  conn_row clued_private.storage_budgets_v1; acct_row clued_private.storage_budgets_v1;
  r public.clued_audit_receipts; scope text; target uuid; read_bytes bigint; upload_bytes bigint; ceiling bigint;
  refs jsonb; ev text; version_key text; base bigint; result jsonb;
  min_bytes constant bigint:=33554432; step constant bigint:=1048576;
  connection_max constant bigint:=2147483648; account_max constant bigint:=8589934592;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','set') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='status' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb or jsonb_typeof(p_input->'connection_id') is distinct from 'string'
      or p_input->>'connection_id' !~ uuid_re then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select * into conn_row from clued_private.storage_budgets_v1 where owner_id=u and connection_id=c.id and state='active';
    select * into acct_row from clued_private.storage_budgets_v1 where owner_id=u and connection_id is null and state='active';
    return jsonb_build_object('contract','clued.storage-budget/1','connection_id',c.id,
      'connection',jsonb_build_object('budget_generation',coalesce(conn_row.budget_generation,0),'configured',conn_row.id is not null,
        'read_bytes_per_hour',clued_private.storage_budget_limit_v1(u,c.id,'read'),
        'upload_bytes_per_hour',clued_private.storage_budget_limit_v1(u,c.id,'upload')),
      'account',jsonb_build_object('budget_generation',coalesce(acct_row.budget_generation,0),'configured',acct_row.id is not null,
        'read_bytes_per_hour',clued_private.storage_budget_limit_v1(u,null,'read'),
        'upload_bytes_per_hour',clued_private.storage_budget_limit_v1(u,null,'upload')),
      'defaults',jsonb_build_object('connection',jsonb_build_object('read_bytes_per_hour',268435456,'upload_bytes_per_hour',268435456),
        'account',jsonb_build_object('read_bytes_per_hour',1073741824,'upload_bytes_per_hour',1073741824)),
      'bounds',jsonb_build_object('step_bytes',step,
        'connection',jsonb_build_object('min_bytes',min_bytes,'max_bytes',connection_max),
        'account',jsonb_build_object('min_bytes',min_bytes,'max_bytes',account_max)));
  end if;
  scope:=p_input->>'scope';
  if jsonb_typeof(p_input->'scope') is distinct from 'string' or coalesce(scope,'') not in ('connection','account')
    or (p_input-array['action','scope','connection_id','base_generation','read_bytes_per_hour','upload_bytes_per_hour','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','scope','base_generation','read_bytes_per_hour','upload_bytes_per_hour','idempotency_key'])
    or (p_input ? 'connection_id') is distinct from (scope='connection')
    or (scope='connection' and (jsonb_typeof(p_input->'connection_id') is distinct from 'string' or p_input->>'connection_id' !~ uuid_re))
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^(0|[1-9][0-9]{0,17})$'
    or jsonb_typeof(p_input->'read_bytes_per_hour') is distinct from 'number' or p_input->>'read_bytes_per_hour' !~ '^[1-9][0-9]{0,11}$'
    or jsonb_typeof(p_input->'upload_bytes_per_hour') is distinct from 'number' or p_input->>'upload_bytes_per_hour' !~ '^[1-9][0-9]{0,11}$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  read_bytes:=(p_input->>'read_bytes_per_hour')::bigint; upload_bytes:=(p_input->>'upload_bytes_per_hour')::bigint;
  ceiling:=case when scope='account' then account_max else connection_max end;
  if read_bytes not between min_bytes and ceiling or upload_bytes not between min_bytes and ceiling
    or read_bytes % step<>0 or upload_bytes % step<>0 then
    raise exception 'storage_budget_out_of_bounds' using errcode='22023'; end if;
  target:=case when scope='connection' then (p_input->>'connection_id')::uuid end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-budget:'||u::text,0));
  perform clued_private.authorization_account_v12(u);
  if scope='connection' then
    select * into c from clued_private.storage_connections_v1 where id=target and owner_id=u for share;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select pr.project_id into project from clued_private.resource_center_profiles_v1 pr where pr.id=c.profile_id and pr.user_id=u;
    if project is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  end if;
  r:=clued_private.m1_begin_receipt(u,null,'storage_budget_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  if scope='connection' then
    select * into prior from clued_private.storage_budgets_v1 where owner_id=u and connection_id=target and state='active' for update;
  else
    select * into prior from clued_private.storage_budgets_v1 where owner_id=u and connection_id is null and state='active' for update;
  end if;
  base:=coalesce(prior.budget_generation,0);
  if base<>(p_input->>'base_generation')::bigint
    or (scope='connection' and (c.state='revoked' or c.revoked_at is not null)) then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  if prior.id is not null then
    update clued_private.storage_budgets_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=prior.id;
  end if;
  insert into clued_private.storage_budgets_v1(owner_id,connection_id,read_bytes_per_hour,upload_bytes_per_hour,budget_generation,receipt_id)
  values(u,target,read_bytes,upload_bytes,base+1,r.id) returning * into fresh;
  version_key:='storage_budget:'||coalesce(target::text,'account');
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',version_key));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:budget_v1',refs,
    case when scope='connection' then 'project:'||project::text else 'profile' end,null,
    jsonb_build_object('scope',scope,'connection_id',target,'budget_generation',fresh.budget_generation,
      'read_bytes_per_hour',fresh.read_bytes_per_hour,'upload_bytes_per_hour',fresh.upload_bytes_per_hour,
      'previous_read_bytes_per_hour',prior.read_bytes_per_hour,'previous_upload_bytes_per_hour',prior.upload_bytes_per_hour),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(version_key,base),
    jsonb_build_object(version_key,fresh.budget_generation),array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;

revoke all on function clued_private.storage_budget_guard_v1(),
  clued_private.storage_budget_limit_v1(uuid,uuid,text),
  clued_private.storage_read_owner_used_v1(uuid,uuid),
  clued_private.storage_read_budget_lock_v1(uuid,uuid),
  clued_private.storage_read_budget_check_v1(uuid,uuid,uuid,uuid,bigint),
  clued_private.storage_upload_budget_v2(uuid,uuid,uuid,bigint)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_budget_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_budget_v1(jsonb) to authenticated;
