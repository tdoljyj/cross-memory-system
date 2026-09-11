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
import threading
from urllib.parse import quote

BASE = Path(__file__).resolve().parent
VERIFIER = BASE.parent / 'kernel-phase2-repo/scripts/phase2-qualification/control-root-registration/verify.py'
VERIFIER_SHA = '040ef7b7a8536d6b210ada9a15a26af6749e58c5da10cd401b98c36155373093'
if hashlib.sha256(VERIFIER.read_bytes()).hexdigest() != VERIFIER_SHA:
    raise RuntimeError('Existing exact GitHub verifier changed')
spec = importlib.util.spec_from_file_location('existing_control_source_verifier', VERIFIER)
existing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(existing)
PREFIX = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/'
REPOSITORY = 'tdoljyj/cross-memory-system'
BRANCH = 'codex/phase2-qualification-evidence-20260908'
REF = 'refs/heads/' + BRANCH
COMMIT_IDENTITY = {'name': 'Codex@DESK-W-591', 'email': 'codex@local'}
KINDS = ('result',)
MAX_BYTES = 4000000  # Bounded V6 Evidence-only candidate; legacy and Root limits unchanged.
MAX_TRANSPORT_JSON_BYTES = 8388608
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


def strict_transport_json(raw):
    """Evidence-only request/blob-response parser; original Root reader stays unchanged."""
    need(type(raw) is bytes and 0 < len(raw) <= MAX_TRANSPORT_JSON_BYTES, 'Explicit Evidence transport JSON bound')
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'Duplicate JSON field')
            out[key] = value
        return out
    def no_float(_):
        raise Unknown('Floating point values unsupported in Evidence encoding')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_float=no_float, parse_constant=no_float)


def path_for(attempt, kind):
    need(isinstance(attempt, str) and re.fullmatch(r'original-inputs-[a-f0-9]{32}', attempt), 'Invalid fixed attempt path')
    need(kind in KINDS, 'Only auxiliary intent/result/recovery evidence allowed')
    return PREFIX + attempt + '/' + kind + '.json'


def raw_record(raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'Bounded exact JSON bytes required')
    value = strict_transport_json(raw)  # raw_record already enforces the separate 4,000,000-byte Evidence bound.
    need(type(value) is dict and set(value) == {'kind', 'ga_raw', 'observation_raw', 'runtime_acceptance_raw', 'qualification_raw'}
         and value.get('kind') == 'ACTUAL_VERIFIER_ORIGINAL_INPUTS'
         and all(type(value[k]) is str for k in ('ga_raw', 'observation_raw', 'runtime_acceptance_raw', 'qualification_raw')),
         'Only complete original verifier input bytes')
    return value


def reference(attempt, kind, commit, raw):
    value = raw_record(raw)
    ga = existing.strict_json(value['ga_raw'].encode('utf-8'))
    need(type(ga) is dict and ga.get('gate_authorization_id') == 'ga_' + attempt.removeprefix('original-inputs-'), 'Exact same GA input publication')
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
        self.publication_objects = {}

    def read_input_blob(self, ref):
        # Only the exact immutable id selected by the already checked commit/path tree.
        need(type(ref) is dict and ref.get('repository') == REPOSITORY
             and re.fullmatch(r'[0-9a-f]{40}', ref.get('git_blob_sha', ''))
             and type(ref.get('size')) is int and 0 < ref['size'] <= MAX_BYTES,
             'Exact bounded original-input blob reference')
        private_repository(self)
        process = subprocess.Popen([self.executable, 'api', '--method', 'GET',
                'repos/' + REPOSITORY + '/git/blobs/' + ref['git_blob_sha']],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, errors, failures = [], [], []
        def drain(stream, chunks, limit, label):
            count = 0
            try:
                while True:
                    piece = stream.read1(65536)
                    if not piece:
                        break
                    count += len(piece)
                    if count > limit:
                        failures.append(label)
                        process.kill()
                        break
                    chunks.append(piece)
            except Exception as exc:
                failures.append(type(exc).__name__)
                if process.poll() is None:
                    process.kill()
        readers = [threading.Thread(target=drain, args=(process.stdout, output, MAX_TRANSPORT_JSON_BYTES, 'Evidence blob response limit'), daemon=True),
                   threading.Thread(target=drain, args=(process.stderr, errors, 65536, 'Evidence blob stderr limit'), daemon=True)]
        for reader in readers:
            reader.start()
        try:
            code = process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            failures.append('Evidence blob read timeout')
            process.kill()
            code = process.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=5)
        need(all(not reader.is_alive() for reader in readers), 'Evidence blob stream did not close')
        process.stdout.close()
        process.stderr.close()
        need(not failures and code == 0, 'Immutable Evidence blob read unavailable: ' + ','.join(failures))
        response_raw = b''.join(output)
        obj = strict_transport_json(response_raw)
        need(type(obj) is dict and obj.get('sha') == ref['git_blob_sha']
             and obj.get('encoding') == 'base64' and type(obj.get('size')) is int
             and obj['size'] == ref['size'] and type(obj.get('content')) is str,
             'Exact immutable blob response fields')
        original = base64.b64decode(''.join(obj['content'].split()), validate=True)
        need(len(original) == ref['size'] and sha(original) == ref['sha256']
             and git_blob(original) == ref['git_blob_sha'], 'Exact full original-input blob bytes')
        self.observations.append({'endpoint': 'https://api.github.com/repos/' + REPOSITORY + '/git/blobs/' + ref['git_blob_sha'],
                'observed_at_utc': existing.dt.datetime.now(existing.dt.timezone.utc).isoformat(),
                'response_sha256': sha(response_raw)})
        return original

    def _write(self, stage, body):
        private_repository(self)
        method, suffix, status = {
            'blob': ('POST', '/git/blobs', 201), 'tree': ('POST', '/git/trees', 201),
            'commit': ('POST', '/git/commits', 201),
            'ref': ('PATCH', '/git/refs/heads/' + BRANCH, 200),
        }[stage]
        if stage == 'blob':
            need(type(body) is dict and set(body) == {'encoding', 'content'}
                 and body['encoding'] == 'base64' and type(body['content']) is str
                 and len(body['content']) <= 4 * ((MAX_BYTES + 2) // 3),
                 'Bounded original-input base64 request before serialization')
        request_raw = json.dumps(body).encode('utf-8')
        need(len(request_raw) <= MAX_TRANSPORT_JSON_BYTES, 'Explicit Evidence API request bound')
        response = subprocess.run([self.executable, 'api', '--method', method, '--include',
                'repos/' + REPOSITORY + suffix, '--input', '-'],
                input=request_raw, capture_output=True, timeout=30, check=False)
        need(response.returncode == 0, 'Publication response unknown/failed; never retry automatically')
        normalized = response.stdout.replace(b'\r\n', b'\n')
        header, separator, body = normalized.partition(b'\n\n')
        need(separator and re.match(rb'^HTTP/[^ ]+ ' + str(status).encode() + rb'(?: |\n|$)', header), 'Unexpected Git object/ref response')
        value = strict_transport_json(body)  # Evidence response only; never modifies the Root parser.
        need(type(value) is dict, 'Missing Git object/ref response')
        return value

    def create_file(self, path, raw, expected_parent):
        # No branch-creation endpoint, main mutation, arbitrary ref or force update.
        need(isinstance(path, str) and path.startswith(PREFIX), 'Write outside fixed evidence scope')
        parts = path[len(PREFIX):].split('/')
        need(len(parts) == 2 and parts[1] in [k + '.json' for k in KINDS], 'Invalid evidence target')
        attempt, kind = parts[0], parts[1][:-5]
        need(reference(attempt, kind, expected_parent, raw)['path'] == path, 'Invalid exact target')
        self.publication_objects = {}
        private_repository(self)
        require_head(self, expected_parent)
        parent = self.get('/git/commits/' + expected_parent)
        need(parent.get('sha') == expected_parent, 'Wrong parent commit')
        parent_tree = parent.get('tree', {}).get('sha')
        old_leaves = tree_leaves(self, parent_tree)
        need(path not in old_leaves, 'Existing target never overwritten')
        def remember(stage, identity):
            need(isinstance(identity, str) and re.fullmatch(r'[0-9a-f]{40}', identity), 'Invalid created Git object')
            self.publication_objects[stage] = identity
            persist_ticket(attempt, kind, {'path': path, 'expected_parent': expected_parent,
                    'objects': dict(self.publication_objects), **BOUNDARY}, phase=stage)
        blob = self._write('blob', {'encoding': 'base64', 'content': base64.b64encode(raw).decode('ascii')})
        need(blob.get('sha') == git_blob(raw), 'Wrong created blob')
        remember('blob', blob['sha'])
        tree = self._write('tree', {'base_tree': parent_tree,
                'tree': [{'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']}]})
        remember('tree', tree.get('sha'))
        expected_leaves = {**old_leaves, path: ('100644', 'blob', blob['sha'])}
        need(tree_leaves(self, tree['sha']) == expected_leaves, 'Tree changes beyond one new Evidence blob')
        commit = self._write('commit', {'message': '[Codex@DESK-W-591] append ' + path,
                'author': dict(COMMIT_IDENTITY), 'committer': dict(COMMIT_IDENTITY),
                'tree': tree['sha'], 'parents': [expected_parent]})
        remember('commit', commit.get('sha'))
        need(commit_identity_valid(commit), 'Exact author/committer identity missing')
        need(commit.get('tree', {}).get('sha') == tree['sha'] and type(commit.get('parents')) is list
             and len(commit['parents']) == 1 and commit['parents'][0].get('sha') == expected_parent,
             'Commit is not the exact single-parent successor')
        require_head(self, expected_parent)
        updated = self._write('ref', {'sha': commit['sha'], 'force': False})
        need(updated.get('ref') == REF and updated.get('object', {}).get('sha') == commit['sha'], 'Ref update outcome unknown')
        require_head(self, commit['sha'])
        return {'content': {'path': path, 'sha': blob['sha'], 'size': len(raw)}, 'commit': commit}


def private_repository(api):
    repository = api.get('')
    need(type(repository) is dict and repository.get('full_name') == REPOSITORY
         and repository.get('private') is True, 'Exact private repository required')


def commit_identity_valid(commit):
    return (type(commit) is dict and all(type(commit.get(role)) is dict
            and all(commit[role].get(key) == value for key, value in COMMIT_IDENTITY.items())
            for role in ('author', 'committer')))


def require_head(api, expected):
    current = api.get('/git/ref/heads/' + BRANCH)
    need(type(current) is dict and current.get('ref') == REF and type(current.get('object')) is dict
         and current['object'].get('type') == 'commit' and current['object'].get('sha') == expected,
         'Fixed evidence branch missing or head changed')


def tree_leaves(api, identity):
    need(isinstance(identity, str) and re.fullmatch(r'[0-9a-f]{40}', identity), 'Missing exact tree')
    tree = api.get('/git/trees/' + identity + '?recursive=1')
    need(tree.get('sha') == identity and tree.get('truncated') is False and type(tree.get('tree')) is list,
         'Incomplete parent/new tree')
    result = {}
    for row in tree['tree']:
        need(type(row) is dict and isinstance(row.get('path'), str), 'Malformed tree entry')
        if row.get('type') == 'tree':
            continue
        need(row['path'] not in result, 'Duplicate tree entry')
        result[row['path']] = (row.get('mode'), row.get('type'), row.get('sha'))
    return result


def read_back(api, ref, expected_raw):
    """Independent GET after publication, by exact commit and original bytes."""
    validate_reference(ref, expected_raw)
    commit = api.get('/git/commits/' + ref['commit'])
    need(commit.get('sha') == ref['commit'], 'Wrong remote commit')
    need(commit_identity_valid(commit), 'Remote author/committer identity differs')
    tree_sha = commit.get('tree', {}).get('sha')
    need(isinstance(tree_sha, str) and re.fullmatch(r'[0-9a-f]{40}', tree_sha), 'Missing exact commit tree')
    tree = api.get('/git/trees/' + tree_sha + '?recursive=1')
    need(tree.get('sha') == tree_sha and tree.get('truncated') is False and type(tree.get('tree')) is list,
         'Incomplete exact commit tree')
    matches = [row for row in tree['tree'] if type(row) is dict and row.get('path') == ref['path']]
    need(len(matches) == 1 and matches[0].get('type') == 'blob' and matches[0].get('mode') == '100644'
         and matches[0].get('sha') == ref['git_blob_sha']
         and matches[0].get('size') == ref['size'], 'Wrong tree blob or symlink/executable evidence')
    original = api.read_input_blob(ref)
    need(original == expected_raw and raw_record(original) == raw_record(expected_raw),
         'Remote full raw differs from exact expected bytes')
    return {'status': 'IMMUTABLE_REMOTE_BYTES_READ_BACK', 'reference': dict(ref),
            'remote_bytes_verified': True, **BOUNDARY}


def persist_ticket(attempt, kind, value, phase='publication'):
    # Local ticket only prevents this host's blind publication retry; it is never
    # a remote sink receipt or proof that the later controlled action ran.
    path_for(attempt, kind)
    need(phase in ('publication', 'blob', 'tree', 'commit'), 'Invalid fixed progress phase')
    root = BASE / 'work'
    for part in (root, *root.parents):
        need(not part.is_symlink() and not (hasattr(part, 'is_junction') and part.is_junction()), 'Linked ticket directory')
    root.mkdir(exist_ok=True)
    folder = root / attempt
    need(not folder.is_symlink() and not (hasattr(folder, 'is_junction') and folder.is_junction()), 'Linked attempt directory')
    folder.mkdir(exist_ok=True)
    with (folder / (kind + '-' + phase + '.json')).open('xb') as stream:
        stream.write((json.dumps(value, sort_keys=True) + '\n').encode('utf-8'))
        stream.flush()
        import os
        os.fsync(stream.fileno())


def publish_once(api, attempt, kind, raw, expected_parent):
    """Create-only auxiliary Evidence publication; no action is ever dispatched.

Protected-branch rejection, timeout, existing ticket/file, changed branch parent
or uncertain read-back returns UNKNOWN. An existing remote file is never updated.
"""
    # A reused transport is not an attempt journal. Never attribute a prior
    # publication's objects to this attempt when it fails before create_file.
    api.publication_objects = {}
    path = path_for(attempt, kind)
    raw_record(raw)
    need(isinstance(expected_parent, str) and re.fullmatch(r'[0-9a-f]{40}', expected_parent), 'Exact expected parent required')
    try:
        persist_ticket(attempt, kind, {'path': path, 'sha256': sha(raw), 'size': len(raw),
                'expected_parent': expected_parent, **BOUNDARY})
        private_repository(api)
        require_head(api, expected_parent)
        created = api.create_file(path, raw, expected_parent)
        content, commit = created.get('content'), created.get('commit')
        need(type(content) is dict and type(commit) is dict, 'Incomplete publication response')
        need(content.get('path') == path and content.get('sha') == git_blob(raw)
             and type(content.get('size')) is int and content['size'] == len(raw), 'Wrong created file')
        # Single-parent commit + non-force ref update prevents concurrent branch
        # advance from being overwritten. It is not fencing of later external work.
        need(commit.get('parents') == [{'sha': expected_parent}] or
             (type(commit.get('parents')) is list and len(commit['parents']) == 1
              and commit['parents'][0].get('sha') == expected_parent), 'Publication parent raced; retain UNKNOWN')
        ref = reference(attempt, kind, commit.get('sha'), raw)
        return read_back(api, ref, raw)
    except Exception as exc:
        return {'status': 'UNKNOWN', 'reason': type(exc).__name__, 'path': path,
                'expected_sha256': sha(raw), 'automatic_retry_allowed': False,
                'known_immutable_objects': dict(getattr(api, 'publication_objects', {})), **BOUNDARY}


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
