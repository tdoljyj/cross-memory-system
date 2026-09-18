#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,math,sys,unicodedata
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'development/contracts/model-program/m0'
PLAN='a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4'
REQ_TIERS=['mobile','standard','flagship']
REQ_TIER_SET=set(REQ_TIERS)

def err(code): return False,code
def ok(): return True,'PASS'
def fail(msg): print('FAIL: '+msg,file=sys.stderr); raise SystemExit(1)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def canonical(v): return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def object_digest(v): return hashlib.sha256(canonical(v).encode('utf-8')).hexdigest()
def is_hex64(v): return isinstance(v,str) and len(v)==64 and all(c in '0123456789abcdef' for c in v)

def validate_schema(name,v):
    p=BASE/'schemas'/name
    if not p.is_file(): return err('CLUED_MODEL_M0_REQUIRED_BINDING')
    try:
        s=load(p); Draft202012Validator.check_schema(s)
        errors=list(Draft202012Validator(s).iter_errors(v))
    except Exception:
        return err('CLUED_MODEL_M0_SCHEMA_VALIDATION')
    return ok() if not errors else err('CLUED_MODEL_M0_SCHEMA_VALIDATION')

def canonical_task(domain,parts):
    raw=canonical({'domain_separator':domain,'parts':parts})
    raw=unicodedata.normalize('NFC',raw).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()

def validate_experiment_profile(v):
    if v.get('environment')!='NON_PRODUCTION' or v.get('training_allowed') or v.get('real_model_evaluation_allowed') or v.get('production_allowed'):
        return err('CLUED_MODEL_M0_PROFILE_AUTHORITY_EXPANSION')
    b=v.get('budget') or {}; a=(v.get('attempts') or {}).get('max_attempts')
    if not isinstance(b.get('max_wall_seconds'),int) or b['max_wall_seconds']<=0 or not isinstance(b.get('max_compute_bytes'),int) or b['max_compute_bytes']<=0 or b.get('max_cost_microunits')!=0 or not isinstance(a,int) or a<=0 or not v.get('deadline') or not v.get('stop_conditions'):
        return err('CLUED_MODEL_M0_PROFILE_BUDGET_UNBOUNDED')
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
    ids=[u.get('tier_id') for u in units]
    if len(ids)!=3 or set(ids)!=REQ_TIER_SET:
        return err('CLUED_MODEL_M0_REQUIRED_BINDING')
    risks=[u.get('risk_manifest_ref') for u in units if u.get('risk_manifest_ref')]
    if len(risks)!=len(set(risks)): return err('CLUED_MODEL_M0_SHARED_RISK')
    receipts=[x for u in units for x in (u.get('gate_receipt_refs') or [])]
    if len(receipts)!=len(set(receipts)): return err('CLUED_MODEL_M0_CROSS_TIER_RECEIPT_REUSE')
    cs=[u.get('candidate_ref') for u in units if u.get('candidate_ref')]
    rs=[u.get('rc_ref') for u in units if u.get('rc_ref')]
    if len(cs)!=len(set(cs)) or len(rs)!=len(set(rs)): return err('CLUED_MODEL_M0_CROSS_TIER_CANDIDATE_REUSE')
    return ok()

def validate_identity(v):
    if v.get('domain_separator') not in {'clued:model:promotion-task:v1','clued:model:verification-task:v1','clued:model:tier-unit:v1'}:
        return err('CLUED_MODEL_M0_IDENTITY_METHOD')
    if v.get('canonicalization')!='NFC_UTF8_JCS_SHA256': return err('CLUED_MODEL_M0_IDENTITY_METHOD')
    if v.get('task_id')!=canonical_task(v.get('domain_separator'),v.get('parts')): return err('CLUED_MODEL_M0_IDENTITY_METHOD')
    return ok()

def validate_verification_lane(v):
    if v.get('writer')!='M6-V_EVIDENCE_ONLY' or v.get('may_unlock_dependency') is True or any(x not in {'Evidence','VerificationCloseoutReference'} for x in v.get('write_set',[])):
        return err('CLUED_MODEL_M0_VERIFICATION_UNLOCK')
    return ok()

def validate_promotion_action(v):
    if v.get('action_kind') in {'publish','activate','rollback'} and not v.get('promotion_authority_ref'):
        return err('CLUED_MODEL_M0_PROMOTION_AUTHORITY_MISSING')
    return ok()

def validate_projection(v):
    if v.get('creates_decision') or v.get('creates_receipt') or v.get('creates_authority'):
        return err('CLUED_MODEL_M0_PROJECTION_AUTHORITY')
    return ok()

def _gate_registry():
    r=load(BASE/'registries/GateDefinitionRegistry.json')
    return r,{x['gate_id']:x for x in r['gate_definitions']}

def validate_gate_set(v):
    registry,defs=_gate_registry()
    refs=v.get('gate_refs') or []
    if v.get('gate_definition_set_digest')!=registry.get('gate_definition_set_digest'):
        return err('CLUED_MODEL_M0_GATE_DEFINITION_SET_DRIFT')
    if not refs: return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
    seen=set()
    for g in refs:
        if not isinstance(g,dict): return err('CLUED_MODEL_M0_GATE_REF_BARE')
        gid=g.get('gate_id')
        if gid not in defs: return err('CLUED_MODEL_M0_UNKNOWN_GATE')
        if gid in seen: return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
        seen.add(gid); d=defs[gid]
        for k in ('definition_version','content_digest','object_type'):
            if g.get(k)!=d.get(k): return err('CLUED_MODEL_M0_GATE_DEFINITION_DRIFT')
        if g.get('release_action') not in {'rerun','revalidate_attestation','not_required'}:
            return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
        ap=g.get('applicability_proof_digest')
        if ap!='N_A' and not is_hex64(ap): return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
        if not isinstance(g.get('independent_reviewer_ref'),str) or not g['independent_reviewer_ref']:
            return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
        age=g.get('attestation_max_age')
        if age is not None and (not isinstance(age,str) or not age):
            return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
        if not isinstance(g.get('revalidation_input_fields'),list):
            return err('CLUED_MODEL_M0_RELEASE_PROFILE_GATE_BINDING')
    return ok()

def validate_release_profile(v):
    if not v.get('carrier_binding_ref') or not v.get('risk_manifest_ref'):
        return err('CLUED_MODEL_M0_REQUIRED_BINDING')
    return validate_gate_set(v)

def validate_performance_type(v):
    expected={'PERF-B':'TEST_OR_ATTESTATION','PERF-S':'KERNEL_GATE_BOUND_REQUIREMENT','PERF-Q':'TEST_OR_ATTESTATION'}
    return ok() if expected.get(v.get('id'))==v.get('kind') else err('CLUED_MODEL_M0_PERF_TYPE')

def validate_migration(v):
    mode=v.get('mode')
    if mode=='NOT_APPLICABLE_WITH_PROOF':
        proof=v.get('na_proof_digest')
        if not is_hex64(proof): return err('CLUED_MODEL_M0_MIGRATION_APPLICABILITY')
        return ok()
    if mode=='REQUIRED':
        if not all(v.get(k) for k in ('mig_q_ref','mig_p_ref','mig_c_ref')): return err('CLUED_MODEL_M0_MIGRATION_APPLICABILITY')
        return ok()
    if mode=='TO_BE_BOUND': return ok()
    return err('CLUED_MODEL_M0_MIGRATION_APPLICABILITY')

def _exact_tier_map(v):
    return isinstance(v,dict) and set(v)==REQ_TIER_SET and all(isinstance(v[k],str) and v[k] for k in REQ_TIERS) and len(set(v.values()))==3

def validate_signed_manifest(v):
    tiers=v.get('tier_units') or []
    if v.get('all_required_tiers_final_rc') is not True:
        return err('CLUED_MODEL_M0_TIERSET_MANIFEST_PREMATURE')
    if len(tiers)!=3 or set(tiers)!=REQ_TIER_SET:
        return err('CLUED_MODEL_M0_TIERSET_MANIFEST_BINDING')
    if not all(_exact_tier_map(v.get(k)) for k in ('final_rc_refs','profile_refs','risk_refs')) or not v.get('j0_ref'):
        return err('CLUED_MODEL_M0_TIERSET_MANIFEST_BINDING')
    if v.get('authority_effect')!='NONE': return err('CLUED_MODEL_M0_PROJECTION_AUTHORITY')
    return ok()

def validate_tier_set_readiness(v):
    tiers=v.get('required_tier_units') or []
    if len(tiers)!=3 or set(tiers)!=REQ_TIER_SET or not _exact_tier_map(v.get('final_rc_refs')) or not _exact_tier_map(v.get('g7p_refs')):
        return err('CLUED_MODEL_M0_TIERSET_READINESS_BINDING')
    if v.get('all_required_tiers_final_rc') is not True or v.get('all_required_tiers_g7p') is not True or not v.get('signed_tier_set_manifest_ref') or v.get('creates_promotion_authority') is not False:
        return err('CLUED_MODEL_M0_TIERSET_READINESS_BINDING')
    return ok()

def validate_object_authority(v):
    reg=load(BASE/'upstream/ObjectAuthorityRegistry_model_program_v1_20260918.json')
    for row in reg['authorities']:
        if v.get('object_name') in row.get('objects',[]):
            if v.get('owner')!=row.get('owner') or v.get('model_domain_effect')!=row.get('model_domain_effect') or v.get('creates_authority') is not False:
                return err('CLUED_MODEL_M0_OBJECT_AUTHORITY')
            return ok()
    return err('CLUED_MODEL_M0_OBJECT_AUTHORITY')

def validate_m6_review(v):
    if not is_hex64(v.get('fixed_candidate_digest')) or not is_hex64(v.get('closeout_evidence_set_digest')) or not v.get('signature_ref') or v.get('authority_effect')!='NONE':
        return err('CLUED_MODEL_M0_M6_REVIEW_BINDING')
    if v.get('read_only') is not True or v.get('fresh_context') is not True or v.get('reviewer_not_modifier') is not True:
        return err('CLUED_MODEL_M0_M6_REVIEW_BINDING')
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
    if v.get('score_kind')=='CALIBRATED_PROBABILITY' and (not v.get('calibration_ref') or v.get('calibration_status')!='VALID'):
        return err('CLUED_MODEL_M0_CALL_CALIBRATION')
    if v.get('score_kind')=='RAW_SCORE' and v.get('calibration_status')=='NOT_APPLICABLE': return ok()
    return ok()

def validate_source_reuse(v):
    if v.get('reuse_previous_result') and v.get('bound_source_revision')!=v.get('observed_source_revision'):
        return err('CLUED_MODEL_M0_SOURCE_REVISION_DRIFT')
    return ok()

VALIDATORS={
'experiment_profile':validate_experiment_profile,'carrier_decision':validate_carrier_decision,
'carrier_binding':validate_carrier_binding,'rc_schema_authority':validate_rc_schema_authority,
'tier_set':validate_tier_set,'identity':validate_identity,'verification_lane':validate_verification_lane,
'promotion_action':validate_promotion_action,'projection':validate_projection,'gate_set':validate_gate_set,
'release_profile':validate_release_profile,'performance_type':validate_performance_type,'migration':validate_migration,
'signed_manifest':validate_signed_manifest,'tier_set_readiness':validate_tier_set_readiness,
'object_authority':validate_object_authority,'m6_review':validate_m6_review,
'complete_call':validate_complete_call,'source_reuse':validate_source_reuse
}

def run_case(c):
    if c.get('schema'):
        good,code=validate_schema(c['schema'],c['input'])
        if not good: return good,code
    name=c.get('validator')
    if not name: return ok()
    fn=VALIDATORS.get(name)
    if fn is None: return err('CLUED_MODEL_M0_UNKNOWN_VALIDATOR')
    return fn(c['input'])

def expected_manifest_paths():
    paths=set()
    for p in BASE.rglob('*'):
        if p.is_file() and p.name!='SHA256SUMS.json':
            paths.add(p.relative_to(ROOT).as_posix())
    paths.update({
        '.github/workflows/model-program-m0.yml',
        'scripts/model-program/validate_m0_foundation.py',
        'tests/fixtures/model-program-m0/fixtures.json',
        'tests/fixtures/model-program-m0/negative-fixtures.json',
        'tests/test_model_program_m0.py',
    })
    return paths

def _validate_governance_chain(lock):
    rp=BASE/'governance/IndependentPlanReviewReceipt.v1.0.1.json'
    receipt=load(rp)
    if receipt.get('target',{}).get('sha256')!=PLAN or receipt.get('verdict')!='PASS / CLUED_FIRST_PARTY_MODEL_SYSTEM_PLAN_V1_0_1_ACCEPTED':
        fail('independent plan review receipt invalid')
    if receipt.get('review_mode')!=['FRESH_CONTEXT','READ_ONLY','INDEPENDENT','REVIEWER_NOT_MODIFIER'] or receipt.get('reviewer_not_modifier') is not True or receipt.get('candidate_mutation_by_reviewer')!='NONE':
        fail('independent plan review mode invalid')
    f=receipt.get('findings') or {}
    if any(f.get(k)!=0 for k in ('BLOCKER','MAJOR','MINOR','EDITORIAL')) or receipt.get('checks')!={'passed':35,'total':35}:
        fail('independent plan review result incomplete')
    attp=BASE/'governance/PlanReviewAttestation.v1.0.1.json'; att=load(attp)
    if att.get('target',{}).get('sha256')!=PLAN or att.get('verdict')!='PASS' or att.get('independent_review_receipt',{}).get('sha256')!=sha(rp):
        fail('plan review attestation binding invalid')
    adoptp=BASE/'governance/OwnerSuccessorAdoption.v1.0.1.json'; adopt=load(adoptp)
    if adopt.get('target',{}).get('sha256')!=PLAN or adopt.get('status')!='ADOPTED' or adopt.get('plan_review_binding',{}).get('plan_review_attestation_sha256')!=sha(attp) or adopt.get('plan_review_binding',{}).get('independent_review_receipt_sha256')!=sha(rp):
        fail('owner adoption binding invalid')
    rcp=BASE/'governance/CurrentReadinessRecheck.v1.0.1.json'; rc=load(rcp)
    pb=rc.get('prerequisite_binding') or {}
    if rc.get('target',{}).get('sha256')!=PLAN or rc.get('current_readiness')!='PASS' or rc.get('upstream_compatibility')!='PASS' or pb.get('plan_review_attestation_sha256')!=sha(attp) or pb.get('owner_successor_adoption_sha256')!=sha(adoptp):
        fail('current readiness recheck binding invalid')
    ap=BASE/'governance/NonProductionM0Authorization.v1.0.1.json'; a=load(ap); ab=a.get('prerequisite_binding') or {}
    if a.get('target',{}).get('sha256')!=PLAN or a.get('status')!='ISSUED' or ab.get('current_readiness_recheck_sha256')!=sha(rcp) or ab.get('owner_successor_adoption_sha256')!=sha(adoptp) or ab.get('plan_review_attestation_sha256')!=sha(attp) or ab.get('independent_review_receipt_sha256')!=sha(rp):
        fail('M0 authorization prerequisite chain invalid')
    forbidden={'MODEL_DOWNLOAD','TRAINING','REAL_MODEL_EVALUATION','PROMOTION','ACTIVATION','PRODUCTION_DEPLOYMENT','PRODUCTION_TRAFFIC','PRODUCTION_DATABASE_MUTATION','PRODUCTION_SECRET_MUTATION','G1_CUTOVER','MACHINE_RC_SEAL','G7A','G7P'}
    if not forbidden.issubset(set(a.get('explicitly_not_authorized') or [])):
        fail('M0 authorization authority ceiling invalid')

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
    _validate_governance_chain(lock)
    for x in lock['repository_live_bindings']:
        p=ROOT/x['repo_path']
        if not p.is_file() or sha(p)!=x['sha256']: fail('repository live binding drift '+x['id'])

    kr=load(BASE/'upstream/KernelV33Reference.json')
    evidence=ROOT/kr['repository_evidence']['path']
    if not evidence.is_file() or sha(evidence)!=kr['repository_evidence']['sha256']: fail('Kernel v3.3 evidence locator drift')
    if kr['source_sha256'] not in evidence.read_text(encoding='utf-8'): fail('Kernel v3.3 digest absent from source evidence')

    readiness=load(BASE/'upstream/Phase2EntryDevelopmentReadinessDecision_PASS_20260918.json')
    term=readiness['terminal_phase2']
    if readiness['status']!='PASS' or term['result']!='PASS' or term['receipt_revoked'] or term['current_head_revoked'] or term['active_ga_id'] is not None or term['pending_budget_sequence'] is not None:
        fail('pre-M0 receipt/currentness readback failed')
    readback=load(BASE/'evidence/ReadinessSourceLockVerification.json')
    if readback['mismatch_count']!=0 or readback['result']!='PASS_STATIC_READBACK': fail('M0-13 readiness source-lock verification not PASS')
    observed={x['id']:(x['expected_sha256'],x['observed_sha256'],x['result']) for x in readback['verified_typed_inputs']}
    if set(observed)!=set(x['id'] for x in lock['required_typed_inputs']): fail('M0-13 typed input set mismatch')
    for x in lock['required_typed_inputs']:
        if observed[x['id']]!=(x['sha256'],x['sha256'],'MATCH'): fail('M0-13 typed input readback mismatch '+x['id'])

    mapping=load(BASE/'upstream/KernelGateMappingRevision_model_program_v1_20260918.json')
    gates=load(BASE/'registries/GateDefinitionRegistry.json')
    tracep=BASE/'upstream/RequirementTraceRevision_v15.json'; traced=load(tracep)
    if sha(BASE/'upstream/KernelGateMappingRevision_model_program_v1_20260918.json')!=gates['upstream_mapping']['sha256']: fail('gate mapping source drift')
    if sha(tracep)!=gates['requirement_trace']['sha256']: fail('requirement trace drift')
    defs=gates['gate_definitions']
    basis=[{k:d[k] for k in ('gate_id','definition_version','content_digest','object_type')} for d in defs]
    if object_digest(basis)!=gates.get('gate_definition_set_digest'): fail('gate definition set digest drift')
    trace_gate={g['gate_id']:g for g in traced['registered_gates']}
    for d in defs:
        src=trace_gate.get(d['gate_id'])
        if src is None or d['definition_version']!=src['definition_version'] or d['typed_uri']!=src['typed_uri'] or d['content_digest']!=object_digest(src) or d['source_record_sha256']!=object_digest(src):
            fail('gate definition binding drift '+d['gate_id'])
    trace_model={}
    for e in traced['entries']:
        if e['requirement_ref'].startswith('urn:clued:requirement:MODEL-'):
            rid=e['requirement_ref'].split(':')[-1]
            trace_model[rid]={
                'tests':sorted(x.split(':')[-1] for x in e['registered_test_refs']),
                'gates':sorted(x.split(':')[-1] for x in e['registered_gate_refs'])
            }
    rows=mapping['registered_model_requirement_mappings']
    if set(rows)!=set(trace_model): fail('gate mapping requirement set drift')
    for req,row in rows.items():
        if sorted(row.get('tests') or [])!=trace_model[req]['tests'] or sorted(row.get('gates') or [])!=trace_model[req]['gates']:
            fail('gate mapping invalid '+req)

    carrier=load(BASE/'contracts/ModelRcCarrierStrategyReference.json')
    if carrier['status']!='ACCEPTED_BY_v1.0.1_OWNER_ADOPTION_AND_CURRENT_RECHECK' or carrier['mode']!='product_runtime_package_rc' or carrier['authority_owner']!='KERNEL_ONLY' or carrier['selection_rule']!='TOPOLOGY_EVIDENCE_ONLY_NEVER_TIER_NAME':
        fail('carrier strategy not accepted/bound')
    if any(v!='TO_BE_BOUND' for v in carrier['per_tier_exact_binding'].values()): fail('premature per-tier rc binding')

    for t in REQ_TIERS:
        p=BASE/f'release/TierReleaseUnit_{t}.json'; u=load(p)
        good,code=validate_schema('TierReleaseUnit.schema.json',u)
        if not good: fail('tier unit schema invalid '+t+' '+code)
        if u['tier_id']!=t or u['release_eligible'] or u['status']!='FOUNDATION_REGISTERED_NOT_RELEASE_READY': fail('tier unit foundation state invalid '+t)

    schema_names=[
        'ExperimentAuthorizationProfile.schema.json','PerTierCarrierBinding.schema.json','ModelReleaseProfile.schema.json',
        'TierReleaseUnit.schema.json','TierFinalReleaseArtifactInputSet.schema.json','KernelRcCandidateReference.schema.json',
        'KernelRcReference.schema.json','SignedTierSetReleaseManifest.schema.json','TierSetReleaseBOM.schema.json',
        'TierSetPromotionReadinessInput.schema.json','PromotionTaskIdentity.schema.json','VerificationTaskIdentity.schema.json',
        'TierUnitIdentity.schema.json','PromotionActionPlan.schema.json','PromotionTaskInstanceManifest.schema.json',
        'VerificationTaskInstanceManifest.schema.json','VerificationCloseoutReference.schema.json','MigrationApplicability.schema.json',
        'CompleteCall.schema.json','M6CloseoutEvidenceSet.schema.json','IndependentM6Review.schema.json','Projection.schema.json',
        'ObjectAuthorityAssertion.schema.json'
    ]
    for n in schema_names:
        p=BASE/'schemas'/n
        if not p.is_file(): fail('missing schema surface '+n)
        try: Draft202012Validator.check_schema(load(p))
        except Exception: fail('invalid Draft 2020-12 schema surface '+n)

    fx=load(BASE/'identity/TaskIdFixtures.json')['fixtures']
    if len(fx)!=8: fail('task fixture count != 8')
    identity_schema={
        'clued:model:promotion-task:v1':'PromotionTaskIdentity.schema.json',
        'clued:model:verification-task:v1':'VerificationTaskIdentity.schema.json',
        'clued:model:tier-unit:v1':'TierUnitIdentity.schema.json'
    }
    for f in fx:
        n=identity_schema.get(f.get('domain_separator'))
        if not n: fail('task identity unknown domain '+f['fixture_id'])
        good,code=validate_schema(n,{k:f[k] for k in ('domain_separator','parts','canonicalization','task_id')})
        if not good: fail('task identity schema rejected '+f['fixture_id']+' '+code)
        good,code=validate_identity(f)
        if not good: fail('task identity fixture rejected '+f['fixture_id']+' '+code)

    basefx=load(ROOT/'tests/fixtures/model-program-m0/fixtures.json')
    good,code=validate_schema('ExperimentAuthorizationProfile.schema.json',basefx['valid_profile'])
    if not good: fail('fixtures.json valid_profile schema rejected '+code)
    good,code=validate_experiment_profile(basefx['valid_profile'])
    if not good: fail('fixtures.json valid_profile semantic rejected '+code)

    cases=load(ROOT/'tests/fixtures/model-program-m0/negative-fixtures.json')
    for c in cases['negative_cases']:
        good,code=run_case(c)
        if good or code!=c['expected_error']: fail('negative fixture not deterministically rejected '+c['id']+' got='+code)
    for c in cases['positive_cases']:
        good,code=run_case(c)
        if not good: fail('positive fixture rejected '+c['id']+' got='+code)

    m6=load(BASE/'contracts/M6P06DependencyRelease.contract.json')
    if m6['writer']!='M6-P06_ONLY' or m6['verification_lane_may_release'] is not False: fail('M6-P/M6-V separation invalid')

    manifest=load(BASE/'SHA256SUMS.json')
    if not manifest.get('manifest_self_excluded_by_design'): fail('manifest self-exclusion not explicit')
    listed=[e['path'] for e in manifest['files']]
    if len(listed)!=len(set(listed)) or set(listed)!=expected_manifest_paths():
        fail('CLUED_MODEL_M0_MANIFEST_COVERAGE')
    for e in manifest['files']:
        p=ROOT/e['path']
        if not p.is_file() or sha(p)!=e['sha256'] or p.stat().st_size!=e['bytes']:
            fail('candidate manifest mismatch '+e['path'])

    print('PASS: MODEL-PROGRAM-M0 targeted-repair successor validator; exact gates, Draft 2020-12 schemas, authority/tier-set bindings, closed-world manifest, and all qualification fixtures verified; independent fresh-context M0 review still required')
    return 0

if __name__=='__main__': raise SystemExit(main())
