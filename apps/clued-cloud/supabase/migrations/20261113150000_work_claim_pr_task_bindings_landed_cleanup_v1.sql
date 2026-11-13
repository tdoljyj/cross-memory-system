-- One-time cleanup (Owner-approved 2026-11-13): bindings of PRs that GitHub reports merged or closed
-- stayed 'active' because the adopt that finishes them never ran; a Task with several active
-- bindings could not pick its open PR as the merge-train front (#1087). States checked on GitHub 07:06Z.
update clued_private.work_claim_pr_task_bindings_v1 set status='merged'
 where repo_id='tdoljyj/cross-memory-system' and status='active'
   and pr_number in (1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1081,1082,1083,1084,1085,1086);
update clued_private.work_claim_pr_task_bindings_v1 set status='closed'
 where repo_id='tdoljyj/cross-memory-system' and status='active' and pr_number=1061;
