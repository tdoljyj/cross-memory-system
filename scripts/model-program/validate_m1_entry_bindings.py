#!/usr/bin/env python3
from __future__ import annotations
import json,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'development/contracts/model-program/m1'
PLAN='a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4'
QWEN_REV='2fc06364715b967f1860aea9cf38778875588b17'
LLAMA_REV='bdcbaaf6e7520b68c8c60ff724c67409970d70e1'
PROFILE001_CODE_COMMIT='a7307dd78997ca5a6e6ef2a8f53811a3058e37ef'
PROFILE001_SCRIPT_BLOB='086849744f4d66eeee49a8dea59c676d6582757d'
PROFILE002_CODE_COMMIT='42240b91b29c80e45270036f8d98df0603f034cb'
PROFILE002_SCRIPT_BLOB='9b31ee6003c53bbc045c99249b995e72aa9ae938'
PROFILE003_CODE_COMMIT='6e26bd4a4d90772a83c1dd1f1e8f2c9524e3eafd'
PROFILE003_SCRIPT_BLOB='f69c8abece8854de67c87c489076d5e52eb2c097'
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

def validate_issued_profile(p,expected_code_commit,expected_script_blob):
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
    if codeb.get('commit')!=expected_code_commit or codeb.get('script_git_blob_sha1')!=expected_script_blob:
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

    issued1=load(BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.issued.json')
    good,code=validate_issued_profile(issued1,PROFILE001_CODE_COMMIT,PROFILE001_SCRIPT_BLOB)
    if not good: fail(code)
    closeout=load(BASE/'evidence/M1ExperimentProfile001ExecutionCloseout_20260918.json')
    if closeout.get('profile_id')!='M1-REF-QWEN35-08B-LLAMACPP-001' or closeout.get('result')!='FAIL / CLUED_MODEL_M1_PROFILE_001_EXECUTION_CODE_SYNTAX_ERROR':
        fail('Profile 001 closeout missing')
    if closeout.get('attempt_accounting',{}).get('retry_under_same_profile_allowed') is not False or closeout.get('effects',{}).get('network_model_download_bytes')!=0:
        fail('Profile 001 fail-closed closeout invalid')

    issued2=load(BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-002.issued.json')
    good,code=validate_issued_profile(issued2,PROFILE002_CODE_COMMIT,PROFILE002_SCRIPT_BLOB)
    if not good: fail(code)
    closeout2=load(BASE/'evidence/M1ExperimentProfile002ExecutionCloseout_20260918.json')
    if closeout2.get('profile_id')!='M1-REF-QWEN35-08B-LLAMACPP-002' or closeout2.get('result')!='FAIL / CLUED_MODEL_M1_PROFILE_002_CONCURRENT_DUPLICATE_WRITE_INVALIDATED_SNAPSHOT':
        fail('Profile 002 closeout missing')
    if closeout2.get('attempt_accounting',{}).get('retry_under_same_profile_allowed') is not False:
        fail('Profile 002 retry ceiling invalid')
    issued3=load(BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-003.issued.json')
    good,code=validate_issued_profile(issued3,PROFILE003_CODE_COMMIT,PROFILE003_SCRIPT_BLOB)
    if not good: fail(code)
    if issued3.get('attempt_control')!='ONE_SHOT_EXCLUSIVE_LOCK / NEW_OUTPUT_DIR / ATOMIC_FILE_REPLACE':
        fail('Profile 003 attempt control invalid')

    closeout3=load(BASE/'evidence/M1ExperimentProfile003ExecutionCloseout_20260918.json')
    if closeout3.get('profile_id')!='M1-REF-QWEN35-08B-LLAMACPP-003' or closeout3.get('result')!='PASS / CLUED_MODEL_M1_PROFILE_003_DOWNLOAD_AND_INTEGRITY_ACCEPTED':
        fail('Profile 003 PASS closeout missing')
    snap3=closeout3.get('snapshot') or {}
    if snap3.get('source_file_count')!=13 or snap3.get('snapshot_bytes')!=1769980465 or snap3.get('network_bytes')!=1769980465 or snap3.get('mismatched_files')!=[] or snap3.get('partial_files_remaining')!=[]:
        fail('Profile 003 snapshot closeout invalid')
    w3=snap3.get('weight') or {}
    if w3.get('bytes')!=1746942600 or w3.get('sha256')!='04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696' or w3.get('expected_lfs_sha256')!=w3.get('sha256'):
        fail('Profile 003 weight integrity invalid')
    iv3=closeout3.get('integrity_verification') or {}
    if iv3.get('downloader_internal_independent_rehash')!='PASS' or iv3.get('reviewer_external_rehash')!='PASS' or iv3.get('externally_matching_source_files')!=13:
        fail('Profile 003 independent rehash evidence invalid')
    eff3=closeout3.get('effects') or {}
    if any(eff3.get(k) is not False for k in ('model_loaded','inference_performed','evaluation_performed','training_performed','semantic_index_written','semantic_recall_released','promotion_or_activation','production_mutation','trust_remote_code')):
        fail('Profile 003 closeout authority/effect violation')
    acct3=closeout3.get('attempt_accounting') or {}
    if acct3.get('attempts_used')!=1 or acct3.get('retry_under_same_profile_allowed') is not False or acct3.get('profile_status_after_closeout')!='CLOSED_SUCCESS':
        fail('Profile 003 attempt closeout invalid')

    script=ROOT/'scripts/model-program/m1_download_exact_hf_snapshot.py'
    if not script.is_file():
        fail('bound download script missing')
    try:
        compile(script.read_text(encoding='utf-8'),str(script),'exec')
    except SyntaxError:
        fail('bound download script does not compile')

    print('PASS: MODEL-PROGRAM-M1 Profiles 001/002 closed fail-closed; Profile 003 exact download/integrity closed PASS with dual rehash; inference/evaluation/training remain prohibited')
    return 0

if __name__=='__main__': raise SystemExit(main())
