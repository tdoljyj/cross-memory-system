-- No application, issuer or credentials are seeded. Provisioning is a reviewed
-- deployment operation. Native users and OAuth clients cannot register issuers.
create table clued_private.storage_oauth_apps_v1 (
  issuer_hash text primary key check(issuer_hash ~ '^[0-9a-f]{64}$'),
  oauth_client_id text not null check(oauth_client_id ~ '^[A-Za-z0-9._-]{1,255}$'),
  redirect_uri text not null check(redirect_uri ~ '^https://[^/?#]+/storage/google/callback$'),
  revoked_at timestamptz
);
create table clued_private.storage_oauth_attempts_v1 (
  id uuid primary key,
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  owner_id uuid not null references auth.users(id),
  session_id uuid not null,
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  connection_version bigint not null,
  state_hash text not null unique check(state_hash ~ '^[0-9a-f]{64}$'),
  verifier_envelope jsonb not null,
  expires_at timestamptz not null,
  status text not null default 'prepared' check(status in ('prepared','claimed','completed')),
  receipt_id uuid references public.clued_audit_receipts(id)
);
create index storage_oauth_attempt_connection_v1 on clued_private.storage_oauth_attempts_v1(connection_id);
create index storage_oauth_attempt_owner_v1 on clued_private.storage_oauth_attempts_v1(owner_id);
alter table clued_private.storage_oauth_apps_v1 enable row level security;
alter table clued_private.storage_oauth_attempts_v1 enable row level security;
revoke all on clued_private.storage_oauth_apps_v1,clued_private.storage_oauth_attempts_v1 from public,anon,authenticated,service_role;

create function clued_private.storage_envelope_valid_v1(e jsonb) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(e)='object' and
    (e-array['contract','key_id','nonce','ciphertext'])='{}'::jsonb and
    e->>'contract'='clued.storage-credential/1' and e->>'key_id' ~ '^[A-Za-z0-9_-]{1,64}$' and
    e->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and length(e->>'ciphertext') between 23 and 21867
    and e->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',false)
$$;
revoke all on function clued_private.storage_envelope_valid_v1(jsonb) from public,anon,authenticated,service_role;

-- Requires BOTH a currently live native session and the server connector issuer.
-- The issuer alone is neither a user nor a general database credential.
create function public.clued_storage_oauth_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); a clued_private.storage_oauth_apps_v1;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  x clued_private.storage_oauth_attempts_v1; op text:=p_input->>'action'; out jsonb;
  r public.clued_audit_receipts; refs jsonb; ev text; req jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('describe','prepare','claim','complete') then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  select * into a from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  if op in ('claim','complete') then
    if coalesce(p_input->>'state_hash','') !~ '^[0-9a-f]{64}$' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash' and owner_id=u
      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=a.issuer_hash;
    if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    select * into c from clued_private.storage_connections_v1 where id=x.connection_id and owner_id=u for update;
    select * into x from clued_private.storage_oauth_attempts_v1 where id=x.id for update;
  else
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
  end if;
  if c.id is null or c.revoked_at is not null or c.state='revoked' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  if not found or p.state<>'active' or p.version<>c.profile_version then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id in (c.source_decision_id,p.source_decision_id) order by id for share;
  if not exists(select 1 from public.clued_memories where id=c.source_decision_id and version=c.decision_version)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,p.source_decision_id) then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  out:=jsonb_build_object('owner_id',u,'connection_id',c.id,'connection_version',c.version,
    'credential_version',c.credential_version+1,'provider_subject',c.provider_subject,
    'oauth_client_id',a.oauth_client_id,'redirect_uri',a.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id);
  if op='describe' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  elsif op='prepare' then
    if (p_input-array['action','connection_id','connection_version','attempt_id','state_hash','verifier_envelope'])<>'{}'::jsonb
      or c.version is distinct from (p_input->>'connection_version')::bigint
      or not clued_private.storage_envelope_valid_v1(p_input->'verifier_envelope') then
      raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,state_hash,verifier_envelope,expires_at)
      values((p_input->>'attempt_id')::uuid,c.id,u,(auth.jwt()->>'session_id')::uuid,a.issuer_hash,c.version,
        p_input->>'state_hash',p_input->'verifier_envelope',clock_timestamp()+interval '10 minutes');
    out:=jsonb_build_object('status','prepared');
  else
    if x.expires_at<=clock_timestamp() then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    if x.status='completed' then
      if op<>'claim' or p_input<>jsonb_build_object('action','claim','state_hash',x.state_hash) then
        raise exception 'storage_oauth_denied' using errcode='42501'; end if;
      out:=jsonb_build_object('status','completed','receipt_id',x.receipt_id);
    else
      if c.version<>x.connection_version or (c.oauth_client_id is not null and c.oauth_client_id<>a.oauth_client_id) then
        raise exception 'storage_oauth_denied' using errcode='42501'; end if;
      if op='claim' then
        if x.status<>'prepared' or p_input<>jsonb_build_object('action','claim','state_hash',x.state_hash) then
          raise exception 'storage_oauth_denied' using errcode='42501'; end if;
        update clued_private.storage_oauth_attempts_v1 set status='claimed' where id=x.id;
        out:=out||jsonb_build_object('status','claimed','attempt_id',x.id,'verifier_envelope',x.verifier_envelope);
      else
        if x.status<>'claimed' or (p_input-array['action','state_hash','credential_envelope','provider_subject'])<>'{}'::jsonb
          or coalesce(p_input->>'provider_subject','') !~ '^[A-Za-z0-9_-]{1,255}$'
          or (c.provider_subject is not null and c.provider_subject<>p_input->>'provider_subject')
          or not clued_private.storage_envelope_valid_v1(p_input->'credential_envelope') then
          raise exception 'storage_oauth_denied' using errcode='42501'; end if;
        req:=jsonb_build_object('idempotency_key',x.id::text||':activate','connection_id',c.id,
          'credential_version',c.credential_version+1,'request_digest',clued_private.m1_sha256(p_input));
        r:=clued_private.m1_begin_receipt(u,null,'storage_oauth_activate',req,clued_private.m1_sha256(req));
        if r.status<>'pending' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
        update clued_private.storage_connections_v1 set state='active',provider_subject=p_input->>'provider_subject',
          oauth_client_id=a.oauth_client_id,credential_version=credential_version+1,
          credential_envelope=p_input->'credential_envelope',version=version+1,receipt_id=r.id where id=c.id returning * into c;
        refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
        ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:oauth_activate',refs,
          'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'credential_version',c.credential_version),
          req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
        perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(c.id::text,x.connection_version),
          jsonb_build_object(c.id::text,c.version),array[ev],'{}'::uuid[],null);
        update clued_private.storage_oauth_attempts_v1 set status='completed',receipt_id=r.id where id=x.id;
        out:=jsonb_build_object('status','completed','receipt_id',r.id);
      end if;
    end if;
  end if;
  perform clued_private.storage_owner_v1();
  if x.id is not null and x.expires_at<=clock_timestamp() then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  return out;
end $$;
revoke all on function public.clued_storage_oauth_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_oauth_v1(text,jsonb) to authenticated;
