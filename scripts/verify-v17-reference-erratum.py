#!/usr/bin/env python3
"""Validate the append-only V17 correction against unchanged original bytes."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path, PurePosixPath

ERRATUM = 'docs/execution-plans/kernel-phase2-closeout-20260908/V17-ReferenceErratum.json'


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify(repo: Path, correction: dict) -> dict:
    def require(condition: bool, reason: str) -> None:
        if not condition:
            raise ValueError(reason)

    require(correction['schema_version'] == 'clued.v17.reference-erratum/1', 'wrong erratum schema')
    source = correction['original_zip']
    archive_path = (repo / source['path']).resolve()
    require(archive_path.is_relative_to(repo.resolve()), 'archive path outside repository')
    raw = archive_path.read_bytes()
    require(len(raw) == source['bytes'] and digest(raw) == source['sha256'], 'original archive changed')
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.namelist()
        require(len(members) == len(set(members)), 'duplicate archive member')
        prefix = 'Clued-Kernel-Next-V17-Local-RC-20260903/'
        require(all(n.startswith(prefix) for n in members), 'unexpected archive root')
        payloads = {}
        for name in members:
            relative = name[len(prefix):]
            require(not PurePosixPath(relative).is_absolute() and '..' not in PurePosixPath(relative).parts, 'unsafe archive member')
            if not name.endswith('/'):
                payloads[relative] = archive.read(name)
    checked = 0
    for line in payloads['SHA256SUMS.txt'].decode('utf-8-sig').splitlines():
        if not line.strip():
            continue
        expected, relative = re.split(r'\s+', line, maxsplit=1)
        require(digest(payloads[relative]) == expected, 'manifest mismatch: ' + relative)
        checked += 1
    receipt_spec = correction['original_receipt']
    receipt_bytes = payloads[receipt_spec['member']]
    require(digest(receipt_bytes) == receipt_spec['sha256'], 'original receipt changed')
    receipt = json.loads(receipt_bytes)
    patch = correction['correction']
    require(patch['json_pointer'] == '/acceptance_chain/final_rebind_index_sha256', 'unexpected correction pointer')
    require(receipt['acceptance_chain']['final_rebind_index_sha256'] == patch['original_value'], 'original value mismatch')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', patch['corrected_value']) is not None, 'corrected digest must contain 64 hexadecimal digits')
    actual = 'sha256:' + digest(payloads[patch['target_member']])
    require(actual == patch['corrected_value'], 'corrected target digest mismatch')
    require(patch['corrected_value'] == patch['original_value'] + '5', 'not the recorded single-digit correction')
    hashes = {digest(value) for value in payloads.values()}
    reference_count = 0
    for key, value in receipt['acceptance_chain'].items():
        if not key.endswith('_sha256'):
            continue
        effective = patch['corrected_value'] if key == 'final_rebind_index_sha256' else value
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', effective) is not None, 'malformed evidence reference: ' + key)
        require(effective.removeprefix('sha256:') in hashes, 'unresolved evidence reference: ' + key)
        reference_count += 1
    index = json.loads(payloads[patch['target_member']])
    require(index['stage_count'] == 20 and index['ready_count'] == 20 and not index['pending'], 'stage index is not closed')
    require(index['source']['commit_sha1'] == correction['accepted_candidate'] == receipt['candidate']['commit_sha1'], 'candidate binding mismatch')
    require(all(value is False for value in correction['preservation'].values()), 'historical evidence rewrite claimed')
    require(correction['production_effect'] == 'NONE' and correction['business_authority_effect'] == 'NONE', 'erratum expands authority')
    return {
        'status': 'PASS_REFERENCE_CORRECTION',
        'manifest_files_verified': checked,
        'acceptance_references_verified': reference_count,
        'stage_count': index['stage_count'],
        'original_zip_sha256': digest(raw),
        'original_receipt_sha256': digest(receipt_bytes),
        'corrected_target_sha256': actual,
        'scope': 'append-only reference correction; no new stage or production acceptance',
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--erratum', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    path = args.erratum or args.repo / ERRATUM
    try:
        result = verify(args.repo, json.loads(path.read_text(encoding='utf-8')))
        result['erratum_sha256'] = digest(path.read_bytes())
        code = 0
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        result, code = {'status': 'FAIL', 'reason': str(error)}, 1
    text = json.dumps(result, indent=2, ensure_ascii=False) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding='utf-8')
    print(text, end='')
    return code


if __name__ == '__main__':
    raise SystemExit(main())
