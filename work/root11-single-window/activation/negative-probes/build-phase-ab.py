# 生成第 11 代 reserve_gate 的负向探针 SQL。
# A 组：只改 GA 输入，不动库，可以连着跑。
# B 组：要改库里的历史，每条跑完都得重置复制品。
import json, hashlib, pathlib, collections, copy

LIVE = pathlib.Path(r'C:/Users/17531/root10-snapshot-20260916/gen11-live')
OUTD = pathlib.Path(r'C:/Users/17531/root10-snapshot-20260916/negatives')
OUTD.mkdir(parents=True, exist_ok=True)

sha = lambda b: hashlib.sha256(b).hexdigest()
compact = lambda v: json.dumps(v, separators=(',', ':'), ensure_ascii=False) + '\n'
ga0 = json.loads((LIVE / 'Root11GateAuthorization.json').read_text(encoding='utf-8'),
                 object_pairs_hook=collections.OrderedDict)


def call(ga, label):
    raw = compact(ga)
    assert '$ga$' not in raw
    return "select '%s' as probe, clued_control.reserve_gate($ga$%s$ga$, '%s');\n" % (label, raw, sha(raw.encode()))


def probe(name, ga, expect):
    """跑一次调用，捕获异常并把实际错误码打出来。"""
    raw = compact(ga)
    return ("do $p$ begin\n"
            "  perform clued_control.reserve_gate($ga$%s$ga$, '%s');\n"
            "  raise notice '%%: UNEXPECTED SUCCESS (expected %%)', '%s', '%s';\n"
            "exception when others then\n"
            "  if sqlerrm = '%s' then raise notice '%%: PASS (%%)', '%s', sqlerrm;\n"
            "  else raise notice '%%: FAIL got %%, expected %%', '%s', sqlerrm, '%s'; end if;\n"
            "end $p$;\n" % (raw, sha(raw.encode()), name, expect, expect, name, name, expect))


A = []

# N03 仓促修复引用非空
g = copy.deepcopy(ga0)
g['revocation_epoch_vector'] = dict(g['revocation_epoch_vector'], repair_refs=[{'ga_id': 'ga_x'}]) \
    if isinstance(g.get('revocation_epoch_vector'), dict) else {'repair_refs': [{'ga_id': 'ga_x'}]}
A.append(('N03_NONEMPTY_REPAIR_REFS', g, 'root10_exact_accepted_scope_or_zero_repairs_required'))

# N04 固定字段漂移：逐个改，取其中四个代表
for key, err in (('controller_digest', 'root10_exact_accepted_scope_or_zero_repairs_required'),
                 ('scope_digest', 'root10_exact_accepted_scope_or_zero_repairs_required'),
                 ('schema_digest', 'root10_complete_fixed_and_late_bound_ga_contract_required'),
                 ('issuer_ref', 'root10_complete_fixed_and_late_bound_ga_contract_required')):
    g = copy.deepcopy(ga0)
    g[key] = ('f' * 64) if isinstance(g[key], str) else {'drifted': True}
    A.append(('N04_FIXED_DRIFT_' + key, g, err))

# N05 Status 引用指向别的代次
g = copy.deepcopy(ga0)
g['status_manifest_ref'] = dict(g['status_manifest_ref'],
                                uri='control://status-manifests/sm_root10_single_window_20260915')
A.append(('N05_STATUS_WRONG_GENERATION', g, 'exact_stored_status_manifest_required'))

# N19 Status 引用指向被取代的那一份（generation 30，仍不可变地存在库里）
g = copy.deepcopy(ga0)
g['status_manifest_ref'] = {'uri': 'control://status-manifests/sm_root11_single_window_20260916',
                            'sha256': hashlib.sha256(
                                pathlib.Path(r'C:/Users/17531/root10-snapshot-20260916/gen11-live/Root11SignedStatus.json')
                                .read_bytes()).hexdigest()}
A.append(('N19_SUPERSEDED_STATUS_GENERATION_30', g, 'exact_stored_status_manifest_required'))

# N06 预算引用指向别的序号
g = copy.deepcopy(ga0)
g['budget_reservation_ref'] = dict(
    g['budget_reservation_ref'],
    uri='urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:117')
A.append(('N06_BUDGET_WRONG_SEQUENCE', g, 'root11_exact_prior_committed_budget_required'))

# N07 窗口不是精确 600 秒
import datetime
for delta, label in ((599, 'N07_599_SECONDS'), (601, 'N07_601_SECONDS')):
    g = copy.deepcopy(ga0)
    issued = datetime.datetime.fromisoformat(g['issued_at'].replace('Z', '+00:00'))
    end = issued + datetime.timedelta(seconds=delta)
    stamp = end.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (end.microsecond // 1000)
    g['expires_at'] = stamp
    g['deadline'] = stamp
    A.append((label, g, 'root10_exact_600_second_ga_window_required'))

# N14 51 字段集合：少一个 / 多一个
g = copy.deepcopy(ga0)
del g['dominant_role']
A.append(('N14_MISSING_FIELD', g, 'root10_complete_fixed_and_late_bound_ga_contract_required'))
g = copy.deepcopy(ga0)
g['extra_field'] = 'x'
A.append(('N14_EXTRA_FIELD', g, 'root10_complete_fixed_and_late_bound_ga_contract_required'))

# N04b target_revision 不是 40 hex
g = copy.deepcopy(ga0)
g['target_revision'] = 'not-a-commit'
A.append(('N14_BAD_TARGET_REVISION', g, 'root10_complete_fixed_and_late_bound_ga_contract_required'))

body = ''.join(probe(n, g, e) for n, g, e in A)
(OUTD / 'phase-a.sql').write_text(body, encoding='utf-8', newline='\n')

# ---- B 组：先成功签发，再测重放与第二个 GA ----
good = call(ga0, 'GOOD')
g = copy.deepcopy(ga0)
g['signature'] = g['signature'] + '#drift'
n01 = probe('N01_CHANGED_BYTES_SAME_IDEMPOTENCY', g, 'idempotency_conflict')
g2 = copy.deepcopy(ga0)
g2['gate_authorization_id'] = 'ga_' + 'e' * 32
g2['idempotency_key'] = 'root11_single_window_ga_second'
g2['signature'] = 'urn:clued:gate-authorization:uscrdifznmlvczcekqpw:ga_' + 'e' * 32 + '#signature'
n02 = probe('N02_SECOND_GA', g2, 'root10_exact_single_ga_preimage_required')
replay = ("do $p$ declare r jsonb; begin\n"
          "  r := clued_control.reserve_gate($ga$%s$ga$, '%s');\n"
          "  if r->>'status' = 'DUPLICATE' then raise notice 'N10_EXACT_REPLAY: PASS (DUPLICATE)';\n"
          "  else raise notice 'N10_EXACT_REPLAY: FAIL got %%', r->>'status'; end if;\n"
          "end $p$;\n" % (compact(ga0), sha(compact(ga0).encode())))
(OUTD / 'phase-b.sql').write_text(good + n01 + n02 + replay, encoding='utf-8', newline='\n')

print(json.dumps({'phase_a_probes': len(A), 'phase_b_probes': 3, 'dir': str(OUTD)}, indent=1))
