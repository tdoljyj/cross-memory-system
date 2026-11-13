do $patch$
declare body text:=pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  anchor text:=$a$  if admitted.admission_id is null then return result; end if;
$a$;
  replacement text:=$r$  if admitted.admission_id is null then return result; end if;
  -- Paused 2026-11-13: the resident's scan start refuses admission facts that carry a terminal admission
  -- (scan-start-v1/subject.mjs fixed field list); no terminal admission until every node accepts it.
  return result;
$r$;
begin
  if (length(body)-length(replace(body,anchor,'')))<>length(anchor) then
    raise exception 'work_verify_terminal_admission_pause_anchor_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $patch$;
