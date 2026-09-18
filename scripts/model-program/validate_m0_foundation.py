#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,sys,unicodedata
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'development/contracts/model-program/m0'
PLAN='a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4'
def fail(x): print('FAIL: '+x,file=sys.stderr); raise SystemExit(1)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def task_id(domain,parts):
    raw=json.dumps({'domain_separator':domain,'parts':parts},ensure_ascii=False,sort_keys=True,separators=(',',':'))
    return hashlib.sha256(unicodedata.normalize('NFC',raw).encode()).hexdigest()
def main():
    for n in ['ModelProgramM0.contract-pack.json','model-program-source-lock.json','M0Closeout.json','SHA256SUMS.json']:
        if not (BASE/n).is_file(): fail('missing '+n)
    pack=load(BASE/'ModelProgramM0.contract-pack.json'); lock=load(BASE/'model-program-source-lock.json')
    if pack['plan']['sha256']!=PLAN or lock['plan']['sha256']!=PLAN: fail('plan mismatch')
    for k,r in lock['repository_live_bindings'].items():
        p=ROOT/r['path']
        if not p.is_file() or sha(p)!=r['sha256']: fail('live binding drift: '+k)
    for n,d in lock['governance_records'].items():
        p=BASE/'governance'/n
        if not p.is_file() or sha(p)!=d: fail('governance record drift: '+n)
    a=load(BASE/'governance/NonProductionM0Authorization.v1.0.1.json')
    forbidden={'TRAINING','REAL_MODEL_EVALUATION','PROMOTION','ACTIVATION','PRODUCTION_DEPLOYMENT','PRODUCTION_TRAFFIC','PRODUCTION_DATABASE_MUTATION','PRODUCTION_SECRET_MUTATION','MACHINE_RC_SEAL','G7A','G7P'}
    if a['status']!='ISSUED' or not forbidden.issubset(set(a['explicitly_not_authorized'])): fail('authority expansion')
    c=pack['carrier']
    if c['strategy_status']!='ACCEPTED' or c['authority_owner']!='KERNEL_ONLY' or c['selection_policy']['tier_name_may_select_rc_type'] is not False: fail('carrier invalid')
    for t in ['mobile','standard','flagship']:
        if c['per_tier_exact_binding'][t]!={'rc_type':None,'status':'TO_BE_BOUND'}: fail('premature exact rc binding '+t)
    tr=pack['tier_release']['rules']
    if tr['profile_to_current_signed_risk_manifest_cardinality']!=1 or tr['signed_tier_set_manifest_creates_authority'] is not False: fail('tier composition invalid')
    if pack['gates']['gate_engine_owner']!='KERNEL_ONLY' or pack['gates']['model_gate_registry_is_second_gate_engine'] is not False: fail('second gate engine')
    if pack['complete_binding']['verification_lane']['write_set']!='EVIDENCE_ONLY' or pack['complete_binding']['verification_lane']['may_unlock_dependency'] is not False: fail('verification authority leak')
    if pack['storage_responsibility']['repository']['canonical_store'] is not False or pack['storage_responsibility']['memory_directory']['model_development_status_write']!='FORBIDDEN': fail('storage boundary')
    fs=pack['identity']['fixtures']
    if len(fs)!=8: fail('task fixture count')
    for f in fs:
        if task_id(f['domain_separator'],f['parts'])!=f['expected_sha256']: fail('task fixture digest '+f['fixture_id'])
    x=load(ROOT/'tests/fixtures/model-program-m0/fixtures.json')
    v=x['valid_profile']
    if v['environment']!='NON_PRODUCTION' or v['training_allowed'] or v['real_model_evaluation_allowed'] or v['production_allowed'] or v['budget']['max_wall_seconds']<=0: fail('valid profile invalid')
    if x['negative_unbounded_budget']['max_wall_seconds']>0: fail('budget negative malformed')
    if not x['negative_production_authority']['production_allowed']: fail('production negative malformed')
    if x['negative_tier_implies_rc']['selection_basis']!='TIER_NAME_ONLY': fail('tier rc negative malformed')
    r=x['negative_cross_tier_risk_reuse']
    if len(set(r.values()))==3: fail('cross-tier risk negative malformed')
    if 'DependencyUnlock' not in x['negative_verification_unlock']['writes']: fail('verification negative malformed')
    cc=pack['complete_binding']['call_contract']
    if 'MAYBE' in cc['allowed_labels'] or cc['value_range']!=[0,1] or cc['abstain_maps_to_default_business_value'] is not False or cc['missing_evidence_creates_authority'] is not False or cc['source_revision_change_invalidates_dependent_result'] is not True: fail('complete-call fail-closed rules')
    if x['negative_illegal_number']['value']<=1 or x['negative_missing_evidence']['evidence_refs'] or x['negative_calibration_missing']['calibration']!='MISSING': fail('call negative malformed')
    if x['positive_abstain'].get('value') is not None or x['positive_raw_score_not_applicable']['calibration']!='NOT_APPLICABLE_DECLARED_RAW_SCORE': fail('positive call fixture malformed')
    if not x['negative_route_budget_terminal']['attempt_route_again'] or x['negative_route_budget_terminal']['remaining_hops']!=0: fail('route terminal negative malformed')
    if x['negative_source_revision_drift']['bound_source_revision']==x['negative_source_revision_drift']['observed_source_revision']: fail('source drift negative malformed')
    manifest=load(BASE/'SHA256SUMS.json')
    for e in manifest['files']:
        p=ROOT/e['path']
        if not p.is_file() or sha(p)!=e['sha256']: fail('manifest mismatch '+e['path'])
    print('PASS: MODEL-PROGRAM-M0 static implementation candidate; independent qualification still required')
    return 0
if __name__=='__main__': raise SystemExit(main())
