-- Terminal admission paused until every resident node accepts it (field 2026-11-13).
--
-- Once 20261113143000 let an authorized head's terminal admission through, the resident's scan start
-- refused the admission facts that carried it: scan-start-v1/subject.mjs checks the facts against the
-- fixed ADMISSION_FIELDS_V2/V3 list, while admittedFactsMatchJobV2 adds terminalAdmission when present.
-- Stage 1 failed with SCAN_START_SUBJECT_ADMISSION_REQUIRED and DESK's breaker reopened. The verifier
-- now returns before it records or returns a terminal admission; claims are then released as before
-- 20261108204157. A later migration removes this return once the fixed resident runs on every node.

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
