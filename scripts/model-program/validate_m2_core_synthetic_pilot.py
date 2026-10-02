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
    'utterance_card': 'EXPLICIT_SINGLE_CLAIM_CANDIDATE_EXTRACTION/1',
    'card_chain': 'EXPLICIT_LOCAL_EDGE_SUGGESTION_NO_EXECUTION/1',
    'imprint': 'EXACT_SAME_SUBJECT_MULTI_SOURCE_CONFLICT_PRESERVATION/1',
    'context': 'DECLARED_SYNTHETIC_SCOPE_CURRENTNESS_FILTER_NO_GRANT/1',
}
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
              'source_bindings', 'domain_rules', 'role_slots', 'authority'), 'CORE_CONTRACT_SHAPE')
    require(c['schema_version'] == 'clued.model-m2-core-synthetic-pilot/1' and
            c['status'] == 'AUTHOR_VISIBLE_DEVELOPMENT_CANDIDATE' and c['source_class'] == 'C', 'CORE_SCOPE')
    require(digest(c['planned_counts']) == digest({d: {'DEVELOPMENT': 6, 'QUALIFICATION': 6, 'FINAL_HOLDOUT': 6} for d in DOMAINS}), 'CORE_QUOTA')
    require(c['materialization'] == {'DEVELOPMENT': 'AUTHOR_VISIBLE_24_CANDIDATES',
             'QUALIFICATION': 'NOT_GENERATED', 'FINAL_HOLDOUT': 'NOT_GENERATED',
             'heldout_seed_or_answer_material': None}, 'CORE_HELDOUT_BLOCKED')
    require(c['domain_rules'] == RULES and c['authority'] == AUTHORITY, 'CORE_AUTHORITY')
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
                'confidence': 0.5, 'uncertainties': ['作者答案候选，尚未独立复核'], 'sensitivity_hint': 'none'}
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
        msgs = [message(sid + '-m1', f'{subject}的演示属性是{first}。', 'assistant'),
                message(sid + '-m2', f'{subject}的演示属性是{second}。', 'assistant')]
        answer = {'source_message_ids': [m['message_id'] for m in msgs],
                  'conflict': first != second, 'claims': [m['content'] for m in msgs],
                  'external_truth_verified': False, 'canonical_write': False}
    else:
        state = ('CURRENT', 'STALE', 'UNKNOWN', 'CURRENT', 'CURRENT', 'CURRENT')[n-1]
        scope = 'synthetic-project-B' if n == 4 else 'synthetic-project-A'
        revoked = n == 5
        grant_present = n != 6
        text = f'{subject}：这是声明的合成资源 scope={scope}; currentness={state}; revoked={str(revoked).lower()}; grant_present={str(grant_present).lower()}。'
        msgs = [message(sid + '-m1', text)]
        eligible = state == 'CURRENT' and scope == 'synthetic-project-A' and not revoked and grant_present
        answer = {'candidate_eligible': eligible, 'live_authorization_checked': False,
                  'reason': ('DECLARED_MATCH_ONLY', 'STALE', 'UNKNOWN', 'SCOPE_MISMATCH', 'REVOKED', 'MISSING_GRANT')[n-1],
                  'execute': False}
    segment = {'schema_version': 'segment_input.v1', 'segment_id': sid, 'reference_time': STAMP,
               'timezone': 'Etc/UTC', 'messages': msgs}
    source = {'source_class': 'C', 'origin': 'DETERMINISTIC_AUTHOR_SYNTHETIC_ONLY',
              'license_scope': 'INTERNAL_NON_PRODUCTION_CANDIDATE_REVIEW_ONLY',
              'private_data_imported': False, 'copied_upstream_fixture': False,
              'rule_revision': RULES[domain], 'upstream_mapping':
              'M0A_SCHEMA_BOUND' if domain == 'utterance_card' else 'CANDIDATE_MAPPING_NOT_FORMAL_CORE_TAXONOMY'}
    row = {'sample_id': sid, 'domain': domain, 'partition': 'DEVELOPMENT',
           'group_id': sid, 'input': segment, 'answer_candidate': answer, 'source': source,
           'review': {'status': 'AUTHOR_ONLY_PENDING_INDEPENDENT_REVIEW', 'receipt_ref': None},
           'evidence': {}}
    row['evidence'] = {'input_sha256': digest(segment), 'answer_sha256': digest(answer),
                       'source_sha256': digest(source), 'rule_sha256': digest(RULES[domain])}
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
