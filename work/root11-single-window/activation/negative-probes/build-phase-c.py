# C 组负向探针：要改库里的历史才能触发，因此每条都单独重置复制品。
# 这些 update 只在复制品上做，且都要临时停用不可变触发器——生产库上绝不做这种事。
import json, hashlib, pathlib, collections

LIVE = pathlib.Path(r'C:/Users/17531/root10-snapshot-20260916/gen11-live')
OUTD = pathlib.Path(r'C:/Users/17531/root10-snapshot-20260916/negatives')
OUTD.mkdir(parents=True, exist_ok=True)
sha = lambda b: hashlib.sha256(b).hexdigest()
compact = lambda v: json.dumps(v, separators=(',', ':'), ensure_ascii=False) + '\n'
ga = json.loads((LIVE / 'Root11GateAuthorization.json').read_text(encoding='utf-8'),
                object_pairs_hook=collections.OrderedDict)
RAW = compact(ga)
SHA = sha(RAW.encode())
R = "ctr_414bd3c724264a83894b0c55cf2ab878"

OFF = ("alter table clued_control.events disable trigger events_immutable;\n"
       "alter table clued_control.execution_events disable trigger execution_events_immutable;\n"
       "alter table clued_control.gate_attempts disable trigger gate_bytes_immutable;\n")
ON = ("alter table clued_control.events enable trigger events_immutable;\n"
      "alter table clued_control.execution_events enable trigger execution_events_immutable;\n"
      "alter table clued_control.gate_attempts enable trigger gate_bytes_immutable;\n")

CASES = [
    ('N11a_ROOT_PREFIX_DRIFT',
     "update clued_control.events set request=jsonb_set(request,'{kind}','\"DRIFTED\"') "
     "where root_id='%s' and sequence=6;" % R,
     ['series_full_original_root_changed']),
    ('N11b_EXECUTION_PREFIX_DRIFT',
     "update clued_control.execution_events set request=jsonb_set(request,'{operation}','\"DRIFTED\"') "
     "where root_id='%s' and sequence=44;" % R,
     ['series_original_44_events_changed']),
    ('N12_HISTORICAL_BUDGET_DRIFT',
     "update clued_control.execution_events set request=jsonb_set(request,'{body,raw}',"
     "to_jsonb(replace(request->'body'->>'raw','\"root_generation\":\"','\"root_generation\":\"x'))) "
     "where root_id='%s' and sequence=46 and request->>'operation'='BUDGET_RESERVED';" % R,
     ['root10_exact_single_ga_preimage_required']),
    ('N13_GA6_CLOSURE_DRIFT',
     "update clued_control.execution_events set request=jsonb_set(request,'{body,decision_raw}',"
     "to_jsonb((request->'body'->>'decision_raw')||' ')) "
     "where root_id='%s' and sequence=111;" % R,
     ['root10_exact_single_ga_preimage_required']),
    ('N08_HISTORICAL_ATTEMPT_DRIFT',
     "update clued_control.gate_attempts set receipt_raw=receipt_raw||' ' "
     "where root_id='%s' and ga_id='ga_165dc2e72b62414a8023e726d8114f28';" % R,
     ['series_original_six_attempts_changed', 'root10_exact_single_ga_preimage_required']),
    ('N09_NONTERMINAL_HISTORICAL_PHASE',
     "update clued_control.gate_attempts set phase='RUNNING' "
     "where root_id='%s' and ga_id='ga_04377008dc04437d9ee9d28a3c79ff3a';" % R,
     ['root10_exact_single_ga_preimage_required']),
    # 下面三条针对迁移 01 开出的那个例外：它必须窄到改一个字节就失效。
    ('N16_TERMINATED_PHASE_DRIFT',
     "update clued_control.gate_attempts set phase='BLOCKED' "
     "where root_id='%s' and ga_id='ga_32daa5daf52c4deb8e893c25b08eff38';" % R,
     ['root10_exact_single_ga_preimage_required']),
    ('N17_TERMINATED_RECEIPT_INJECTED',
     "update clued_control.gate_attempts set receipt_id='grr_forged', receipt_raw='{}', "
     "receipt_sha256=encode(sha256(convert_to('{}','UTF8')),'hex') "
     "where root_id='%s' and ga_id='ga_32daa5daf52c4deb8e893c25b08eff38';" % R,
     ['root10_exact_single_ga_preimage_required']),
    ('N18_TERMINATION_EVENT_DRIFT',
     "update clued_control.execution_events set request=jsonb_set(request,'{body,counters_unchanged}','false'::jsonb) "
     "where root_id='%s' and sequence=131;" % R,
     ['root10_exact_single_ga_preimage_required']),
]

for name, mutation, expects in CASES:
    want = ' or '.join("sqlerrm = '%s'" % e for e in expects)
    body = (OFF + mutation + "\n" + ON +
            "do $p$ begin\n"
            "  perform clued_control.reserve_gate($ga$%s$ga$, '%s');\n"
            "  raise notice '%%: UNEXPECTED SUCCESS', '%s';\n"
            "exception when others then\n"
            "  if %s then raise notice '%%: PASS (%%)', '%s', sqlerrm;\n"
            "  else raise notice '%%: FAIL got %%', '%s', sqlerrm; end if;\n"
            "end $p$;\n" % (RAW, SHA, name, want, name, name))
    (OUTD / (name + '.sql')).write_text(body, encoding='utf-8', newline='\n')

runner = "#!/bin/sh\nset -e\n"
for name, _, _ in CASES:
    runner += ("sh /out/reset-and-activate.sh >/dev/null 2>&1\n"
               "psql -h 172.17.0.6 -U postgres -d clued -X -q -A -t -f /out/negatives/%s.sql 2>&1 | "
               "sed 's/^psql:[^ ]* //' | grep -E 'PASS|FAIL|UNEXPECTED'\n" % name)
(OUTD / 'run-c.sh').write_text(runner, encoding='utf-8', newline='\n')
print(json.dumps({'cases': [c[0] for c in CASES]}, indent=1))
