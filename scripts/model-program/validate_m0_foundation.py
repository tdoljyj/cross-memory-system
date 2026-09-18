#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,math,sys,unicodedata
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'development/contracts/model-program/m0'
PLAN='a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4'
REQ_TIERS=['mobile','standard','flagship']
def err(code): return False,code
def ok(): return True,'PASS'
def fail(msg): print('FAIL: '+msg,file=sys.stderr); raise SystemExit(1)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def canonical_task(domain,parts):
    raw=json.dumps({'domain_separator':domain,'parts':parts},ensure_ascii=False,sort_keys=True,separators=(',',':'))
    raw=unicodedata.normalize('NFC',raw).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()
def validate_experiment_profile(v):
    if v.get('environment')!='NON_PRODUCTION' or v.get('training_allowed') or v.get('real_model_evaluation_allowed') or v.get('production_allowed'): return err('CLUED_MODEL_M0_PROFILE_AUTHORITY_EXPANSION')
    b=v.get('budget') or {}; a=(v.get('attempts') or {}).get('max_attempts')
    if not isinstance(b.get('max_wall_seconds'),int) or b['max_wall_seconds']<=0 or not isinstance(b.get('max_compute_bytes'),int) or b['max_compute_bytes']<=0 or b.get('max_cost_microunits')!=0 or not isinstance(a,int) or a<=0 or not v.get('deadline') or not v.get('stop_conditions'): return err('CLUED_MODEL_M0_PROFILE_BUDGET_UNBOUNDED')
    return ok()
def validate_carrier_decision(v):
    return ok() if v.get('status')=='ACCEPTED' else err('CLUED_MODEL_M0_CARRIER_UNACCEPTED')
def validate_carrier_binding(v):
    if v.get('selection_basis')=='TIER_NAME_ONLY': return err('CLUED_MODEL_M0_TIER_NAME_RC_INFERENCE')
    return ok()
def validate_rc_schema_authority(v):
    return ok() if v.get('authority_owner')=='KERNEL_ONLY' else err('CLUED_MODEL_M0_PARALLEL_RC_SCHEMA')
def validate_tier_set(v):
    units=v.get('units') or []
    if sorted([u.get('tier_id') for u in units])!=sorted(REQ_TIERS): return err('CLUED_MODEL_M0_REQUIRED_BINDING')
    risks=[u.get('risk_manifest_ref') for u in units if u.get('risk_manifest_ref')]
    if len(risks)!=len(set(risks)): return err('CLUED_MODEL_M0_SHARED_RISK')
    receipts=[x for u in units for x in (u.get('gate_receipt_refs') or [])]
    if len(receipts)!=len(set(receipts)): return err('CLUED_MODEL_M0_CROSS_TIER_RECEIPT_REUSE')
    cs=[u.get('candidate_ref') for u in units if u.get('candidate_ref')]
    rs=[u.get('rc_ref') for u in units if u.get('rc_ref')]
    if len(cs)!=len(set(cs)) or len(rs)!=len(set(rs)): return err('CLUED_MODEL_M0_CROSS_TIER_CANDIDATE_REUSE')
    return ok()
def validate_identity(v):
    if v.get('canonicalization')!='NFC_UTF8_JCS_SHA256': return err('CLUED_MODEL_M0_IDENTITY_METHOD')
    if v.get('task_id')!=canonical_task(v.get('domain_separator'),v.get('parts')): return err('CLUED_MODEL_M0_IDENTITY_METHOD')
    return ok()
def validate_verification_lane(v):
    if v.get('writer')!='M6-V_EVIDENCE_ONLY' or v.get('may_unlock_dependency') is True or any(x not in {'Evidence','VerificationCloseoutReference'} for x in v.get('write_set',[])): return err('CLUED_MODEL_M0_VERIFICATION_UNLOCK')
    return ok()
def validate_promotion_action(v):
    if v.get('action_kind') in {'publish','activate'} and not v.get('promotion_authority_ref'): return err('CLUED_MODEL_M0_PROMOTION_AUTHORITY_MISSING')
    return ok()
def validate_projection(v):
    if v.get('creates_decision') or v.get('creates_receipt') or v.get('creates_authority'): return err('CLUED_MODEL_M0_PROJECTION_AUTHORITY')
    return ok()
def validate_complete_call(v):
    rb=v.get('route_budget') or {}
    if v.get('attempt_route_again') and rb.get('remaining_calls')==0: return err('CLUED_MODEL_M0_ROUTE_BUDGET_TERMINAL')
    st=v.get('status')
    if st not in {'PREDICTED','ABSTAINED','INVALID','TIMEOUT','UNAVAILABLE','BUDGET_EXHAUSTED'}: return err('CLUED_MODEL_M0_CALL_LABEL')
    if st=='ABSTAINED':
        if v.get('value') is not None: return err('CLUED_MODEL_M0_CALL_ABSTAIN_DEFAULT')
        if not v.get('abstain_reason'): return err('CLUED_MODEL_M0_CALL_LABEL')
        return ok()
    value=v.get('value')
    if isinstance(value,dict):
        if value.get('label') not in {'SUPPORTED','UNSUPPORTED','UNKNOWN'}: return err('CLUED_MODEL_M0_CALL_LABEL')
        p=value.get('probability')
        if not isinstance(p,(int,float)) or isinstance(p,bool) or not math.isfinite(p) or not 0<=p<=1: return err('CLUED_MODEL_M0_CALL_NUMBER')
    elif v.get('score_kind') in {'MODEL_PROBABILITY','CALIBRATED_PROBABILITY'}:
        if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or not 0<=value<=1: return err('CLUED_MODEL_M0_CALL_NUMBER')
    if v.get('evidence_required') and not v.get('evidence_refs'): return err('CLUED_MODEL_M0_CALL_EVIDENCE')
    if v.get('score_kind')=='CALIBRATED_PROBABILITY' and (not v.get('calibration_ref') or v.get('calibration_status')!='VALID'): return err('CLUED_MODEL_M0_CALL_CALIBRATION')
    if v.get('score_kind')=='RAW_SCORE' and v.get('calibration_status')=='NOT_APPLICABLE': return ok()
    return ok()
def validate_source_reuse(v):
    if v.get('reuse_previous_result') and v.get('bound_source_revision')!=v.get('observed_source_revision'): return err('CLUED_MODEL_M0_SOURCE_REVISION_DRIFT')
    return ok()
VALIDATORS={'experiment_profile':validate_experiment_profile,'carrier_decision':validate_carrier_decision,'carrier_binding':validate_carrier_binding,'rc_schema_authority':validate_rc_schema_authority,'tier_set':validate_tier_set,'identity':validate_identity,'verification_lane':validate_verification_lane,'promotion_action':validate_promotion_action,'projection':validate_projection,'complete_call':validate_complete_call,'source_reuse':validate_source_reuse}
def main():
    required=['ModelProgramCharter.json','MODEL-SOURCE-POLICY.json','model-program-source-lock.json','ModelProgramM0.contract-pack.json','KnownSupersededInputRegister.json','StorageStatusResponsibilityRegistration.json','ResponsibilityTransferVerification.json','M0Closeout.json','SHA256SUMS.json']
    for n in required:
        if not (BASE/n).is_file(): fail('missing required artifact '+n)
    lock=load(BASE/'model-program-source-lock.json')
    if lock['plan']['sha256']!=PLAN: fail('plan source lock mismatch')
    for x in lock['required_typed_inputs']:
        p=BASE/x['path']
        if not p.is_file(): fail('missing typed input '+x['id'])
        if sha(p)!=x['sha256']: fail('typed input digest mismatch '+x['id'])
    for x in lock['governance_records']:
        p=BASE/x['path']
        if not p.is_file() or sha(p)!=x['sha256']: fail('governance binding mismatch '+x['path'])
    for x in lock['repository_live_bindings']:
        p=ROOT/x['repo_path']
        if not p.is_file() or sha(p)!=x['sha256']: fail('repository live binding drift '+x['id'])
    kr=load(BASE/'upstream/KernelV33Reference.json')
    evidence=ROOT/kr['repository_evidence']['path']
    if not evidence.is_file() or sha(evidence)!=kr['repository_evidence']['sha256']: fail('Kernel v3.3 evidence locator drift')
    if kr['source_sha256'] not in evidence.read_text(encoding='utf-8'): fail('Kernel v3.3 digest absent from source evidence')
    readiness=load(BASE/'upstream/Phase2EntryDevelopmentReadinessDecision_PASS_20260918.json')
    term=readiness['terminal_phase2']
    if readiness['status']!='PASS' or term['result']!='PASS' or term['receipt_revoked'] or term['current_head_revoked'] or term['active_ga_id'] is not None or term['pending_budget_sequence'] is not None: fail('pre-M0 receipt/currentness readback failed')
    readback=load(BASE/'evidence/ReadinessSourceLockVerification.json')
    if readback['mismatch_count']!=0 or readback['result']!='PASS_STATIC_READBACK': fail('M0-13 readiness source-lock verification not PASS')
    mapping=load(BASE/'upstream/KernelGateMappingRevision_model_program_v1_20260918.json')
    gates=load(BASE/'registries/GateDefinitionRegistry.json')
    allowed=set(gates['atomic_gate_ids'])
    if sha(BASE/'upstream/KernelGateMappingRevision_model_program_v1_20260918.json')!=gates['upstream_mapping']['sha256']: fail('gate mapping source drift')
    trace=BASE/'upstream/RequirementTraceRevision_v15.json'
    if sha(trace)!=gates['requirement_trace']['sha256']: fail('requirement trace drift')
    for req,row in mapping['registered_model_requirement_mappings'].items():
        if not row.get('tests') or not row.get('gates') or any(g not in allowed for g in row['gates']): fail('gate mapping invalid '+req)
    carrier=load(BASE/'contracts/ModelRcCarrierStrategyReference.json')
    if carrier['status']!='ACCEPTED_BY_v1.0.1_OWNER_ADOPTION_AND_CURRENT_RECHECK' or carrier['mode']!='product_runtime_package_rc' or carrier['authority_owner']!='KERNEL_ONLY' or carrier['selection_rule']!='TOPOLOGY_EVIDENCE_ONLY_NEVER_TIER_NAME': fail('carrier strategy not accepted/bound')
    if any(v!='TO_BE_BOUND' for v in carrier['per_tier_exact_binding'].values()): fail('premature per-tier rc binding')
    # Three foundation Tier units must be independent and not release-ready.
    units=[]
    for t in REQ_TIERS:
        u=load(BASE/f'release/TierReleaseUnit_{t}.json')
        if u['tier_id']!=t or u['release_eligible'] or u['status']!='FOUNDATION_REGISTERED_NOT_RELEASE_READY': fail('tier unit foundation state invalid '+t)
        units.append(u)
    # Task fixtures are actively validated.
    fx=load(BASE/'identity/TaskIdFixtures.json')['fixtures']
    if len(fx)!=8: fail('task fixture count != 8')
    for f in fx:
        good,code=validate_identity(f)
        if not good: fail('task identity fixture rejected '+f['fixture_id']+' '+code)
    # Static fixture harness must reject all negatives with exact error and accept all positives.
    cases=load(ROOT/'tests/fixtures/model-program-m0/negative-fixtures.json')
    for c in cases['negative_cases']:
        fn=VALIDATORS[c['validator']]
        good,code=fn(c['input'])
        if good or code!=c['expected_error']: fail('negative fixture not deterministically rejected '+c['id']+' got='+code)
    for c in cases['positive_cases']:
        fn=VALIDATORS[c['validator']]
        good,code=fn(c['input'])
        if not good: fail('positive fixture rejected '+c['id']+' got='+code)
    # Schema surfaces required by M0-04/06/10/11/14 must exist and be machine-readable.
    schema_names=['ExperimentAuthorizationProfile.schema.json','PerTierCarrierBinding.schema.json','ModelReleaseProfile.schema.json','TierReleaseUnit.schema.json','TierFinalReleaseArtifactInputSet.schema.json','KernelRcCandidateReference.schema.json','KernelRcReference.schema.json','SignedTierSetReleaseManifest.schema.json','TierSetReleaseBOM.schema.json','TierSetPromotionReadinessInput.schema.json','PromotionTaskIdentity.schema.json','VerificationTaskIdentity.schema.json','TierUnitIdentity.schema.json','PromotionActionPlan.schema.json','PromotionTaskInstanceManifest.schema.json','VerificationTaskInstanceManifest.schema.json','VerificationCloseoutReference.schema.json','MigrationApplicability.schema.json','CompleteCall.schema.json','M6CloseoutEvidenceSet.schema.json','IndependentM6Review.schema.json','Projection.schema.json']
    for n in schema_names:
        s=load(BASE/'schemas'/n)
        if s.get('$schema')!='https://json-schema.org/draft/2020-12/schema' or s.get('type')!='object' or not s.get('required'): fail('invalid schema surface '+n)
    # ModelReleaseProfile schema must make gate refs/digest mandatory.
    mrp=load(BASE/'schemas/ModelReleaseProfile.schema.json')
    if not {'gate_refs','gate_definition_set_digest'}.issubset(set(mrp['required'])): fail('release profile gate binding not mandatory')
    # Verification lane is evidence-only and only M6-P06 can release dependency.
    m6=load(BASE/'contracts/M6P06DependencyRelease.contract.json')
    if m6['writer']!='M6-P06_ONLY' or m6['verification_lane_may_release'] is not False: fail('M6-P/M6-V separation invalid')
    # Complete manifest covers implementation surface (self excluded by design).
    manifest=load(BASE/'SHA256SUMS.json')
    if not manifest.get('manifest_self_excluded_by_design'): fail('manifest self-exclusion not explicit')
    for e in manifest['files']:
        p=ROOT/e['path']
        if not p.is_file() or sha(p)!=e['sha256'] or p.stat().st_size!=e['bytes']: fail('candidate manifest mismatch '+e['path'])
    print('PASS: MODEL-PROGRAM-M0 targeted-repair static validator; all negative fixtures rejected; independent fresh-context review still required')
    return 0
if __name__=='__main__': raise SystemExit(main())
