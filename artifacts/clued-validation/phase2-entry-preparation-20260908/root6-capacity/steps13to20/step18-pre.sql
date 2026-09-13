-- ========================================================================================
-- STEP 18 PRECONDITIONS (the single 600-second run). Read-only for the database part.
-- ========================================================================================
-- The run is NOT started from SQL. Start it only through the fixed trusted entry
-- (tool-entry.functions.js), never by calling `node cli.mjs` directly. The entry, measured at
-- lines 67 to 85 of that file, does this in order:
--     sha256 /usr/bin/python3.11      == f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e
--     python3.11 -I -S -B             validates every manifest file's length and sha256
--     sha256 /opt/node22/bin/node     == 81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90
--     NODE_OPTIONS= NODE_PATH= exec /opt/node22/bin/node <controller>/cli.mjs
--
-- cli.mjs reads two JSON lines from stdin, each at most 4 MiB:
--   line 1  the material  -> replies {state:'NEED_COMMITTED_DISPATCH', challenge, project, intent,
--                                     dispatch_key}   (or NEED_FRESH_RESULT_CONTEXT for GRR)
--   line 2  must echo the same challenge -> replies with the dispatch result
-- It arms a 600000 ms watchdog. On expiry it emits
--   {state:'UNKNOWN'|'BLOCKED', reason:'VERIFIER_PROCESS_DEADLINE', capacity_released:false,
--    automatic_retry:false}
--
-- state:'UNKNOWN' means the effect MAY have happened. DO NOT RETRY on UNKNOWN. Determine the
-- actual state with the read-only queries in step18-readback.sql and step19-ga-id.sql.
--
-- HOST CHECKS, not checkable in SQL, all four must pass before starting:
--   /opt/node22/bin/node   81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90
--   /usr/bin/python3.11    f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e
--   /usr/bin/docker        18c2a16d6aa0331bbd78b93e0a57f344c62bda0be52c054d4ee80e11176b0c30
--   /usr/local/bin/gh      f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618
-- plus a reachable docker daemon (parent600.py invokes /usr/bin/docker by absolute path).
-- At preparation time the first three matched on this host and gh was ABSENT, with no docker
-- daemon. Both are host provisioning, not controller defects -- see HostProvisioning.json's
-- attribution_rule.

select
  clock_timestamp()                                                            as observed_at,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select active_ga_id is not null from clued_control.execution_current)       as ga_present,
  (select pending_budget_sequence is not null from clued_control.execution_current) as reservation_present,
  (select charged_seconds from clued_control.execution_current) = 9906         as allocation_not_yet_consumed,
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                                as head_is_root6,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a'       as binding_is_frozen_linux,
  -- Enough window left for 600 seconds of run plus the twenty observations plus the GRR.
  (select extract(epoch from (expires_at - clock_timestamp()))
     from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as seconds_left_in_window,
  (select clock_timestamp() + interval '600 seconds' < expires_at
     from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as room_for_the_run;
