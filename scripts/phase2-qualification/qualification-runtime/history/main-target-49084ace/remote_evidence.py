"""Private Git auxiliary Evidence append/read-back candidate, never an action gate.

Uses the existing GitHub credential only in the trusted host. No Docker, Skill,
RootStore write, root registration, GA/GRR issuer or current-revocation assertion.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

BASE = Path(__file__).resolve().parent
VERIFIER = BASE.parent / 'control-root-registration' / 'verify.py'
VERIFIER_SHA = '040ef7b7a8536d6b210ada9a15a26af6749e58c5da10cd401b98c36155373093'
if hashlib.sha256(VERIFIER.read_bytes()).hexdigest() != VERIFIER_SHA:
    raise RuntimeError('Existing exact GitHub verifier changed')
spec = importlib.util.spec_from_file_location('existing_control_source_verifier', VERIFIER)
existing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(existing)
PREFIX = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/'
REPOSITORY = 'tdoljyj/cross-memory-system'
KINDS = ('intent', 'result', 'recovery')
MAX_BYTES = 65536
BOUNDARY = {'authorization_effect': 'NONE', 'execution_enabled': False,
            'current_authority_verified': False, 'controller_qualified': False}


class Unknown(ValueError):
    pass


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def need(condition, message):
    if not condition:
        raise Unknown(message)


def path_for(attempt, kind):
    need(isinstance(attempt, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', attempt), 'Invalid fixed attempt path')
    need(kind in KINDS, 'Only auxiliary intent/result/recovery evidence allowed')
    return PREFIX + attempt + '/' + kind + '.json'


def raw_record(raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'Bounded exact JSON bytes required')
    value = existing.strict_json(raw)
    need(type(value) is dict, 'Evidence must be an object')
    return value


def reference(attempt, kind, commit, raw):
    raw_record(raw)
    need(isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit), 'Exact immutable commit required')
    return {'repository': REPOSITORY, 'commit': commit, 'path': path_for(attempt, kind),
            'sha256': sha(raw), 'git_blob_sha': git_blob(raw), 'size': len(raw)}


def validate_reference(ref, raw):
    need(type(ref) is dict and set(ref) == {'repository', 'commit', 'path', 'sha256', 'git_blob_sha', 'size'},
         'Only exact evidence reference fields accepted')
    path = ref.get('path')
    need(isinstance(path, str) and path.startswith(PREFIX), 'Evidence path outside fixed scope')
    parts = path[len(PREFIX):].split('/')
    need(len(parts) == 2 and parts[1] in [k + '.json' for k in KINDS], 'Invalid evidence filename')
    expected = reference(parts[0], parts[1][:-5], ref.get('commit'), raw)
    need(type(ref['size']) is int and ref == expected, 'Reference/content binding mismatch')


def encode_result(intent_ref, intent_raw, outcome):
    """Auxiliary result framing only; not a GateResultReceipt or its enum.

The original exact Intent reference stays inside the persisted result bytes.
Outcome remains untrusted evidence requiring the actual qualified verifier.
"""
    validate_reference(intent_ref, intent_raw)
    need(intent_ref['path'].endswith('/intent.json') and type(outcome) is dict, 'Original Intent and outcome required')
    value = {'intent_evidence_ref': intent_ref, 'outcome_evidence': outcome, **BOUNDARY}
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    raw_record(raw)
    return raw


class GitHubEvidence(existing.GitHub):
    def __init__(self):
        super().__init__('C:/Program Files/GitHub CLI/gh.exe')

    def create_file(self, path, raw, expected_parent):
        # Caller cannot select repo, branch, commit message or overwrite SHA.
        need(isinstance(path, str) and path.startswith(PREFIX), 'Write outside fixed evidence scope')
        parts = path[len(PREFIX):].split('/')
        need(len(parts) == 2 and parts[1] in [k + '.json' for k in KINDS], 'Invalid evidence target')
        need(reference(parts[0], parts[1][:-5], expected_parent, raw)['path'] == path, 'Invalid exact target')
        request = {'message': '[Codex@DESK-W-591] append ' + path,
                   'committer': {'name': 'Codex@DESK-W-591', 'email': 'tdoljyj@users.noreply.github.com'},
                   'content': base64.b64encode(raw).decode('ascii'), 'branch': 'main'}
        response = subprocess.run([self.executable, 'api', '--method', 'PUT', '--include',
                'repos/' + REPOSITORY + '/contents/' + quote(path, safe='/'), '--input', '-'],
                input=json.dumps(request).encode('utf-8'), capture_output=True, timeout=30, check=False)
        need(response.returncode == 0, 'Publication response unknown/failed; never retry automatically')
        normalized = response.stdout.replace(b'\r\n', b'\n')
        header, separator, body = normalized.partition(b'\n\n')
        need(separator and re.match(rb'^HTTP/[^ ]+ 201(?: |\n|$)', header), 'Only HTTP 201 file creation accepted')
        value = existing.strict_json(body)
        need(type(value) is dict, 'Missing creation response')
        return value


def read_back(api, ref, expected_raw):
    """Independent GET after publication, by exact commit and original bytes."""
    validate_reference(ref, expected_raw)
    commit = api.get('/git/commits/' + ref['commit'])
    need(commit.get('sha') == ref['commit'], 'Wrong remote commit')
    tree_sha = commit.get('tree', {}).get('sha')
    need(isinstance(tree_sha, str) and re.fullmatch(r'[0-9a-f]{40}', tree_sha), 'Missing exact commit tree')
    tree = api.get('/git/trees/' + tree_sha + '?recursive=1')
    need(tree.get('sha') == tree_sha and tree.get('truncated') is False and type(tree.get('tree')) is list,
         'Incomplete exact commit tree')
    matches = [row for row in tree['tree'] if type(row) is dict and row.get('path') == ref['path']]
    need(len(matches) == 1 and matches[0].get('type') == 'blob' and matches[0].get('mode') == '100644'
         and matches[0].get('sha') == ref['git_blob_sha'], 'Wrong tree blob or symlink/executable evidence')
    value = api.bound_json({'path': ref['path'], 'sha256': ref['sha256']}, ref['commit'])
    need(value == raw_record(expected_raw), 'Remote JSON differs from exact expected bytes')
    return {'status': 'IMMUTABLE_REMOTE_BYTES_READ_BACK', 'reference': dict(ref),
            'remote_bytes_verified': True, **BOUNDARY}


def persist_ticket(attempt, kind, value):
    # Local ticket only prevents this host's blind publication retry; it is never
    # a remote sink receipt or proof that the later controlled action ran.
    path_for(attempt, kind)
    root = BASE / 'work'
    for part in (root, *root.parents):
        need(not part.is_symlink() and not (hasattr(part, 'is_junction') and part.is_junction()), 'Linked ticket directory')
    root.mkdir(exist_ok=True)
    folder = root / attempt
    need(not folder.is_symlink() and not (hasattr(folder, 'is_junction') and folder.is_junction()), 'Linked attempt directory')
    folder.mkdir(exist_ok=True)
    with (folder / (kind + '-publication.json')).open('xb') as stream:
        stream.write((json.dumps(value, sort_keys=True) + '\n').encode('utf-8'))
        stream.flush()
        import os
        os.fsync(stream.fileno())


def publish_once(api, attempt, kind, raw, expected_parent):
    """Create-only auxiliary Evidence publication; no action is ever dispatched.

Protected-branch rejection, timeout, existing ticket/file, changed branch parent
or uncertain read-back returns UNKNOWN. An existing remote file is never updated.
"""
    path = path_for(attempt, kind)
    raw_record(raw)
    need(isinstance(expected_parent, str) and re.fullmatch(r'[0-9a-f]{40}', expected_parent), 'Exact expected parent required')
    try:
        persist_ticket(attempt, kind, {'path': path, 'sha256': sha(raw), 'size': len(raw),
                'expected_parent': expected_parent, **BOUNDARY})
        current = api.get('/git/ref/heads/main')
        need(current.get('object', {}).get('sha') == expected_parent, 'Main changed before publication')
        created = api.create_file(path, raw, expected_parent)
        content, commit = created.get('content'), created.get('commit')
        need(type(content) is dict and type(commit) is dict, 'Incomplete publication response')
        need(content.get('path') == path and content.get('sha') == git_blob(raw)
             and type(content.get('size')) is int and content['size'] == len(raw), 'Wrong created file')
        # Contents API has no expected-head CAS. A race can append an immutable
        # evidence file, but cannot release execution: mismatched parent => UNKNOWN.
        need(commit.get('parents') == [{'sha': expected_parent}] or
             (type(commit.get('parents')) is list and len(commit['parents']) == 1
              and commit['parents'][0].get('sha') == expected_parent), 'Publication parent raced; retain UNKNOWN')
        ref = reference(attempt, kind, commit.get('sha'), raw)
        return read_back(api, ref, raw)
    except Exception as exc:
        return {'status': 'UNKNOWN', 'reason': type(exc).__name__, 'path': path,
                'expected_sha256': sha(raw), 'automatic_retry_allowed': False, **BOUNDARY}


def read_result_chain(api, result_ref, result_raw, intent_ref, intent_raw):
    validate_reference(result_ref, result_raw)
    validate_reference(intent_ref, intent_raw)
    need(result_ref['path'].endswith('/result.json') and intent_ref['path'].endswith('/intent.json'), 'Wrong record roles')
    need(result_ref['path'].rsplit('/', 1)[0] == intent_ref['path'].rsplit('/', 1)[0], 'Cross-attempt result')
    value = raw_record(result_raw)
    need(value.get('intent_evidence_ref') == intent_ref, 'Result does not bind exact original Intent')
    need(all(value.get(key) == expected and type(value.get(key)) is type(expected)
             for key, expected in BOUNDARY.items()), 'Auxiliary result cannot claim authority')
    intent_proof = read_back(api, intent_ref, intent_raw)
    result_proof = read_back(api, result_ref, result_raw)
    return {'status': 'IMMUTABLE_INTENT_RESULT_CHAIN_READ_BACK',
            'intent': intent_proof, 'result': result_proof, **BOUNDARY}


def formal_run(*_args, **_kwargs):
    return {'status': 'BLOCKED', 'reason': 'Actual accepted Root/Profile/GA/current revocation/budget/action driver not wired',
            'side_effects_dispatched': 0, **BOUNDARY}


if __name__ == '__main__':
    # No CLI publication or execution entry: root integrates these functions only
    # after exact independent review, with its existing trusted host transport.
    print(json.dumps(formal_run()))
