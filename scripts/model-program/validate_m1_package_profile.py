#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
M1=ROOT/'development/contracts/model-program/m1'
SCRIPT=ROOT/'scripts/model-program/m1_prepare_package_variants.py'

def load(p): return json.loads(Path(p).read_text(encoding='utf-8'))
def fail(m): print('FAIL: '+m,file=sys.stderr); raise SystemExit(1)
def git_blob_sha1(p):
    b=Path(p).read_bytes()
    return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()

def main():
    closeout=load(M1/'evidence/M1ExperimentProfile003ExecutionCloseout_20260918.json')
    if closeout.get('result')!='PASS / CLUED_MODEL_M1_PROFILE_003_DOWNLOAD_AND_INTEGRITY_ACCEPTED':
        fail('M1-03 prerequisite not PASS')

    sel=load(M1/'package/RuntimePackageSelection.v1.0.1.json')
    if sel.get('successor_runtime',{}).get('commit')!='8ed1a55efcd7424d2c592f6cbc9f97756db1d74d':
        fail('runtime successor drift')
    asset=sel['successor_runtime']['selected_asset']
    if asset.get('name')!='llama-b11033-bin-win-vulkan-x64.zip' or asset.get('bytes')!=31766410 or asset.get('sha256')!='8ca91d4621fcac8799245f01a6467e9c09eba7b8d3be161a382048dc5c839db2':
        fail('runtime asset binding drift')
    delta=sel.get('successor_delta_review') or {}
    if delta.get('qwen35_conversion_core_changed') is not False or delta.get('qwen35_runtime_core_changed') is not False:
        fail('runtime successor review boundary changed')

    matrix=load(M1/'package/PackageVariantMatrix.v1.0.1.json')
    source=matrix.get('source_snapshot') or {}
    if source.get('revision')!='2fc06364715b967f1860aea9cf38778875588b17' or source.get('weight_sha256')!='04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696':
        fail('package source lineage drift')
    if [x['variant_id'] for x in matrix.get('variants',[])]!=['bf16','q8_0','q4_0','q4_k_m']:
        fail('variant matrix drift')
    if matrix.get('m1_06_required_before_quality_selection') is not True:
        fail('quality selection moved before M1-06')

    closeout1=load(M1/'evidence/M1PackageProfile001PreExecutionCloseout_20260918.json')
    if closeout1.get('result')!='CANCELLED / CLUED_MODEL_M1_PKG_PROFILE_001_PRE_EXECUTION_NETWORK_ACCOUNTING_INCOMPLETE':
        fail('Profile 001 pre-execution closeout missing')
    if closeout1.get('attempt_accounting',{}).get('attempts_used')!=0 or closeout1.get('execution_observation',{}).get('process_started') is not False:
        fail('Profile 001 closeout effects invalid')

    profile=load(M1/'governance/ExperimentAuthorizationProfile.M1-PKG-QWEN35-08B-002.issued.json')
    if profile.get('status')!='ISSUED' or profile.get('effectful_authority_issued') is not True:
        fail('M1-05 Profile 002 not issued')
    if profile.get('authority_effect')!='M1-05_PACKAGE_CONVERSION_AND_QUANTIZATION_ONLY':
        fail('M1-05 authority effect drift')
    if profile.get('execution_code',{}).get('commit')!='dc59d70a2196708a94d862073b52dd315b2a0c71' or profile.get('execution_code',{}).get('script_git_blob_sha1')!='0f3e59b1c2022d8f298836f4d3c4c26b8e4c7ae5':
        fail('M1-05 Profile 002 execution code binding drift')
    if git_blob_sha1(SCRIPT)!='0f3e59b1c2022d8f298836f4d3c4c26b8e4c7ae5':
        fail('package preparation successor script blob drift')
    b=profile.get('budget_ceiling') or {}
    if b.get('max_attempts')!=1 or b.get('max_cost_microunits')!=0 or b.get('max_network_bytes')!=6442450944 or b.get('max_output_storage_bytes')!=12884901888:
        fail('M1-05 budget drift')
    prohibited=set(profile.get('prohibited_operations') or [])
    required={'MODEL_INFERENCE','MODEL_EVALUATION','QUALITY_RANKING','TRAINING','DISTILLATION','SEMANTIC_RECALL_RELEASE','PROMOTION','ACTIVATION','PRODUCTION_DEPLOYMENT'}
    if not required.issubset(prohibited):
        fail('M1-05 authority expansion')

    src=SCRIPT.read_text(encoding='utf-8')
    for forbidden in ('llama-cli','llama-server','llama-bench','--prompt','MODEL_INFERENCE'):
        if forbidden in src:
            fail('package script contains inference/evaluation primitive: '+forbidden)
    for required_text in ('llama-quantize.exe','Q4_K_M','Q4_0','--outtype','bf16','q8_0','"pip", "download"','--no-index','NetworkAccounting.json','git_object_store_bytes','wheelhouse_bytes'):
        if required_text not in src:
            fail('package script missing required operation/accounting control: '+required_text)
    accounting=profile.get('network_budget_accounting') or {}
    if accounting.get('method')!='CONSERVATIVE_AT_REST_UPPER_BOUND' or accounting.get('install_mode')!='PIP_DOWNLOAD_THEN_OFFLINE_NO_INDEX_INSTALL' or accounting.get('fail_closed') is not True:
        fail('Profile 002 network accounting not fail-closed')

    try:
        compile(src,str(SCRIPT),'exec')
    except SyntaxError:
        fail('package script compile failed')

    spec=importlib.util.spec_from_file_location('pkg',SCRIPT)
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)/'package'
        lock=m.acquire_lock(root)
        if not lock.exists(): fail('package one-shot lock missing')
        try: m.acquire_lock(root)
        except SystemExit: pass
        else: fail('package second lock acquisition did not fail')

    print('PASS: MODEL-PROGRAM-M1 M1-05 Profile 001 closed pre-execution and Profile 002 exact package conversion/quantization profile is bound with conservative network accounting; inference/evaluation/quality selection remain prohibited')
    return 0

if __name__=='__main__':
    raise SystemExit(main())
