#!/usr/bin/env python3
"""Validate an input-only projection of the existing public Core dev candidate.

This is offline payload preparation, never a model invocation or admission. The
source validator owns semantics, provenance and the 24 DEVELOPMENT-only boundary.
No answer, review, Gold or held-out material belongs in an invocation payload.
"""
import argparse
import copy
import json
from pathlib import Path

import validate_m2_core_synthetic_pilot as core
from validate_m2_dataset_foundation import FoundationError, digest, load, require

CONTRACT = core.BASE / 'CoreInputEnvelope.candidate.json'
FIXTURE = core.ROOT / 'tests/fixtures/model-program-m2/core-input-envelope.json'
EXPECTED_CONTRACT = {
    'schema_version': 'clued.model-m2-core-input-envelope-contract/1',
    'status': 'OFFLINE_PUBLIC_DEVELOPMENT_PAYLOAD_ONLY',
    'source_bundle': 'tests/fixtures/model-program-m2/core-development-candidate.json',
    'source_contract': 'development/contracts/model-program/m2/CoreSyntheticPilot.candidate.json',
    'projection': 'EXACT_SEGMENT_INPUT_ONLY_SORTED_SAMPLE_ID/1',
    'segment_handling': 'UNTRUSTED_TASK_DATA_NO_CHAT_ROLE_PROMOTION',
    'partition': 'DEVELOPMENT',
    'license_scope': 'INTERNAL_NON_PRODUCTION_CANDIDATE_REVIEW_ONLY',
    'source_class': 'C',
    'request_fields': ['sample_id', 'domain', 'partition', 'input', 'input_sha256'],
    'dispatch': 'NOT_IMPLEMENTED_NOT_AUTHORIZED',
    'model_call_profile_ref': None,
    'formal_domain_receipt_ref': None,
    'authority_effect': 'NONE',
    'm2_verdict': 'NOT_ISSUED',
}


def build_envelope(bundle, source_contract, contract):
    require(digest(contract) == digest(EXPECTED_CONTRACT), 'CORE_INPUT_CONTRACT')
    # Reuse the established deterministic source/rule/answer checks without
    # changing its generator, schema pins, semantics or accepted source bytes.
    core.validate(bundle, source_contract)
    requests = [{
        'sample_id': row['sample_id'], 'domain': row['domain'],
        'partition': row['partition'], 'input': copy.deepcopy(row['input']),
        'input_sha256': digest(row['input']),
    } for row in sorted(bundle['samples'], key=lambda row: row['sample_id'])]
    envelope = {
        'schema_version': 'clued.model-m2-core-input-envelope/1',
        'contract_sha256': digest(contract),
        'source_bundle_revision_sha256': bundle['revision_sha256'],
        'source_contract_sha256': digest(source_contract),
        'source_rule_sha256': source_contract['rule_implementation']['sha256'],
        'requests': requests,
        'dispatch': contract['dispatch'],
        'model_call_profile_ref': None,
        'formal_domain_receipt_ref': None,
        'authority_effect': 'NONE', 'm2_verdict': 'NOT_ISSUED',
    }
    return {**envelope, 'revision_sha256': digest(envelope)}


def validate(envelope, bundle, source_contract, contract, require_call_admission=False):
    expected = build_envelope(bundle, source_contract, contract)
    core.shape(envelope, expected, 'CORE_INPUT_ENVELOPE_SHAPE')
    require(type(envelope['requests']) is list and len(envelope['requests']) == 24,
            'CORE_INPUT_COVERAGE')
    for request in envelope['requests']:
        core.shape(request, contract['request_fields'], 'CORE_INPUT_REQUEST_SHAPE')
        require(request['partition'] == 'DEVELOPMENT', 'CORE_INPUT_PROTECTED_PARTITION')
        require(request['input_sha256'] == digest(request['input']), 'CORE_INPUT_DIGEST')
    require(envelope['revision_sha256'] == digest({
        k: v for k, v in envelope.items() if k != 'revision_sha256'
    }), 'CORE_INPUT_REVISION')
    # A rehashed forged payload is not a projection of the validated source.
    # JSON digest equality also distinguishes bool/int and preserves list order.
    require(digest(envelope) == digest(expected), 'CORE_INPUT_SOURCE_BINDING')
    require(not require_call_admission, 'CORE_INPUT_CALL_ADMISSION_REQUIRED')
    return {
        'status': 'PASS_OFFLINE_CORE_INPUT_PROJECTION_ONLY',
        'development_inputs': len(expected['requests']),
        'source_bundle_revision_sha256': expected['source_bundle_revision_sha256'],
        'revision_sha256': expected['revision_sha256'],
        'answer_or_review_fields_projected': False,
        'qualification_generated': 0, 'holdout_generated': 0,
        'dispatch': expected['dispatch'], 'model_calls': 0,
        'call_admission': 'NOT_ISSUED', 'formal_license_or_domain_clearance': False,
        'independent_gold': 'NOT_ISSUED', 'm2_verdict': 'NOT_ISSUED',
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--envelope', type=Path, default=FIXTURE)
    parser.add_argument('--require-call-admission', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = validate(load(args.envelope), load(core.FIXTURE), load(core.CONTRACT),
                          load(CONTRACT), args.require_call_admission)
    except (FoundationError, OSError, ValueError, TypeError, KeyError, RecursionError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else 'CLUED_MODEL_M2_INVALID_INPUT'
        print(json.dumps({'status': 'FAIL_CLOSED_CORE_INPUT_PROJECTION', 'error': code}, sort_keys=True))
        return 1
    # The CLI reports identities and scope; it never echoes the payload or labels.
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
