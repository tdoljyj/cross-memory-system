-- ========================================================================================
-- STEP 20 PRECONDITIONS (GRR). Read-only. Expect every boolean true.
-- ========================================================================================
-- The command is the same trusted entry with material.operation = 'GRR' and material.grr_raw
-- supplied; it lands through  select clued_control.commit_gate_result(<raw>,<sha>,<decision_sha>).
--
-- cli.mjs replies {state:'NEED_FRESH_RESULT_CONTEXT', challenge, project} for the GRR path
-- rather than NEED_COMMITTED_DISPATCH (context.mjs:367 returns kind 'RESULT_TERMINAL').
--
-- If the terminal result is FAIL, BLOCKED or STALE, context.mjs:303 switches seriesOperation to
-- 'RESULT_RECONCILIATION' instead of 'CURRENT_DISPATCH'. That is the normal path for a
-- non-passing run; it is not an error.
--
-- WHAT THE GRR MUST STATE -- not checkable in SQL, and not optional. See the sheet, section 11:
--   1. the enforcing layer (clued_control's SECURITY DEFINER functions, accepted_binding's
--      constraints and immutable triggers) was modified before the run by the party under
--      qualification; and a prior modification of the same kind on 2026-09-11 had no PR, no
--      independent review, and no migration-table record. Wording: SuccessorReviewerRound8.md
--      section 5, which is NOT on this branch -- it is on claude/trusting-keller-mm2s0v together
--      with its AddendumA. Fetch both before issuing.
--   2. "Owner has approved" is a restatement of the GitHub API's verification.verified and
--      reason:'valid'. capture-owner-merge.mjs and trusted-github.mjs check only that signature
--      and payload EXIST; neither verifies the payload against the commit, nor the signature.
--   3. the controller digest IS its manifest digest, and this must be restated for the Linux
--      controller rather than copied from the Windows wording: of the 314 entries, 161 are
--      RUNTIME_DEPENDENCY with absolute paths inside one ephemeral container (for example
--      /home/user/cross-memory-system/apps/clued-cloud/node_modules/ajv/lib/ajv.js). Unless those
--      bytes are re-verified before and after the run, the GRR's claim about controller identity
--      holds only under an unverified assumption about a container that is reclaimed by design.
--   4. the host loss and the Linux port (HostLossTerminalRecord.md, LostInputsRecoveryAnalysis.md)
--      and that this is therefore a NEW chain, not a continuation.
--   5. the actual status, at issuance, of the three blockers in section 0 of the sheet -- for each,
--      whether it was closed or bypassed.

select
  clock_timestamp()                                                            as observed_at,
  (select active_ga_id from clued_control.execution_current)                   as active_ga_id,
  (select active_ga_id is not null from clued_control.execution_current)       as ga_present,
  (select phase from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as phase,
  (select receipt_id from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as receipt_id,
  (select receipt_id is null from clued_control.gate_attempts
    where ga_id=(select active_ga_id from clued_control.execution_current)
    order by sequence desc limit 1)     as receipt_not_yet_committed,
  (select charged_seconds from clued_control.execution_current)                as charged_seconds,
  (select charged_seconds - 9906 from clued_control.execution_current)         as seconds_consumed,
  (select expires_at > clock_timestamp() from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as owner_window_open,
  (select expires_at - clock_timestamp() from clued_control.accepted_binding
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')                      as window_remaining,
  (select generation_id from clued_control.current_head
    where root_id='ctr_414bd3c724264a83894b0c55cf2ab878')
    = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b'                                as head_is_root6,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)
    = '389fee9b7e533041119838df59706cc2166b44497369cca419b1dc125e9a98ec'       as binding_is_frozen_linux,
  (select count(*) from clued_control.control_objects)                         as control_objects_before,
  (select count(*) from clued_control.gate_attempts)                           as gate_attempts_before;
