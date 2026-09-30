-- StorageFullCapability.v0.1 P2 (§5.4): the read_content class.
--
-- P1 rejected read_content in set_classes. The Owner can now enable it on the
-- native page under its own disclosure text; the stored disclosure_version
-- says which text was shown. The read evaluator already maps operation=read
-- to read_content and applies the per-class client deny; this migration only
-- adds what P2 needs on top:
-- * read_content can only be enabled together with read, and a content read
--   is also evaluated for read: its response names the file, which is what the
--   read level covers, so a per-client read deny also stops content reads;
-- * read requires an object_id (one file per call);
-- * a budget of 8 MiB of content per Binding (one authorized Agent connection)
--   per rolling hour. The server has no chat-session identity; a Binding is at
--   least as strict. Finalized receipts count their byte_count; an admitted but
--   not yet finalized read counts as the full 256 KiB it may return. Content
--   admissions of one Binding are serialized by a transaction advisory lock, so
--   concurrent calls see each other's intents and cannot exceed the budget.
--   The limit is fixed; an Owner-adjustable value is deferred.
-- No table changes. Reads still create no job, journal row or provider fence.

do $migration$
declare patch record; body text; hits int;
begin
  for patch in select * from (values
    -- Owner control: separate disclosure for read_content.
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$  disclosure constant text:='clued.storage-read-disclosure/1';$a$,
     $r$  disclosure constant text:='clued.storage-read-disclosure/1';
  content_disclosure constant text:='clued.storage-read-content-disclosure/1';$r$,1),
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$return jsonb_build_object('connection_id',c.id,'disclosure_version',disclosure,$a$,
     $r$return jsonb_build_object('connection_id',c.id,'disclosure_version',disclosure,'content_disclosure_version',content_disclosure,$r$,1),
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$    if 'read_content'=any(wanted) then raise exception 'storage_read_class_unavailable' using errcode='42501'; end if;
    if cardinality(wanted)>0 and p_input->>'disclosure_version' is distinct from disclosure then$a$,
     $r$    if 'read_content'=any(wanted) and not 'read'=any(wanted) then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    if cardinality(wanted)>0 and p_input->>'disclosure_version' is distinct from
      (case when 'read_content'=any(wanted) then content_disclosure else disclosure end) then$r$,1),
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$where connection_id=c.id),0)+1,disclosure,r.id)$a$,
     $r$where connection_id=c.id),0)+1,
        case when 'read_content'=any(wanted) then content_disclosure else disclosure end,r.id)$r$,1),
    -- Worker transport: one object per content read, and the hourly budget.
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$    wanted:=case when p_input->>'operation'='read' then 'read_content' else 'read' end;$a$,
     $r$    wanted:=case when p_input->>'operation'='read' then 'read_content' else 'read' end;
    if wanted='read_content' and not (p_input ? 'object_id') then
      raise exception 'storage_read_input_invalid' using errcode='22023'; end if;$r$,1),
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$    evaluated:=clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,wanted);$a$,
     $r$    if wanted='read_content' then
      perform clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,'read');
    end if;
    evaluated:=clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,wanted);
    if wanted='read_content' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-read-budget:'||(evaluated->>'binding_id'),0));
    end if;
    if wanted='read_content' and (select coalesce(sum(case when rc.state='finalized' then rc.byte_count else 262144 end),0)
        from clued_private.storage_read_receipts_v1 rc
        where rc.binding_id=(evaluated->>'binding_id')::uuid and rc.class='read_content'
          and rc.created_at>clock_timestamp()-interval '1 hour')>8388608-262144 then
      raise exception 'storage_read_budget_exhausted' using errcode='42501'; end if;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    body:=pg_get_functiondef(patch.sig::regprocedure);
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_read_content_definition_mismatch: % (% of %)',patch.sig,hits,patch.expected;
    end if;
    execute replace(body,patch.anchor,patch.replacement);
  end loop;
end $migration$;

-- The budget query reads recent receipts of one Binding.
create index storage_read_receipts_binding_recent_v1
  on clued_private.storage_read_receipts_v1(binding_id,created_at) where class='read_content';
