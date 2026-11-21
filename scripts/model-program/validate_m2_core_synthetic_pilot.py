#!/usr/bin/env python3
"""Author-visible M2 Core development candidates. No held-out data or authority."""
import argparse
import json
import hashlib
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from validate_m2_dataset_foundation import ROOT, FoundationError, digest, load, require

BASE = ROOT / 'development/contracts/model-program/m2'
CONTRACT = BASE / 'CoreSyntheticPilot.candidate.json'
FIXTURE = ROOT / 'tests/fixtures/model-program-m2/core-development-candidate.json'
DOMAINS = ('utterance_card', 'card_chain', 'imprint', 'context')
STAMP = '2026-10-02T00:00:00Z'
SOURCE_PINS = [{'path': 'development/contracts/information-flow/vendored/m0a/segment-input.v1.schema.json', 'sha256': 'a4f174a56a3e53bad8c72ba0e888bd012164542920df293466c2e711aaece865'}, {'path': 'development/contracts/information-flow/vendored/m0a/candidate-information.v1.schema.json', 'sha256': '52b270b24458a76ae40257df4e9a3d220aad232ba9ee939b2fde96f33b9c7702'}, {'path': 'development/contracts/model-program/m2/DatasetSplitDefinition.v0.1.json', 'sha256': 'f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77'}]
RULES = {
    'utterance_card': 'EXPLICIT_SINGLE_CLAIM_CANDIDATE_EXTRACTION/2',
    'card_chain': 'EXPLICIT_LOCAL_EDGE_SUGGESTION_NO_EXECUTION/1',
    'imprint': 'EXPLICIT_SINGLE_VALUE_SAME_TIME_CONFLICT_PRESERVATION/2',
    'context': 'VISIBLE_DECLARED_POLICY_SCOPE_FILTER_NO_GRANT/2',
}
IMPLEMENTATION_PATH = 'scripts/model-program/validate_m2_core_synthetic_pilot.py'
IMPLEMENTATION_REVISION = 'core-dev-semantic-rules/2'
CONTEXT_POLICY = {'revision': 'declared-context-match/2', 'expected_scope': 'synthetic-project-A',
                  'accepted_currentness': ['CURRENT'], 'require_declared_grant': True,
                  'reject_revoked': True, 'effect': 'DECLARED_SYNTHETIC_MATCH_ONLY_NOT_AUTHORIZATION'}
AUTHORITY = {'formal_gold_ref': None, 'independent_review_ref': None,
             'holdout_lock_ref': None, 'domain_receipt_ref': None,
             'model_call_profile_ref': None, 'm2_verdict': 'NOT_ISSUED'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def shape(obj, fields, code):
    require(type(obj) is dict and set(obj) == set(fields), code)


def schema_validator(relative):
    return Draft202012Validator(load(ROOT / relative), format_checker=FormatChecker())


def validate_contract(c):
    shape(c, ('schema_version', 'status', 'source_class', 'planned_counts', 'materialization',
              'source_bindings', 'domain_rules', 'rule_implementation', 'context_policy_sha256', 'role_slots', 'authority'), 'CORE_CONTRACT_SHAPE')
    require(c['schema_version'] == 'clued.model-m2-core-synthetic-pilot/1' and
            c['status'] == 'AUTHOR_VISIBLE_DEVELOPMENT_CANDIDATE' and c['source_class'] == 'C', 'CORE_SCOPE')
    require(digest(c['planned_counts']) == digest({d: {'DEVELOPMENT': 6, 'QUALIFICATION': 6, 'FINAL_HOLDOUT': 6} for d in DOMAINS}), 'CORE_QUOTA')
    require(c['materialization'] == {'DEVELOPMENT': 'AUTHOR_VISIBLE_24_CANDIDATES',
             'QUALIFICATION': 'NOT_GENERATED', 'FINAL_HOLDOUT': 'NOT_GENERATED',
             'heldout_seed_or_answer_material': None}, 'CORE_HELDOUT_BLOCKED')
    require(c['domain_rules'] == RULES and c['authority'] == AUTHORITY, 'CORE_AUTHORITY')
    require(c['rule_implementation'] == implementation_binding(), 'CORE_RULE_IMPLEMENTATION')
    require(c['context_policy_sha256'] == digest(CONTEXT_POLICY), 'CORE_CONTEXT_POLICY_BINDING')
    require(c['role_slots'] == {r: {'authenticated_subject_ref': None, 'current_grant_ref': None,
                                  'status': 'NOT_ASSIGNED_NOT_VERIFIED'}
                               for r in ('gold_reviewer', 'dispute_adjudicator', 'holdout_custodian', 'data_gate_reviewer')}, 'CORE_ROLE_CLAIM')
    require(c['source_bindings'] == SOURCE_PINS, 'CORE_SOURCE_PINS')
    expected_paths = {
        'development/contracts/information-flow/vendored/m0a/segment-input.v1.schema.json',
        'development/contracts/information-flow/vendored/m0a/candidate-information.v1.schema.json',
        'development/contracts/model-program/m2/DatasetSplitDefinition.v0.1.json',
    }
    require({r['path'] for r in c['source_bindings']} == expected_paths, 'CORE_SOURCE_PATH')
    for ref in c['source_bindings']:
        shape(ref, ('path', 'sha256'), 'CORE_SOURCE_REF')
        require(sha(ROOT / ref['path']) == ref['sha256'], 'CORE_SOURCE_BYTES')


def message(identifier, content, role='user', context_only=False):
    return {'message_id': identifier, 'evidence_id': 'synthetic-evidence-' + identifier,
            'author_role': role, 'created_at': STAMP, 'context_only': context_only, 'content': content}



def implementation_binding():
    # The hashed file contains no contract/fixture hash and no embedded self-hash.
    # Contract -> implementation raw bytes; bundle -> contract and implementation.
    return {'path': IMPLEMENTATION_PATH, 'revision': IMPLEMENTATION_REVISION,
            'sha256': sha(ROOT / IMPLEMENTATION_PATH),
            'hash_bytes': 'SHA256_COMPLETE_RAW_FILE_BYTES_NO_NEWLINE_OR_JSON_NORMALIZATION'}


def context_answer(segment, policy_sha256):
    messages = segment.get('messages', [])
    require(len(messages) == 2 and messages[0]['context_only'] is False and
            messages[1]['context_only'] is True, 'CORE_CONTEXT_POLICY_INPUT')
    resource, policy = (json.loads(m['content']) for m in messages)
    shape(resource, ('subject', 'scope', 'currentness', 'revoked', 'grant_present'), 'CORE_CONTEXT_RESOURCE')
    require(digest(policy) == policy_sha256, 'CORE_CONTEXT_POLICY_INPUT')
    shape(policy, CONTEXT_POLICY, 'CORE_CONTEXT_POLICY_SHAPE')
    require(type(resource['revoked']) is bool and type(resource['grant_present']) is bool,
            'CORE_CONTEXT_RESOURCE_FLAGS')
    if resource['currentness'] not in policy['accepted_currentness']:
        eligible, reason = False, resource['currentness']
    elif resource['scope'] != policy['expected_scope']:
        eligible, reason = False, 'SCOPE_MISMATCH'
    elif policy['reject_revoked'] and resource['revoked']:
        eligible, reason = False, 'REVOKED'
    elif policy['require_declared_grant'] and not resource['grant_present']:
        eligible, reason = False, 'MISSING_GRANT'
    else:
        eligible, reason = True, 'DECLARED_MATCH_ONLY'
    return {'candidate_eligible': eligible, 'live_authorization_checked': False,
            'reason': reason, 'execute': False, 'policy_sha256': digest(policy),
            'policy_message_id': messages[1]['message_id']}


def imprint_answer(segment):
    messages = segment['messages']
    premise = json.loads(messages[0]['content']) if len(messages) == 3 else {}
    sources = messages[-2:]
    claims = [json.loads(m['content']) for m in sources]
    required = ('subject', 'attribute', 'effective_at')
    established = (premise.get('cardinality') == 'SINGLE' and
                   all(type(premise.get(k)) is str and premise[k] for k in required) and
                   all(all(c.get(k) == premise[k] for k in required) and
                       type(c.get('value')) is str and c['value'] for c in claims))
    conflict = claims[0]['value'] != claims[1]['value'] if established else None
    return {'source_message_ids': [m['message_id'] for m in sources],
            'premise_message_id': messages[0]['message_id'] if len(messages) == 3 else None,
            'conflict': conflict, 'claims': [m['content'] for m in sources],
            'ambiguities': [] if established else ['SINGLE_VALUE_SAME_SUBJECT_ATTRIBUTE_TIME_NOT_ESTABLISHED'],
            'external_truth_verified': False, 'canonical_write': False}


def make_case(domain, n):
    sid = f'm2-core-dev-20261002-{domain}-{n:02d}'
    subject = f'虚构试验-{domain}-{n:02d}'
    if domain == 'utterance_card':
        kinds = ('fact', 'preference', 'decision', 'task', 'status', 'unclassified')
        texts = (f'{subject}的演示版本是青色。', f'在{subject}中我偏好短句。',
                 f'我决定{subject}只做离线演示。', f'请为{subject}整理演示清单。',
                 f'{subject}的演示清单已经准备好。', f'{subject}可能需要更轻的呈现，含义尚未确定。')
        text, kind = texts[n-1], kinds[n-1]
        msgs = [message(sid + '-m1', text)]
        item = {'candidate_local_id': 'item_dev_' + str(n), 'item_type': kind, 'claim': text,
                'summary': text, 'action_level': 'needs_action' if kind == 'task' else 'reference',
                'priority': None, 'entity_mentions': [], 'topics': ['合成开发演示'],
                'temporal_mentions': [], 'source_anchors': [{'message_id': msgs[0]['message_id'], 'exact_quote': text}],
                'confidence': 0.5, 'uncertainties': ['更轻的呈现含义未确定'] if n == 6 else [], 'sensitivity_hint': 'none'}
        answer = {'schema_version': 'candidate_information.v1', 'segment_id': sid, 'items': [item]}
    elif domain == 'card_chain':
        pairs = [('card_A', 'card_B'), ('card_B', 'card_A'), ('card_A', 'card_C'),
                 ('card_C', 'card_B'), ('card_B', 'card_C'), ('card_C', 'card_A')]
        before, after = pairs[n-1]
        text = f'{subject}：先完成{before}的演示，再开始{after}；这里只建议依赖，未批准执行。'
        msgs = [message(sid + '-m1', text)]
        answer = {'suggested_before': before, 'suggested_after': after,
                  'anchor_message_ids': [msgs[0]['message_id']], 'execute': False}
    elif domain == 'imprint':
        first = ('青色', '圆形', '短句', '离线', '单列', '低对比')[n-1]
        second = first if n % 2 else ('紫色', '方形', '长句', '在线', '双列', '高对比')[n-1]
        attribute = ('highlight_color', 'tile_shape', 'sentence_length',
                     'connection_mode', 'column_count', 'contrast_level')[n-1]
        premise = {'subject': subject, 'attribute': attribute,
                   'effective_at': STAMP, 'cardinality': 'SINGLE'}
        claim1 = {k: premise[k] for k in ('subject', 'attribute', 'effective_at')}
        claim2 = dict(claim1)
        claim1['value'], claim2['value'] = first, second
        msgs = [message(sid + '-premise', json.dumps(premise, ensure_ascii=False, sort_keys=True)),
                message(sid + '-m1', json.dumps(claim1, ensure_ascii=False, sort_keys=True), 'assistant'),
                message(sid + '-m2', json.dumps(claim2, ensure_ascii=False, sort_keys=True), 'assistant')]
        answer = imprint_answer({'messages': msgs})
    else:
        state = ('CURRENT', 'STALE', 'UNKNOWN', 'CURRENT', 'CURRENT', 'CURRENT')[n-1]
        resource = {'subject': subject, 'scope': 'synthetic-project-B' if n == 4 else 'synthetic-project-A',
                    'currentness': state, 'revoked': n == 5, 'grant_present': n != 6}
        msgs = [message(sid + '-m1', json.dumps(resource, ensure_ascii=False, sort_keys=True)),
                message(sid + '-policy', json.dumps(CONTEXT_POLICY, ensure_ascii=False, sort_keys=True),
                        'system', context_only=True)]
        answer = context_answer({'messages': msgs}, digest(CONTEXT_POLICY))
    segment = {'schema_version': 'segment_input.v1', 'segment_id': sid, 'reference_time': STAMP,
               'timezone': 'Etc/UTC', 'messages': msgs}
    source = {'source_class': 'C', 'origin': 'DETERMINISTIC_AUTHOR_SYNTHETIC_ONLY',
              'license_scope': 'INTERNAL_NON_PRODUCTION_CANDIDATE_REVIEW_ONLY',
              'private_data_imported': False, 'copied_upstream_fixture': False,
              'rule_revision': RULES[domain], 'rule_implementation': implementation_binding(), 'upstream_mapping':
              'M0A_SCHEMA_BOUND' if domain == 'utterance_card' else 'CANDIDATE_MAPPING_NOT_FORMAL_CORE_TAXONOMY'}
    row = {'sample_id': sid, 'domain': domain, 'partition': 'DEVELOPMENT',
           'group_id': sid, 'input': segment, 'answer_candidate': answer, 'source': source,
           'review': {'status': 'AUTHOR_ONLY_PENDING_INDEPENDENT_REVIEW', 'receipt_ref': None,
                      'confidence_semantics': 'EXISTING_0_5_SCHEMA_PLACEHOLDER_UNCALIBRATED_NOT_MODEL_ESTIMATE'},
           'evidence': {}}
    row['evidence'] = {'input_sha256': digest(segment), 'answer_sha256': digest(answer),
                       'source_sha256': digest(source), 'rule_sha256': implementation_binding()['sha256']}
    return row


def generate(c):
    validate_contract(c)
    rows = [make_case(d, n) for d in DOMAINS for n in range(1, 7)]
    bundle = {'schema_version': 'clued.model-m2-core-development-candidate/1',
              'contract_sha256': digest(c), 'samples': rows,
              'heldout_material': None, 'authority': AUTHORITY, 'revision_sha256': ''}
    bundle['revision_sha256'] = digest({k: v for k, v in bundle.items() if k != 'revision_sha256'})
    return bundle


def validate(bundle, c, require_formal=False):
    validate_contract(c)
    shape(bundle, ('schema_version', 'contract_sha256', 'samples', 'heldout_material', 'authority', 'revision_sha256'), 'CORE_BUNDLE_SHAPE')
    require(bundle['authority'] == AUTHORITY and bundle['heldout_material'] is None, 'CORE_FORMAL_OR_HELDOUT_INJECTION')
    require(type(bundle['samples']) is list and len(bundle['samples']) == 24, 'CORE_SAMPLE_COUNT')
    inp = schema_validator(c['source_bindings'][0]['path'])
    out = schema_validator(c['source_bindings'][1]['path'])
    ids, inputs = set(), set()
    for row in bundle['samples']:
        require(row.get('partition') == 'DEVELOPMENT', 'CORE_PARTITION')
        require(row.get('sample_id') not in ids and digest(row.get('input')) not in inputs, 'CORE_DUPLICATE')
        ids.add(row['sample_id']); inputs.add(digest(row['input']))
        require(row.get('domain') in DOMAINS, 'CORE_DOMAIN')
        require(not list(inp.iter_errors(row['input'])), 'CORE_INPUT_SCHEMA')
        if row['domain'] == 'context':
            require(row['answer_candidate'] == context_answer(row['input'], c['context_policy_sha256']),
                    'CORE_CONTEXT_ANSWER')
        if row['domain'] == 'imprint':
            require(row['answer_candidate'] == imprint_answer(row['input']), 'CORE_IMPRINT_ANSWER')
        if row['domain'] == 'utterance_card':
            require(not list(out.iter_errors(row['answer_candidate'])), 'CORE_OUTPUT_SCHEMA')
            messages = {m['message_id']: m for m in row['input']['messages']}
            for item in row['answer_candidate']['items']:
                require(any(a['message_id'] in messages and not messages[a['message_id']]['context_only'] and
                            a['exact_quote'] in messages[a['message_id']]['content'] for a in item['source_anchors']), 'CORE_EXACT_ANCHOR')
    # Rehashing an altered answer, source, review, role or quota cannot bless it.
    require(digest(bundle) == digest(generate(c)), 'CORE_DETERMINISTIC_REVISION')
    require(not require_formal, 'CORE_FORMAL_GOLD_REQUIRED')
    return {'status': 'PASS_AUTHOR_VISIBLE_CORE_DEV_CANDIDATE_ONLY', 'development_samples': 24,
            'domain_counts': {d: 6 for d in DOMAINS}, 'qualification_generated': 0, 'holdout_generated': 0,
            'independent_review': 'NOT_PERFORMED', 'formal_core_mapping': 'PARTIAL_NOT_ADOPTED',
            'full_frozen_parents_currentness': 'NOT_ATTESTED_BY_OFFLINE_VALIDATOR',
            'revision_sha256': bundle['revision_sha256'], 'model_calls': 0, 'm2_verdict': 'NOT_ISSUED'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle', type=Path, default=FIXTURE)
    p.add_argument('--require-formal-gold', action='store_true')
    args = p.parse_args()
    try:
        print(json.dumps(validate(load(args.bundle), load(CONTRACT), args.require_formal_gold), ensure_ascii=False, sort_keys=True))
        return 0
    except (FoundationError, OSError, ValueError, KeyError, TypeError):
        print(json.dumps({'status': 'FAIL_CLOSED_CORE_DEV_CANDIDATE'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
