"""Select existing terminal evidence without inventing a live ledger entry."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def rehearsal_matches(document, package_sha, commit, config_sha, proven_adopted_sha=None):
    accepted = {package_sha}
    if proven_adopted_sha is not None:
        accepted.add(proven_adopted_sha)
    return bool(document and document.get('contract') == 'clued.independent-ci.reinstall-rehearsal/1'
                and document.get('status') == 'REHEARSAL_PASS' and document.get('findings') == []
                and document.get('packageManifestSha256') in accepted
                and document.get('commit') == commit and document.get('configSha256') == config_sha)


def plain(path, directory):
    value = path.lstat()
    if (stat.S_ISLNK(value.st_mode) or getattr(value, 'st_file_attributes', 0) & 0x400
            or (directory and not stat.S_ISDIR(value.st_mode))
            or (not directory and (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1))):
        raise ValueError('LEDGER_EVIDENCE_NOT_PLAIN')
    return value


def select_terminal(root, halted_key=None):
    root = Path(root).absolute()
    plain(root, True)
    plain(root / 'state', True)
    live = root / 'state/ledger'
    plain(live, True)
    live_entries = sorted(live.iterdir())
    ledgers = [live]
    manifest_sha = None
    listed = {}
    # Only a literally empty live directory may fall back. An open or broken
    # live batch never becomes quiet merely because historical evidence exists.
    if not live_entries:
        backfill = root / 'state/backfill'
        if backfill.exists():
            plain(backfill, True)
            plain(root / 'install', True)
            manifest = root / 'install/backfill-manifest.json'
            plain(manifest, False)
            manifest_bytes = manifest.read_bytes()
            doc = json.loads(manifest_bytes.decode('utf-8-sig'))
            if doc.get('contract') != 'clued.independent-ci.resident-backfill-manifest/1' or not isinstance(doc.get('sources'), list):
                raise ValueError('BACKFILL_MANIFEST_INVALID')
            manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
            generations = set()
            for source in doc['sources']:
                generation = source.get('dir')
                if not isinstance(generation, str) or not re.fullmatch(r'[1-9][0-9]*', generation) or generation in generations:
                    raise ValueError('BACKFILL_MANIFEST_INVALID')
                generations.add(generation)
                for item in source.get('files', []):
                    name = item.get('path')
                    if not isinstance(name, str):
                        raise ValueError('BACKFILL_MANIFEST_INVALID')
                    key = (generation, name.replace('\\', '/'))
                    if key in listed:
                        raise ValueError('BACKFILL_MANIFEST_DUPLICATE')
                    listed[key] = item
            for generation in sorted(backfill.iterdir()):
                if not re.fullmatch(r'[1-9][0-9]*', generation.name):
                    raise ValueError('BACKFILL_GENERATION_INVALID')
                plain(generation, True)
                ledger = generation / 'ledger'
                if ledger.exists():
                    plain(ledger, True)
                    ledgers.append(ledger)
    candidates = []
    for ledger in ledgers:
        for entry in sorted(ledger.iterdir()):
            if not re.fullmatch(r'[0-9a-f]{64}', entry.name):
                raise ValueError('LEDGER_KEY_INVALID')
            plain(entry, True)
            terminal = entry / '90-terminal.json'
            if not terminal.exists():
                if ledger == live:
                    raise ValueError('LIVE_LEDGER_NOT_TERMINAL')
                continue
            identity = plain(terminal, False)
            data = terminal.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if ledger != live:
                item = listed.get((ledger.parent.name, 'ledger/' + entry.name + '/90-terminal.json'))
                if not item or item.get('sha256') != digest or item.get('bytes') != len(data):
                    raise ValueError('BACKFILL_TERMINAL_NOT_MANIFESTED')
            document = json.loads(data.decode('utf-8-sig'))
            if not isinstance(document, dict) or not isinstance(document.get('outcome'), str) or not document['outcome']:
                raise ValueError('TERMINAL_EVIDENCE_INVALID')
            if halted_key is None or entry.name == halted_key:
                candidates.append((identity.st_mtime_ns, ledger.relative_to(root).as_posix(), entry.name,
                                   digest))
    if not candidates:
        raise ValueError('NO_TERMINAL_LEDGER_ENTRY')
    _, relative, key, digest = max(candidates)
    return {'relativeDirectory': relative, 'key': key, 'terminalSha256': digest,
            'backfillManifestSha256': manifest_sha if relative != 'state/ledger' else None}
