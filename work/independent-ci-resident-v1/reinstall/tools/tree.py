"""The extracted source tree (workDir\\tree-<c8>) is exactly the commit (review 1-4): every file the commit holds, byte for byte (its Git
blob id), and nothing else. Root executes files from this tree, so it is checked every time a tool uses it, never trusted by its name.
  verify(repo, commit, tree)       raises TreeError(code, detail) on any difference
  python -I tree.py <repo> <commit40> <tree>    exit 0 and TREE_IS_THE_COMMIT, else 1 and the difference
"""
import hashlib, json, os, re, subprocess, sys


class TreeError(Exception):
    def __init__(self, code, detail=None):
        super().__init__('%s %s' % (code, detail))
        self.code = code


def blob_id(path):
    with open(path, 'rb') as f:
        data = f.read()
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def verify(repo, commit, tree):
    if not re.fullmatch(r'[0-9a-f]{40}', commit or ''):
        raise TreeError('TREE_COMMIT_40HEX')
    p = subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '-z', '--full-tree', commit], capture_output=True,
                       env=dict(os.environ, GIT_NO_REPLACE_OBJECTS='1'))   # the objects themselves, as root's src.git sees them
    if p.returncode != 0:
        raise TreeError('TREE_COMMIT_NOT_IN_REPO', p.stderr.decode('utf-8', 'replace')[-200:])
    want = {}
    for rec in p.stdout.split(b'\0'):
        if not rec:
            continue
        meta, path = rec.split(b'\t', 1)
        mode, kind, oid = meta.decode().split(' ')
        if kind != 'blob' or mode == '120000':
            raise TreeError('TREE_COMMIT_HAS_NON_FILE_ENTRY', path.decode('utf-8', 'replace'))
        want[path.decode('utf-8')] = oid
    have = set()
    for d, _, files in os.walk(tree):
        for n in files:
            have.add(os.path.relpath(os.path.join(d, n), tree).replace(os.sep, '/'))
    extra, missing = sorted(have - set(want)), sorted(set(want) - have)
    if extra or missing:
        raise TreeError('TREE_NOT_THE_COMMIT_FILES', {'extra': extra[:5], 'missing': missing[:5]})
    for rel, oid in want.items():
        if blob_id(os.path.join(tree, *rel.split('/'))) != oid:
            raise TreeError('TREE_FILE_NOT_THE_COMMIT', rel)
    return len(want)


if __name__ == '__main__':
    try:
        n = verify(*sys.argv[1:4])
    except TreeError as e:
        print(json.dumps({'status': 'REFUSED', 'code': e.code, 'detail': str(e)}))
        sys.exit(1)
    print(json.dumps({'status': 'TREE_IS_THE_COMMIT', 'commit': sys.argv[2], 'files': n}))
