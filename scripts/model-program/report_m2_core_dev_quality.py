#!/usr/bin/env python3
"""Read-only flags for the exact existing 24 public Core DEVELOPMENT candidates."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import validate_m2_core_synthetic_pilot as core
import validate_m2_offline_pipeline as scanner
from validate_m2_dataset_foundation import FoundationError, digest, load, require

CONTRACT = core.BASE / 'CoreDevQualityReport.candidate.json'
EXPECTED_CONTRACT = {
    'schema_version': 'clued.model-m2-core-dev-quality-contract/1',
    'status': 'OFFLINE_REVIEW_FLAGS_ONLY', 'authority_effect': 'NONE',
    'source_bundle': 'tests/fixtures/model-program-m2/core-development-candidate.json',
    'source_contract': 'development/contracts/model-program/m2/CoreSyntheticPilot.candidate.json',
    'scanner_path': 'scripts/model-program/validate_m2_offline_pipeline.py',
    'scanner_sha256': 'e0f3aa520b7b686be35ebc12a4146257f478298f3ddcbf14768d781dfd9b0bd9',
    'scanner_git_blob': '2dad334636ae42baee8071f892df00086e74edba',
    'policy_path': 'development/contracts/model-program/m2/OfflinePipeline.candidate.json',
    'policy_sha256': '80c3c3222ba5f0c173a56f7ae7c563fd265b2cc231d1c6584081ec10cc9165b9',
    'projection': 'EXPLICIT_ID_PATHS_POSITIONAL_REFERENCE_GRAPH_SEMANTIC_GUARD/1',
    'classification': 'DECLARED_CORE_DOMAIN_AND_FINITE_SCRIPT_LANGUAGE/1',
    'normalization': 'NFKC_WHITESPACE_CASEFOLD/1',
    'scrub_policy': 'FINITE_EMAIL_PHONE_ASSIGNMENT_INJECTION_RULES/1',
    'dedup_policy': 'NORMALIZED_EXACT_AND_TOKEN_JACCARD_COMPONENTS/1',
    'near_duplicate_threshold': {'numerator': 9, 'denominator': 10},
    'threshold_authority': 'EXISTING_OFFLINE_LEXICAL_HEURISTIC_NOT_ACCEPTANCE',
    'partition': 'DEVELOPMENT', 'sample_count': 24, 'model_calls': 0,
    'training_authorized': False, 'semantic_deduplication': False,
    'formal_qualification': False, 'm2_verdict': 'NOT_ISSUED',
}


def raw_sha(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'QUALITY_DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def nonfinite(_):
        require(False, 'QUALITY_NONFINITE_JSON')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=nonfinite)


def comparison_projection(row):
    """Never recursively strip arbitrary `id` fields or parse away task content."""
    segment = row['input']
    core.shape(segment, ('schema_version', 'segment_id', 'reference_time', 'timezone', 'messages'),
               'QUALITY_SEGMENT_SHAPE')
    require(type(segment['messages']) is list and bool(segment['messages']), 'QUALITY_MESSAGES')
    positions, messages = {}, []
    for index, message in enumerate(segment['messages']):
        core.shape(message, ('message_id', 'evidence_id', 'author_role', 'created_at',
                             'context_only', 'content'), 'QUALITY_MESSAGE_SHAPE')
        require(type(message['message_id']) is str and message['message_id'] not in positions,
                'QUALITY_MESSAGE_ID')
        require(type(message['content']) is str and type(message['context_only']) is bool and
                message['author_role'] in ('user', 'assistant', 'system', 'tool'), 'QUALITY_MESSAGE')
        positions[message['message_id']] = index
        messages.append({k: copy.deepcopy(v) for k, v in message.items()
                         if k not in ('message_id', 'evidence_id')})

    def reference(identifier):
        require(type(identifier) is str and identifier in positions, 'QUALITY_REFERENCE')
        return {'message_position': positions[identifier]}

    answer = copy.deepcopy(row['answer_candidate'])
    domain = row['domain']
    if domain == 'utterance_card':
        core.shape(answer, ('schema_version', 'segment_id', 'items'), 'QUALITY_ANSWER_SHAPE')
        require(answer['segment_id'] == segment['segment_id'], 'QUALITY_SEGMENT_REFERENCE')
        del answer['segment_id']
        require(type(answer['items']) is list, 'QUALITY_ITEMS')
        for item in answer['items']:
            # Only the declared candidate-local identity and anchor references.
            require(type(item) is dict and 'candidate_local_id' in item and
                    type(item.get('source_anchors')) is list, 'QUALITY_ITEM')
            del item['candidate_local_id']
            for anchor in item['source_anchors']:
                core.shape(anchor, ('message_id', 'exact_quote'), 'QUALITY_ANCHOR_SHAPE')
                anchor['message_id'] = reference(anchor['message_id'])
    elif domain == 'card_chain':
        core.shape(answer, ('suggested_before', 'suggested_after', 'anchor_message_ids', 'execute'),
                   'QUALITY_ANSWER_SHAPE')
        answer['anchor_message_ids'] = [reference(v) for v in answer['anchor_message_ids']]
    elif domain == 'imprint':
        core.shape(answer, ('source_message_ids', 'premise_message_id', 'conflict', 'claims',
                            'ambiguities', 'external_truth_verified', 'canonical_write'), 'QUALITY_ANSWER_SHAPE')
        answer['source_message_ids'] = [reference(v) for v in answer['source_message_ids']]
        if answer['premise_message_id'] is not None:
            answer['premise_message_id'] = reference(answer['premise_message_id'])
    elif domain == 'context':
        core.shape(answer, ('candidate_eligible', 'live_authorization_checked', 'reason', 'execute',
                            'policy_sha256', 'policy_message_id'), 'QUALITY_ANSWER_SHAPE')
        answer['policy_message_id'] = reference(answer['policy_message_id'])
    else:
        require(False, 'QUALITY_DOMAIN')
    return {'domain': domain, 'partition': row['partition'],
            'input': {**{k: copy.deepcopy(v) for k, v in segment.items()
                       if k not in ('segment_id', 'messages')}, 'messages': messages},
            'answer_candidate': answer}


def comparison_guard(projection):
    guard = copy.deepcopy(projection)
    for message in guard['input']['messages']:
        content = message.pop('content')
        # JSON declarations and context-only policies are conservative exact guards:
        # Jaccard cannot establish equality of scope, grants or visibility semantics.
        try:
            declaration = strict_json(content.encode('utf-8'))
        except (ValueError, FoundationError):
            declaration = None
        if declaration is not None or message['context_only']:
            message['visible_content_sha256'] = digest(content)
        elif len(guard['input']['messages']) > 1:
            # Conservative ordered-turn comparison. Multi-turn near matches are
            # not promoted by a bag of tokens that could conceal swapped turns.
            message['ordered_content_sha256'] = digest(scanner.normalized(content))
    return guard


def compare(left, right):
    if digest(comparison_guard(left)) != digest(comparison_guard(right)):
        return None
    kinds = []
    for index, (a, b) in enumerate(zip(left['input']['messages'], right['input']['messages'])):
        report = scanner.contamination(
            [{'sample_id': 'left', 'input': a['content']}],
            [{'sample_id': 'right', 'input': b['content']}], 'CORE_DEV', 'CORE_DEV')
        if not report['matches']:
            return None
        kinds.extend(report['matches'][0]['reason_codes'])
    return 'NORMALIZED_EXACT' if all(k == 'NORMALIZED_EXACT' for k in kinds) else 'LEXICAL_NEAR'


def scrub_fields(value, prefix):
    flags = []
    def visit(node, path):
        if type(node) is dict:
            for key in sorted(node):
                visit(node[key], path + '/' + key)
        elif type(node) is list:
            for index, item in enumerate(node):
                visit(item, path + '/' + str(index))
        elif type(node) is str:
            _, report = scanner.scrub_rows([{'sample_id': 'field', 'input': node,
                                            'gold': {'answer': ''}}])
            if report['rejected']:
                flags.append({'field_path': path, 'sha256': digest(node),
                              'reason_codes': report['rejected'][0]['reason_codes']})
        else:
            require(node is None or type(node) in (int, float, bool), 'QUALITY_FIELD_TYPE')
    visit(value, prefix)
    return flags


def build_report(source_raw, source_contract, contract):
    require(digest(contract) == digest(EXPECTED_CONTRACT), 'QUALITY_CONTRACT')
    require(raw_sha((core.ROOT / contract['scanner_path']).read_bytes()) == contract['scanner_sha256'],
            'QUALITY_SCANNER_BINDING')
    policy_raw = (core.ROOT / contract['policy_path']).read_bytes()
    require(raw_sha(policy_raw) == contract['policy_sha256'], 'QUALITY_POLICY_BINDING')
    policy = strict_json(policy_raw)
    require(digest(policy) == digest(scanner.EXPECTED_CONTRACT), 'QUALITY_POLICY')
    bundle = strict_json(source_raw)
    core.validate(bundle, source_contract)  # Exact established 24, before any scan/projection.
    rows = sorted(bundle['samples'], key=lambda row: row['sample_id'])
    projections = [comparison_projection(row) for row in rows]
    # Partition the comparison space by exact semantics before reusing the
    # existing connected-components primitive. Ignore its curated rows: this
    # adapter reports potential duplicates and never deletes source samples.
    groups, by_id = {}, {}
    for row, projection in zip(rows, projections):
        by_id[row['sample_id']] = projection
        groups.setdefault(digest(comparison_guard(projection)), []).append({
            'sample_id': row['sample_id'],
            'input': '\n'.join(m['content'] for m in projection['input']['messages']),
            'gold': {}, 'partition_id': 'core-public-development'})
    edges, clusters = [], []
    for key in sorted(groups):
        _, duplicate_report = scanner.deduplicate(groups[key])
        components = {}
        for removed in duplicate_report['removed']:
            representative = removed['representative_id']
            components.setdefault(representative, [representative]).append(removed['sample_id'])
        clusters.extend(sorted(ids) for ids in components.values())
        for edge in duplicate_report['edges']:
            require(compare(by_id[edge['left']], by_id[edge['right']]) == edge['kind'],
                    'QUALITY_COMPARISON_CONSISTENCY')
            edges.append(edge)
    samples = []
    for row, projection in zip(rows, projections):
        text = '\n'.join(m['content'] for m in row['input']['messages'])
        classification = scanner.classify({'input': text, 'provenance': {'template_id': 'core-dev/1'}})
        samples.append({'sample_id': row['sample_id'], 'input_sha256': digest(row['input']),
                        'answer_sha256': digest(row['answer_candidate']), 'row_sha256': digest(row),
                        'comparison_sha256': digest(projection), 'declared_domain': row['domain'],
                        'finite_language': classification['language'],
                        'scrub_flags': scrub_fields(row['input'], 'input') +
                                       scrub_fields(row['answer_candidate'], 'answer_candidate')})
    report = {'schema_version': 'clued.model-m2-core-dev-quality-report/1',
              'status': 'OFFLINE_REVIEW_FLAGS_ONLY', 'authority_effect': 'NONE',
              'bindings': {'source_raw_sha256': raw_sha(source_raw),
                           'input_revision_sha256': bundle['revision_sha256'],
                           'source_contract_sha256': digest(source_contract),
                           'report_contract_sha256': digest(contract),
                           'adapter_raw_sha256': raw_sha(Path(__file__).read_bytes()),
                           'scanner_sha256': contract['scanner_sha256'],
                           'scanner_git_blob': contract['scanner_git_blob'],
                           'policy_sha256': contract['policy_sha256'],
                           'source_rule_sha256': source_contract['rule_implementation']['sha256']},
              'policies': {k: contract[k] for k in ('projection', 'classification', 'normalization',
                           'scrub_policy', 'dedup_policy', 'near_duplicate_threshold', 'threshold_authority')},
              'samples': samples, 'lexical_edges': sorted(edges, key=lambda e: (e['left'], e['right'])),
              'review_clusters': sorted(clusters),
              'cross_corpus_contamination': 'NOT_EVALUATED_NO_OTHER_CORPUS_READ',
              'source_modified': False, 'model_calls': 0, 'qualification_generated': 0,
              'holdout_generated': 0, 'semantic_deduplication': False,
              'formal_qualification': False, 'm2_verdict': 'NOT_ISSUED'}
    return {**report, 'revision_sha256': digest(report)}


def validate_report(report, source_raw, source_contract, contract):
    require(digest(report) == digest(build_report(source_raw, source_contract, contract)),
            'QUALITY_REPORT_REPLAY_BINDING')
    return report


def ordinary_path(path, output=False):
    path = Path(path)
    require(not path.is_symlink(), 'QUALITY_PATH')
    resolved = path.resolve()
    require(resolved.is_relative_to(core.ROOT.resolve()) and
            not any(p.lower() in ('.git', 'memory', '.agents', '.codex', '.aws') for p in resolved.parts),
            'QUALITY_PATH')
    relative = resolved.relative_to(core.ROOT.resolve()).as_posix()
    if output:
        require(relative.startswith('artifacts/model-program/') and resolved.suffix == '.json' and
                not resolved.exists(), 'QUALITY_OUTPUT_PATH')
    else:
        require(relative == EXPECTED_CONTRACT['source_bundle'], 'QUALITY_SOURCE_PATH')
    require(all(not p.is_symlink() for p in [path, *path.parents]), 'QUALITY_PATH')
    return resolved


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=core.FIXTURE)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    try:
        source = ordinary_path(args.input).read_bytes()
        report = build_report(source, load(core.CONTRACT), load(CONTRACT))
        if args.output:
            output = ordinary_path(args.output, output=True)
            # Exclusive creation: never replace a reviewed source or existing artifact.
            with output.open('x', encoding='utf-8', newline='\n') as handle:
                handle.write(scanner.render(report) + '\n')
        print(scanner.render(report))
        return 0
    except (FoundationError, OSError, ValueError, TypeError, KeyError, RecursionError):
        print(json.dumps({'status': 'FAIL_CLOSED_CORE_DEV_QUALITY_REPORT'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
