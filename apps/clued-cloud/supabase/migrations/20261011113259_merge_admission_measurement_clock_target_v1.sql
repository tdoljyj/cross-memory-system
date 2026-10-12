-- Private target-clock source only: authenticated transport remains separate.
-- Existing configured publisher applies this whole body and history atomically.
do $measurement_clock$ begin
set local lock_timeout='3s';set local statement_timeout='30s';
create table clued_private.merge_measurement_clock_registration_v1 (
 singleton boolean primary key default true check(singleton),
 source_version text not null check(source_version='20261011113259'),
 source_name text not null check(source_name='merge_admission_measurement_clock_target_v1'),
 trusted_registry_accepted boolean not null default false,
 transport_connected boolean not null default false
);
alter table clued_private.merge_measurement_clock_registration_v1 enable row level security;
revoke all on table clued_private.merge_measurement_clock_registration_v1 from public,anon,authenticated,service_role;
insert into clued_private.merge_measurement_clock_registration_v1(source_version,source_name)
 values('20261011113259','merge_admission_measurement_clock_target_v1');
-- Installation metadata is not an accepted source pin or authenticated reader.

lock table clued_private.merge_measurement_stream_v1,
  clued_private.merge_measurement_events_v1 in share row exclusive mode;
create table clued_private.merge_clock_boundary_candidate_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stream_id uuid not null, generation_id uuid not null default extensions.gen_random_uuid(),
  base_sequence bigint not null check(base_sequence>0),
  last_sequence bigint not null check(last_sequence>=0), last_raw timestamptz,
  regression_seen boolean not null default false, gap_seen boolean not null default false
);
create table clued_private.merge_clock_samples_candidate_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  sequence bigint not null check(sequence>0), stream_id uuid not null,
  generation_id uuid not null, transaction_id text not null, raw_observed_at timestamptz not null,
  regression_seen boolean not null, gap_seen boolean not null,
  primary key(user_id,sequence)
);
alter table clued_private.merge_clock_boundary_candidate_v1 enable row level security;
alter table clued_private.merge_clock_samples_candidate_v1 enable row level security;
revoke all on table clued_private.merge_clock_boundary_candidate_v1,
  clued_private.merge_clock_samples_candidate_v1 from public,anon,authenticated,service_role;
-- Existing events are not retroactively given raw clock samples.
insert into clued_private.merge_clock_boundary_candidate_v1(user_id,stream_id,base_sequence,last_sequence)
  select user_id,stream_id,last_sequence+1,last_sequence from clued_private.merge_measurement_stream_v1;

create function clued_private.merge_clock_raw_sample_candidate_v1() returns timestamptz
  language sql volatile set search_path='' as $$select pg_catalog.clock_timestamp()$$;
create function clued_private.merge_clock_capture_candidate_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare s clued_private.merge_measurement_stream_v1%rowtype;
  c clued_private.merge_clock_boundary_candidate_v1%rowtype; raw_time timestamptz;
begin
  -- Same lock order as the foundation: stream, then sidecar boundary.
  select * into s from clued_private.merge_measurement_stream_v1 where user_id=new.user_id for update;
  if not found or new.transaction_id<>pg_catalog.pg_current_xact_id()::text or new.sequence>s.last_sequence then
    raise exception 'clock_candidate_source_member_invalid' using errcode='55000'; end if;
  insert into clued_private.merge_clock_boundary_candidate_v1(user_id,stream_id,base_sequence,last_sequence)
    values(new.user_id,s.stream_id,new.sequence,new.sequence-1) on conflict(user_id) do nothing;
  select * into c from clued_private.merge_clock_boundary_candidate_v1 where user_id=new.user_id for update;
  raw_time:=clued_private.merge_clock_raw_sample_candidate_v1();
  if raw_time is null then raise exception 'clock_candidate_sample_unavailable' using errcode='55000'; end if;
  update clued_private.merge_clock_boundary_candidate_v1 set
    regression_seen=regression_seen or (last_raw is not null and raw_time<last_raw),
    gap_seen=gap_seen or stream_id<>s.stream_id or new.sequence<>last_sequence+1,
    last_sequence=greatest(last_sequence,new.sequence),last_raw=raw_time
    where user_id=new.user_id returning * into c;
  insert into clued_private.merge_clock_samples_candidate_v1
    (user_id,sequence,stream_id,generation_id,transaction_id,raw_observed_at,regression_seen,gap_seen)
    values(new.user_id,new.sequence,s.stream_id,c.generation_id,new.transaction_id,raw_time,c.regression_seen,c.gap_seen);
  return new;
end $$;
create trigger merge_clock_journal_capture_candidate_v1 before insert
  on clued_private.merge_measurement_events_v1 for each row
  execute function clued_private.merge_clock_capture_candidate_v1();

create function clued_private.merge_clock_samples_immutable_candidate_v1() returns trigger
language plpgsql security definer set search_path='' as $$begin
  if tg_op='DELETE' and not exists(select 1 from auth.users where id=old.user_id) then return old; end if;
  raise exception 'clock_candidate_samples_immutable' using errcode='55000';
end $$;
create trigger merge_clock_samples_immutable_candidate_v1 before update or delete
  on clued_private.merge_clock_samples_candidate_v1 for each row
  execute function clued_private.merge_clock_samples_immutable_candidate_v1();
create trigger merge_clock_samples_no_truncate_candidate_v1 before truncate
  on clued_private.merge_clock_samples_candidate_v1 for each statement
  execute function clued_private.merge_clock_samples_immutable_candidate_v1();


revoke all on function clued_private.merge_clock_raw_sample_candidate_v1(),clued_private.merge_clock_capture_candidate_v1(),
 clued_private.merge_clock_samples_immutable_candidate_v1() from public,anon,authenticated,service_role;
set local lock_timeout='3s';set local statement_timeout='30s';
create table clued_private.clock_source_epoch_candidate_v1 (
 epoch_id uuid primary key default extensions.gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 stream_id uuid not null default extensions.gen_random_uuid(),queue_ref text not null,upstream_stream_id uuid not null,
 clock_generation_id uuid not null,upstream_start_sequence bigint not null,opening_us text not null,
 foundation_digest text not null,catalog_digest text not null,initial_events jsonb not null,ddl_tainted boolean not null default false);
create table clued_private.clock_source_seals_candidate_v1 (
 seal_id uuid primary key default extensions.gen_random_uuid(),epoch_id uuid not null references clued_private.clock_source_epoch_candidate_v1(epoch_id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,upstream_end_sequence bigint not null,end_sequence bigint not null,
 closing_us text not null,catalog_digest text not null,raw_regression boolean not null,sample_gap boolean not null,ddl_tainted boolean not null,observations jsonb not null);
alter table clued_private.clock_source_epoch_candidate_v1 enable row level security;
alter table clued_private.clock_source_seals_candidate_v1 enable row level security;
revoke all on clued_private.clock_source_epoch_candidate_v1,clued_private.clock_source_seals_candidate_v1 from public,anon,authenticated,service_role;

create function clued_private.clock_source_projection_candidate_v1(p_user uuid,p_epoch uuid,p_end bigint)
returns table(sequence bigint,upstream_sequence bigint,transaction_id text,recorded_at timestamptz,context_key text,kind text,object_key text,payload jsonb,source_digest text)
language sql stable security definer set search_path='' as $$
 with epoch as (select * from clued_private.clock_source_epoch_candidate_v1 where user_id=p_user and epoch_id=p_epoch),
 target_claims as (select object_key,min(first_target) first_target from (
  select x->>'object_key' object_key,0::bigint first_target from epoch,jsonb_array_elements(initial_events) x where x->>'kind'='claim'
  union all select j.object_key,j.sequence from epoch e join clued_private.merge_measurement_events_v1 j on j.user_id=e.user_id
   and j.sequence>e.upstream_start_sequence and j.sequence<=p_end and j.kind='claim'
   where exists(select 1 from jsonb_array_elements_text(j.payload->'merge_refs') r where lower(r)=e.queue_ref)) x group by object_key),
 selected as (select j.* from epoch e join clued_private.merge_measurement_events_v1 j on j.user_id=e.user_id
  and j.sequence>e.upstream_start_sequence and j.sequence<=p_end
  where j.kind='policy' or j.kind='queue_marker' and lower(j.object_key)=e.queue_ref or j.kind='claim'
   and exists(select 1 from target_claims c where c.object_key=j.object_key and j.sequence>=c.first_target))
 select row_number() over(order by j.sequence),j.sequence,j.transaction_id,j.recorded_at,j.context_key,j.kind,j.object_key,j.payload,j.source_digest
 from selected j order by j.sequence
$$;

create function clued_private.clock_source_catalog_candidate_v1() returns text language sql stable set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('foundation',clued_private.merge_measurement_source_digest_v1(),
 'functions',(select jsonb_agg(jsonb_build_array(n,coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(n)),'MISSING')) order by n)
 from unnest(array['clued_private.merge_clock_raw_sample_candidate_v1()','clued_private.merge_clock_capture_candidate_v1()',
 'clued_private.clock_source_projection_candidate_v1(uuid,uuid,bigint)','clued_private.clock_source_catalog_candidate_v1()',
 'clued_private.clock_source_epoch_candidate_v1(uuid,text)','clued_private.clock_source_seal_candidate_v1(uuid,uuid)',
 'clued_private.clock_source_page_candidate_v1(text,jsonb)','clued_private.clock_source_ddl_candidate_v1()']) x(n)),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid))
 order by n.nspname,c.relname,t.tgname),'[]'::jsonb) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and (n.nspname,c.relname) in
 (('clued_private','work_claims_v1'),('clued_private','work_claim_merge_queue_v1'),('public','clued_audit_receipts'),
 ('clued_private','merge_measurement_events_v1'),('clued_private','merge_measurement_stream_v1'),
 ('clued_private','merge_clock_samples_candidate_v1'),('clued_private','merge_clock_boundary_candidate_v1'),
 ('clued_private','clock_source_epoch_candidate_v1'),('clued_private','clock_source_seals_candidate_v1'))),
 'observers',(select coalesce(jsonb_agg(jsonb_build_array(evtname,evtevent,evtenabled,evtfoid::text) order by evtname),'[]'::jsonb)
 from pg_catalog.pg_event_trigger where evtname in ('clock_source_ddl_end_candidate','clock_source_sql_drop_candidate'))
 )::text,'UTF8'),'sha256'),'hex')
$$;

create function clued_private.clock_source_epoch_candidate_v1(p_user uuid,p_queue text) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='3s' set statement_timeout='30s' as $$
declare s clued_private.merge_measurement_stream_v1%rowtype;c clued_private.merge_clock_boundary_candidate_v1%rowtype;
 e clued_private.clock_source_epoch_candidate_v1%rowtype;initial jsonb;sample text;q text:=lower(p_queue);
begin
 if current_setting('transaction_isolation')<>'read committed' then
 raise exception 'clock_source_snapshot_isolation_unsupported' using errcode='55000';end if;
 if q is null or q !~ '^merge:[a-z0-9_.-]+/[a-z0-9_.-]+:[a-z0-9_.-]+$' then raise exception 'clock_source_target_invalid' using errcode='22023';end if;
 -- Stream SHARE first, then one MVCC snapshot, with no table/claim SHARE lock.
 -- Pending normal row writers cannot commit their append while this lock lasts.
 if exists(select 1 from clued_private.merge_measurement_events_v1 where user_id=p_user and transaction_id=pg_catalog.pg_current_xact_id()::text) then
 raise exception 'clock_source_source_write_in_transaction' using errcode='55000';end if;
 select * into s from clued_private.merge_measurement_stream_v1 where user_id=p_user for share;
 if not found then raise exception 'clock_source_stream_missing' using errcode='55000';end if;
 select * into c from clued_private.merge_clock_boundary_candidate_v1 where user_id=p_user;
 if not found or c.stream_id<>s.stream_id then raise exception 'clock_source_sidecar_missing' using errcode='55000';end if;
 if s.source_changed or s.source_digest<>clued_private.merge_measurement_source_digest_v1() or
 clued_private.merge_measurement_capabilities_v1(p_user)->'capture_configuration_matches' is distinct from 'true'::jsonb then
 raise exception 'clock_source_foundation_changed' using errcode='55000';end if;
 if not exists(select 1 from pg_catalog.pg_trigger where tgrelid='clued_private.merge_measurement_events_v1'::regclass
 and tgname='merge_clock_journal_capture_candidate_v1' and tgenabled in ('O','A')) then raise exception 'clock_source_capture_disabled' using errcode='55000';end if;
 select jsonb_build_array(jsonb_build_object('kind','policy','object_key','fifo-v1','context_key','global',
 'payload',jsonb_build_object('profile',clued_private.work_claim_profile_v1()))) ||
 coalesce((select jsonb_agg(jsonb_build_object('kind','claim','object_key',x.claim_id::text,'context_key',x.context_key,
 'payload',clued_private.merge_measurement_claim_v1(x)) order by x.claim_id) from clued_private.work_claims_v1 x where x.user_id=p_user
 and exists(select 1 from unnest(clued_private.work_claim_merge_refs_v1(x.trigger_refs)) r where lower(r)=q)),'[]'::jsonb) ||
 coalesce((select jsonb_agg(jsonb_build_object('kind','queue_marker','object_key',x.merge_ref,'context_key','global',
 'payload',jsonb_build_object('merge_ref',x.merge_ref,'head_left_at',x.head_left_at,'left_queued_at',x.left_queued_at,'left_claim_id',x.left_claim_id)))
 from clued_private.work_claim_merge_queue_v1 x where x.user_id=p_user and lower(x.merge_ref)=q),'[]'::jsonb) into initial;
 sample:=((extract(epoch from clued_private.merge_clock_raw_sample_candidate_v1())*1000000)::bigint)::text;
 insert into clued_private.clock_source_epoch_candidate_v1(user_id,queue_ref,upstream_stream_id,clock_generation_id,upstream_start_sequence,
 opening_us,foundation_digest,catalog_digest,initial_events) values(p_user,q,s.stream_id,c.generation_id,s.last_sequence,sample,
 s.source_digest,clued_private.clock_source_catalog_candidate_v1(),initial) returning * into e;
 return jsonb_build_object('kind','epoch_snapshot_candidate','epoch_id',e.epoch_id,'stream_id',e.stream_id,'queue_ref',q,
 'clock_generation_id',e.clock_generation_id,'start_sequence',0,'opening_us',sample,'foundation_digest',e.foundation_digest,
 'catalog_digest',e.catalog_digest,'initial_events',initial,'source_auth',false,'official_metric',false,'t0',null);
end $$;

create function clued_private.clock_source_seal_candidate_v1(p_user uuid,p_epoch uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='3s' set statement_timeout='30s' as $$
declare s clued_private.merge_measurement_stream_v1%rowtype;e clued_private.clock_source_epoch_candidate_v1%rowtype;
 z clued_private.clock_source_seals_candidate_v1%rowtype;sample text;reg boolean;missing boolean;n bigint;observations jsonb;
 full_reg boolean;full_gap boolean;prior_reg boolean;prior_gap boolean;prior_max bigint;
begin
 if current_setting('transaction_isolation')<>'read committed' then
 raise exception 'clock_source_snapshot_isolation_unsupported' using errcode='55000';end if;
 if exists(select 1 from clued_private.merge_measurement_events_v1 where user_id=p_user and transaction_id=pg_catalog.pg_current_xact_id()::text) then
 raise exception 'clock_source_source_write_in_transaction' using errcode='55000';end if;
 select * into s from clued_private.merge_measurement_stream_v1 where user_id=p_user for share;
 if not found then raise exception 'clock_source_stream_missing' using errcode='55000';end if;
 -- Serialize same-epoch sampling and persistence, including uncommitted seals.
 -- After waiting for the first commit, later READ COMMITTED SPI queries see it.
 select * into e from clued_private.clock_source_epoch_candidate_v1 where epoch_id=p_epoch and user_id=p_user for update;
 if not found or s.stream_id<>e.upstream_stream_id or s.last_sequence<e.upstream_start_sequence then raise exception 'clock_source_epoch_mismatch' using errcode='55000';end if;
 sample:=((extract(epoch from clued_private.merge_clock_raw_sample_candidate_v1())*1000000)::bigint)::text;
 with selected as (select j.sequence,c.raw_observed_at from clued_private.clock_source_projection_candidate_v1(p_user,p_epoch,s.last_sequence) j
 left join clued_private.merge_clock_samples_candidate_v1 c on c.user_id=p_user and c.sequence=j.upstream_sequence
 and c.transaction_id=j.transaction_id and c.generation_id=e.clock_generation_id and c.stream_id=e.upstream_stream_id),
 clocks as (select *, (extract(epoch from raw_observed_at)*1000000)::bigint at_us,
 lag((extract(epoch from raw_observed_at)*1000000)::bigint,1,e.opening_us::bigint) over(order by sequence) prior_us from selected)
 select count(*),count(raw_observed_at)<>count(*),coalesce(bool_or(at_us<prior_us),false) or
 sample::bigint<greatest(e.opening_us::bigint,coalesce(max(at_us),e.opening_us::bigint)) into n,missing,reg from clocks;
 -- Clock validity is technical evidence for the whole fixed epoch. A hidden
 -- unrelated member can witness a rollback inside the target's transaction;
 -- filtering that witness would invalidate the target commit-time bound.
 -- Only booleans escape; no unrelated row, identity, time or upstream cursor.
 with all_members as (select j.sequence,c.raw_observed_at from clued_private.merge_measurement_events_v1 j
 left join clued_private.merge_clock_samples_candidate_v1 c on c.user_id=j.user_id and c.sequence=j.sequence
 and c.transaction_id=j.transaction_id and c.stream_id=e.upstream_stream_id and c.generation_id=e.clock_generation_id
 where j.user_id=p_user and j.sequence>e.upstream_start_sequence and j.sequence<=s.last_sequence),
 all_clocks as (select *, (extract(epoch from raw_observed_at)*1000000)::bigint at_us,
 lag((extract(epoch from raw_observed_at)*1000000)::bigint,1,e.opening_us::bigint) over(order by sequence) prior_us from all_members)
 select count(raw_observed_at)<>count(*),coalesce(bool_or(at_us<prior_us),false) or
 sample::bigint<greatest(e.opening_us::bigint,coalesce(max(at_us),e.opening_us::bigint)) into full_gap,full_reg from all_clocks;
 select coalesce(bool_or(raw_regression),false),coalesce(bool_or(sample_gap),false),max(closing_us::bigint) into prior_reg,prior_gap,prior_max
 from clued_private.clock_source_seals_candidate_v1 where epoch_id=e.epoch_id and user_id=p_user;
 reg:=reg or full_reg or prior_reg or sample::bigint<coalesce(prior_max,e.opening_us::bigint);
 missing:=missing or full_gap or prior_gap;
 select coalesce(jsonb_agg(jsonb_build_object('end_sequence',end_sequence,'closing_us',closing_us) order by closing_us::bigint,end_sequence),'[]'::jsonb)
 into observations from clued_private.clock_source_seals_candidate_v1 where epoch_id=e.epoch_id and user_id=p_user
 and upstream_end_sequence<=s.last_sequence and closing_us::bigint<=sample::bigint and catalog_digest=e.catalog_digest
 and not(raw_regression or sample_gap or ddl_tainted);
 insert into clued_private.clock_source_seals_candidate_v1(epoch_id,user_id,upstream_end_sequence,end_sequence,closing_us,catalog_digest,
 raw_regression,sample_gap,ddl_tainted,observations) values(p_epoch,p_user,s.last_sequence,n,sample,
 clued_private.clock_source_catalog_candidate_v1(),reg,missing,e.ddl_tainted,observations) returning * into z;
 return jsonb_build_object('kind','closing_seal_candidate','epoch_id',p_epoch,'seal_id',z.seal_id,'stream_id',e.stream_id,
 'queue_ref',e.queue_ref,'clock_generation_id',e.clock_generation_id,'start_sequence',0,'end_sequence',n,'opening_us',e.opening_us,
 'closing_us',sample,'foundation_digest',e.foundation_digest,'catalog_digest',z.catalog_digest,'ddl_tainted',z.ddl_tainted,
 'raw_clock_regression_observed',reg,'raw_sample_gap_observed',missing,'candidate_ready',not(reg or missing or e.ddl_tainted) and z.catalog_digest=e.catalog_digest,
 'source_auth',false,'official_metric',false,'t0',null);
end $$;

create function clued_private.clock_source_ddl_candidate_v1() returns event_trigger language plpgsql security definer set search_path='' as $$
declare affected boolean;
begin
 if tg_event='sql_drop' then
 select exists(select 1 from pg_catalog.pg_event_trigger_dropped_objects() x where x.schema_name='clued_private' and
 (x.object_name in ('work_claims_v1','work_claim_merge_queue_v1','work_claim_profile_v1','work_claim_merge_slot_until_from_v1',
 'work_claim_merge_slot_stamp_v1','work_claim_merge_refs_v1') or x.object_name like 'merge_measurement_%' or x.object_name like 'merge_clock_%' or x.object_name like 'clock_source_%')
 or x.schema_name='public' and x.object_name='clued_audit_receipts') into affected;
 else
 select exists(select 1 from pg_catalog.pg_event_trigger_ddl_commands() x where
 (x.classid='pg_catalog.pg_trigger'::regclass and exists(select 1 from pg_catalog.pg_trigger t where t.oid=x.objid
 and t.tgrelid in ('clued_private.work_claims_v1'::regclass,'clued_private.work_claim_merge_queue_v1'::regclass,
 'public.clued_audit_receipts'::regclass,'clued_private.merge_measurement_events_v1'::regclass,
 'clued_private.merge_measurement_stream_v1'::regclass,'clued_private.merge_clock_samples_candidate_v1'::regclass,
 'clued_private.merge_clock_boundary_candidate_v1'::regclass,'clued_private.clock_source_epoch_candidate_v1'::regclass,
 'clued_private.clock_source_seals_candidate_v1'::regclass)))
 or x.object_identity like 'clued_private.work_claims_v1%' or x.object_identity like 'clued_private.work_claim_merge_queue_v1%'
 or x.object_identity like 'clued_private.work_claim_profile_v1%' or x.object_identity like 'clued_private.work_claim_merge_slot_until_from_v1%'
 or x.object_identity like 'clued_private.work_claim_merge_slot_stamp_v1%' or x.object_identity like 'clued_private.work_claim_merge_refs_v1%'
 or x.object_identity like 'public.clued_audit_receipts%' or x.object_identity like 'clued_private.merge_measurement_%'
 or x.object_identity like 'clued_private.merge_clock_%' or x.object_identity like 'clued_private.clock_source_%') into affected;
 end if;
 if affected then update clued_private.clock_source_epoch_candidate_v1 set ddl_tainted=true;end if;
end $$;

create function clued_private.clock_source_page_candidate_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='3s' set statement_timeout='30s' as $$
declare b public.clued_agent_bindings%rowtype;checked public.clued_agent_bindings%rowtype;
 e clued_private.clock_source_epoch_candidate_v1%rowtype;z clued_private.clock_source_seals_candidate_v1%rowtype;
 before_digest text;ctx text;contexts text[];after_seq bigint;lim integer;events jsonb;samples jsonb;last_seq bigint;first_epoch jsonb;final_epoch jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then
 raise exception 'clock_source_snapshot_isolation_unsupported' using errcode='55000';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('context_key','seal_id','after_sequence','limit'))
 or coalesce(p_input->>'after_sequence','0') !~ '^[0-9]{1,6}$' or coalesce(p_input->>'limit','100') !~ '^[0-9]{1,3}$' then
 raise exception 'clock_source_page_input_invalid' using errcode='22023';end if;
 b:=clued_private.resolve_binding(p_token_hash,'audit:read',coalesce(p_input->>'context_key','global'));
 select * into z from clued_private.clock_source_seals_candidate_v1 where seal_id=(p_input->>'seal_id')::uuid and user_id=b.user_id;
 if not found then return jsonb_build_object('status','NOT_MEASURED','reason','clock_source_seal_missing','events','[]'::jsonb);end if;
 select * into e from clued_private.clock_source_epoch_candidate_v1 where epoch_id=z.epoch_id and user_id=b.user_id;
 first_epoch:=to_jsonb(e);before_digest:=clued_private.clock_source_catalog_candidate_v1();
 select coalesce(array_agg(distinct context_key),'{}'::text[]) into contexts from (
 select x->>'context_key' context_key from jsonb_array_elements(e.initial_events) x union
 select context_key from clued_private.clock_source_projection_candidate_v1(b.user_id,e.epoch_id,z.upstream_end_sequence)) x;
 foreach ctx in array contexts loop
 begin checked:=clued_private.resolve_binding(p_token_hash,'audit:read',ctx);
 if checked.id<>b.id or checked.user_id<>b.user_id then raise exception 'clock_source_binding_changed';end if;
 exception when others then return jsonb_build_object('status','NOT_MEASURED','reason','clock_source_target_scope_incomplete','events','[]'::jsonb);end;
 end loop;
 if e.ddl_tainted or z.ddl_tainted or e.catalog_digest<>before_digest or z.catalog_digest<>before_digest or z.raw_regression or z.sample_gap or
 clued_private.merge_measurement_capabilities_v1(b.user_id)->'capture_configuration_matches' is distinct from 'true'::jsonb then
 return jsonb_build_object('status','NOT_MEASURED','reason','clock_source_epoch_unqualified','events','[]'::jsonb);end if;
 after_seq:=coalesce(p_input->>'after_sequence','0')::bigint;lim:=coalesce(p_input->>'limit','100')::integer;
 if after_seq>z.end_sequence or lim<1 or lim>500 then raise exception 'clock_source_page_bounds_invalid' using errcode='22023';end if;
 with members as (select * from clued_private.clock_source_projection_candidate_v1(b.user_id,e.epoch_id,z.upstream_end_sequence)
 where sequence>after_seq order by sequence limit lim)
 select coalesce(jsonb_agg(jsonb_build_object('sequence',j.sequence,'transaction_id',j.transaction_id,'recorded_at',j.recorded_at,
 'context_key',j.context_key,'kind',j.kind,'object_key',j.object_key,'payload',j.payload,'source_digest',j.source_digest) order by j.sequence),'[]'::jsonb),
 coalesce(jsonb_agg(jsonb_build_object('sequence',j.sequence,'transaction_id',j.transaction_id,'raw_us',
 ((extract(epoch from c.raw_observed_at)*1000000)::bigint)::text) order by j.sequence) filter(where c.sequence is not null),'[]'::jsonb),
 coalesce(max(j.sequence),after_seq) into events,samples,last_seq from members j left join clued_private.merge_clock_samples_candidate_v1 c
 on c.user_id=b.user_id and c.sequence=j.upstream_sequence and c.transaction_id=j.transaction_id and c.generation_id=e.clock_generation_id and c.stream_id=e.upstream_stream_id;
 select to_jsonb(x) into final_epoch from clued_private.clock_source_epoch_candidate_v1 x where epoch_id=e.epoch_id;
 if before_digest<>clued_private.clock_source_catalog_candidate_v1() or first_epoch is distinct from final_epoch then
 return jsonb_build_object('status','NOT_MEASURED','reason','clock_source_pins_changed','events','[]'::jsonb);end if;
 begin checked:=clued_private.resolve_binding(p_token_hash,'audit:read',coalesce(p_input->>'context_key','global'));
 if checked.id<>b.id or checked.user_id<>b.user_id then raise exception 'clock_source_binding_changed';end if;
 foreach ctx in array contexts loop checked:=clued_private.resolve_binding(p_token_hash,'audit:read',ctx);
 if checked.id<>b.id or checked.user_id<>b.user_id then raise exception 'clock_source_binding_changed';end if;end loop;
 exception when others then return jsonb_build_object('status','NOT_MEASURED','reason','clock_source_target_scope_incomplete','events','[]'::jsonb);end;
 return jsonb_build_object('status','ok','stream_id',e.stream_id,'source_digest',e.foundation_digest,'after_sequence',after_seq,
 'next_sequence',last_seq,'end_sequence',z.end_sequence,'has_more',last_seq<z.end_sequence,'events',events,'clock_samples',samples,
 'epoch',jsonb_build_object('epoch_id',e.epoch_id,'stream_id',e.stream_id,'queue_ref',e.queue_ref,'clock_generation_id',e.clock_generation_id,
 'start_sequence',0,'opening_us',e.opening_us,'foundation_digest',e.foundation_digest,'catalog_digest',e.catalog_digest,'initial_events',e.initial_events),
 'seal',jsonb_build_object('seal_id',z.seal_id,'epoch_id',e.epoch_id,'end_sequence',z.end_sequence,'closing_us',z.closing_us,
 'catalog_digest',z.catalog_digest,'raw_regression',z.raw_regression,'sample_gap',z.sample_gap,'ddl_tainted',z.ddl_tainted),
 'observation_seals',z.observations||jsonb_build_array(jsonb_build_object('end_sequence',z.end_sequence,'closing_us',z.closing_us)),
 'coverage_manifest',jsonb_build_object('queue_ref',e.queue_ref,'event_count',z.end_sequence,
 'projection','first-target snapshot and all subsequent claim snapshots; target markers; policy; fixed private watermark'),
 'candidate_ready',true,'source_auth',false,'official_metric',false,'t0',null);
end $$;
revoke all on function clued_private.clock_source_projection_candidate_v1(uuid,uuid,bigint),clued_private.clock_source_catalog_candidate_v1(),
 clued_private.clock_source_epoch_candidate_v1(uuid,text),clued_private.clock_source_seal_candidate_v1(uuid,uuid),
 clued_private.clock_source_ddl_candidate_v1(),clued_private.clock_source_page_candidate_v1(text,jsonb) from public,anon,authenticated,service_role;
create event trigger clock_source_ddl_end_candidate on ddl_command_end execute function clued_private.clock_source_ddl_candidate_v1();
create event trigger clock_source_sql_drop_candidate on sql_drop execute function clued_private.clock_source_ddl_candidate_v1();

end $measurement_clock$;
