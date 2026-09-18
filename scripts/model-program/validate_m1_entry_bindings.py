#!/usr/bin/env python3
from __future__ import annotations
import json,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'development/contracts/model-program/m1'
PLAN='a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4'
QWEN_REV='2fc06364715b967f1860aea9cf38778875588b17'
LLAMA_REV='bdcbaaf6e7520b68c8c60ff724c67409970d70e1'
DOWNLOAD_CODE_COMMIT='a7307dd78997ca5a6e6ef2a8f53811a3058e37ef'
DOWNLOAD_SCRIPT_BLOB='086849744f4d66eeee49a8dea59c676d6582757d'
REQ_ROLES={
'Mobile-class Local Reference','Personal-device Local Reference','Strong Hosted / Enterprise Reference',
'Reproducible From-scratch Reference','Embedding Reference','Reranker Reference','Guard / Classifier Reference'
}
BASE_REQ_PROHIBITED={
'MODEL_INFERENCE','REAL_MODEL_EVALUATION','TRAINING','DISTILLATION',
'PROMOTION','ACTIVATION','PRODUCTION_DEPLOYMENT','SEMANTIC_RECALL_RELEASE'
}
ISSUED_REQ_PROHIBITED=BASE_REQ_PROHIBITED|{'MODEL_LOAD'}

def load(p): return json.loads(p.read_text(encoding='utf-8'))
def fail(msg): print('FAIL: '+msg,file=sys.stderr); raise SystemExit(1)

def has_tbb(v):
    if isinstance(v,str): return 'TO_BE_BOUND' in v
    if isinstance(v,list): return any(has_tbb(x) for x in v)
    if isinstance(v,dict): return any(has_tbb(x) for x in v.values())
    return False

def common_profile_checks(p,required_prohibited):
    if p.get('model_binding',{}).get('model_id')!='Qwen/Qwen3.5-0.8B' or p.get('model_binding',{}).get('revision')!=QWEN_REV:
        return False,'CLUED_MODEL_M1_PROFILE_MODEL_BINDING'
    if p.get('runtime_binding',{}).get('revision')!=LLAMA_REV:
        return False,'CLUED_MODEL_M1_PROFILE_RUNTIME_BINDING'
    forbidden=set(p.get('prohibited_operations') or [])
    if not required_prohibited.issubset(forbidden):
        return False,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION'
    return True,'PASS'

def validate_candidate_profile(p):
    good,code=common_profile_checks(p,BASE_REQ_PROHIBITED)
    if not good: return good,code
    if has_tbb(p) and (p.get('status')=='ISSUED' or p.get('effectful_authority_issued') is True):
        return False,'CLUED_MODEL_M1_PROFILE_PENDING_BINDING_ISSUED'
    if p.get('status')!='BLOCKED_PENDING_EXACT_PHYSICAL_DEVICE_READBACK_AND_FINAL_ISSUANCE':
        return False,'CLUED_MODEL_M1_PROFILE_STATUS'
    if p.get('effectful_authority_issued') is not False or p.get('authority_effect')!='NONE':
        return False,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION'
    return True,'PASS'

def validate_issued_profile(p):
    good,code=common_profile_checks(p,ISSUED_REQ_PROHIBITED)
    if not good: return good,code
    if has_tbb(p):
        return False,'CLUED_MODEL_M1_ISSUED_PROFILE_UNRESOLVED_BINDING'
    if p.get('status')!='ISSUED' or p.get('effectful_authority_issued') is not True:
        return False,'CLUED_MODEL_M1_ISSUED_PROFILE_STATUS'
    if p.get('authority_effect')!='M1-03_CONTROLLED_DOWNLOAD_AND_INTEGRITY_ONLY':
        return False,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION'
    if p.get('runtime_binding',{}).get('runtime_execution_allowed_in_this_profile') is not False:
        return False,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION'
    d=p.get('device_binding') or {}
    if d.get('binding_state')!='EXACT_BOUND' or d.get('device_name')!='DESK-W-591' or 'v1.0.2' not in d.get('device_profile_ref',''):
        return False,'CLUED_MODEL_M1_PROFILE_DEVICE_BINDING'
    codeb=p.get('execution_code') or {}
    if codeb.get('commit')!=DOWNLOAD_CODE_COMMIT or codeb.get('script_git_blob_sha1')!=DOWNLOAD_SCRIPT_BLOB:
        return False,'CLUED_MODEL_M1_PROFILE_EXECUTION_CODE_BINDING'
    b=p.get('budget_ceiling') or {}
    if b.get('max_network_bytes')!=3221225472 or b.get('max_storage_bytes')!=4294967296 or b.get('max_cost_microunits')!=0 or b.get('max_attempts')!=1:
        return False,'CLUED_MODEL_M1_PROFILE_BUDGET'
    return True,'PASS'

def main():
    stage=load(BASE/'governance/M1StageEntryAuthorization.v1.0.1.json')
    if stage.get('bound_plan',{}).get('sha256')!=PLAN:
        fail('M1 stage plan binding drift')

    old=load(BASE/'registries/DeviceRuntimeMatrix.v1.0.1.json')
    runtimes={x['runtime_id']:x for x in old['runtime_candidates']}
    if runtimes.get('llama.cpp',{}).get('revision')!=LLAMA_REV or runtimes['llama.cpp'].get('license')!='MIT':
        fail('first runtime binding drift')

    matrix=load(BASE/'registries/DeviceRuntimeMatrix.v1.0.2.json')
    devices={x['device_id']:x for x in matrix['physical_device_profiles']}
    d=devices.get('DEV-PERSONAL-WINDOWS-01') or {}
    if d.get('binding_state')!='EXACT_BOUND' or d.get('device_name')!='DESK-W-591':
        fail('exact device binding missing')
    if d.get('cpu',{}).get('name')!='Intel(R) Core(TM) i7-14700K' or d.get('ram_bytes')!=68719476736:
        fail('device CPU/RAM binding drift')
    if d.get('primary_gpu',{}).get('name')!='NVIDIA GeForce RTX 4070' or d.get('primary_gpu',{}).get('vram_mib')!=12282 or d.get('primary_gpu',{}).get('driver_version')!='610.47':
        fail('device GPU binding drift')

    receipt=load(BASE/'evidence/M1PhysicalDeviceBindingReceipt_20260918.json')
    if receipt.get('result')!='PASS / CLUED_MODEL_M1_PHYSICAL_DEVICE_EXACT_BOUND' or receipt.get('readback',{}).get('c_drive_free_bytes',0)<4294967296:
        fail('device binding receipt invalid')

    shortlist=load(BASE/'registries/ReferenceModelShortlist.v1.0.1.json')
    if {x['role'] for x in shortlist['roles']}!=REQ_ROLES:
        fail('reference role coverage drift')
    first=shortlist.get('first_tranche') or {}
    if first.get('model_id')!='Qwen/Qwen3.5-0.8B' or first.get('revision')!=QWEN_REV or first.get('runtime_id')!='llama.cpp':
        fail('first tranche drift')

    lr=load(BASE/'evidence/LicenseTermsCompatibilityReview.v1.0.1.json')
    reviewed={x['id']:x for x in lr['model_reviews']}
    if reviewed.get('Qwen/Qwen3.5-0.8B',{}).get('license')!='Apache-2.0':
        fail('first tranche license screen drift')

    candidate=load(BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.candidate.json')
    good,code=validate_candidate_profile(candidate)
    if not good: fail(code)

    issued=load(BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.issued.json')
    good,code=validate_issued_profile(issued)
    if not good: fail(code)

    script=ROOT/'scripts/model-program/m1_download_exact_hf_snapshot.py'
    if not script.is_file():
        fail('bound download script missing')

    print('PASS: MODEL-PROGRAM-M1 exact Windows device binding and first M1-03 controlled-download profile issued; inference/evaluation/training remain prohibited')
    return 0

if __name__=='__main__': raise SystemExit(main())
