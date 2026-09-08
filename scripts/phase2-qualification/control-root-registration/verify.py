"""Candidate read-only registration verifier; never issues a root, GA or result.

GitHub API verification is reused as explicitly authorized, not represented as
local OpenPGP verification. Operational bindings may be supplied after signing;
the independently accepted subject digest remains immutable (no SHA cycle).
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

REPOSITORY = 'tdoljyj/cross-memory-system'
OWNER = 'tdoljyj'
REVIEWER = '/root/project_list_auth_fix'
BASE = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/'
DOMAIN = BASE + 'runtime-evidence/control-root-registration/'
CANDIDATE = BASE + 'ControlRootRegistrationCandidate.json'
PROPOSAL_SHA = 'f655e8a16f428bbccfca3687c28e31bc57aed0e7a9fd9ac0191648266afec533'
APPROVAL_SHA = '3d9c4c9e06217c7c2ef0d32dba77bb5aa66bd745a8f92f0ea255b19a95127aea'
OWNER_EXPIRES = '2026-09-09T09:28:59Z'
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_HISTORY_COMMITS = 256  # Reader resource bound, never a truncated-history success.


class Blocked(ValueError):
    pass


def need(condition, reason):
    if not condition:
        raise Blocked(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(',', ':'), allow_nan=False) + '\n').encode()


def strict_json(raw):
    need(len(raw) <= MAX_JSON_BYTES, 'JSON size exceeds candidate reader bound')
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'Duplicate JSON field')
            out[key] = value
        return out
    def no_float(_):
        raise Blocked('Floating point values unsupported in registration encoding')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_float=no_float, parse_constant=no_float)


def safe_path(value):
    need(isinstance(value, str) and value and '\\' not in value and ':' not in value,
         'Invalid repository path')
    need(not value.startswith('/') and all(p not in ('', '.', '..') for p in value.split('/')),
         'Repository path traversal')
    return value


def timestamp(value):
    need(isinstance(value, str), 'Missing timestamp')
    value = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(value.tzinfo is not None, 'Timestamp timezone required')
    return value


def within_window(start, end, now):
    start, end = timestamp(start), timestamp(end)
    need(start <= now < end <= timestamp(OWNER_EXPIRES), 'Expired, future or expanded Owner window')


def validate_candidate(candidate, expected_subject_sha):
    need(re.fullmatch(r'[0-9a-f]{64}', expected_subject_sha or ''), 'Expected subject digest required')
    subject = candidate['subject']
    need(sha(canonical(subject)) == expected_subject_sha == candidate['subject_sha256'], 'Subject digest mismatch')
    for key, expected in {
        'object_type': 'ControlTrustRootSet', 'record_state': 'CANDIDATE_NOT_REGISTERED',
        'purpose': 'SKILL_COEXISTENCE_QUALIFICATION', 'profile_id': 'DP-PREENTRY-SKILL-QUALIFICATION',
        'phase': 'PRE_ENTRY_SKILL_QUALIFICATION', 'environment': 'ISOLATED_TEST',
        'repository': REPOSITORY, 'owner': OWNER, 'signing_service': 'web-flow',
        'independent_reviewer': REVIEWER, 'coordinator': '/root',
        'expires_at': OWNER_EXPIRES, 'no_ga_or_qualification_effect': True, 'old_pins_modified': False,
    }.items():
        need(subject.get(key) == expected, 'Scope or identity mismatch: ' + key)
    need(re.fullmatch(r'ctr_[0-9a-f]{32}', subject['root_set_id']), 'Invalid new root identity')
    need(re.fullmatch(r'ctrgen_[0-9a-f]{32}', subject['generation_id']), 'Invalid new generation identity')
    need(type(subject['generation_ordinal']) is int and subject['generation_ordinal'] == 1
         and subject['predecessor'] is None, 'This candidate is explicitly a first-registration subject')
    need(subject['approval']['sha256'] == APPROVAL_SHA
         and subject['approval']['proposal_sha256'] == PROPOSAL_SHA, 'Wrong Owner proposal/approval')
    need(subject['approval']['path'] == BASE + 'ControlRootRegistrationOwnerApproval.json'
         and subject['approval']['proposal_path'] == BASE + 'ControlRootGenerationBindingProposal.md',
         'Wrong approval source path')
    need(subject['limits'] == {'model_budget': 0, 'paid_budget': 0, 'max_active_isolated_tests': 1,
         'cumulative_controlled_execution_seconds': 7200, 'new_local_evidence_bytes': 1073741824,
         'per_ga_max_seconds': 600}, 'Budget or resource scope expansion')
    namespace = DOMAIN + subject['root_set_id'] + '/'
    need(subject['storage_candidate']['evidence_namespace'] == namespace, 'Evidence namespace mismatch')
    need(subject['storage_candidate']['schema_responsibility'] ==
         'protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json', 'Wrong schema responsibility')
    need(subject['storage_candidate']['uri_template_responsibility'] ==
         'protocol/continuity/v1/manifest.json#/control_uri_templates', 'Wrong URI-template responsibility')
    need(subject['storage_candidate']['business_canonical_effect'] == 'NONE', 'Second Canonical authority forbidden')
    return subject


def verify_merge(commit, pr, expected_sha):
    need(commit['sha'] == expected_sha and re.fullmatch(r'[0-9a-f]{40}', expected_sha), 'Wrong commit')
    need(commit['committer']['login'] == 'web-flow', 'Wrong signing service')
    verification = commit['commit']['verification']
    need(verification.get('verified') is True and verification.get('reason') == 'valid', 'Invalid signature')
    signature = verification.get('signature', '')
    need(signature.startswith('-----BEGIN PGP SIGNATURE-----') and '-----END PGP SIGNATURE-----' in signature,
         'Missing actual signature carrier')
    payload = verification.get('payload', '')
    tree = commit['commit']['tree']['sha']
    need(payload.startswith('tree ' + tree + '\n'), 'Signed tree mismatch')
    parents = [p['sha'] for p in commit['parents']]
    need(len(parents) == 2 and re.findall(r'^parent ([0-9a-f]{40})$', payload.split('\n\n', 1)[0], re.M) == parents,
         'Signed parents mismatch')
    need(pr['merged'] is True and pr['merged_by']['login'] == OWNER and pr['merge_commit_sha'] == expected_sha,
         'Owner merged-PR binding missing')
    need(pr['base']['ref'] == 'main' and pr['base']['repo']['full_name'] == REPOSITORY
         and pr['head']['repo']['full_name'] == REPOSITORY, 'Wrong repository/branch')
    return tree, parents


def verify_chain(records, current_id, first_subject, minimum_generation_id=None):
    need(records, 'Missing generation history')
    previous = None
    seen = set()
    for ordinal, (reference, entry) in enumerate(records, 1):
        need(entry['root_set_id'] == first_subject['root_set_id'], 'Cross-root generation')
        need(type(entry['generation_ordinal']) is int and entry['generation_ordinal'] == ordinal,
             'Generation gap or rollback')
        need(entry['status'] == 'REGISTERED' and entry['generation_id'] not in seen, 'Invalid/repeated generation')
        need(re.fullmatch(r'ctrgen_[0-9a-f]{32}', entry['generation_id']), 'Generation must not be a merge SHA')
        if ordinal == 1:
            need(entry['generation_id'] == first_subject['generation_id'] and entry['predecessor'] is None,
                 'Wrong initial generation')
            need(entry['subject_sha256'] == sha(canonical(first_subject)), 'Initial registration subject mismatch')
        else:
            need(entry['predecessor'] == {'generation_id': previous[1]['generation_id'],
                                         'sha256': previous[0]['sha256']}, 'Broken predecessor binding')
        seen.add(entry['generation_id'])
        previous = (reference, entry)
    need(records[-1][1]['generation_id'] == current_id, 'Current generation rollback')
    if minimum_generation_id:
        need(minimum_generation_id in seen, 'Previously trusted generation absent/rollback')
    return records[-1][1]


def verify_revocations(index, events, root_id, current_id):
    need(index.get('owner_delegation_status') == 'CURRENT_UNREVOKED', 'Owner revocation source missing/unknown')
    for event in events:
        need(event.get('status') == 'REVOKED' and event.get('authority') == OWNER,
             'Unknown or unauthenticated revocation entry')
        need(event.get('target_kind') in ('root_set', 'generation', 'owner_delegation'), 'Unknown revocation target')
        need(event.get('target_id'), 'Missing revocation target')
        if event['target_kind'] == 'owner_delegation' or event['target_id'] in (root_id, current_id):
            raise Blocked('Applicable root/generation/Owner revoked')


class GitHub:
    def __init__(self, executable='gh'):
        self.executable = executable
        self.observations = []
        self.history_commits = {}
        self.history_trees = {}

    def get(self, suffix):
        endpoint = 'repos/' + REPOSITORY + suffix
        result = subprocess.run([self.executable, 'api', '--method', 'GET', endpoint],
                                capture_output=True, timeout=30, check=False)
        need(result.returncode == 0, 'GitHub read unavailable: ' + suffix.split('?')[0])
        value = strict_json(result.stdout)
        self.observations.append({'endpoint': 'https://api.github.com/' + endpoint,
            'observed_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
            'response_sha256': sha(result.stdout)})
        return value

    def bound_json(self, reference, commit):
        path = safe_path(reference['path'])
        need(re.fullmatch(r'[0-9a-f]{64}', reference['sha256']), 'Missing exact content digest')
        obj = self.get('/contents/' + quote(path, safe='/') + '?ref=' + commit)
        need(obj['path'] == path and obj['type'] == 'file' and obj['encoding'] == 'base64', 'Wrong GitHub blob')
        raw = base64.b64decode(''.join(obj['content'].split()), validate=True)
        need(len(raw) == obj['size'] and sha(raw) == reference['sha256'], 'Blob content/size mismatch')
        need(hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == obj['sha'],
             'Git blob identity mismatch')
        return strict_json(raw)

    def merge(self, commit, pr_number):
        need(re.fullmatch(r'[0-9a-f]{40}', commit or '') and type(pr_number) is int and pr_number > 0,
             'Missing actual signed merge/PR')
        return verify_merge(self.get('/commits/' + commit), self.get('/pulls/' + str(pr_number)), commit)

    def tree_paths(self, tree):
        obj = self.get('/git/trees/' + tree + '?recursive=1')
        need(obj.get('truncated') is False, 'Incomplete history/revocation tree')
        return {r['path'] for r in obj['tree'] if r['type'] == 'blob'}

    def require_ancestor(self, ancestor, head):
        result = self.get('/compare/' + ancestor + '...' + head)
        need(result.get('status') in ('ahead', 'identical')
             and result.get('merge_base_commit', {}).get('sha') == ancestor,
             'Signed publication is not an ancestor of current authorized history')

    def history_snapshot(self, commit):
        need(re.fullmatch(r'[0-9a-f]{40}', commit or ''), 'Invalid history commit')
        if commit not in self.history_commits:
            need(len(self.history_commits) < MAX_HISTORY_COMMITS,
                 'Complete history exceeds reader bound; no history conclusion')
            obj = self.get('/git/commits/' + commit)
            need(obj.get('sha') == commit and isinstance(obj.get('parents'), list),
                 'Missing exact full history parent list')
            parents = [p['sha'] for p in obj['parents']]
            need(len(parents) == len(set(parents)) and all(
                re.fullmatch(r'[0-9a-f]{40}', p) for p in parents), 'Invalid history parents')
            tree = obj['tree']['sha']
            need(re.fullmatch(r'[0-9a-f]{40}', tree or ''), 'Missing history tree')
            if tree not in self.history_trees:
                result = self.get('/git/trees/' + tree + '?recursive=1')
                need(result.get('sha') == tree and result.get('truncated') is False,
                     'Incomplete exact history tree')
                scoped = {}
                for row in result['tree']:
                    path = safe_path(row['path'])
                    if path.startswith(DOMAIN) and row['type'] != 'tree':
                        need(row['type'] == 'blob' and row.get('mode') in ('100644', '100755'),
                             'Unsupported history object or link')
                        need(path not in scoped and re.fullmatch(r'[0-9a-f]{40}', row['sha']),
                             'Invalid history blob')
                        scoped[path] = (row['sha'], row['mode'])
                self.history_trees[tree] = scoped
            self.history_commits[commit] = (parents, self.history_trees[tree])
        return self.history_commits[commit]


def verify_empty_domain_history(api, first_parent):
    """Visit every reachable parent; a clean current tree alone is insufficient."""
    pending, empty_ancestors = [first_parent], set()
    while pending:
        commit = pending.pop()
        if commit in empty_ancestors:
            continue
        parents, files = api.history_snapshot(commit)
        need(not files, 'Prior registration domain existed in reachable history')
        empty_ancestors.add(commit)
        pending.extend(parents)
    return empty_ancestors


def verify_immutable_history(api, head, empty_ancestors, namespace):
    """Check every parent edge, including merged branches, to the proven empty boundary."""
    need(empty_ancestors, 'Missing complete prior empty-history boundary')
    pending, checked = [head], set()
    while pending:
        child = pending.pop()
        if child in checked or child in empty_ancestors:
            continue
        parents, child_files = api.history_snapshot(child)
        for parent in parents:
            _, parent_files = api.history_snapshot(parent)
            for path, identity in parent_files.items():
                if path.startswith(namespace) and path != namespace + 'index.json':
                    need(child_files.get(path) == identity,
                         'Immutable generation/event deleted or modified in history')
            pending.append(parent)
        checked.add(child)


def verify_publication_source(api, reference, head):
    publication = reference['publication_commit']
    api.merge(publication, reference['publication_pr'])
    api.require_ancestor(publication, head)
    api.bound_json(reference, publication)
    return publication


def verify_remote(candidate, expected_subject_sha, api, now, minimum_generation_id=None):
    subject = validate_candidate(candidate, expected_subject_sha)
    need(minimum_generation_id, 'Explicit previously trusted minimum generation required; first registration uses its new candidate ID')
    bindings = candidate['bindings']
    for key in ('owner_approval_commit', 'owner_approval_pr', 'registration_commit', 'registration_pr',
                'independent_review_ref', 'formal_store_binding_ref', 'history_index_ref'):
        need(bindings.get(key), 'Missing actual binding: ' + key)
    api.merge(bindings['owner_approval_commit'], bindings['owner_approval_pr'])
    approval = api.bound_json({'path': subject['approval']['path'], 'sha256': APPROVAL_SHA}, bindings['owner_approval_commit'])
    need(approval['verbatim'] == '批准提案限定的登记例外' and approval['proposal']['sha256'] == PROPOSAL_SHA,
         'Wrong explicit Owner approval')
    tree, parents = api.merge(bindings['registration_commit'], bindings['registration_pr'])
    api.require_ancestor(bindings['owner_approval_commit'], bindings['registration_commit'])
    # Full parent history is required: registration followed by deletion is not a first registration.
    empty_ancestors = verify_empty_domain_history(api, parents[0])
    review = api.bound_json(bindings['independent_review_ref'], bindings['registration_commit'])
    need(review.get('state') == 'ACCEPTED_FOR_LIMITED_CONTROL_ROOT_REGISTRATION'
         and review.get('independent_reviewer') == REVIEWER
         and review.get('subject_sha256') == expected_subject_sha,
         'Missing exact independent registration acceptance')
    need(review.get('verifier_sha256') == sha(Path(__file__).read_bytes()), 'Accepted verifier digest mismatch')
    store = api.bound_json(bindings['formal_store_binding_ref'], bindings['registration_commit'])
    namespace = subject['storage_candidate']['evidence_namespace']
    need(store.get('state') == 'ACCEPTED_FOR_NONPRODUCTION_CONTROL_EVIDENCE_STORE_ADAPTER'
         and store.get('independent_reviewer') == REVIEWER and store.get('subject_sha256') == expected_subject_sha
         and store.get('repository') == REPOSITORY and store.get('namespace') == namespace
         and store.get('business_canonical_effect') == 'NONE', 'Formal store mapping missing/wrong')
    need(store.get('protocol_template_ref') and store.get('schema_accepted_ref'), 'Actual accepted Protocol/Schema references absent')
    api.bound_json(store['protocol_template_ref'], bindings['registration_commit'])
    api.bound_json(store['schema_accepted_ref'], bindings['registration_commit'])
    head = api.get('/branches/main')['commit']['sha']
    api.require_ancestor(bindings['registration_commit'], head)
    current = api.get('/commits/' + head)
    prs = api.get('/commits/' + head + '/pulls')
    matches = [pr for pr in prs if pr.get('merge_commit_sha') == head and pr.get('merged_at')]
    need(len(matches) == 1, 'Current signed Owner head cannot be uniquely verified')
    current_tree, _ = verify_merge(current, api.get('/pulls/' + str(matches[0]['number'])), head)
    index_ref = bindings['history_index_ref']
    need(index_ref['path'] == namespace + 'index.json', 'Wrong currentness index')
    index = api.bound_json(index_ref, head)
    need(index.get('namespace') == namespace and index.get('root_set_id') == subject['root_set_id'], 'Wrong index scope')
    within_window(index['as_of'], index['expires_at'], now)
    refs = index['generation_refs'] + index['revocation_refs']
    paths = [safe_path(r['path']) for r in refs]
    need(len(paths) == len(set(paths)) and all(p.startswith(namespace) for p in paths), 'Duplicate/foreign registry ref')
    actual = {p for p in api.tree_paths(current_tree) if p.startswith(namespace)}
    need(actual == set(paths + [index_ref['path']]), 'Incomplete generation/revocation inventory')
    verify_immutable_history(api, head, empty_ancestors, namespace)
    records = [(r, api.bound_json(r, head)) for r in index['generation_refs']]
    latest = verify_chain(records, index['current_generation_id'], subject, minimum_generation_id)
    for reference, entry in records:
        # Publication links live in the later index, not inside their own commit.
        publication = verify_publication_source(api, reference, head)
        accepted = api.bound_json(reference['independent_review_ref'], publication)
        need(accepted.get('state') == 'ACCEPTED_FOR_LIMITED_CONTROL_ROOT_REGISTRATION'
             and accepted.get('independent_reviewer') == REVIEWER
             and accepted.get('root_set_id') == subject['root_set_id']
             and accepted.get('generation_sha256') == reference['sha256'], 'Generation lacks exact independent acceptance')
        need(timestamp(entry['not_before']) < timestamp(entry['expires_at']) <= timestamp(OWNER_EXPIRES),
             'Invalid historical generation window')
    # Historical expiry does not erase valid history or grant current authority.
    within_window(latest['not_before'], latest['expires_at'], now)
    events = [api.bound_json(r, head) for r in index['revocation_refs']]
    verify_revocations(index, events, subject['root_set_id'], latest['generation_id'])
    need(api.get('/branches/main')['commit']['sha'] == head, 'Currentness changed during read; retry as a new query')
    return {'status': 'REGISTERED_BINDING_READBACK_VERIFIED_NO_GATE_AUTHORITY',
            'root_set_id': subject['root_set_id'], 'generation_id': latest['generation_id'],
            'subject_sha256': expected_subject_sha, 'current_main_commit': head,
            'observed_at_utc': now.isoformat(), 'authority_effect': 'NO_GA_NO_QUALIFICATION',
            'scope': 'Point-in-time readback only; no lease, side-effect gate or ongoing revocation guarantee',
            'observations': api.observations}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--expected-subject-sha256', required=True)
    parser.add_argument('--shape-only', action='store_true')
    parser.add_argument('--minimum-generation-id')
    parser.add_argument('--gh-executable', default='gh')
    args = parser.parse_args()
    try:
        candidate = strict_json(Path(args.candidate).read_bytes())
        validate_candidate(candidate, args.expected_subject_sha256)
        result = {'status': 'CANDIDATE_SHAPE_VALID_NOT_REGISTERED', 'authority_effect': 'NONE'} if args.shape_only else verify_remote(
            candidate, args.expected_subject_sha256, GitHub(args.gh_executable), dt.datetime.now(dt.timezone.utc), args.minimum_generation_id)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (Blocked, KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'BLOCKED', 'authority_effect': 'NONE', 'reason': str(error)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
