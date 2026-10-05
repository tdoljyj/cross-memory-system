-- StorageFullCapability.v0.1 P5 (§3.1, §3.4, §6.1, §6.2; Owner Decisions
-- ba02734a and 7f9daf68): trash and untrash of one Clued-registered file or
-- EMPTY directory under a separate destructive write level. Built on the same
-- account-policy job chain as the P3-B modify and P4 overwrite levels; every
-- existing function is changed by an anchored patch with an exact hit count,
-- never rewritten.
--
-- * Policies gain the action "destructive". A /3 policy's action set is the
--   create set plus any of modify, overwrite, destructive (canonical order).
--   clued_storage_write_access_v1 toggles it like the other levels: its own
--   disclosure (clued.storage-destructive-disclosure/1), a policy replacement
--   with auth_generation+1, queued jobs cancelled, read access moved.
-- * Submit accepts {operation: delete | restore, target_kind: file |
--   directory, source_path, source_file_version, source_file_id}. The Agent
--   tool calls them trash and untrash; they are recorded under the Artifact
--   authority's names. The item is named by its Drive file ID AND path AND
--   version. Never the root, a track or a non-empty directory (§3.4 item 5),
--   never a permanent delete (D3): the provider effect is files.update
--   {trashed: true | false}.
-- * An untrash whose name is taken is refused with restore_name_conflict
--   (at submit when the registry shows it, RESTORE_NAME_CONFLICT at execution
--   when Drive does). The user may then choose, explicitly, restore_mode
--   "folder" (same name, another registered folder) or "suffix" (original
--   folder, "name (n).ext", n 1..99); destination_path is the final path.
--   Files only.
-- * The Artifact authority gains operation restore. A trash source is an
--   active registered item; an untrash source is an item Clued trashed
--   (Artifact state trashed, new). In place, both name the source's
--   registered folder (provider identity source_parent_id); a relocating
--   untrash names its registered destination folder instead. A governance
--   item needs delete_authority to be trashed (reason
--   delete_authority_required); identical bytes are never a reason. A
--   directory must have no registered item under it (directory_not_empty)
--   and must not be a track (track_forbidden); the executor also requires
--   Drive to report no child at all, trashed ones included.
-- * §3.4 item 4 (D4, N = 5): at most 5 trash jobs per client registration
--   lineage and connection in any 24 hours (a job refused before any
--   reservation does not count, nor does one covered by a confirmed batch
--   item). Beyond that submit refuses with owner_batch_confirmation_required
--   and no job exists. The Agent then registers ONE batch
--   (clued_storage_trash_batch_v1: items each bound to Artifact, Drive ID,
--   path and version); the Owner confirms the whole batch once on the native
--   page (clued_storage_trash_confirmation_v1). A confirmed batch is bound to
--   the policy active when it was requested and to the requesting lineage,
--   is valid 24 hours, and each trash item covers one job. An item whose job
--   is later refused before any reservation is free again.
-- * The provider attempt is clued.storage-destructive-attempt/1. The verified
--   proofs are clued.storage-trash-verified/1 and
--   clued.storage-untrash-verified/1. Settlement changes the same Artifact
--   by CAS on the version the authority saw: artifact_trash (active ->
--   trashed) or artifact_untrash (trashed -> active, at its final path),
--   recording the observed Drive version. The trash settlement Event states
--   Drive's 30-day purge.
-- * Scheduled and native recovery load trash and untrash descriptors; the
--   Worker re-verifies by GET only and settles through the same verified
--   record, never repeating the update.

-- Action sets: the create set plus any of modify, overwrite, destructive.
alter table clued_private.storage_account_policies_v2
  drop constraint storage_account_policies_v2_actions_check,
  add constraint storage_account_policies_v2_actions_check check(
    actions=array['inspect','create_file','create_topic']::text[]
    or (scope_contract='clued.storage-account-scope/3' and actions in (
      array['inspect','create_file','create_topic','modify']::text[],
      array['inspect','create_file','create_topic','overwrite']::text[],
      array['inspect','create_file','create_topic','modify','overwrite']::text[],
      array['inspect','create_file','create_topic','destructive']::text[],
      array['inspect','create_file','create_topic','modify','destructive']::text[],
      array['inspect','create_file','create_topic','overwrite','destructive']::text[],
      array['inspect','create_file','create_topic','modify','overwrite','destructive']::text[])));

-- An item Clued moved to the Drive trash keeps its Artifact in state trashed
-- (§6.2 untrash row). The partial unique indexes cover active rows only, so a
-- trashed path does not block a new item; its in-place untrash is then
-- refused while the name is taken.
alter table clued_private.resource_center_artifacts_v1
  drop constraint resource_center_artifacts_v1_state_check,
  add constraint resource_center_artifacts_v1_state_check check(state in ('active','revoked','trashed'));

-- One batch of items for the Owner to confirm at once (Decision 7f9daf68).
-- The Agent's batch_id is the row ID; the request digest pins its exact
-- items. Only the confirmation fields ever change, once.
create table clued_private.storage_trash_batches_v1 (
  owner_id uuid not null references auth.users(id),
  id uuid not null,
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  account_policy_id uuid not null references clued_private.storage_account_policies_v2(id),
  policy_generation bigint not null,
  registration_lineage uuid not null,
  binding_id uuid not null references public.clued_agent_bindings(id),
  request_digest text not null check(request_digest ~ '^[0-9a-f]{64}$'),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  confirmed_expires_at timestamptz,
  confirm_receipt_id uuid references public.clued_audit_receipts(id),
  primary key(owner_id,id),
  check(expires_at>created_at),
  check((confirmed_at is null)=(confirmed_expires_at is null) and (confirmed_at is null)=(confirm_receipt_id is null))
);
create index storage_trash_batches_connection_v1 on clued_private.storage_trash_batches_v1(owner_id,connection_id,created_at);
create table clued_private.storage_trash_batch_items_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  batch_id uuid not null,
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  position int not null check(position between 1 and 50),
  operation text not null check(operation in ('delete','restore')),
  target_kind text not null check(target_kind in ('file','directory')),
  artifact_id uuid not null references clued_private.resource_center_artifacts_v1(id),
  artifact_version bigint not null check(artifact_version>0),
  provider_file_id text not null check(provider_file_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  path text not null check(char_length(path) between 2 and 1000),
  provider_file_version text not null check(provider_file_version ~ '^[0-9]{1,40}$'),
  foreign key(owner_id,batch_id) references clued_private.storage_trash_batches_v1(owner_id,id),
  unique(owner_id,batch_id,position),
  unique(owner_id,batch_id,artifact_id)
);
create index storage_trash_batch_items_match_v1 on clued_private.storage_trash_batch_items_v1(owner_id,connection_id,path);
-- Which job each confirmed trash item covered. A use whose job was refused
-- before any reservation no longer counts, so the item is free again.
create table clued_private.storage_trash_batch_uses_v1 (
  item_id uuid not null references clued_private.storage_trash_batch_items_v1(id),
  owner_id uuid not null references auth.users(id),
  job_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,job_id)
);
create index storage_trash_batch_uses_item_v1 on clued_private.storage_trash_batch_uses_v1(item_id);
create function clued_private.storage_trash_batches_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name<>'storage_trash_batches_v1' or tg_op='DELETE'
    or (to_jsonb(old)->>'confirmed_at') is not null or (to_jsonb(new)->>'confirmed_at') is null
    or (to_jsonb(new)-array['confirmed_at','confirmed_expires_at','confirm_receipt_id'])
      is distinct from (to_jsonb(old)-array['confirmed_at','confirmed_expires_at','confirm_receipt_id']) then
    raise exception 'storage_trash_batch_immutable' using errcode='42501'; end if;
  return new;
end $$;
create trigger storage_trash_batches_immutable_v1 before update or delete on clued_private.storage_trash_batches_v1
  for each row execute function clued_private.storage_trash_batches_guard_v1();
create trigger storage_trash_batch_items_immutable_v1 before update or delete on clued_private.storage_trash_batch_items_v1
  for each row execute function clued_private.storage_trash_batches_guard_v1();
create trigger storage_trash_batch_uses_immutable_v1 before update or delete on clued_private.storage_trash_batch_uses_v1
  for each row execute function clued_private.storage_trash_batches_guard_v1();
alter table clued_private.storage_trash_batches_v1 enable row level security;
alter table clued_private.storage_trash_batch_items_v1 enable row level security;
alter table clued_private.storage_trash_batch_uses_v1 enable row level security;
revoke all on clued_private.storage_trash_batches_v1,clued_private.storage_trash_batch_items_v1,
  clued_private.storage_trash_batch_uses_v1 from public,anon,authenticated,service_role;

-- The untrash name option: name with " (n)" before its extension, n 1..99.
create function clued_private.storage_suffixed_name_v1(p_name text,p_candidate text)
returns boolean language plpgsql immutable set search_path='' as $$
declare dot int:=strpos(reverse(p_name),'.'); stem text; ext text; mid text;
begin
  if p_name is null or p_candidate is null then return false; end if;
  if dot>0 and dot<char_length(p_name) then
    stem:=left(p_name,char_length(p_name)-dot); ext:=right(p_name,dot);
  else stem:=p_name; ext:=''; end if;
  if char_length(p_candidate)<=char_length(stem)+char_length(ext)+3
    or left(p_candidate,char_length(stem)+2)<>stem||' ('
    or right(p_candidate,char_length(ext)+1)<>')'||ext then return false; end if;
  mid:=substr(p_candidate,char_length(stem)+3,char_length(p_candidate)-char_length(stem)-char_length(ext)-3);
  return mid ~ '^[1-9][0-9]?$';
end $$;

-- Exact trash/untrash shape after path canonicalization: one item by Drive
-- ID, source path and observed version; an untrash of a file may add the
-- user's explicit relocation (restore_mode + destination_path). Nothing else.
create function clued_private.storage_destructive_shape_v1(m jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare sp text; dp text; keys text[]; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)';
begin
  if jsonb_typeof(m) is distinct from 'object' then return false; end if;
  select array_agg(k order by k) into keys from jsonb_object_keys(m) k;
  if (keys is distinct from array['operation','source_file_id','source_file_version','source_path','target_kind']
      and keys is distinct from array['destination_path','operation','restore_mode','source_file_id','source_file_version','source_path','target_kind'])
    or coalesce(m->>'operation','') not in ('delete','restore') or coalesce(m->>'target_kind','') not in ('file','directory')
    or jsonb_typeof(m->'source_path') is distinct from 'string'
    or jsonb_typeof(m->'source_file_version') is distinct from 'string' or coalesce(m->>'source_file_version','') !~ '^[1-9][0-9]{0,39}$'
    or jsonb_typeof(m->'source_file_id') is distinct from 'string' or coalesce(m->>'source_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    return false; end if;
  sp:=m->>'source_path';
  if length(sp) not between 1 and 1000 or sp ~ bad or strpos(sp,'/')=0 then return false; end if;
  if not (m ? 'destination_path') then return true; end if;
  dp:=m->>'destination_path';
  if m->>'operation'<>'restore' or m->>'target_kind'<>'file' or jsonb_typeof(m->'destination_path') is distinct from 'string'
    or coalesce(m->>'restore_mode','') not in ('folder','suffix')
    or length(dp) not between 1 and 1000 or dp ~ bad or strpos(dp,'/')=0 then return false; end if;
  if m->>'restore_mode'='folder' then
    return regexp_replace(dp,'^.*/','')=regexp_replace(sp,'^.*/','')
      and regexp_replace(dp,'/[^/]*$','')<>regexp_replace(sp,'/[^/]*$','');
  end if;
  return regexp_replace(dp,'/[^/]*$','')=regexp_replace(sp,'/[^/]*$','')
    and clued_private.storage_suffixed_name_v1(regexp_replace(sp,'^.*/',''),regexp_replace(dp,'^.*/',''));
end $$;

-- Registry checks at submit, only after the evaluator authenticated the
-- Binding (unlocked hints; the authority decides again under its locks):
-- a track directory is never a target, and an untrash
-- whose final path is taken by an active item is a fixed, explanatory refusal.
create function clued_private.storage_destructive_target_v1(p_connection uuid,m jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
declare p clued_private.resource_center_profiles_v1; final_path text:=coalesce(m->>'destination_path',m->>'source_path');
begin
  select pr.* into p from clued_private.storage_connections_v1 c
    join clued_private.resource_center_profiles_v1 pr on pr.id=c.profile_id and pr.user_id=c.owner_id
    where c.id=p_connection;
  if not found then return; end if;
  if m->>'target_kind'='directory' and regexp_replace(m->>'source_path','/[^/]*$','')=p.managed_root then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  if m->>'operation'='restore' and exists(select 1 from clued_private.resource_center_artifacts_v1 a
      where a.profile_id=p.id and a.path=final_path and a.state='active') then
    raise exception 'restore_name_conflict' using errcode='22023'; end if;
end $$;

-- Whether a batch item's registered item is still exactly what it named.
create function clued_private.storage_trash_item_current_v1(i clued_private.storage_trash_batch_items_v1)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.resource_center_artifacts_v1 a
    where a.id=i.artifact_id and a.user_id=i.owner_id and a.version=i.artifact_version and a.path=i.path
      and a.provider_file_id=i.provider_file_id and a.provider_file_version=i.provider_file_version
      and a.target_kind=i.target_kind and a.state=case i.operation when 'delete' then 'active' else 'trashed' end
      and (i.operation='restore' or a.governance_class='ordinary' or a.delete_authority))
$$;
-- Whether a confirmed item covers a job that is not refused before reservation.
create function clued_private.storage_trash_item_used_v1(i clued_private.storage_trash_batch_items_v1)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.storage_trash_batch_uses_v1 u
    where u.item_id=i.id and u.owner_id=i.owner_id and not exists(select 1 from clued_private.storage_jobs_v1 j
      where j.owner_id=u.owner_id and j.job_id=u.job_id and j.intent_id is null
        and coalesce(j.dispatch_outcome->>'status','')='denied'))
$$;
-- pending / confirmed / expired, or voided once the requesting policy is no
-- longer the connection's active destructive policy.
create function clued_private.storage_trash_batch_state_v1(b clued_private.storage_trash_batches_v1)
returns text language sql stable security definer set search_path='' as $$
  select case
    when not exists(select 1 from clued_private.storage_connections_v1 c
        join clued_private.storage_account_policies_v2 p on p.id=c.account_policy_id and p.connection_id=c.id
        where c.id=b.connection_id and c.owner_id=b.owner_id and c.auth_mode='account_policy' and c.state='active'
          and c.revoked_at is null and p.id=b.account_policy_id and p.state='active' and 'destructive'=any(p.actions)) then 'voided'
    when b.confirmed_at is not null then case when b.confirmed_expires_at>clock_timestamp() then 'confirmed' else 'expired' end
    when b.expires_at>clock_timestamp() then 'pending' else 'expired' end
$$;
create function clued_private.storage_trash_batch_view_v1(b clued_private.storage_trash_batches_v1,p_owner boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('batch_id',b.id,'connection_id',b.connection_id,'status',clued_private.storage_trash_batch_state_v1(b),
    'created_at',b.created_at,'expires_at',coalesce(b.confirmed_expires_at,b.expires_at),'execution_permitted',false,
    'items',coalesce((select jsonb_agg(jsonb_build_object('operation',i.operation,'target_kind',i.target_kind,'path',i.path,
        'provider_file_id',i.provider_file_id,'provider_file_version',i.provider_file_version,
        'used',clued_private.storage_trash_item_used_v1(i))
        ||case when p_owner then jsonb_build_object('current',clued_private.storage_trash_item_current_v1(i)) else '{}'::jsonb end
        order by i.position)
      from clued_private.storage_trash_batch_items_v1 i where i.owner_id=b.owner_id and i.batch_id=b.id),'[]'::jsonb))
$$;

-- §3.4 item 4 at submit, under the evaluator's exclusive root lock: count
-- this client lineage's trash jobs on this connection in the last 24 hours
-- (refused before any reservation, or covered by a batch item: not counted).
-- From the sixth on, the job must be covered by one unused item of a
-- confirmed, unexpired batch of this lineage under the active policy naming
-- exactly this item (Drive ID, path, version, still current), or the submit
-- is refused and no job exists.
create function clued_private.storage_trash_admit_v1(m jsonb,p_snapshot jsonb,p_connection uuid,p_job uuid)
returns void language plpgsql security definer set search_path='' as $$
declare owner_key uuid:=(p_snapshot->>'owner_id')::uuid; lineage uuid:=(p_snapshot->>'registration_lineage')::uuid;
  used int; item clued_private.storage_trash_batch_items_v1;
begin
  if m->>'operation' is distinct from 'delete' then return; end if;
  if owner_key is null or lineage is null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select count(*) into used from clued_private.storage_jobs_v1 j
    where j.owner_id=owner_key and j.connection_id=p_connection and j.mutation->>'operation'='delete'
      and j.authority_snapshot_v2->>'registration_lineage'=lineage::text
      and j.created_at>clock_timestamp()-interval '24 hours'
      and not (j.intent_id is null and coalesce(j.dispatch_outcome->>'status','')='denied')
      and not exists(select 1 from clued_private.storage_trash_batch_uses_v1 u where u.owner_id=owner_key and u.job_id=j.job_id);
  if used<5 then return; end if;
  select i.* into item from clued_private.storage_trash_batch_items_v1 i
    join clued_private.storage_trash_batches_v1 b on b.owner_id=i.owner_id and b.id=i.batch_id
    where i.owner_id=owner_key and i.connection_id=p_connection and b.connection_id=p_connection
      and b.confirmed_at is not null and b.confirmed_expires_at>clock_timestamp()
      and b.account_policy_id=(p_snapshot->>'policy_id')::uuid and b.registration_lineage=lineage
      and i.operation='delete' and i.target_kind=m->>'target_kind' and i.path=m->>'source_path'
      and i.provider_file_id=m->>'source_file_id' and i.provider_file_version=m->>'source_file_version'
      and clued_private.storage_trash_item_current_v1(i) and not clued_private.storage_trash_item_used_v1(i)
    order by b.confirmed_at,i.position limit 1 for update of i;
  if not found then raise exception 'owner_batch_confirmation_required' using errcode='42501'; end if;
  insert into clued_private.storage_trash_batch_uses_v1(item_id,owner_id,job_id) values(item.id,owner_key,p_job);
end $$;

-- Expected provider attempt of a trash or untrash. The item and its folders
-- are the authority's provider identity, and the item is the one the job
-- names by Drive ID; the content identity (null for a directory) is
-- observed by the executor and only shape-checked here; the proof must
-- repeat it.
create function clued_private.storage_destructive_attempt_v1(m clued_private.resource_center_mutations_v1,
  j clued_private.storage_jobs_v1,p_content jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare pi jsonb:=m.authority_request->'provider_identity';
begin
  if j.mutation->>'source_file_version' is distinct from pi->>'source_file_version'
    or j.mutation->>'source_file_id' is distinct from pi->>'source_file_id'
    or coalesce(pi->>'source_parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
    or (j.mutation ? 'destination_path') is distinct from (pi->>'destination_parent_id' is not null) then
    return null; end if;
  if j.mutation->>'target_kind'='directory' then
    if p_content is distinct from 'null'::jsonb then return null; end if;
  elsif jsonb_typeof(p_content) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_content) k) is distinct from array['head_revision_id','md5','sha256','size']
    or jsonb_typeof(p_content->'size') is distinct from 'string' or p_content->>'size' !~ '^(0|[1-9][0-9]{0,19})$'
    or jsonb_typeof(p_content->'head_revision_id') is distinct from 'string' or p_content->>'head_revision_id' !~ '^[A-Za-z0-9_-]{1,200}$'
    or jsonb_typeof(p_content->'sha256') not in ('string','null') or jsonb_typeof(p_content->'md5') not in ('string','null')
    or coalesce(p_content->>'sha256','0'||repeat('a',63)) !~ '^[0-9a-f]{64}$'
    or coalesce(p_content->>'md5',repeat('a',32)) !~ '^[0-9a-f]{32}$'
    or (p_content->>'sha256' is null and p_content->>'md5' is null) then
    return null; end if;
  return jsonb_build_object('contract','clued.storage-destructive-attempt/1','intent_id',m.id,'request_sha256',m.request_sha256,
    'profile_id',m.profile_id,'operation',j.mutation->>'operation','target_kind',j.mutation->>'target_kind',
    'provider_file_id',pi->>'source_file_id',
    'source_path',j.mutation->>'source_path','source_file_version',j.mutation->>'source_file_version',
    'destination_path',j.mutation->'destination_path','restore_mode',j.mutation->'restore_mode',
    'parent_id',coalesce(pi->>'destination_parent_id',pi->>'source_parent_id'),
    'content',p_content,'binding',m.exact_request->'binding');
end $$;

-- The registered, trashed source of an untrash job, handed to the executor
-- (a trashed item is never listed by name): exactly the item the job names
-- by Drive ID, path and version, or nothing at all.
create function clued_private.storage_untrash_source_v1(j clued_private.storage_jobs_v1)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when j.mutation->>'operation'='restore' then (
    select case when count(*)=1 then jsonb_build_object('provider_file_id',min(a.provider_file_id),
        'provider_file_version',min(a.provider_file_version)) end
      from clued_private.resource_center_artifacts_v1 a
      join clued_private.storage_connections_v1 c on c.id=j.connection_id and c.owner_id=j.owner_id
      where a.profile_id=c.profile_id and a.user_id=j.owner_id and a.state='trashed'
        and a.target_kind=j.mutation->>'target_kind' and a.path=j.mutation->>'source_path'
        and a.provider_file_id=j.mutation->>'source_file_id' and a.provider_file_version=j.mutation->>'source_file_version') end
$$;

-- Agent side of the batch (Decision 7f9daf68): with the Owner's destructive
-- level, register one pending batch of 1..50 trash/untrash items, each
-- matched against the registry (Artifact, Drive ID, path, version). The
-- same batch_id and items return the batch's status; other items under the
-- same batch_id are refused; at most 5 pending batches per client
-- registration and connection. Never creates a job or permits execution.
create function public.clued_storage_trash_batch_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_connection uuid; v_batch uuid; items jsonb:='[]'::jsonb; e jsonb; m jsonb; snapshot jsonb; digest text;
  b clued_private.storage_trash_batches_v1; p clued_private.resource_center_profiles_v1; a clued_private.resource_center_artifacts_v1;
  r public.clued_audit_receipts; refs jsonb; ev text; pos int:=0; owner_key uuid; listed jsonb:='[]'::jsonb;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or (p_input-array['connection_id','batch_id','items'])<>'{}'::jsonb
    or coalesce(p_input->>'connection_id','') !~ uuid_re or coalesce(p_input->>'batch_id','') !~ uuid_re
    or jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_array_length(p_input->'items') not between 1 and 50 then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  v_connection:=(p_input->>'connection_id')::uuid; v_batch:=(p_input->>'batch_id')::uuid;
  for e in select x from jsonb_array_elements(p_input->'items') x loop
    if jsonb_typeof(e) is distinct from 'object' then raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    m:=clued_private.storage_mutation_paths_v1(p_token_hash,v_connection,e);
    if not clued_private.storage_destructive_shape_v1(m) or m ? 'destination_path' then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    items:=items||jsonb_build_array(m);
  end loop;
  if (select count(distinct x->>'source_file_id') from jsonb_array_elements(items) x)<>jsonb_array_length(items) then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  digest:=clued_private.m1_sha256(jsonb_build_object('connection_id',v_connection,'items',items));
  snapshot:=clued_private.storage_policy_evaluate_v2(p_token_hash,v_connection,'destructive',v_batch);
  owner_key:=(snapshot->>'owner_id')::uuid;
  select * into b from clued_private.storage_trash_batches_v1 where owner_id=owner_key and id=v_batch for update;
  if found then
    if b.request_digest<>digest or b.connection_id<>v_connection then
      raise exception 'storage_trash_batch_conflict' using errcode='40001'; end if;
    return clued_private.storage_trash_batch_view_v1(b,false)||jsonb_build_object('replayed',true);
  end if;
  -- At most 5 pending (unconfirmed, unexpired, not voided) batches per client
  -- registration and connection; refused before any receipt is written.
  if (select count(*) from clued_private.storage_trash_batches_v1 b0
      where b0.owner_id=owner_key and b0.connection_id=v_connection
        and b0.registration_lineage=(snapshot->>'registration_lineage')::uuid
        and b0.account_policy_id=(snapshot->>'policy_id')::uuid
        and b0.confirmed_at is null and b0.expires_at>clock_timestamp())>=5 then
    raise exception 'storage_trash_batch_pending_limit' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=(snapshot->>'profile_id')::uuid and user_id=owner_key;
  r:=clued_private.m1_begin_receipt(owner_key,(snapshot->>'binding_id')::uuid,'storage_trash_batch_request',
    jsonb_build_object('idempotency_key','storage-trash-batch:'||v_batch::text,'batch_id',v_batch,'request_digest',digest),digest);
  if r.status<>'pending' then raise exception 'storage_trash_batch_conflict' using errcode='40001'; end if;
  insert into clued_private.storage_trash_batches_v1(owner_id,id,connection_id,account_policy_id,policy_generation,
    registration_lineage,binding_id,request_digest,receipt_id,expires_at)
  values(owner_key,v_batch,v_connection,(snapshot->>'policy_id')::uuid,(snapshot->>'policy_generation')::bigint,
    (snapshot->>'registration_lineage')::uuid,(snapshot->>'binding_id')::uuid,digest,r.id,clock_timestamp()+interval '24 hours')
  returning * into b;
  for e in select x from jsonb_array_elements(items) x loop
    pos:=pos+1;
    select * into a from clued_private.resource_center_artifacts_v1
      where profile_id=p.id and user_id=owner_key and path=e->>'source_path' and provider_file_id=e->>'source_file_id'
        and provider_file_version=e->>'source_file_version' and target_kind=e->>'target_kind'
        and state=case e->>'operation' when 'delete' then 'active' else 'trashed' end;
    if not found or a.path=p.managed_root
      or (e->>'operation'='delete' and not (a.governance_class='ordinary' or a.delete_authority))
      or (a.target_kind='directory' and (regexp_replace(a.path,'/[^/]*$','')=p.managed_root
        or exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id
          and x.state in ('active','trashed') and left(x.path,char_length(a.path)+1)=a.path||'/'))) then
      raise exception 'storage_trash_batch_item_unavailable' using errcode='22023'; end if;
    insert into clued_private.storage_trash_batch_items_v1(owner_id,batch_id,connection_id,position,operation,target_kind,
      artifact_id,artifact_version,provider_file_id,path,provider_file_version)
    values(owner_key,v_batch,v_connection,pos,e->>'operation',e->>'target_kind',a.id,a.version,a.provider_file_id,a.path,a.provider_file_version);
    listed:=listed||jsonb_build_array(jsonb_build_object('operation',e->>'operation','artifact_id',a.id,
      'provider_file_id',a.provider_file_id,'provider_file_version',a.provider_file_version));
  end loop;
  -- Events are exported to context readers: Drive IDs and versions, never paths.
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',v_batch));
  ev:=clued_private.m1_append_event_row(owner_key,(snapshot->>'binding_id')::uuid,r.id,r.canonical_version,
    'extension:storage:trash_batch_requested',refs,'project:'||p.project_id::text,null,
    jsonb_build_object('batch_id',v_batch,'connection_id',v_connection,'request_digest',digest,'items',listed),
    'storage-trash-batch:'||v_batch::text,r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,jsonb_build_object(v_batch::text,1),array[ev],'{}'::uuid[],null);
  -- Expiry or a policy change while waiting for locks rolls everything back.
  if clued_private.storage_policy_evaluate_v2(p_token_hash,v_connection,'destructive',v_batch) is distinct from snapshot then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  return clued_private.storage_trash_batch_view_v1(b,false)||jsonb_build_object('replayed',false);
end $$;

-- Owner side (native session only): status lists the connection's pending
-- and confirmed batches (newest 20) with each item's current/used state;
-- confirm accepts one whole pending batch ("全部确认") by CAS on the policy
-- generation, only while every item is still exactly what it named.
create function public.clued_storage_trash_confirmation_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; b clued_private.storage_trash_batches_v1;
  root text; r public.clued_audit_receipts; refs jsonb; ev text; result jsonb; visible int;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','confirm') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='status' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb or coalesce(p_input->>'connection_id','') !~ uuid_re then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select * into policy from clued_private.storage_account_policies_v2
      where id=c.account_policy_id and connection_id=c.id and owner_id=u and state='active';
    select count(*) into visible from clued_private.storage_trash_batches_v1 b0
      where b0.owner_id=u and b0.connection_id=c.id and clued_private.storage_trash_batch_state_v1(b0) in ('pending','confirmed');
    return jsonb_build_object('connection_id',c.id,'limit',5,'window_hours',24,
      'destructive',policy.id is not null and 'destructive'=any(policy.actions) and c.auth_mode='account_policy' and c.state='active',
      'policy_generation',coalesce(policy.policy_generation,0),'batches_truncated',visible>20,
      'batches',coalesce((select jsonb_agg(clued_private.storage_trash_batch_view_v1(x.b0,true) order by (x.b0).created_at desc)
        from (select b0 from clued_private.storage_trash_batches_v1 b0 where b0.owner_id=u and b0.connection_id=c.id
          and clued_private.storage_trash_batch_state_v1(b0) in ('pending','confirmed') order by b0.created_at desc limit 20) x),'[]'::jsonb));
  end if;
  if (p_input-array['action','connection_id','batch_id','base_generation','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','batch_id','base_generation','idempotency_key'])
    or coalesce(p_input->>'connection_id','') !~ uuid_re or coalesce(p_input->>'batch_id','') !~ uuid_re
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  -- Root advisory first, as the evaluators, submit and the level switch: a
  -- confirmation serializes with every admission on this root.
  select pr.root_folder_id into root from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
    where co.id=(p_input->>'connection_id')::uuid and co.owner_id=u;
  if root is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  perform clued_private.storage_owner_v1();
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for share;
  select * into policy from clued_private.storage_account_policies_v2
    where id=c.account_policy_id and connection_id=c.id and owner_id=u for share;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  r:=clued_private.m1_begin_receipt(u,null,'storage_owner_trash_batch_confirm_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  if c.id is null or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null
    or policy.id is null or policy.state<>'active' or not ('destructive'=any(policy.actions))
    or policy.policy_generation<>(p_input->>'base_generation')::bigint
    or p.id is null or p.root_folder_id is distinct from root or p.state<>'active' or p.version<>c.profile_version then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  select * into b from clued_private.storage_trash_batches_v1
    where owner_id=u and id=(p_input->>'batch_id')::uuid and connection_id=c.id for update;
  if not found or b.account_policy_id<>policy.id or b.confirmed_at is not null or b.expires_at<=clock_timestamp()
    or exists(select 1 from clued_private.storage_trash_batch_items_v1 i
      where i.owner_id=u and i.batch_id=b.id and not clued_private.storage_trash_item_current_v1(i)) then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  update clued_private.storage_trash_batches_v1 set confirmed_at=clock_timestamp(),
    confirmed_expires_at=clock_timestamp()+interval '24 hours',confirm_receipt_id=r.id
    where owner_id=u and id=b.id returning * into b;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',b.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_trash_batch_confirmed_v1',
    refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'batch_id',b.id,
      'policy_id',policy.id,'expires_at',b.confirmed_expires_at,
      'items',(select jsonb_agg(jsonb_build_object('operation',i.operation,'artifact_id',i.artifact_id,
        'provider_file_id',i.provider_file_id,'provider_file_version',i.provider_file_version) order by i.position)
        from clued_private.storage_trash_batch_items_v1 i where i.owner_id=u and i.batch_id=b.id)),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,
    jsonb_build_object(b.id::text,1),array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;

-- Native Owner write-level switch: destructive is a third class with its own
-- disclosure; one class changes per call, exactly as for modify and overwrite.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    ('clued_private.storage_policy_scope_digest_v3(uuid,text,text[])',
     $a$      array['inspect','create_file','create_topic','modify','overwrite']::text[]) then$a$,
     $r$      array['inspect','create_file','create_topic','modify','overwrite']::text[],
      array['inspect','create_file','create_topic','destructive']::text[],
      array['inspect','create_file','create_topic','modify','destructive']::text[],
      array['inspect','create_file','create_topic','overwrite','destructive']::text[],
      array['inspect','create_file','create_topic','modify','overwrite','destructive']::text[]) then$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify','overwrite') then$a$,
     $r$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify','overwrite','destructive') then$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$  overwrite_disclosure constant text:='clued.storage-overwrite-disclosure/1';$a$,
     $r$  overwrite_disclosure constant text:='clued.storage-overwrite-disclosure/1';
  destructive_disclosure constant text:='clued.storage-destructive-disclosure/1';$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$'overwrite_disclosure_version',overwrite_disclosure,$a$,
     $r$'overwrite_disclosure_version',overwrite_disclosure,
      'destructive_disclosure_version',destructive_disclosure,$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$unnest(policy.actions) x where x in ('modify','overwrite')$a$,
     $r$unnest(policy.actions) x where x in ('modify','overwrite','destructive')$r$,2),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$not (wanted <@ array['modify','overwrite']) then$a$,
     $r$not (wanted <@ array['modify','overwrite','destructive']) then$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$(case toggled when 'overwrite' then overwrite_disclosure else disclosure end)$a$,
     $r$(case toggled when 'overwrite' then overwrite_disclosure when 'destructive' then destructive_disclosure else disclosure end)$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$  actions:=base_actions||array(select x from unnest(array['modify','overwrite']) x where x=any(wanted));$a$,
     $r$  actions:=base_actions||array(select x from unnest(array['modify','overwrite','destructive']) x where x=any(wanted));$r$,1),
    -- Registry: trash and untrash keep the Artifact; CAS on its version.
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$    ('profile_register','artifact_register','artifact_update','artifact_revoke',$a$,
     $r$    ('profile_register','artifact_register','artifact_update','artifact_revoke','artifact_trash','artifact_untrash',$r$,1),
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$    elsif v_action='binding_issue' then$a$,
     $r$    elsif v_action in ('artifact_trash','artifact_untrash') then
      -- StorageFullCapability P5: an item Clued moved to (or out of) the
      -- Drive trash keeps its Artifact and governance; the state and the
      -- observed Drive version change by CAS on the Artifact version. An
      -- untrash may land at another final path the user chose (Decision
      -- 7f9daf68): under the root, in a registered folder, not taken.
      select * into v_artifact from clued_private.resource_center_artifacts_v1
        where id=(p_input->>'artifact_id')::uuid and profile_id=v_profile.id and user_id=p_user_id
          and state=case v_action when 'artifact_trash' then 'active' else 'trashed' end for update;
      if not found or v_artifact.path=v_profile.managed_root or
        v_artifact.version is distinct from (p_input->>'base_version')::bigint then
        raise exception 'resource_center_artifact_conflict' using errcode='40001';
      end if;
      v_path:=p_input->>'path'; v_root:=v_profile.managed_root;
      if p_input->>'provider_file_id' is distinct from v_artifact.provider_file_id or
        coalesce(p_input->>'provider_file_version','') !~ '^[0-9]+$' or v_path is null or
        (v_action='artifact_trash' and v_path<>v_artifact.path) or
        (v_path<>v_artifact.path and (v_artifact.target_kind<>'file' or
          left(v_path,char_length(v_root)+1)<>v_root||'/' or right(v_path,1)='/' or
          position(E'\\' in v_path)>0 or position('..' in v_path)>0)) then
        raise exception 'resource_center_artifact_invalid' using errcode='22023';
      end if;
      if v_action='artifact_untrash' then
        v_parent:=left(v_path,char_length(v_path)-strpos(reverse(v_path),'/'));
        if not exists(select 1 from clued_private.resource_center_artifacts_v1 x
          where x.profile_id=v_profile.id and x.path=v_parent and x.state='active'
            and x.target_kind='directory') then
          raise exception 'resource_center_parent_unregistered' using errcode='22023';
        end if;
      end if;
      v_base:=jsonb_build_object(v_artifact.id::text,v_artifact.version);
      update clued_private.resource_center_artifacts_v1
        set state=case v_action when 'artifact_trash' then 'trashed' else 'active' end,
          path=v_path,provider_file_version=p_input->>'provider_file_version',
          version=version+1,updated_at=now(),
          source_decision_id=v_decision_id,receipt_id=v_receipt.id
        where id=v_artifact.id returning * into v_artifact;
      v_target_id:=v_artifact.id; v_version:=v_artifact.version;
    elsif v_action='binding_issue' then$r$,1),
    -- Artifact authority: restore (untrash), source first like delete.
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$    v_operation not in ('create','write','replace','move','rename','delete') or$a$,
     $r$    v_operation not in ('create','write','replace','move','rename','delete','restore') or$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if v_operation='delete' then
    if v_source_path is null or v_destination_path is not null then$a$,
     $r$  if v_operation in ('delete','restore') then
    if v_source_path is null or (v_destination_path is not null and v_operation='delete') then$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_source_path and path<>v_profile.managed_root$a$,
     $r$      where profile_id=v_profile.id and user_id=v_profile.user_id
        and state=case when v_operation='restore' then 'trashed' else 'active' end
        and path=v_source_path and path<>v_profile.managed_root$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$      v_profile.managed_root,v_source_path) then
      return jsonb_build_object('status','denied','reason','source_mismatch');$a$,
     $r$      v_profile.managed_root,case when v_operation<>'restore' then v_source_path
        when v_destination_path is null then left(v_source_path,char_length(v_source_path)-strpos(reverse(v_source_path),'/'))
        else v_profile.managed_root end) then
      return jsonb_build_object('status','denied','reason','source_mismatch');$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if v_destination_path is not null then
    if left(v_destination_path,$a$,
     $r$  -- Trash and untrash (P5): a directory is never a track and has no
  -- registered item under it; a governance item is trashed only with delete
  -- authority (§3.4 item 2). In place, the source's folder is its
  -- registered, current parent as Drive reports it and an untrash needs its
  -- name free; a relocating untrash is checked as a destination below.
  if v_operation in ('delete','restore') then
    if v_source.target_kind='directory' then
      if left(v_source_path,char_length(v_source_path)-strpos(reverse(v_source_path),'/'))=v_profile.managed_root then
        return jsonb_build_object('status','denied','reason','track_forbidden');
      end if;
      if exists(select 1 from clued_private.resource_center_artifacts_v1 a
          where a.profile_id=v_profile.id and a.state in ('active','trashed')
            and left(a.path,char_length(v_source_path)+1)=v_source_path||'/') then
        return jsonb_build_object('status','denied','reason','directory_not_empty');
      end if;
    end if;
    if v_operation='delete' and v_source.governance_class='governance' and not v_source.delete_authority then
      return jsonb_build_object('status','denied','reason','delete_authority_required');
    end if;
    if v_destination_path is null then
      v_parent_path:=left(v_source_path,char_length(v_source_path)-strpos(reverse(v_source_path),'/'));
      select * into v_parent from clued_private.resource_center_artifacts_v1
        where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
          and path=v_parent_path and target_kind='directory'
          and provider_file_id=v_provider->>'source_parent_id';
      if not found then
        return jsonb_build_object('status','denied','reason','parent_unregistered');
      end if;
      if not clued_private.resource_center_path_current_v1(
        v_profile.user_id,v_profile.project_id,v_profile.id,
        v_profile.managed_root,v_parent_path) then
        return jsonb_build_object('status','denied','reason','parent_path_not_current');
      end if;
      if v_operation='restore' and exists(select 1 from clued_private.resource_center_artifacts_v1 a
          where a.profile_id=v_profile.id and a.path=v_source_path and a.state='active') then
        return jsonb_build_object('status','denied','reason','restore_name_conflict');
      end if;
    end if;
  end if;
  if v_destination_path is not null then
    if left(v_destination_path,$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$        where a.profile_id=v_profile.id and a.path=v_destination_path and a.state='active') then
      return jsonb_build_object('status','denied','reason','destination_exists');$a$,
     $r$        where a.profile_id=v_profile.id and a.path=v_destination_path and a.state='active') then
      return jsonb_build_object('status','denied','reason',
        case when v_operation='restore' then 'restore_name_conflict' else 'destination_exists' end);$r$,1),
    -- Settlement authority and registry change for trash / untrash.
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$  existing:=p_mutation->>'operation' in ('rename','move','replace');$a$,
     $r$  existing:=p_mutation->>'operation' in ('rename','move','replace','delete','restore');$r$,1),
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$        and state='active' and target_kind='file'$a$,
     $r$        and state=case when p_mutation->>'operation'='restore' then 'trashed' else 'active' end
        and target_kind=case when p_mutation->>'operation' in ('delete','restore') then p_mutation->>'target_kind' else 'file' end$r$,1),
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$    if not found or not clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,selected.path)$a$,
     $r$    if not found or not clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,
        case when p_mutation->>'operation'<>'restore' then selected.path
          else regexp_replace(coalesce(p_mutation->>'destination_path',selected.path),'/[^/]*$','') end)
      or (p_mutation->>'operation'='restore' and exists(select 1 from clued_private.resource_center_artifacts_v1 x
        where x.profile_id=p.id and x.path=coalesce(p_mutation->>'destination_path',selected.path) and x.state='active'))
      or (p_mutation->>'operation' in ('delete','restore') and selected.target_kind='directory'
        and (regexp_replace(selected.path,'/[^/]*$','')=p.managed_root
          or exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id
            and x.state in ('active','trashed') and left(x.path,char_length(selected.path)+1)=selected.path||'/')))
      or (p_mutation->>'operation'='delete' and selected.governance_class='governance' and not selected.delete_authority)$r$,1),
    ('clued_private.storage_settle_input_v1(uuid,clued_private.resource_center_mutations_v1,jsonb)',
     $a$  select case when m.authority_request->'mutation'->>'operation' in ('rename','move','replace') then$a$,
     $r$  select case when m.authority_request->'mutation'->>'operation' in ('delete','restore') then
    jsonb_build_object('action',case m.authority_request->'mutation'->>'operation' when 'delete' then 'artifact_trash' else 'artifact_untrash' end,
      'profile_id',p_profile,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,
      'artifact_id',m.authority_result->'authority'->>'artifact_id',
      'base_version',split_part(m.authority_result->'authority'->>'authority_version',':',2)::bigint,
      'path',p_proof->>'path','provider_file_id',p_proof->>'provider_file_id','provider_file_version',p_proof->>'provider_file_version')
  when m.authority_request->'mutation'->>'operation' in ('rename','move','replace') then$r$,1),
    -- Submit: shape, level, registry hints and the trash limit.
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$        'destination_file_version','restore_job_id','staging_id','mime_type','content_sha256']<>'{}'::jsonb
      or coalesce(m->>'operation','') not in ('create','rename','move','replace')
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or jsonb_typeof(m->'destination_path') is distinct from 'string'
      or length(m->>'destination_path') not between 1 and 1000 then$a$,
     $r$        'destination_file_version','restore_job_id','staging_id','mime_type','content_sha256','source_file_id','restore_mode']<>'{}'::jsonb
      or coalesce(m->>'operation','') not in ('create','rename','move','replace','delete','restore')
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or ((m->>'operation' not in ('delete','restore') or m ? 'destination_path')
        and (jsonb_typeof(m->'destination_path') is distinct from 'string'
          or length(m->>'destination_path') not between 1 and 1000)) then$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$    if m->>'operation' in ('rename','move') then
      wanted:='modify';$a$,
     $r$    if m->>'operation' in ('delete','restore') then
      wanted:='destructive';
      if not clued_private.storage_destructive_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m ?| array['source_file_id','restore_mode'] then
      raise exception 'storage_job_input_invalid' using errcode='22023';
    elsif m->>'operation' in ('rename','move') then
      wanted:='modify';$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$  perform clued_private.storage_staging_consume_v1(m,$a$,
     $r$  -- Registry hints only after the evaluator authenticated this Binding and
  -- the destructive level (never a pre-authorization registry oracle).
  if m->>'operation' in ('delete','restore') then perform clued_private.storage_destructive_target_v1(connection_id,m); end if;
  perform clued_private.storage_trash_admit_v1(m,snapshot,connection_id,v_job_id);
  perform clued_private.storage_staging_consume_v1(m,$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$  wanted:=case when j.mutation->>'operation' in ('rename','move') then 'modify' when j.mutation->>'operation'='replace' then 'overwrite'$a$,
     $r$  wanted:=case when j.mutation->>'operation' in ('rename','move') then 'modify' when j.mutation->>'operation'='replace' then 'overwrite'
    when j.mutation->>'operation' in ('delete','restore') then 'destructive'$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$r$,1),
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$  elsif j.mutation->>'operation'='replace' then
    expected:=clued_private.storage_replace_attempt_v1(m,j,p_attempt);$a$,
     $r$  elsif j.mutation->>'operation'='replace' then
    expected:=clued_private.storage_replace_attempt_v1(m,j,p_attempt);
  elsif j.mutation->>'operation' in ('delete','restore') then
    expected:=clued_private.storage_destructive_attempt_v1(m,j,p_attempt->'content');$r$,1),
    ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
     $a$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move','replace') then$a$,
     $r$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move','replace','delete','restore') then$r$,1),
    -- Verified record and settlement.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$  parent_path:=left(j.mutation->>'destination_path',char_length(j.mutation->>'destination_path')-strpos(reverse(j.mutation->>'destination_path'),'/'));$a$,
     $r$  -- Trash and in-place untrash have no destination: the parent is the source's folder.
  parent_path:=left(coalesce(j.mutation->>'destination_path',j.mutation->>'source_path'),
    char_length(coalesce(j.mutation->>'destination_path',j.mutation->>'source_path'))
      -strpos(reverse(coalesce(j.mutation->>'destination_path',j.mutation->>'source_path')),'/'));$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    or clued_private.resource_center_directory_match_v1(parent.provider_file_version,parent.provider_sharing_digest,
      m.authority_request->'provider_identity'->>'destination_parent_version',
      m.authority_request->'provider_identity'->>'destination_parent_sharing_digest') is distinct from 'match'$a$,
     $r$    or (not (j.mutation->>'operation' in ('delete','restore') and not (j.mutation ? 'destination_path'))
      and clued_private.resource_center_directory_match_v1(parent.provider_file_version,parent.provider_sharing_digest,
      m.authority_request->'provider_identity'->>'destination_parent_version',
      m.authority_request->'provider_identity'->>'destination_parent_sharing_digest') is distinct from 'match')
    or (j.mutation->>'operation' in ('delete','restore') and not (j.mutation ? 'destination_path')
      and parent.provider_file_id is distinct from m.authority_request->'provider_identity'->>'source_parent_id')$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    elsif j.mutation->>'operation'='replace' then
      attempt_expected:=clued_private.storage_replace_attempt_v1(m,j,m.provider_attempt);$a$,
     $r$    elsif j.mutation->>'operation'='replace' then
      attempt_expected:=clued_private.storage_replace_attempt_v1(m,j,m.provider_attempt);
    elsif j.mutation->>'operation' in ('delete','restore') then
      attempt_expected:=clued_private.storage_destructive_attempt_v1(m,j,m.provider_attempt->'content');$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    post:=jsonb_build_object('path',attempt_expected->>'destination_path',$a$,
     $r$    post:=jsonb_build_object('path',coalesce(attempt_expected->>'destination_path',attempt_expected->>'source_path'),$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    if j.mutation->>'operation'='replace' then
      expected:=post||jsonb_build_object('contract','clued.storage-replace-verified/1',$a$,
     $r$    if j.mutation->>'operation' in ('delete','restore') then
      expected:=post||jsonb_build_object('contract',case j.mutation->>'operation' when 'delete'
          then 'clued.storage-trash-verified/1' else 'clued.storage-untrash-verified/1' end,
        'operation',j.mutation->>'operation','target_kind',j.mutation->>'target_kind','source_path',j.mutation->>'source_path',
        'source_file_version',j.mutation->>'source_file_version','restore_mode',j.mutation->'restore_mode',
        'trashed',j.mutation->>'operation'='delete',
        'content',attempt_expected->'content','provider_before',m.authority_request->'provider_identity',
        'checks',(case when j.mutation->>'operation'='delete'
          then jsonb_build_object('identity',true,'ancestors',true,'stable_state',true,'trashed',true,'parent',true,'name_vacated',true)
          else jsonb_build_object('identity',true,'ancestors',true,'stable_state',true,'untrashed',true,'parent',true,'unique_name',true) end)
          ||case when j.mutation->>'target_kind'='directory' then jsonb_build_object('empty',true)
            else jsonb_build_object('content_unchanged',true) end);
    elsif j.mutation->>'operation'='replace' then
      expected:=post||jsonb_build_object('contract','clued.storage-replace-verified/1',$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$  req:=jsonb_build_object('idempotency_key','storage-settle-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);$a$,
     $r$  req:=jsonb_build_object('idempotency_key','storage-settle-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2)
    -- §3.4 item 1: the trash receipt states that the recovery window ends.
    ||case when j.mutation->>'operation'='delete' then jsonb_build_object('trash_retention',
      'Google Drive permanently deletes a trashed item 30 days after it was trashed; after that it cannot be restored.')
      else '{}'::jsonb end;$r$,1),
    -- The executor descriptor names an untrash job's trashed source.
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$      'restore',clued_private.storage_restore_v1(j),'revision_releases',clued_private.storage_revision_releases_for_job_v1(j),$a$,
     $r$      'restore',clued_private.storage_restore_v1(j),'revision_releases',clued_private.storage_revision_releases_for_job_v1(j),
      'untrash_source',clued_private.storage_untrash_source_v1(j),$r$,1),
    -- Recovery loads trash and untrash descriptors (GET-only re-verification).
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$r$,1),
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$    or m.provider_attempt->>'parent_id' is distinct from
      m.authority_request->'provider_identity'->>'destination_parent_id'$a$,
     $r$    or m.provider_attempt->>'parent_id' is distinct from
      coalesce(m.authority_request->'provider_identity'->>'destination_parent_id',m.authority_request->'provider_identity'->>'source_parent_id')$r$,1),
    ('public.clued_storage_native_recovery_load_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$r$,1),
    ('public.clued_storage_native_recovery_load_v2(text,jsonb)',
     $a$    or m.provider_attempt->>'parent_id' is distinct from
      m.authority_request->'provider_identity'->>'destination_parent_id'$a$,
     $r$    or m.provider_attempt->>'parent_id' is distinct from
      coalesce(m.authority_request->'provider_identity'->>'destination_parent_id',m.authority_request->'provider_identity'->>'source_parent_id')$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Paired edits are applied together: every edit of one function first,
    -- then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_destructive_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_trash_batches_guard_v1(),
  clued_private.storage_suffixed_name_v1(text,text),
  clued_private.storage_destructive_shape_v1(jsonb),
  clued_private.storage_destructive_target_v1(uuid,jsonb),
  clued_private.storage_trash_item_current_v1(clued_private.storage_trash_batch_items_v1),
  clued_private.storage_trash_item_used_v1(clued_private.storage_trash_batch_items_v1),
  clued_private.storage_trash_batch_state_v1(clued_private.storage_trash_batches_v1),
  clued_private.storage_trash_batch_view_v1(clued_private.storage_trash_batches_v1,boolean),
  clued_private.storage_trash_admit_v1(jsonb,jsonb,uuid,uuid),
  clued_private.storage_destructive_attempt_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1,jsonb),
  clued_private.storage_untrash_source_v1(clued_private.storage_jobs_v1)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_trash_batch_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_trash_batch_v1(text,jsonb) to anon;
revoke all on function public.clued_storage_trash_confirmation_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_trash_confirmation_v1(jsonb) to authenticated;
