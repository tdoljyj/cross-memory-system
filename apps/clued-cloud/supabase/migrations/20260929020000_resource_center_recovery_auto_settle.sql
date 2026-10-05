-- A new recovery consent may request one automatic, read-only comparison of
-- the original job. Existing OAuth attempts remain credential-only.
alter table clued_private.storage_oauth_attempts_v1
  add column auto_settle_original boolean not null default false,
  add constraint storage_oauth_auto_settle_original_v1 check
    (not auto_settle_original or (purpose='credential_recovery' and recovery_job_id is not null));

create function public.clued_storage_recovery_auto_target_v1(p_issuer_secret text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); x clued_private.storage_oauth_attempts_v1;
  issuer text; op text:=p_input->>'action';
begin
  if coalesce(length(p_issuer_secret),0)<32 or jsonb_typeof(p_input) is distinct from 'object'
    or op not in ('mark','target') or p_input->>'state_hash' !~ '^[0-9a-f]{64}$' then
    raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
  issuer:=encode(sha256(convert_to(p_issuer_secret,'UTF8')),'hex');
  perform 1 from clued_private.storage_oauth_apps_v1 where issuer_hash=issuer and revoked_at is null for share;
  if not found then raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
  if op='mark' then
    if p_input is distinct from jsonb_build_object('action',op,'state_hash',p_input->>'state_hash',
      'connection_id',p_input->>'connection_id','job_id',p_input->>'job_id') then
      raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
    select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash'
      and owner_id=u and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=issuer
      and purpose='credential_recovery' and connection_id=(p_input->>'connection_id')::uuid
      and recovery_job_id=(p_input->>'job_id')::uuid and status='prepared'
      and expires_at>clock_timestamp() for update;
    if not found then raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
    perform clued_private.storage_owner_v1();
    if x.expires_at<=clock_timestamp() then raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
    update clued_private.storage_oauth_attempts_v1 set auto_settle_original=true where id=x.id;
    return jsonb_build_object('status','marked');
  end if;
  if p_input is distinct from jsonb_build_object('action',op,'state_hash',p_input->>'state_hash') then
    raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
  select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash'
    and owner_id=u and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=issuer
    and purpose='credential_recovery' and status='completed' and expires_at>clock_timestamp();
  if not found then raise exception 'storage_recovery_auto_denied' using errcode='42501'; end if;
  if not x.auto_settle_original then return jsonb_build_object('status','manual'); end if;
  -- This is a reference, never settlement authority. The existing Owner recovery
  -- contract independently rechecks the exact job, intent, root and credential.
  return jsonb_build_object('status','ready','connection_id',x.connection_id,
    'job_id',x.recovery_job_id,'execution_permitted',false);
end $$;
revoke all on function public.clued_storage_recovery_auto_target_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_recovery_auto_target_v1(text,jsonb) to authenticated;
