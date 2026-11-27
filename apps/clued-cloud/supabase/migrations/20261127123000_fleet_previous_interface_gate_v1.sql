-- The protected release job enforces successful replay. The seal transaction
-- checks the evidence bindings and current predecessor, then records the evidence.
alter table clued_private.fleet_accepted_v1 add column previous_interface_evidence jsonb;

create function clued_private.fleet_require_previous_interface_v1(p_input jsonb, p_accepted clued_private.fleet_accepted_v1)
returns jsonb language plpgsql stable set search_path='' as $$
declare
  proof jsonb:=p_input->'previousInterfaceEvidence';
  predecessor jsonb;
  prior clued_private.fleet_accepted_v1%rowtype;
  now_ms numeric:=extract(epoch from statement_timestamp())*1000;
begin
  if jsonb_typeof(proof) is distinct from 'object' or octet_length(proof::text)>4096 then
    raise exception 'fleet_previous_interface_evidence_required' using errcode='22023'; end if;
  predecessor:=proof->'previous';
  if proof->>'contract' is distinct from 'clued.fleet-previous-interface.v1'
      or proof->>'status' is distinct from 'PASS'
      or proof->'candidate' is distinct from p_input->'candidate'
      or coalesce(proof->'candidate'->>'commit','') !~ '^[0-9a-f]{40}$'
      or proof->>'acceptanceSha256' is distinct from p_input->>'acceptanceSha256'
      or coalesce(proof->>'migrationsSha256','') !~ '^[0-9a-f]{64}$'
      or proof->>'migrationsSha256' is distinct from p_input->>'migrationsSha256'
      or coalesce(proof->>'workflowCommit','') !~ '^[0-9a-f]{40}$'
      or coalesce(proof->>'runId','') !~ '^[1-9][0-9]{0,19}$'
      or coalesce(proof->>'checkedAt','') !~ '^[0-9]{13}$' then
    raise exception 'fleet_previous_interface_evidence_mismatch' using errcode='22023'; end if;
  if (proof->>'checkedAt')::numeric not between now_ms-1800000 and now_ms+60000 then
    raise exception 'fleet_previous_interface_evidence_stale' using errcode='40001'; end if;

  select * into prior from clued_private.fleet_accepted_v1
    where user_id=p_accepted.user_id and repository=p_accepted.repository and sealed_at is not null
      and version<>p_accepted.version and clued_private.fleet_package_generation_v1(version)>=25
    order by version desc limit 1;
  if not found or clued_private.fleet_package_generation_v1(prior.version)>=clued_private.fleet_package_generation_v1(p_accepted.version)
      or predecessor->>'repository' is distinct from prior.repository
      or predecessor->>'version' is distinct from prior.version
      or predecessor->>'requestSha256' is distinct from prior.request_sha256
      or predecessor->>'archiveSha256' is distinct from prior.archive_sha256
      or predecessor->>'acceptanceSha256' is distinct from prior.acceptance_sha256
      or coalesce(predecessor->>'commit','') !~ '^[0-9a-f]{40}$'
      or predecessor->>'commit'=proof->'candidate'->>'commit'
      or (prior.previous_interface_evidence is not null and predecessor->>'commit'
        is distinct from prior.previous_interface_evidence->'candidate'->>'commit') then
    raise exception 'fleet_previous_interface_predecessor_changed' using errcode='40001'; end if;
  return proof;
end $$;

-- Preserve the one existing RPC signature and its ACL. The gate and write
-- share the transaction and all callers of the signature use this definition.
create or replace function clued_private.fleet_delivery_seal_v1(p_input jsonb)
returns jsonb language plpgsql volatile set search_path='' as $$
declare candidate jsonb:=p_input->'candidate'; at_time timestamptz;
  d text:=p_input->>'acceptanceSha256'; a clued_private.fleet_accepted_v1%rowtype; proof jsonb;
begin
  if coalesce(d,'') !~ '^[0-9a-f]{64}$' or clued_private.fleet_package_generation_v1(candidate->>'version')<25
      or coalesce(candidate->>'repository','') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then
    raise exception 'fleet_delivery_seal_invalid' using errcode='22023'; end if;
  -- A caller that waited for another seal must take a fresh snapshot of its predecessor.
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'fleet_previous_interface_isolation_invalid' using errcode='25000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet_delivery_seal_v1:'||(candidate->>'repository'),0));
  select accepted.* into a from clued_private.fleet_accepted_v1 accepted
    join clued_private.release_identity_v1 r using (user_id,repository)
    where accepted.version=candidate->>'version' and accepted.repository=candidate->>'repository'
      and accepted.request_sha256=candidate->>'requestSha256' and accepted.archive_sha256=candidate->>'archiveSha256'
      and accepted.grant_id::text=p_input->>'grantId' and accepted.receipt_id::text=p_input->>'receiptId'
      and date_trunc('second',accepted.accepted_at)=(p_input->>'acceptedAt')::timestamptz
    for update of accepted;
  if not found then raise exception 'fleet_delivery_acceptance_changed' using errcode='22023'; end if;
  proof:=clued_private.fleet_require_previous_interface_v1(p_input,a);
  if a.sealed_at is not null then
    if a.acceptance_sha256 is distinct from d then raise exception 'fleet_delivery_seal_conflict' using errcode='22023'; end if;
    at_time:=a.sealed_at;
  else
    perform clued_private.fleet_delivery_require_snapshot_v1(candidate,p_input->>'snapshotToken');
    at_time:=clock_timestamp();
    update clued_private.fleet_accepted_v1 set sealed_at=at_time,acceptance_sha256=d,previous_interface_evidence=proof
      where grant_id=a.grant_id;
  end if;
  return jsonb_build_object('status','sealed','grantId',a.grant_id,'receiptId',a.receipt_id,'acceptanceSha256',d,'sealedAt',at_time);
end $$;

revoke all on function clued_private.fleet_require_previous_interface_v1(jsonb,clued_private.fleet_accepted_v1),
  clued_private.fleet_delivery_seal_v1(jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
