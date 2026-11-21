#!/usr/bin/env python3
"""Score saved synthetic Core candidate outputs; never model evaluation or Gold."""
import argparse
from pathlib import Path

import validate_m2_core_synthetic_pilot as core
import validate_m2_offline_pipeline as offline
from report_m2_core_dev_quality import raw_sha, strict_json
from validate_m2_dataset_foundation import FoundationError, digest, load, require

CONTRACT = core.BASE / 'CoreSavedOutput.candidate.json'
FIXTURE = core.ROOT / 'tests/fixtures/model-program-m2/core-saved-synthetic-outputs.json'
IMPLEMENTATION = Path(__file__).resolve()
EXPECTED_CONTRACT = {
    'schema_version': 'clued.model-m2-core-saved-output-contract/1',
    'status': 'OFFLINE_SYNTHETIC_CORE_CANDIDATE_SCORING_ONLY',
    'source_bundle': 'tests/fixtures/model-program-m2/core-development-candidate.json',
    'source_contract': 'development/contracts/model-program/m2/CoreSyntheticPilot.candidate.json',
    'source_raw_sha256': 'dc17097bd3d12c415b2496962815397a98259bb8bab4922799a7eb00d8316eba',
    'source_contract_raw_sha256': '386472d78e739b4ed0dfae592290c5cb2e8fa2a84bf45efb32ac5d2b909d2182',
    'primitive_path': 'scripts/model-program/validate_m2_offline_pipeline.py',
    'primitive_raw_sha256': 'e0f3aa520b7b686be35ebc12a4146257f478298f3ddcbf14768d781dfd9b0bd9',
    'parser_path': 'scripts/model-program/report_m2_core_dev_quality.py',
    'parser_raw_sha256': '0a4f0f15a174cc1e63286847cc7119bd07afeb36c2ba5a910f622c407e79992f',
    'policy_path': 'development/contracts/model-program/m2/OfflinePipeline.candidate.json',
    'policy_raw_sha256': '80c3c3222ba5f0c173a56f7ae7c563fd265b2cc231d1c6584081ec10cc9165b9',
    'scorer': 'CORE_CLOSED_TYPED_JSON_CANDIDATE_EXACT_MATCH/1',
    'schema_policy': 'VENDORED_UTTERANCE_AND_CLOSED_TYPED_CORE_DOMAIN_OUTPUTS/1',
    'reference_policy': 'EXACT_INPUT_SEGMENT_AND_MESSAGE_REFERENCE_MEMBERSHIP/1',
    'renderer': 'SORTED_LOCAL_JSON_NO_NONFINITE/1',
    'output_identity': 'SHA256_ORIGINAL_OUTPUT_TEXT_UTF8_BYTES_NO_NORMALIZATION/1',
    'origin': 'DETERMINISTIC_SYNTHETIC_FIXTURE_WRITER',
    'source_class': 'C', 'partition': 'DEVELOPMENT',
    'license_scope': 'INTERNAL_NON_PRODUCTION_CANDIDATE_REVIEW_ONLY',
    'max_saved_bytes': 65536, 'max_output_chars': 20000, 'sample_count': 24,
    'authority_effect': 'NONE', 'model_call_profile_ref': None,
    'formal_gold_ref': None, 'holdout_material': None,
    'independent_gold_review': 'NOT_PERFORMED', 'model_inference_performed': False,
    'training_authorized': False, 'formal_eval_acceptance': False, 'm2_verdict': 'NOT_ISSUED',
}


def closed(properties):
    return {'type': 'object', 'additionalProperties': False,
            'required': list(properties), 'properties': properties}


STRING = {'type': 'string', 'minLength': 1, 'maxLength': 20000}
ID = {'type': 'string', 'minLength': 1, 'maxLength': 128}
BOOLEAN = {'type': 'boolean'}
IDS = {'type': 'array', 'items': ID, 'minItems': 1, 'maxItems': 64, 'uniqueItems': True}
STRINGS = {'type': 'array', 'items': STRING, 'maxItems': 64}
DOMAIN_SCHEMAS = {
    'card_chain': closed({'suggested_before': ID, 'suggested_after': ID,
                          'anchor_message_ids': IDS, 'execute': BOOLEAN}),
    'imprint': closed({'source_message_ids': IDS,
                       'premise_message_id': {'type': ['string', 'null'], 'minLength': 1, 'maxLength': 128},
                       'conflict': {'type': ['boolean', 'null']}, 'claims': STRINGS,
                       'ambiguities': STRINGS, 'external_truth_verified': BOOLEAN, 'canonical_write': BOOLEAN}),
    'context': closed({'candidate_eligible': BOOLEAN, 'live_authorization_checked': BOOLEAN,
                       'reason': STRING, 'execute': BOOLEAN,
                       'policy_sha256': {'type': 'string', 'pattern': '^[a-f0-9]{64}$'},
                       'policy_message_id': ID}),
}


def seal(value):
    return {**value, 'sha256': digest(value)}


def versions(source_raw, source_contract_raw, contract):
    require(digest(contract) == digest(EXPECTED_CONTRACT), 'CORE_SAVED_CONTRACT')
    require(raw_sha(source_raw) == contract['source_raw_sha256'] and
            raw_sha(source_contract_raw) == contract['source_contract_raw_sha256'], 'CORE_SAVED_SOURCE_BYTES')
    for prefix in ('primitive', 'parser', 'policy'):
        require(raw_sha((core.ROOT / contract[prefix + '_path']).read_bytes()) ==
                contract[prefix + '_raw_sha256'], 'CORE_SAVED_PRIMITIVE_BINDING')
    policy = load(core.ROOT / contract['policy_path'])
    require(digest(policy) == digest(offline.EXPECTED_CONTRACT) and
            contract['renderer'] == policy['renderer'] and contract['origin'] == policy['saved_output_origin'],
            'CORE_SAVED_POLICY_BINDING')
    bundle, source_contract = strict_json(source_raw), strict_json(source_contract_raw)
    core.validate(bundle, source_contract)
    dataset = seal({'revision_id': 'core-public-candidate-dataset/1',
                    'source_raw_sha256': raw_sha(source_raw),
                    'input_revision_sha256': bundle['revision_sha256'],
                    'source_contract_raw_sha256': raw_sha(source_contract_raw),
                    'source_contract_sha256': digest(source_contract),
                    'source_rule_sha256': source_contract['rule_implementation']['sha256'],
                    'reference_set_sha256': digest([{'sample_id': r['sample_id'],
                        'input_sha256': r['evidence']['input_sha256'],
                        'candidate_sha256': r['evidence']['answer_sha256']}
                        for r in sorted(bundle['samples'], key=lambda r: r['sample_id'])])})
    schema_binding = {'utterance_schema': source_contract['source_bindings'][1],
                      'closed_core_schemas_sha256': digest(DOMAIN_SCHEMAS),
                      'domain_rules': source_contract['domain_rules'],
                      'context_policy_sha256': source_contract['context_policy_sha256']}
    evaluation = seal({'revision_id': 'core-synthetic-saved-output-evaluation/1',
                       'dataset_revision_sha256': dataset['sha256'],
                       'contract_sha256': digest(contract),
                       'implementation_raw_sha256': raw_sha(IMPLEMENTATION.read_bytes()),
                       'parser_raw_sha256': contract['parser_raw_sha256'],
                       'primitive_raw_sha256': contract['primitive_raw_sha256'],
                       'policy_raw_sha256': contract['policy_raw_sha256'],
                       'schema_binding': schema_binding,
                       'scorer': contract['scorer'], 'schema_policy': contract['schema_policy'],
                       'reference_policy': contract['reference_policy'], 'renderer': contract['renderer'],
                       'primitive_scorer': policy['scorer'],
                       'output_identity': contract['output_identity']})
    return bundle, source_contract, dataset, evaluation


def fixture_header(dataset, evaluation, contract):
    return {'schema_version': 'clued.model-m2-core-saved-synthetic-outputs/1',
            'origin': contract['origin'], 'source_class': 'C', 'partition': 'DEVELOPMENT',
            'license_scope': contract['license_scope'], 'authority_effect': 'NONE',
            'model_call_profile_ref': None, 'formal_gold_ref': None, 'holdout_material': None,
            'model_inference_performed': False, 'm2_verdict': 'NOT_ISSUED',
            'contract_sha256': digest(contract), 'dataset_revision_sha256': dataset['sha256'],
            'evaluation_revision_sha256': evaluation['sha256']}


def generate_fixture(source_raw, source_contract_raw, contract):
    """Public candidate-copy writer for regression replay; no teacher/model/Gold."""
    bundle, _, dataset, evaluation = versions(source_raw, source_contract_raw, contract)
    return {**fixture_header(dataset, evaluation, contract),
            'outputs': [{'sample_id': r['sample_id'], 'output_text': offline.render(r['answer_candidate'])}
                        for r in sorted(bundle['samples'], key=lambda r: r['sample_id'])]}


def schema_valid(domain, answer, source_contract):
    if domain == 'utterance_card':
        validator = core.schema_validator(source_contract['source_bindings'][1]['path'])
    else:
        require(domain in DOMAIN_SCHEMAS, 'CORE_SAVED_DOMAIN')
        validator = core.Draft202012Validator(DOMAIN_SCHEMAS[domain])
    return not list(validator.iter_errors(answer))


def reference_valid(row, answer):
    ids = {m['message_id'] for m in row['input']['messages']}
    domain = row['domain']
    if domain == 'utterance_card':
        return answer['segment_id'] == row['input']['segment_id'] and all(
            anchor['message_id'] in ids and not next(m for m in row['input']['messages']
                if m['message_id'] == anchor['message_id'])['context_only']
            for item in answer['items'] for anchor in item['source_anchors']) and all(
            mention['source_message_id'] in ids
            for item in answer['items'] for mention in item['temporal_mentions'])
    if domain == 'card_chain':
        return all(ref in ids for ref in answer['anchor_message_ids'])
    if domain == 'imprint':
        return all(ref in ids for ref in answer['source_message_ids']) and (
            answer['premise_message_id'] is None or answer['premise_message_id'] in ids)
    return answer['policy_message_id'] in ids


def score_saved(source_raw, source_contract_raw, saved_raw, contract):
    bundle, source_contract, dataset, evaluation = versions(source_raw, source_contract_raw, contract)
    require(type(saved_raw) is bytes and len(saved_raw) <= contract['max_saved_bytes'], 'CORE_SAVED_BYTE_BUDGET')
    saved = strict_json(saved_raw)
    expected = fixture_header(dataset, evaluation, contract)
    core.shape(saved, (*expected, 'outputs'), 'CORE_SAVED_SHAPE')
    require(digest({k: saved[k] for k in expected}) == digest(expected), 'CORE_SAVED_BINDING_OR_AUTHORITY')
    require(type(saved['outputs']) is list and len(saved['outputs']) == 24, 'CORE_SAVED_COVERAGE')
    by_id = {}
    for output in saved['outputs']:
        core.shape(output, ('sample_id', 'output_text'), 'CORE_SAVED_OUTPUT_SHAPE')
        require(type(output['sample_id']) is str and output['sample_id'] not in by_id and
                type(output['output_text']) is str and len(output['output_text']) <= contract['max_output_chars'],
                'CORE_SAVED_OUTPUT_TYPE_OR_DUPLICATE')
        # Check UTF8 encodability even when the JSON outer envelope escapes a surrogate.
        output['output_text'].encode('utf-8', errors='strict')
        by_id[output['sample_id']] = output['output_text']
    require(set(by_id) == {r['sample_id'] for r in bundle['samples']}, 'CORE_SAVED_COVERAGE')
    scores = []
    for row in sorted(bundle['samples'], key=lambda r: r['sample_id']):
        text = by_id[row['sample_id']]
        # Malformed JSON, duplicate keys and nonfinite outputs fail the full run.
        # Valid JSON with a wrong typed shape is scored schema-invalid instead.
        answer = strict_json(text.encode('utf-8'))
        valid = schema_valid(row['domain'], answer, source_contract)
        refs = valid and reference_valid(row, answer)
        correct = valid and refs and digest(answer) == digest(row['answer_candidate'])
        scores.append({'sample_id': row['sample_id'], 'domain': row['domain'],
                       'input_sha256': digest(row['input']),
                       'candidate_reference_sha256': digest(row['answer_candidate']),
                       'output_text_raw_utf8_sha256': raw_sha(text.encode('utf-8')),
                       'parsed_output_sha256': digest(answer), 'schema_valid': valid,
                       'reference_valid': bool(refs), 'correct': bool(correct)})
    report = {'schema_version': 'clued.model-m2-core-saved-output-score/1',
              'status': 'OFFLINE_SYNTHETIC_CANDIDATE_REFERENCE_COMPARISON_ONLY',
              'saved_outputs_raw_sha256': raw_sha(saved_raw), 'dataset_revision': dataset,
              'evaluation_revision': evaluation, 'sample_count': 24,
              'schema_valid_count': sum(s['schema_valid'] for s in scores),
              'reference_valid_count': sum(s['reference_valid'] for s in scores),
              'correct_count': sum(s['correct'] for s in scores), 'scores': scores,
              'saved_output_origin': contract['origin'], 'authority_effect': 'NONE',
              'model_call_profile_ref': None, 'model_inference_performed': False,
              'independent_gold_review': 'NOT_PERFORMED', 'formal_gold_ref': None,
              'qualification_generated': 0, 'holdout_generated': 0,
              'training_authorized': False, 'formal_eval_acceptance': False, 'm2_verdict': 'NOT_ISSUED'}
    return {**report, 'score_sha256': digest(report)}


def validate_report(report, source_raw, source_contract_raw, saved_raw, contract):
    require(digest(report) == digest(score_saved(source_raw, source_contract_raw, saved_raw, contract)),
            'CORE_SAVED_REPORT_REPLAY_BINDING')
    return report


def run():
    for path in (core.FIXTURE, core.CONTRACT, CONTRACT, FIXTURE):
        require(not any(p.is_symlink() for p in (path, *path.parents)) and
                path.resolve().is_relative_to(core.ROOT.resolve()), 'CORE_SAVED_PUBLIC_PATH')
    source_raw = core.FIXTURE.read_bytes()
    source_contract_raw = core.CONTRACT.read_bytes()
    with FIXTURE.open('rb') as handle:
        saved_raw = handle.read(EXPECTED_CONTRACT['max_saved_bytes'] + 1)
    contract = load(CONTRACT)
    first = score_saved(source_raw, source_contract_raw, saved_raw, contract)
    second = score_saved(source_raw, source_contract_raw, saved_raw, contract)
    require(first == second, 'CORE_SAVED_NONDETERMINISTIC_REPLAY')
    return first


def main(argv=None):
    # Deliberately fixed public fixtures: no external, Gold or protected path option.
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    try:
        print(offline.render(run()))
        return 0
    except (FoundationError, OSError, ValueError, TypeError, KeyError, RecursionError):
        print(offline.render({'status': 'FAIL_CLOSED_CORE_SAVED_OUTPUT_SCORE'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
