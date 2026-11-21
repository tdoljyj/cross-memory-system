#!/usr/bin/env python3
"""M2 synthetic Gold provenance and accepted M1 reference binding; no issuance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

from validate_m2_dataset_foundation import ROOT, FoundationError, digest, load, require

BASE = ROOT / 'development/contracts/model-program/m2'
CONTRACT = BASE / 'GoldReference.candidate.json'
FIXTURE = ROOT / 'tests/fixtures/model-program-m2/gold-reference.json'
M1_SOURCE = ROOT / 'tests/fixtures/model-program-m2/m1-09-accepted-source.json'
PARENT_READER = ROOT / 'scripts/information-flow/frozen-parent-adapter.mjs'
M1_REF = {
    'repository': 'tdoljyj/cross-memory-system',
    'commit': 'c454d8dfe6b8a216eb2eee5fda39550ea2ac0f82',
    'path': 'development/contracts/model-program/m1/registries/TeacherComparisonSelectionMatrix.v1.0.2.json',
    'git_blob_sha1': '4d86c3e6852f0190e2a19a4226182453850fab94',
    'record_id': 'CLUED-MODEL-M1-TEACHER-COMPARISON-SELECTION-MATRIX-v1.0.2-20260921',
    'accepted_state_id': '50f24568-fd32-4632-8cb7-aa7ac31f84df',
    'accepted_state_version': 2,
    'effect': 'REFERENCE_BASELINE_ONLY_NOT_QUALITY_THRESHOLD',
}
RULE = {'id': 'synthetic-integer-addition', 'revision': '1', 'operation': 'ADD'}


def shape(value, keys, code):
    require(type(value) is dict and set(value) == set(keys), code)


def bind_m1(raw: bytes, reference: dict) -> None:
    require(reference == M1_REF and digest(reference) == digest(M1_REF), 'GOLD_M1_REFERENCE')
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    require(blob == M1_REF['git_blob_sha1'], 'GOLD_M1_SOURCE_BYTES')
    matrix = json.loads(raw)
    require(matrix['record_id'] == M1_REF['record_id'] and matrix['task_id'] == 'M1-09',
            'GOLD_M1_SUBJECT')
    require(matrix['selected_reference_baseline']['package']['quality_winner'] is False and
            matrix['authority_effect'].startswith('REFERENCE_BASELINE_REPORT_ONLY'),
            'GOLD_M1_EFFECT')


def read_parent_gold(reference: dict, roots: dict) -> bytes:
    """Use the existing original-byte parent reader, then read the sealed leaf.

    A source binding alone never certifies labels, domain authority or DataGate.
    No network, permission write or new parent definition is introduced.
    """
    shape(reference, ['stage', 'relative_path', 'sha256'], 'GOLD_PARENT_REFERENCE')
    require(reference['stage'] == 'IF-MVP0-C', 'GOLD_PARENT_STAGE')
    require(type(roots) is dict and set(roots) == {'IF-MVP0-A', 'IF-MVP0-B', 'IF-MVP0-C'},
            'GOLD_PARENT_INPUT_REQUIRED')
    relative = reference['relative_path']
    require(type(relative) is str and relative and '\\' not in relative and ':' not in relative and
            all(part not in ('', '.', '..') for part in relative.split('/')),
            'GOLD_PARENT_PATH')
    env = dict(os.environ)
    for stage, variable in [('IF-MVP0-A', 'M0A_ROOT'), ('IF-MVP0-B', 'M0B_ROOT'),
                            ('IF-MVP0-C', 'M0C_ROOT')]:
        env[variable] = str(roots[stage])
    result = subprocess.run(['node', str(PARENT_READER)], env=env,
                            capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, 'GOLD_PARENT_SOURCE_BINDING')
    evidence = json.loads(result.stdout)
    require(evidence['status'] == 'PASS_SOURCE_BINDING_ONLY', 'GOLD_PARENT_SOURCE_BINDING')
    root = Path(roots['IF-MVP0-C']).resolve(strict=True)
    parent = next(row for row in evidence['parents'] if row['stage'] == 'IF-MVP0-C')
    seal = (root / 'SHA256SUMS').read_bytes()
    require(hashlib.sha256(seal).hexdigest() == parent['delivery_root_sha256'],
            'GOLD_PARENT_SEAL')
    entries = {line[66:]: line[:64] for line in seal.decode('utf-8').splitlines()}
    require(entries.get(relative) == reference['sha256'], 'GOLD_PARENT_LEAF_BINDING')
    path = root.joinpath(*relative.split('/')).resolve(strict=True)
    require(root in path.parents, 'GOLD_PARENT_PATH')
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == reference['sha256'], 'GOLD_PARENT_DIGEST')
    return raw


def validate(bundle: dict, *, m1_raw: bytes, contract=None, parent_roots=None) -> dict:
    contract = load(CONTRACT) if contract is None else contract
    shape(contract, ['schema_version', 'authority_effect', 'm1_reference', 'parent_reader',
                     'formal_gold_ref', 'domain_receipt_ref', 'independent_review_ref',
                     'holdout_lock_ref', 'threshold_ref'], 'GOLD_CONTRACT_SHAPE')
    require(contract['schema_version'] == 'clued.model-m2-gold-reference-contract-candidate/1' and
            contract['authority_effect'] == 'NONE', 'GOLD_CONTRACT_EFFECT')
    for field in ['formal_gold_ref', 'domain_receipt_ref', 'independent_review_ref',
                  'holdout_lock_ref', 'threshold_ref']:
        require(contract[field] is None, 'GOLD_FORMAL_EVIDENCE_NOT_ISSUED')
    require(contract['parent_reader'] == {'path': 'scripts/information-flow/frozen-parent-adapter.mjs',
            'sha256': hashlib.sha256(PARENT_READER.read_bytes()).hexdigest()}, 'GOLD_PARENT_READER')
    bind_m1(m1_raw, contract['m1_reference'])
    shape(bundle, ['schema_version', 'authority_effect', 'gold_revision', 'm1_reference',
                   'source_rule', 'labels', 'revision_sha256'], 'GOLD_BUNDLE_SHAPE')
    require(bundle['schema_version'] == 'clued.model-m2-gold-provenance-candidate/1' and
            bundle['authority_effect'] == 'NONE', 'GOLD_CANDIDATE_EFFECT')
    require(bundle['m1_reference'] == contract['m1_reference'], 'GOLD_M1_REFERENCE')
    require(bundle['source_rule'] == RULE, 'GOLD_RULE_REFERENCE')
    require(type(bundle['gold_revision']) is str and 0 < len(bundle['gold_revision']) <= 128,
            'GOLD_REVISION')
    require(bundle['revision_sha256'] == digest({k: v for k, v in bundle.items()
                                               if k != 'revision_sha256'}), 'GOLD_REVISION_DIGEST')
    require(type(bundle['labels']) is list and 0 < len(bundle['labels']) <= 128, 'GOLD_LABELS')
    seen = set()
    for row in bundle['labels']:
        shape(row, ['sample_id', 'input', 'label', 'source', 'annotator_id', 'adjudication'],
              'GOLD_LABEL_SHAPE')
        require(type(row['sample_id']) is str and 0 < len(row['sample_id']) <= 128 and
                row['sample_id'] not in seen, 'GOLD_SAMPLE_ID')
        seen.add(row['sample_id'])
        source = row['source']
        shape(source, ['kind', 'ref', 'sha256'], 'GOLD_SOURCE_SHAPE')
        if source['kind'] == 'DETERMINISTIC_SYNTHETIC_RULE':
            require(source['ref'] == RULE['id'] + '/' + RULE['revision'] and
                    source['sha256'] == digest(RULE), 'GOLD_SOURCE_BINDING')
            shape(row['input'], ['left', 'right'], 'GOLD_INPUT_SHAPE')
            require(all(type(n) is int for n in row['input'].values()), 'GOLD_INPUT_SHAPE')
            require(row['label'] == {'answer': row['input']['left'] + row['input']['right']} and
                    type(row['label'].get('answer')) is int, 'GOLD_RULE_LABEL')
        elif source['kind'] == 'UPSTREAM_GOLD':
            raw = read_parent_gold(source['ref'], parent_roots)
            require(source['sha256'] == hashlib.sha256(raw).hexdigest(), 'GOLD_SOURCE_BINDING')
            upstream = json.loads(raw)
            require(upstream.get(row['sample_id']) == {'input': row['input'], 'label': row['label']},
                    'GOLD_UPSTREAM_LABEL')
        else:
            require(False, 'GOLD_SOURCE_KIND')
        review = row['adjudication']
        shape(review, ['status', 'reviewer_id', 'evidence'], 'GOLD_ADJUDICATION_SHAPE')
        require(review['status'] == 'RESOLVED', 'GOLD_UNRESOLVED_LABEL')
        require(type(row['annotator_id']) is str and row['annotator_id'].startswith('synthetic-') and
                type(review['reviewer_id']) is str and review['reviewer_id'].startswith('synthetic-') and
                review['reviewer_id'] != row['annotator_id'], 'GOLD_SYNTHETIC_ROLE_SEPARATION')
        expected = {'sample_id': row['sample_id'], 'input_sha256': digest(row['input']),
                    'label_sha256': digest(row['label']), 'source_sha256': source['sha256'],
                    'gold_revision': bundle['gold_revision'],
                    'reviewer_id': review['reviewer_id'], 'annotator_id': row['annotator_id']}
        require(review['evidence'] == expected, 'GOLD_ADJUDICATION_BINDING')
    return {'status': 'PASS_GOLD_REFERENCE_SYNTHETIC_ONLY', 'authority_effect': 'NONE',
            'gold_revision_sha256': bundle['revision_sha256'], 'label_count': len(seen),
            'm1_source_identity': 'EXACT_ACCEPTED_GIT_BLOB_BOUND',
            'm1_reference_use': 'REFERENCE_BASELINE_ONLY_NOT_QUALITY_THRESHOLD',
            'm1_currentness_live_check': 'NOT_RUN_OFFLINE',
            'independent_role_authentication': 'NOT_PERFORMED_SYNTHETIC_IDS_ONLY',
            'formal_gold_ref': None, 'domain_authority_receipt': 'NOT_ISSUED',
            'holdout_lock_ref': None, 'threshold_ref': None, 'data_gate': 'NOT_ISSUED',
            'training_or_data_use_authorized': False, 'm2_verdict': 'NOT_ISSUED'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, default=FIXTURE)
    parser.add_argument('--m1-source', type=Path, default=M1_SOURCE)
    parser.add_argument('--require-formal-gold', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = validate(load(args.fixture), m1_raw=args.m1_source.read_bytes())
        require(not args.require_formal_gold, 'GOLD_FORMAL_EVIDENCE_REQUIRED')
    except (FoundationError, OSError, ValueError, KeyError, TypeError,
            subprocess.SubprocessError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else 'CLUED_MODEL_M2_INVALID_INPUT'
        print(json.dumps({'status': 'FAIL_GOLD_REFERENCE', 'error': code}, sort_keys=True))
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
