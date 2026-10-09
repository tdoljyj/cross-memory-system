-- Binding and Resource Center credentials are stored as verifiers (P0-4 step 2a, Clued Task 9a4d6d2c,
-- Owner Decisions 1427642f and 2ec964af; development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md
-- §4).
--
-- Until now the database stored the value callers present: public.clued_agent_bindings.token_hash and the
-- Resource Center token columns hold sha256(token), and every RPC compared that column with the p_token_hash it
-- was given. Anyone who read a row (a backup, an export, a mis-granted session) could call as that Binding.
--
-- After this migration those columns hold a verifier, 'cv1:' || sha256('clued.credential-verifier.v1:' || proof),
-- which cannot be turned back into the proof:
--   * clued_private.credential_verifier_v1(proof) computes it; it returns 'cv0:', which matches nothing, for
--     anything that is not a proof, so a bad input never compares equal and never compares as NULL.
--   * A BEFORE INSERT/UPDATE trigger on each column turns a written proof into its verifier and leaves a verifier
--     alone, so the functions that issue, rotate or copy credentials, and test fixtures, write as before.
--   * Every comparison with a caller's proof now compares with credential_verifier_v1(proof).
--   * Functions that hand a stored credential to another function as if it were a caller's proof
--     (clued_oauth_call, the storage cloud workers, the Resource Center write journal) pass
--     credential_internal_proof_v1(stored) instead: a random proof that credential_verifier_v1 maps back to that
--     verifier for the rest of the transaction only. The map lives in a transaction-local setting that a
--     PostgREST caller cannot set.
--   * The old values are copied to clued_private.credential_proof_backup_v1 and the old function definitions to
--     clued_private.credential_function_backup_v1 for seven days; docs/maintenance/database-security.md has the
--     rollback.
--
-- Callers (Worker, CI, hooks, Console) do not change. Issuer columns (authorization_issuers_v12,
-- authorization_requests_v12, storage_*.issuer_hash) are step 2b: storage client digests embed them.

-- 1. Verifier and internal proof ------------------------------------------------------------------------------

create or replace function clued_private.credential_verifier_v1(p_proof text) returns text
language plpgsql stable set search_path = '' as $$
declare
  internal text;
  mapped text;
begin
  if p_proof is null or p_proof !~ '^[0-9a-f]{64}$' then
    return 'cv0:';
  end if;
  internal := nullif(pg_catalog.current_setting('clued.credential_internal_v1', true), '');
  if internal is not null then
    mapped := internal::jsonb ->> p_proof;
    if mapped ~ '^cv1:[0-9a-f]{64}$' then
      return mapped;
    end if;
  end if;
  return 'cv1:' || pg_catalog.encode(extensions.digest('clued.credential-verifier.v1:' || p_proof, 'sha256'), 'hex');
end $$;

-- A stored verifier cannot be presented as a proof. When a function holds a stored credential and calls a
-- function that expects a proof, it passes this: a fresh random proof that credential_verifier_v1 maps to the
-- verifier until the transaction ends. Anything that is not a verifier gets a random proof that maps to nothing.
create or replace function clued_private.credential_internal_proof_v1(p_verifier text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  internal jsonb := coalesce(nullif(pg_catalog.current_setting('clued.credential_internal_v1', true), ''), '{}')::jsonb;
  proof text;
begin
  if p_verifier is null or p_verifier !~ '^cv1:[0-9a-f]{64}$' then
    return pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  end if;
  select e.key into proof from jsonb_each_text(internal) e where e.value = p_verifier limit 1;
  if proof is null then
    proof := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    perform pg_catalog.set_config('clued.credential_internal_v1',
      (internal || jsonb_build_object(proof, p_verifier))::text, true);
  end if;
  return proof;
end $$;

-- Resource Center rotations keep the rotate request for idempotent replay; its new credentials are verifiers.
create or replace function clued_private.credential_request_verifiers_v1(p_request jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select p_request || coalesce((
    select jsonb_object_agg(k, clued_private.credential_verifier_v1(p_request ->> k))
      from unnest(array['reader_hash', 'writer_hash', 'renewal_hash']) k
     where jsonb_typeof(p_request -> k) = 'string' and p_request ->> k !~ '^cv1:'), '{}'::jsonb)
$$;

create or replace function clued_private.credential_columns_normalize_v1() returns trigger
language plpgsql set search_path = '' as $$
declare
  col text;
  val text;
  patch jsonb := '{}'::jsonb;
begin
  foreach col in array tg_argv loop
    if col = 'request' then
      if jsonb_typeof(to_jsonb(new) -> 'request') = 'object' then
        patch := patch || jsonb_build_object('request',
          clued_private.credential_request_verifiers_v1(to_jsonb(new) -> 'request'));
      end if;
    else
      val := to_jsonb(new) ->> col;
      if val is not null and val !~ '^cv1:[0-9a-f]{64}$' then
        patch := patch || jsonb_build_object(col, clued_private.credential_verifier_v1(val));
      end if;
    end if;
  end loop;
  if patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, patch);
  end if;
  return new;
end $$;

revoke all on function clued_private.credential_verifier_v1(text), clued_private.credential_internal_proof_v1(text),
  clued_private.credential_request_verifiers_v1(jsonb), clued_private.credential_columns_normalize_v1()
  from public, anon, authenticated, service_role;

-- 2. Seven-day backup -----------------------------------------------------------------------------------------

create table if not exists clued_private.credential_proof_backup_v1(
  table_name text not null,
  row_key jsonb not null,
  column_name text not null,
  old_value text not null,
  delete_after timestamptz not null,
  primary key (table_name, row_key, column_name));

create table if not exists clued_private.credential_function_backup_v1(
  signature text primary key,
  definition text not null,
  delete_after timestamptz not null);

alter table clued_private.credential_proof_backup_v1 enable row level security;
alter table clued_private.credential_function_backup_v1 enable row level security;
revoke all on table clued_private.credential_proof_backup_v1, clued_private.credential_function_backup_v1
  from public, anon, authenticated, service_role;

create or replace function clued_private.credential_backup_purge_v1() returns void
language sql security definer set search_path = '' as $$
  delete from clued_private.credential_proof_backup_v1 where delete_after <= now();
  delete from clued_private.credential_function_backup_v1 where delete_after <= now();
$$;
revoke all on function clued_private.credential_backup_purge_v1() from public, anon, authenticated, service_role;

-- 3. Stored values: back up, convert, constrain, keep converting ----------------------------------------------

do $columns$
declare
  t record;
  col text;
begin
  for t in select * from (values
      ('public', 'clued_agent_bindings', array['token_hash'], array['id'],
        array['information_flow_manifest_binding_change']),
      ('clued_private', 'resource_center_bindings_v1', array['token_hash'], array['id'], array[]::text[]),
      ('clued_private', 'resource_center_writer_bindings_v1', array['token_hash'], array['id'], array[]::text[]),
      ('clued_private', 'resource_center_renewals_v1', array['token_hash'], array['id'], array[]::text[]),
      ('clued_private', 'resource_center_rotations_v1', array['old_token_hash', 'old_reader_hash', 'old_writer_hash'],
        array['grant_id', 'generation'], array[]::text[]),
      ('clued_private', 'resource_center_mutations_v1', array['authority_token_hash'], array['id'],
        array['resource_center_verified_immutable_v2', 'storage_refresh_mutation_fence_v1'])
    ) v(schema_name, table_name, cols, keys, quiet_triggers) loop
    -- History and fence triggers would refuse or record a rewrite of the stored form; it is not a change of value.
    foreach col in array t.quiet_triggers loop
      execute format('alter table %I.%I disable trigger %I', t.schema_name, t.table_name, col);
    end loop;
    foreach col in array t.cols loop
      execute format('alter table %I.%I drop constraint if exists %I', t.schema_name, t.table_name,
        t.table_name || '_' || col || '_check');
      execute format($sql$insert into clued_private.credential_proof_backup_v1
          select %L, jsonb_build_object(%s), %L, %I, now() + interval '7 days' from %I.%I where %I ~ '^[0-9a-f]{64}$'
          on conflict do nothing$sql$,
        t.table_name, (select string_agg(format('%L,%I', k, k), ',') from unnest(t.keys) k), col, col,
        t.schema_name, t.table_name, col);
      execute format($sql$update %I.%I set %I = clued_private.credential_verifier_v1(%I) where %I ~ '^[0-9a-f]{64}$'$sql$,
        t.schema_name, t.table_name, col, col, col);
      execute format($sql$alter table %I.%I add constraint %I check (%I ~ '^cv1:[0-9a-f]{64}$')$sql$,
        t.schema_name, t.table_name, t.table_name || '_' || col || '_check', col);
    end loop;
    if t.table_name = 'resource_center_rotations_v1' then
      insert into clued_private.credential_proof_backup_v1
        select t.table_name, jsonb_build_object('grant_id', grant_id, 'generation', generation), 'request',
          request::text, now() + interval '7 days'
          from clued_private.resource_center_rotations_v1
         where request ->> 'reader_hash' ~ '^[0-9a-f]{64}$' or request ->> 'writer_hash' ~ '^[0-9a-f]{64}$'
            or request ->> 'renewal_hash' ~ '^[0-9a-f]{64}$'
        on conflict do nothing;
      update clued_private.resource_center_rotations_v1
         set request = clued_private.credential_request_verifiers_v1(request)
       where request is distinct from clued_private.credential_request_verifiers_v1(request);
    end if;
    foreach col in array t.quiet_triggers loop
      execute format('alter table %I.%I enable trigger %I', t.schema_name, t.table_name, col);
    end loop;
    execute format('drop trigger if exists credential_verifier_normalize_v1 on %I.%I', t.schema_name, t.table_name);
    execute format('create trigger credential_verifier_normalize_v1 before insert or update of %s on %I.%I
        for each row execute function clued_private.credential_columns_normalize_v1(%s)',
      (select string_agg(format('%I', c), ',') from unnest(t.cols || case when t.table_name = 'resource_center_rotations_v1'
        then array['request'] else array[]::text[] end) c),
      t.schema_name, t.table_name,
      (select string_agg(format('%L', c), ',') from unnest(t.cols || case when t.table_name = 'resource_center_rotations_v1'
        then array['request'] else array[]::text[] end) c));
  end loop;
end
$columns$;

-- 4. Functions: compare with the verifier, hand on internal proofs --------------------------------------------
-- Each rewrite names the exact number of places it changes; a different count (a definition that differs from
-- the one this migration was written against) stops the migration. The 42 definitions present in clued-prod were
-- checked against this repository's on 2026-10-08 (md5 of pg_get_functiondef, all equal).

do $rewrite$
declare
  r record;
  body text;
  n int;
  cmp constant text := '(?<![\w.])((?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash))'
    '(\s*(?:=|<>|is distinct from|is not distinct from)\s*)(p_token_hash|p_hash|p_writer_hash|reader_hash|writer_hash|h)(?!\w)';
begin
  for r in select distinct sig from (values
      ('public.clued_authorization_revoke_self_v12(text)'), ('public.clued_authorization_status_v12(text)'),
      ('public.clued_development_call_v14(text,jsonb)'), ('public.clued_integration_revoke_self_v1(text,jsonb)'),
      ('public.clued_mcp_mtpe_owner_pin(text,jsonb)'), ('public.clued_mcp_restore_before_currentness(text,jsonb)'),
      ('public.clued_mcp_search_context(text,jsonb)'), ('clued_private.connection_permission_binding_v1(text)'),
      ('clued_private.integration_auth_binding_v1(text,uuid[],boolean)'),
      ('clued_private.owner_request_status_binding_v1(text,jsonb)'), ('clued_private.p5_mutate_gateway_core(text,jsonb)'),
      ('clued_private.p5_resolve_binding(text,jsonb,text)'), ('clued_private.resolve_binding(text,text,text)'),
      ('clued_private.resolve_binding_action_v12(text,text,text,text)'),
      ('clued_private.session_context_input(text,text,jsonb)'), ('public.clued_project_list(text,jsonb)'),
      ('public.clued_project_list_v2(text,jsonb)'), ('public.clued_resolve_binding(text,text)'),
      ('public.clued_storage_connections_v1(text)'), ('public.clued_storage_jobs_router_v2(text,jsonb)'),
      ('public.clued_storage_jobs_v1(text,jsonb)'), ('public.clued_storage_read_v1(text,text,jsonb)'),
      ('clued_private.storage_read_reserve_v1(text,text,jsonb)'), ('clued_private.storage_binding_v1(text,uuid,text)'),
      ('clued_private.storage_connection_path_v1(text,uuid,text)'),
      ('clued_private.storage_job_history_v2(text,uuid,uuid,text)'), ('clued_private.storage_jobs_mode_v2(text,jsonb,text)'),
      ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)'),
      ('clued_private.storage_read_evaluate_v1(text,uuid,text)'), ('public.clued_resource_center_authority_v1(text,jsonb)'),
      ('public.clued_resource_center_write_v1(text,jsonb)'), ('public.clued_resource_center_renew_v1(text,jsonb)'),
      ('clued_private.storage_job_begin_v1(uuid,uuid,text,jsonb)'),
      ('clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb)'),
      ('clued_private.storage_job_finalize_v2(uuid,uuid,text,jsonb)'),
      ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)'),
      ('clued_private.storage_cloud_worker_v2(text,jsonb)'), ('public.clued_storage_cloud_worker_v1(text,jsonb)'),
      ('public.clued_resource_center_writer_admin_v1(uuid,jsonb)'),
      ('public.clued_resource_center_renewal_admin_v1(uuid,jsonb)'), ('public.clued_oauth_call(text,jsonb)'),
      ('clued_private.storage_cloud_job_current_v2(uuid,uuid)'), ('public.clued_storage_staging_v1(text,text,jsonb)'),
      ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)')) v(sig) loop
    -- The P5 gateway functions exist only where the P5 migrations ran (not in clued-prod on 2026-10-08).
    continue when to_regprocedure(r.sig) is null;
    insert into clued_private.credential_function_backup_v1
      values (r.sig, pg_catalog.pg_get_functiondef(r.sig::regprocedure), now() + interval '7 days')
      on conflict (signature) do nothing;
  end loop;

  -- Comparisons of a stored credential with a caller's proof.
  for r in select * from (values
      ('public.clued_authorization_revoke_self_v12(text)', 1),
      ('public.clued_authorization_status_v12(text)', 1),
      ('public.clued_development_call_v14(text,jsonb)', 1),
      ('public.clued_integration_revoke_self_v1(text,jsonb)', 1),
      ('public.clued_mcp_mtpe_owner_pin(text,jsonb)', 1),
      ('public.clued_mcp_restore_before_currentness(text,jsonb)', 1),
      ('public.clued_mcp_search_context(text,jsonb)', 2),
      ('clued_private.connection_permission_binding_v1(text)', 1),
      ('clued_private.integration_auth_binding_v1(text,uuid[],boolean)', 2),
      ('clued_private.owner_request_status_binding_v1(text,jsonb)', 1),
      ('clued_private.p5_mutate_gateway_core(text,jsonb)', 1),
      ('clued_private.p5_resolve_binding(text,jsonb,text)', 1),
      ('clued_private.resolve_binding(text,text,text)', 1),
      ('clued_private.resolve_binding_action_v12(text,text,text,text)', 1),
      ('clued_private.session_context_input(text,text,jsonb)', 1),
      ('public.clued_project_list(text,jsonb)', 1),
      ('public.clued_project_list_v2(text,jsonb)', 1),
      ('public.clued_resolve_binding(text,text)', 1),
      ('public.clued_storage_connections_v1(text)', 1),
      ('public.clued_storage_jobs_router_v2(text,jsonb)', 1),
      ('public.clued_storage_jobs_v1(text,jsonb)', 1),
      ('public.clued_storage_read_v1(text,text,jsonb)', 1),
      ('clued_private.storage_read_reserve_v1(text,text,jsonb)', 1),
      ('clued_private.storage_binding_v1(text,uuid,text)', 1),
      ('clued_private.storage_connection_path_v1(text,uuid,text)', 1),
      ('clued_private.storage_job_history_v2(text,uuid,uuid,text)', 2),
      ('clued_private.storage_jobs_mode_v2(text,jsonb,text)', 1),
      ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)', 2),
      ('clued_private.storage_read_evaluate_v1(text,uuid,text)', 2),
      ('public.clued_resource_center_authority_v1(text,jsonb)', 1),
      ('public.clued_resource_center_write_v1(text,jsonb)', 2),
      ('public.clued_resource_center_renew_v1(text,jsonb)', 10),
      ('clued_private.storage_job_begin_v1(uuid,uuid,text,jsonb)', 1),
      ('clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb)', 1),
      ('clued_private.storage_job_finalize_v2(uuid,uuid,text,jsonb)', 1),
      ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)', 1),
      ('clued_private.storage_cloud_worker_v2(text,jsonb)', 2),
      ('public.clued_storage_cloud_worker_v1(text,jsonb)', 2)) v(sig, expected) loop
    continue when to_regprocedure(r.sig) is null;
    body := pg_catalog.pg_get_functiondef(r.sig::regprocedure);
    select count(*) into n from regexp_matches(body, cmp, 'g');
    -- A second run finds the comparisons already rewritten.
    continue when n = 0 and strpos(body, 'clued_private.credential_verifier_v1(') > 0;
    if n <> r.expected then
      raise exception 'credential_verifier_rewrite_mismatch' using detail = format('%s: %s comparisons, expected %s', r.sig, n, r.expected);
    end if;
    execute regexp_replace(body, cmp, '\1\2clued_private.credential_verifier_v1(\3)', 'g');
  end loop;

  -- Other comparisons and the places that hand a stored credential on.
  for r in select * from (values
      ('public.clued_resource_center_writer_admin_v1(uuid,jsonb)',
        $o$p_input->>'token_hash'=v_binding.token_hash$o$,
        $n$clued_private.credential_verifier_v1(p_input->>'token_hash')=v_binding.token_hash$n$, 1),
      ('public.clued_resource_center_renewal_admin_v1(uuid,jsonb)',
        $o$b.token_hash=p_input->>'token_hash' or w.token_hash=p_input->>'token_hash'$o$,
        $n$b.token_hash=clued_private.credential_verifier_v1(p_input->>'token_hash') or w.token_hash=clued_private.credential_verifier_v1(p_input->>'token_hash')$n$, 1),
      ('public.clued_resource_center_renew_v1(text,jsonb)',
        $o$h in (b.token_hash,w.token_hash,g.token_hash)$o$,
        $n$clued_private.credential_verifier_v1(h) in (b.token_hash,w.token_hash,g.token_hash)$n$, 1),
      ('public.clued_resource_center_renew_v1(text,jsonb)',
        $o$request->>'reader_hash'=h or request->>'writer_hash'=h or request->>'renewal_hash'=h$o$,
        $n$request->>'reader_hash'=clued_private.credential_verifier_v1(h) or request->>'writer_hash'=clued_private.credential_verifier_v1(h) or request->>'renewal_hash'=clued_private.credential_verifier_v1(h)$n$, 1),
      ('public.clued_resource_center_renew_v1(text,jsonb)',
        $o$prior.request=p_request$o$,
        $n$prior.request=clued_private.credential_request_verifiers_v1(p_request)$n$, 1),
      ('public.clued_resource_center_renew_v1(text,jsonb)',
        $o$w.token_hash,p_request,result)$o$,
        $n$w.token_hash,clued_private.credential_request_verifiers_v1(p_request),result)$n$, 1),
      ('public.clued_oauth_call(text,jsonb)',
        $o$  v_binding:=clued_private.resolve_oauth_binding();$o$,
        $n$  v_binding:=clued_private.resolve_oauth_binding();
  -- Every tool below expects the caller's proof, not the stored verifier.
  v_binding.token_hash:=clued_private.credential_internal_proof_v1(v_binding.token_hash);$n$, 1),
      ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
        $o$storage_policy_evaluate_v2(b.token_hash,$o$,
        $n$storage_policy_evaluate_v2(clued_private.credential_internal_proof_v1(b.token_hash),$n$, 1),
      ('clued_private.storage_cloud_worker_v2(text,jsonb)',
        $o$clued_resource_center_authority_v1(a.token_hash,$o$,
        $n$clued_resource_center_authority_v1(clued_private.credential_internal_proof_v1(a.token_hash),$n$, 1),
      ('clued_private.storage_cloud_worker_v2(text,jsonb)',
        $o$j.job_id,w.token_hash,$o$,
        $n$j.job_id,clued_private.credential_internal_proof_v1(w.token_hash),$n$, 3),
      ('clued_private.storage_job_begin_v1(uuid,uuid,text,jsonb)',
        $o$storage_binding_v1(b.token_hash,$o$,
        $n$storage_binding_v1(clued_private.credential_internal_proof_v1(b.token_hash),$n$, 2),
      ('public.clued_storage_cloud_worker_v1(text,jsonb)',
        $o$storage_binding_v1(b.token_hash,$o$,
        $n$storage_binding_v1(clued_private.credential_internal_proof_v1(b.token_hash),$n$, 3),
      ('public.clued_storage_cloud_worker_v1(text,jsonb)',
        $o$clued_resource_center_authority_v1(a.token_hash,$o$,
        $n$clued_resource_center_authority_v1(clued_private.credential_internal_proof_v1(a.token_hash),$n$, 1),
      ('public.clued_storage_cloud_worker_v1(text,jsonb)',
        $o$j.job_id,w.token_hash,$o$,
        $n$j.job_id,clued_private.credential_internal_proof_v1(w.token_hash),$n$, 3),
      ('public.clued_storage_staging_v1(text,text,jsonb)',
        $o$storage_policy_evaluate_v2(b.token_hash,$o$,
        $n$storage_policy_evaluate_v2(clued_private.credential_internal_proof_v1(b.token_hash),$n$, 1),
      ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
        $o$v_intent.authority_token_hash,v_intent.authority_request$o$,
        $n$clued_private.credential_internal_proof_v1(v_intent.authority_token_hash),v_intent.authority_request$n$, 2),
      -- clued_resource_center_write_v1 gives the journal the authority Binding's stored verifier (receipts digest
      -- it, and storage_verified_result_v2 recomputes those digests); the authority check gets an internal proof of
      -- it. A service_role caller may still give the proof itself.
      ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
        $o$p_input->>'authority_token_hash',v_request);$o$,
        $n$case when p_input->>'authority_token_hash' ~ '^cv1:' then clued_private.credential_internal_proof_v1(p_input->>'authority_token_hash') else p_input->>'authority_token_hash' end,v_request);$n$, 1)
    ) v(sig, old_text, new_text, expected) loop
    continue when to_regprocedure(r.sig) is null;
    body := pg_catalog.pg_get_functiondef(r.sig::regprocedure);
    -- A second run finds the new text already there (the clued_oauth_call text keeps the old line in it).
    continue when strpos(body, r.new_text) > 0;
    n := (length(body) - length(replace(body, r.old_text, ''))) / length(r.old_text);
    if n <> r.expected then
      raise exception 'credential_verifier_rewrite_mismatch' using detail = format('%s: %s places, expected %s', r.sig, n, r.expected);
    end if;
    execute replace(body, r.old_text, r.new_text);
  end loop;
end
$rewrite$;

-- 5. Nothing compares a stored Binding or Resource Center credential with a raw parameter any more (assignments,
-- `set token_hash=...`, are converted by the trigger).
-- clued_private.authorization_issuer_v12 compares issuer hashes (step 2b) and is the only expected match.
do $guard$
declare
  hits text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into hits
    from pg_catalog.pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'clued_private'::regnamespace)
     and p.prokind = 'f'
     and p.oid <> 'clued_private.authorization_issuer_v12(text,text)'::regprocedure
     and pg_catalog.pg_get_functiondef(p.oid) ~
       '(?<![\w.])(?<!set )(?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash|authority_token_hash)\s*(?:=|<>|is distinct from|is not distinct from)\s*(?:p_\w+|h|reader_hash|writer_hash)(?!\w)';
  if hits is not null then
    raise exception 'credential_verifier_raw_comparison' using detail = hits;
  end if;
end
$guard$;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('clued-credential-backup-purge', '17 3 * * *', 'select clued_private.credential_backup_purge_v1()');
  end if;
end
$cron$;

notify pgrst, 'reload schema';
