-- A current connection's Native status view may include original jobs from
-- its retired predecessor. Original connection/job/receipt identities remain
-- unchanged; the context ID only identifies the current authenticated view.
create function clued_private.storage_recovery_native_visible_v1(
 p_owner uuid,p_context uuid,p_job uuid,p_issuer_identity text) returns boolean
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;c clued_private.storage_connections_v1;
 original clued_private.storage_connections_v1;reader jsonb;
begin
 select * into j from clued_private.storage_jobs_v1 where job_id=p_job and owner_id=p_owner;
 select * into c from clued_private.storage_connections_v1 where id=p_context and owner_id=p_owner;
 if j.job_id is null or c.id is null then return false;end if;
 if j.connection_id=c.id then return true;end if;
 select * into original from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
 if original.id is null or original.profile_id is distinct from c.profile_id
 or original.provider is distinct from c.provider or original.provider_subject is distinct from c.provider_subject
 or original.oauth_client_id is distinct from c.oauth_client_id then return false;end if;
 begin
  reader:=clued_private.storage_recovery_reader_v1(p_issuer_identity,j.connection_id,j.job_id,c.id);
 exception when insufficient_privilege or invalid_text_representation then return false;
 end;
 return reader->'recovery_reader'->>'connection_id'=c.id::text;
end $$;
revoke all on function clued_private.storage_recovery_native_visible_v1(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $native$
declare body text;anchor text;
begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_native_recovery_v1(text,jsonb)'::regprocedure);
 anchor:=$a$clued_private.storage_conflict_public_status_v1(j) result$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_recovery_native_projection_mismatch';end if;
 body:=replace(body,anchor,$r$(clued_private.storage_conflict_public_status_v1(j)||
     jsonb_build_object('read_connection_id',c.id)) result$r$);
 anchor:=$a$j.owner_id=u and j.connection_id=c.id and m.state in ('started','uncertain','conflict')$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_recovery_native_selection_mismatch';end if;
 body:=replace(body,anchor,$r$j.owner_id=u and m.state in ('started','uncertain','conflict')
    and clued_private.storage_recovery_native_visible_v1(u,c.id,j.job_id,p_issuer_identity)$r$);
 execute body;
end $native$;
