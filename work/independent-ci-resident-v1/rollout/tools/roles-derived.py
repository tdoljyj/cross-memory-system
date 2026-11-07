"""The package's linux.sourceV2.rolesDerivedSha256 for an in-place upgrade (DESIGN §42.3.1 step 4). NON-elevated, no key, writes nothing.

The Linux upgrade tool's stage derives each role policy v3 for the new Source from the INSTALLED one and refuses a package whose
rolesDerivedSha256 differs (ROLES_DERIVED_MISMATCH). This computes the same value with the same code: it loads the frozen tool
linux/bin/clued-ci-upgrade-linux of the commit's tree (which must be the installed tool, else the package is a channel change anyway)
and calls its derive_role and canonical_bytes on root's copy of the installed roles-v3 (configuration linux.installedRoles), the new
record's source-manifest.json and the new commit's blobs (git cat-file, GIT_NO_REPLACE_OBJECTS=1).

The installed copy must be current: every <role>.json hashes to the node's own Linux version facts (roles.<role>.policySha256).

Which copy (DESIGN §63, Task 3ea699f6): the companion's roles-public.json next to the version facts (upgrade/mailbox/responses/),
which a companion of this fix or later rewrites from the live roles-v3 whenever the facts name other role files, so no root export
with UAC is needed any more. It is used whenever it is there and names the facts' generation; then every file must hash to its own
entry AND to the facts (a copy that does not is refused, never passed over). Only when it is absent (a companion older than the fix)
or names another generation (facts newer than the copy, or a rollback to an older companion) is the configured directory used, as
before, and the answer carries a "notice" that says so. Either way every byte is checked against the facts.

  python -I roles-derived.py <tree> <repo> <commit40> <installed roles-v3 copy> <new record source-manifest.json> <ciSourceManifestSha256> <version-facts.json>
"""
import base64, binascii, datetime, hashlib, importlib.machinery, importlib.util, json, os, re, subprocess, sys

TOOL = 'work/independent-ci-resident-v1/linux/bin/clued-ci-upgrade-linux'
ROLES = ('gitleaks', 'trivy', 'contract-placement')
FACTS_CONTRACT = 'clued.independent-ci.linux-version-facts/1'
FACTS_MAX_AGE = datetime.timedelta(hours=1)   # the companion rewrites them every 5 minutes
ROLES_PUBLIC_FILE = 'roles-public.json'        # src/roles-public.mjs
ROLES_PUBLIC_CONTRACT = 'clued.independent-ci.linux-roles-public/1'
ROLES_PUBLIC_NAMES = tuple(n for r in ROLES for n in (r + '.json', r + '.qualification.json'))
ROLES_PUBLIC_MAX_BYTES = 192 * 1024
ROLES_PUBLIC_FILE_MAX_BYTES = 16 * 1024
HEX64 = re.compile(r'[0-9a-f]{64}')


def refuse(code, **detail):
    print(json.dumps({'status': 'REFUSED', 'code': code, **detail}, sort_keys=True))
    sys.exit(1)


def load_tool(tree, installed_sha):
    """The commit's frozen tool, loaded (which executes it) only once its bytes are known to be the installed tool's."""
    path = os.path.join(tree, *TOOL.split('/'))
    tool_sha = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if tool_sha != installed_sha:
        refuse('LINUX_UPGRADE_TOOL_IS_NOT_THE_INSTALLED_ONE', tree=tool_sha, installed=installed_sha)
    # Writes nothing, not even the bytecode cache: loading would otherwise leave linux/bin/__pycache__ in the commit's tree, which
    # build-upgrade.ps1 reuses on purpose and checks blob by blob (tree.py), so the next attempt for the same commit was refused
    # (TREE_NOT_THE_COMMIT_FILES, the generation 12 package, 2026-11-06). `python -I` ignores PYTHONDONTWRITEBYTECODE.
    sys.dont_write_bytecode = True
    loader = importlib.machinery.SourceFileLoader('clued_ci_upgrade_linux', path)
    spec = importlib.util.spec_from_loader('clued_ci_upgrade_linux', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod, tool_sha


def read_copy(roles_dir, role, name, extra=None):
    """One file of root's copy of the installed roles-v3. A copy not made yet (an empty or missing public-six directory: the root
    export of THIS generation has not run) is a refusal with its code, never a traceback."""
    path = os.path.join(roles_dir, name)
    try:
        return open(path, 'rb').read()
    except FileNotFoundError:
        refuse('INSTALLED_ROLES_COPY_MISSING', role=role, file=name, dir=roles_dir, **(extra or {}))
    except OSError as e:
        refuse('INSTALLED_ROLES_COPY_UNREADABLE', role=role, file=name, error=type(e).__name__, **(extra or {}))


def companion_copy(facts_file, generation):
    """(files, notice): the six files of the companion's roles-public.json as {name: bytes}, or (None, notice) when it is absent or
    names another generation than the facts. A copy that is there for this generation but is not well formed, or whose bytes do not
    hash to its own entries, is a refusal (ROLES_PUBLIC_COPY_REFUSED): someone changed it, and it is never passed over."""
    path = os.path.join(os.path.dirname(os.path.abspath(facts_file)), ROLES_PUBLIC_FILE)
    try:
        with open(path, 'rb') as f:
            raw = f.read(ROLES_PUBLIC_MAX_BYTES + 1)
    except FileNotFoundError:
        return None, {'code': 'ROLES_PUBLIC_COPY_MISSING', 'copy': path,
                      'hint': 'the installed companion does not write the role copy (older than Task 3ea699f6): the configured '
                              'linux.installedRoles directory, a root export of this generation, is used instead'}
    except OSError as e:
        refuse('ROLES_PUBLIC_COPY_REFUSED', copy=path, error=type(e).__name__)
    try:
        if not 0 < len(raw) <= ROLES_PUBLIC_MAX_BYTES:
            raise ValueError('size')
        doc = json.loads(raw.decode('utf-8'))
        if not isinstance(doc, dict) or set(doc) != {'contract', 'generation', 'factsObservedAt', 'observedAt', 'files'} \
                or doc['contract'] != ROLES_PUBLIC_CONTRACT or type(doc['generation']) is not int \
                or not isinstance(doc['files'], dict) or set(doc['files']) != set(ROLES_PUBLIC_NAMES):
            raise ValueError('shape')
    except ValueError:   # UnicodeDecodeError and json.JSONDecodeError are ValueErrors too
        refuse('ROLES_PUBLIC_COPY_REFUSED', copy=path)
    if type(generation) is not int or doc['generation'] != generation:
        return None, {'code': 'ROLES_PUBLIC_COPY_OTHER_GENERATION', 'copy': path, 'copyGeneration': doc['generation'], 'factsGeneration': generation,
                      'hint': 'the companion rewrites the copy right after the first facts of a new generation (minutes after a switch): '
                              'retry shortly; until then the configured linux.installedRoles directory is used'}
    files = {}
    for name in ROLES_PUBLIC_NAMES:
        entry = doc['files'][name]
        try:
            if not isinstance(entry, dict) or set(entry) != {'sha256', 'base64'} or not isinstance(entry['sha256'], str) \
                    or not HEX64.fullmatch(entry['sha256']) or not isinstance(entry['base64'], str):
                raise ValueError('entry')
            data = base64.b64decode(entry['base64'].encode('ascii'), validate=True)
        except (ValueError, binascii.Error):   # UnicodeEncodeError is a ValueError
            refuse('ROLES_PUBLIC_COPY_REFUSED', copy=path, file=name)
        if not 0 < len(data) <= ROLES_PUBLIC_FILE_MAX_BYTES or hashlib.sha256(data).hexdigest() != entry['sha256']:
            refuse('ROLES_PUBLIC_COPY_REFUSED', copy=path, file=name)
        files[name] = data
    return files, None


def main(argv):
    if len(argv) != 7:
        refuse('USAGE')
    tree, repo, commit, roles_dir, manifest_file, ci_sha, facts_file = argv
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[0-9a-f]{64}', ci_sha):
        refuse('USAGE')
    try:
        facts = json.load(open(facts_file, encoding='utf-8'))
    except (OSError, ValueError):   # missing, unreadable or not JSON: the same refusal as a wrong shape
        refuse('LINUX_VERSION_FACTS_REFUSED')
    if not isinstance(facts, dict) or facts.get('contract') != FACTS_CONTRACT or not isinstance(facts.get('roles'), dict):
        refuse('LINUX_VERSION_FACTS_REFUSED')
    try:
        observed = datetime.datetime.fromisoformat(str(facts.get('observedAt')).replace('Z', '+00:00'))
    except ValueError:
        refuse('LINUX_VERSION_FACTS_REFUSED')
    if observed.tzinfo is None:   # a time without its zone cannot be compared
        refuse('LINUX_VERSION_FACTS_REFUSED')
    if abs(datetime.datetime.now(datetime.timezone.utc) - observed) > FACTS_MAX_AGE:
        refuse('LINUX_VERSION_FACTS_NOT_FRESH', observedAt=facts.get('observedAt'))
    tool, tool_sha = load_tool(tree, facts.get('upgradeToolSha256'))
    manifest_bytes = open(manifest_file, 'rb').read()
    if hashlib.sha256(manifest_bytes).hexdigest() != ci_sha:
        refuse('NEW_SOURCE_MANIFEST_IS_NOT_THE_PACKAGES')
    new_manifest = json.loads(manifest_bytes.decode('utf-8'))
    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')

    def file_sha(rel):
        tool.safe_rel(rel)
        # a regular file with content, as the stage's read_regular demands of the checkout (no link, never empty)
        t = subprocess.run(['git', '-C', repo, 'ls-tree', commit, '--', rel], capture_output=True, text=True, env=env)
        mode = t.stdout.split(' ', 1)[0] if t.returncode == 0 and t.stdout else None
        if mode is None:
            refuse('PINNED_FILE_MISSING_IN_NEW_COMMIT', path=rel)
        if mode not in ('100644', '100755'):
            refuse('PINNED_FILE_NOT_A_REGULAR_FILE', path=rel, mode=mode)
        p = subprocess.run(['git', '-C', repo, 'cat-file', 'blob', f'{commit}:{rel}'], capture_output=True, env=env)
        if p.returncode != 0 or not p.stdout:
            refuse('PINNED_FILE_MISSING_IN_NEW_COMMIT' if p.returncode else 'PINNED_FILE_EMPTY', path=rel)
        return hashlib.sha256(p.stdout).hexdigest()

    companion, notice = companion_copy(facts_file, facts.get('generation'))
    origin = {'copySource': 'companion' if companion is not None else 'configured-directory', **({'notice': notice} if notice else {})}

    def copy_bytes(role, name):
        return companion[name] if companion is not None else read_copy(roles_dir, role, name, origin)

    out = {}
    for role in ROLES:
        pol_bytes = copy_bytes(role, role + '.json')
        want = (facts['roles'].get(role) or {}).get('policySha256')
        if hashlib.sha256(pol_bytes).hexdigest() != want:
            refuse('INSTALLED_ROLES_COPY_NOT_CURRENT', role=role, **origin)
        q_bytes = copy_bytes(role, role + '.qualification.json')
        if hashlib.sha256(q_bytes).hexdigest() != ((facts['roles'].get(role) or {}).get('qualificationSha256')):
            refuse('INSTALLED_ROLES_COPY_NOT_CURRENT', role=role, file='qualification', **origin)
        q = json.loads(q_bytes.decode('utf-8'))
        if not isinstance(q, dict) or set(q) != {'payload', 'signature'}:
            refuse('INSTALLED_QUALIFICATION_REFUSED', role=role)
        try:
            new_policy, _ = tool.derive_role(role, json.loads(pol_bytes.decode('utf-8')), q['payload'], ci_sha, new_manifest, file_sha)
        except tool.Refused as e:
            refuse(e.code, role=role, **e.detail)
        out[role] = hashlib.sha256(tool.canonical_bytes(new_policy)).hexdigest()
    print(json.dumps({'status': 'ROLES_DERIVED', 'rolesDerivedSha256': out, 'upgradeToolSha256': tool_sha, **origin}, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
