-- Owner decision a28a9868-aebf-437c-b1fb-ca6709b3fc36: OAuth consent offers
-- lifetimes of 1, 7, 30, 90 or 365 days. Raise only the approval expiry cap
-- from 30 to 365 days; the rest of the installed approval kernel (validation,
-- CAS, replay, the v13 context-grant adapter) is kept byte for byte.
do $$ declare body text; begin
 body:=pg_get_functiondef('public.clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)'::regprocedure);
 if (length(body)-length(replace(body,'p_expires_at>clock_timestamp()+interval ''30 days''','')))
    <>length('p_expires_at>clock_timestamp()+interval ''30 days''') then
   raise exception 'authorization_expiry_source_mismatch';
 end if;
 body:=replace(body,'p_expires_at>clock_timestamp()+interval ''30 days''','p_expires_at>clock_timestamp()+interval ''365 days''');
 execute body;
end $$;
