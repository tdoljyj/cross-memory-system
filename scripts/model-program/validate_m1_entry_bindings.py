#!/usr/bin/env python3
from __future__ import annotations
import json,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'development/contracts/model-program/m1'
PLAN='a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4'
QWEN_REV='2fc06364715b967f1860aea9cf38778875588b17'
LLAMA_REV='bdcbaaf6e7520b68c8c60ff724c67409970d70e1'
REQ_ROLES={
'Mobile-class Local Reference','Personal-device Local Reference','Strong Hosted / Enterprise Reference',
'Reproducible From-scratch Reference','Embedding Reference','Reranker Reference','Guard / Classifier Reference'
}

def load(p): return json.loads(p.read_text(encoding='utf-8'))
def fail(msg): print('FAIL: '+msg,file=sys.stderr); raise SystemExit(1)

def has_tbb(v):
    if isinstance(v,str): return 'TO_BE_BOUND' in v
    if isinstance(v,list): return any(has_tbb(x) for x in v)
    if isinstance(v,dict): return any(has_tbb(x) for x in v.values())
    return False

def validate_profile(p):
    if p.get('model_binding',{}).get('model_id')!='Qwen/Qwen3.5-0.8B' or p.get('model_binding',{}).get('revision')!=QWEN_REV:
        return False,'CLUED_MODEL_M1_PROFILE_MODEL_BINDING'
    if p.get('runtime_binding',{}).get('revision')!=LLAMA_REV:
        return False,'CLUED_MODEL_M1_PROFILE_RUNTIME_BINDING'
    forbidden=set(p.get('prohibited_operations') or [])
    required={'MODEL_INFERENCE','REAL_MODEL_EVALUATION','TRAINING','DISTILLATION','PROMOTION','ACTIVATION','PRODUCTION_DEPLOYMENT','SEMANTIC_RECALL_RELEASE'}
    if not required.issubset(forbidden):
        return False,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION'
    pending=has_tbb(p)
    if pending and (p.get('status')=='ISSUED' or p.get('effectful_authority_issued') is True):
        return False,'CLUED_MODEL_M1_PROFILE_PENDING_BINDING_ISSUED'
    if p.get('status')!='BLOCKED_PENDING_EXACT_PHYSICAL_DEVICE_READBACK_AND_FINAL_ISSUANCE':
        return False,'CLUED_MODEL_M1_PROFILE_STATUS'
    if p.get('effectful_authority_issued') is not False or p.get('authority_effect')!='NONE':
        return False,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION'
    return True,'PASS'

def main():
    stage=load(BASE/'governance/M1StageEntryAuthorization.v1.0.1.json')
    if stage.get('bound_plan',{}).get('sha256')!=PLAN:
        fail('M1 stage plan binding drift')
    matrix=load(BASE/'registries/DeviceRuntimeMatrix.v1.0.1.json')
    runtimes={x['runtime_id']:x for x in matrix['runtime_candidates']}
    if runtimes.get('llama.cpp',{}).get('revision')!=LLAMA_REV or runtimes['llama.cpp'].get('license')!='MIT':
        fail('first runtime binding drift')
    devices={x['device_id']:x for x in matrix['physical_device_profiles']}
    if devices.get('DEV-PERSONAL-WINDOWS-01',{}).get('binding_state')!='TO_BE_BOUND_BY_OWNER_CONTROLLED_HOST_READBACK':
        fail('device fail-closed binding drift')
    shortlist=load(BASE/'registries/ReferenceModelShortlist.v1.0.1.json')
    roles={x['role'] for x in shortlist['roles']}
    if roles!=REQ_ROLES:
        fail('reference role coverage drift')
    first=shortlist.get('first_tranche') or {}
    if first.get('model_id')!='Qwen/Qwen3.5-0.8B' or first.get('revision')!=QWEN_REV or first.get('runtime_id')!='llama.cpp':
        fail('first tranche drift')
    lr=load(BASE/'evidence/LicenseTermsCompatibilityReview.v1.0.1.json')
    reviewed={x['id']:x for x in lr['model_reviews']}
    for mid in ['Qwen/Qwen3.5-0.8B','Qwen/Qwen3.5-4B','allenai/OLMo-2-0425-1B','Qwen/Qwen3-Embedding-0.6B','Qwen/Qwen3-Reranker-0.6B','Qwen/Qwen3Guard-Gen-0.6B']:
        if mid not in reviewed or not reviewed[mid].get('license'):
            fail('missing license screen '+mid)
    if reviewed['Strong Hosted / Enterprise Reference']['internal_m1_reference']!='BLOCKED_PENDING_PROVIDER_TERMS_DATA_RETENTION_BENCHMARK_AND_MODEL_DEVELOPMENT_USE_REVIEW':
        fail('hosted reference terms must remain blocked')
    p=load(BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.candidate.json')
    good,code=validate_profile(p)
    if not good: fail(code)
    print('PASS: MODEL-PROGRAM-M1 entry bindings; M1-00/01/02 artifacts registered and first experiment profile remains fail-closed pending exact physical-device readback and final issuance')
    return 0

if __name__=='__main__': raise SystemExit(main())
