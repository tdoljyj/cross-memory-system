do $patch$
declare body text:=pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  anchor text:=$a$  head_id:=coalesce(nullif(result->>'head_authorization_id',''),result#>>'{claim_binding,head_authorization_id}')::uuid;
$a$;
  replacement text:=$r$  head_id:=coalesce(nullif(result->>'head_authorization_id',''),result#>>'{claim_binding,head_authorization_id}')::uuid;
  if head_id is null then return result; end if;
  result:=result||jsonb_build_object('head_authorization_id',head_id);
$r$;
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'work_verify_terminal_head_authorization_anchor_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $patch$;
