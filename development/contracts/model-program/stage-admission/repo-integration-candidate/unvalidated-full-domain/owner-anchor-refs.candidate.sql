-- UNINSTALLED neutral projection bootstrap. No public HTTP/MCP registration.
-- Existing Binding context:read + exact fixed Project only; emits two refs,
-- not a domain grant, actor DTO, Owner adoption Receipt or Kernel authority.
create or replace function public.clued_model_dataset_split_owner_anchor_refs_candidate(
 p_token_hash text,p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
 s constant text:='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
 ids constant uuid[]:=array['b8c1d482-9eb4-4bc5-8dd1-372b0d55174e','46b0ff1c-f608-4ff9-89b9-dc90a61ce70f']::uuid[];
 receipts constant uuid[]:=array['45a657d9-ba34-437e-b17c-2d792ce5c692','4c9b9066-5146-4bd5-9e5d-8660624fdecb']::uuid[];
 keys constant text[]:=array['owner_adoption_server_ref','final_recognizer_server_ref'];
 b public.clued_agent_bindings; final_b public.clued_agent_bindings;m public.clued_memories;
 rows jsonb; first_rows jsonb; refs jsonb; i integer; pass integer; recomputed text;
begin
 if p_input is distinct from '{"schema":"clued.model-owner-anchor-refs/1"}'::jsonb
 then raise exception 'FIXED_OWNER_REFS_INPUT_REQUIRED' using errcode='22023'; end if;
 b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
 for pass in 1..2 loop
  rows:='{}';refs:='{}';
  for i in 1..2 loop
   select * into m from public.clued_memories x where x.user_id=b.user_id and x.id=ids[i];
   if not found or m.record_schema_version is distinct from 1 or m.version is distinct from 1 or
      m.record_type is distinct from 'decision' or m.authority is distinct from 'user_explicit' or
      m.canonical_scope is distinct from s or m.lifecycle_status is distinct from 'active' or
      m.receipt_id is distinct from receipts[i] or
      clued_private.record_currentness_fence(b.user_id,m.id,array[s]) is distinct from 'CURRENT'
   then raise exception 'FIXED_OWNER_ANCHOR_NOT_CURRENT' using errcode='42501'; end if;
   recomputed:=clued_private.m1_record_content_hash(m.record_type,m.canonical_scope,m.lifecycle_status,m.title,m.content,
     m.type_fields,m.relations,m.source_refs,m.source_unavailable_reason,m.authority,m.observed_at,m.closed_at,m.confidence,m.confidence_reason);
   if m.content_hash is distinct from recomputed or coalesce(recomputed,'') !~ '^[0-9a-f]{64}$'
   then raise exception 'OWNER_SERVER_FULL_RECORD_HASH_INVALID' using errcode='42501'; end if;
   refs:=refs||jsonb_build_object(keys[i],jsonb_build_object('id',m.id,'version',m.version,'content_hash',m.content_hash));
   rows:=rows||jsonb_build_object(keys[i],jsonb_build_object('ref',refs->keys[i],'type_fields',m.type_fields,'receipt_id',m.receipt_id));
  end loop;
  if pass=1 then first_rows:=rows;
  elsif rows is distinct from first_rows then raise exception 'OWNER_ANCHOR_CHANGED_DURING_READ' using errcode='42501'; end if;
  final_b:=clued_private.resolve_binding(p_token_hash,'context:read',s);
  if final_b.id is distinct from b.id or final_b.user_id is distinct from b.user_id then
   raise exception 'OWNER_ANCHOR_BINDING_CHANGED' using errcode='42501'; end if;
 end loop;
 return refs||jsonb_build_object('status','OWNER_ANCHOR_PROJECTION_REFS_ONLY','projection_only',true,
   'source_scope',s,'authority_effect','NONE','domain_permission','NOT_GRANTED','m2_verdict','NOT_ISSUED');
end $$;
revoke all on function public.clued_model_dataset_split_owner_anchor_refs_candidate(text,jsonb)
 from public,anon,authenticated,service_role;
