create or replace function public.clued_ci_node_registration_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; p uuid; b public.clued_agent_bindings; n clued_private.ci_nodes_v1; d text; r uuid; sid text;
begin
  perform clued_private.ci_input_v1(p_input,array['project_id','node_id','binding_id','name','profile','profile_sha256',
    'identity_public_jwk','encryption_public_jwk','qualification_digest','qualification_source',
    'publisher_requested','scan_signing_requested','idempotency_key'],
    array['project_id','binding_id','name','profile','profile_sha256','identity_public_jwk','encryption_public_jwk','idempotency_key']);
  p:=(p_input->>'project_id')::uuid; u:=clued_private.ci_native_owner_v1(true,p,(p_input->>'binding_id')::uuid);
  sid:=clued_private.native_session_id_v1();
  select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=u;
  if not found or not clued_private.binding_live_v1(b) or not ('context:read'=any(b.scopes)) then
    raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  if p_input::text ~* '(-----BEGIN[^-]*PRIVATE KEY-----|Bearer[[:space:]]|ghp_|gho_|github_pat_|postgres(ql)?://[^/@:]+:[^/@]+@)'
    or not clued_private.ci_profile_v1(p_input->'profile')
    or jsonb_typeof(p_input->'profile_sha256') is distinct from 'string'
    or not clued_private.ci_jwk_v1(p_input->'identity_public_jwk') or not clued_private.ci_jwk_v1(p_input->'encryption_public_jwk')
    or p_input->'identity_public_jwk'=p_input->'encryption_public_jwk'
    or jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 100
    or jsonb_typeof(p_input->'idempotency_key')<>'string' or length(p_input->>'idempotency_key') not between 1 and 120
    or p_input ? 'publisher_requested' and jsonb_typeof(p_input->'publisher_requested')<>'boolean'
    or p_input ? 'scan_signing_requested' and jsonb_typeof(p_input->'scan_signing_requested')<>'boolean' then
    raise exception 'CI_REGISTRATION_INVALID' using errcode='22023'; end if;
  d:=clued_private.m1_sha256(p_input);
  perform pg_advisory_xact_lock(hashtextextended('ci-registration:'||u||':'||p||':'||(p_input->>'idempotency_key'),0));
  select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and idempotency_key=p_input->>'idempotency_key';
  if found then
    if n.registration_digest<>d then raise exception 'CI_IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
    return jsonb_build_object('status','committed','replayed',true,'node_id',n.node_id,'version',n.version,'state',n.state,'receipt_id',n.receipt_id);
  end if;
  perform clued_private.ci_native_recheck_v1(u,sid);
  insert into clued_private.ci_nodes_v1(node_id,user_id,project_id,binding_id,name,profile,profile_sha256,
    identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,
    qualification_digest,qualification_source,publisher_requested,scan_signing_requested,
    connection_expires_at,registration_digest,idempotency_key)
  values(coalesce((p_input->>'node_id')::uuid,extensions.gen_random_uuid()),u,p,b.id,btrim(p_input->>'name'),p_input->'profile',p_input->>'profile_sha256',
    p_input->'identity_public_jwk',p_input->'encryption_public_jwk',clued_private.ci_jwk_fingerprint_v1(p_input->'identity_public_jwk'),clued_private.ci_jwk_fingerprint_v1(p_input->'encryption_public_jwk'),
    p_input->>'qualification_digest',p_input->>'qualification_source',coalesce((p_input->>'publisher_requested')::boolean,false),
    coalesce((p_input->>'scan_signing_requested')::boolean,false),(to_jsonb(b)->>'expires_at')::timestamptz,d,p_input->>'idempotency_key') returning * into n;
  r:=clued_private.ci_receipt_v1(u,p,'ci_node_register',n.node_id::text,jsonb_build_object('state','pending','registration_digest',d));
  update clued_private.ci_nodes_v1 set receipt_id=r where node_id=n.node_id;
  return jsonb_build_object('status','committed','replayed',false,'node_id',n.node_id,'version',n.version,'state',n.state,'receipt_id',r);
end $$;
