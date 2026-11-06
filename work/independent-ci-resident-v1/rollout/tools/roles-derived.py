"""The package's linux.sourceV2.rolesDerivedSha256 for an in-place upgrade (DESIGN §42.3.1 step 4). NON-elevated, no key, writes nothing.

The Linux upgrade tool's stage derives each role policy v3 for the new Source from the INSTALLED one and refuses a package whose
rolesDerivedSha256 differs (ROLES_DERIVED_MISMATCH). This computes the same value with the same code: it loads the frozen tool
linux/bin/clued-ci-upgrade-linux of the commit's tree (which must be the installed tool, else the package is a channel change anyway)
and calls its derive_role and canonical_bytes on root's copy of the installed roles-v3 (configuration linux.installedRoles), the new
record's source-manifest.json and the new commit's blobs (git cat-file, GIT_NO_REPLACE_OBJECTS=1).

The installed copy must be current: every <role>.json hashes to the node's own Linux version facts (roles.<role>.policySha256).

  python -I roles-derived.py <tree> <repo> <commit40> <installed roles-v3 copy> <new record source-manifest.json> <ciSourceManifestSha256> <version-facts.json>
"""
import datetime, hashlib, importlib.machinery, importlib.util, json, os, re, subprocess, sys

TOOL = 'work/independent-ci-resident-v1/linux/bin/clued-ci-upgrade-linux'
ROLES = ('gitleaks', 'trivy', 'contract-placement')
FACTS_CONTRACT = 'clued.independent-ci.linux-version-facts/1'
FACTS_MAX_AGE = datetime.timedelta(hours=1)   # the companion rewrites them every 5 minutes


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


def read_copy(roles_dir, role, name):
    """One file of root's copy of the installed roles-v3. A copy not made yet (an empty or missing public-six directory: the root
    export of THIS generation has not run) is a refusal with its code, never a traceback."""
    path = os.path.join(roles_dir, name)
    try:
        return open(path, 'rb').read()
    except FileNotFoundError:
        refuse('INSTALLED_ROLES_COPY_MISSING', role=role, file=name, dir=roles_dir)
    except OSError as e:
        refuse('INSTALLED_ROLES_COPY_UNREADABLE', role=role, file=name, error=type(e).__name__)


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

    out = {}
    for role in ROLES:
        pol_bytes = read_copy(roles_dir, role, role + '.json')
        want = (facts['roles'].get(role) or {}).get('policySha256')
        if hashlib.sha256(pol_bytes).hexdigest() != want:
            refuse('INSTALLED_ROLES_COPY_NOT_CURRENT', role=role)
        q_bytes = read_copy(roles_dir, role, role + '.qualification.json')
        if hashlib.sha256(q_bytes).hexdigest() != ((facts['roles'].get(role) or {}).get('qualificationSha256')):
            refuse('INSTALLED_ROLES_COPY_NOT_CURRENT', role=role, file='qualification')
        q = json.loads(q_bytes.decode('utf-8'))
        if not isinstance(q, dict) or set(q) != {'payload', 'signature'}:
            refuse('INSTALLED_QUALIFICATION_REFUSED', role=role)
        try:
            new_policy, _ = tool.derive_role(role, json.loads(pol_bytes.decode('utf-8')), q['payload'], ci_sha, new_manifest, file_sha)
        except tool.Refused as e:
            refuse(e.code, role=role, **e.detail)
        out[role] = hashlib.sha256(tool.canonical_bytes(new_policy)).hexdigest()
    print(json.dumps({'status': 'ROLES_DERIVED', 'rolesDerivedSha256': out, 'upgradeToolSha256': tool_sha}, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
