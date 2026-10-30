"""r7 (Task a3701d3d; review BLOCKER-1 of the r7 Linux kit): make-linux-pins-r5c2.py took the external pins of the INSTALLED Linux resident
manifest unchanged. That was right for r5c2 (linux-worker.mjs and prepare-workspaces.py did not change 43883c31..e17a5985), but batch 3
changes both, and continue-after-boot pins every entry of the new manifest against the live files: after the Source switch the old values
would refuse the resident install (RESIDENT_LINUX_PIN_CHANGED) with the old resident already uninstalled.
So: the same paths in the same installed order; an entry under /opt/clued-independent-ci/source-v2/ is pinned to the NEW commit's file
(the Source the same phase B installs there, read from the commit's tree); any other entry (the toolchain node) stays the installed value.
  python -I linux-pins.py pins  <installed-manifest-copy> <out-pins.json> <tree>      (create-only)
  python -I linux-pins.py check <package linux/manifest.json> <installed-manifest-copy> <tree>
      the package's manifest has the installed one's shape: same contract, same paths in the same order, its own four files free to
      change, the source-v2 entries equal to the tree's files and every other external entry equal to the installed one."""
import hashlib, json, os, re, sys

SV2 = '/opt/clued-independent-ci/source-v2/'
sha = lambda b: hashlib.sha256(b).hexdigest()


def load(p):
    m = json.loads(open(p, 'rb').read().decode('utf-8'))
    assert m.get('contract') == 'clued.independent-ci.resident-linux-manifest/2' and set(m) == {'contract', 'files'}, ('MANIFEST_SHAPE', p)
    assert all(set(f) == {'installedPath', 'sha256'} and re.fullmatch(r'[0-9a-f]{64}', f['sha256']) for f in m['files']), ('ENTRY_SHAPE', p)
    return m


def tree_sha(tree, installed_path):
    rel = installed_path[len(SV2):]
    assert rel and '..' not in rel.split('/') and not rel.startswith('/'), ('SOURCE_V2_PATH', installed_path)
    return sha(open(os.path.join(tree, *rel.split('/')), 'rb').read())


def expected(inst, tree):
    return [{'installedPath': f['installedPath'], 'sha256': tree_sha(tree, f['installedPath']) if f['installedPath'].startswith(SV2) else f['sha256']}
            for f in inst['files'][4:]]


mode = sys.argv[1]
if mode == 'pins':
    INST, OUT, TREE = sys.argv[2:5]
    raw = open(INST, 'rb').read()
    inst = load(INST)
    bp = open(os.path.join(TREE, 'work', 'independent-ci-resident-v1', 'tools', 'build-package.mjs'), encoding='utf-8').read()
    own = re.findall(r"\['(?:bin|systemd)/[^']+', '(/[^']+)'\]", bp.split('const LINUX_FILES = [', 1)[1].split('];', 1)[0])
    assert len(own) == 4 and [f['installedPath'] for f in inst['files'][:4]] == own, ('INSTALLED_ORDER_IS_NOT_PACKAGE_FILES_FIRST', own)
    pins = expected(inst, TREE)
    assert all(p['installedPath'].startswith('/') and '..' not in p['installedPath'].split('/') for p in pins)
    with open(OUT, 'x', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(pins, indent=2) + '\n')
    print(json.dumps({'installedManifestSha256': sha(raw), 'entries': len(inst['files']), 'pins': pins, 'out': OUT,
                      'changedFromInstalled': [p['installedPath'] for p, g in zip(pins, inst['files'][4:]) if p['sha256'] != g['sha256']]}, indent=1))
elif mode == 'check':
    PKGM, INST, TREE = sys.argv[2:5]
    a, b = load(PKGM), load(INST)
    assert len(a['files']) == len(b['files']) and [f['installedPath'] for f in a['files']] == [f['installedPath'] for f in b['files']], 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE'
    assert a['files'][4:] == expected(b, TREE), 'LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE'
    print(json.dumps({'linuxOwnFilesChanged': [f['installedPath'] for f, g in zip(a['files'][:4], b['files'][:4]) if f['sha256'] != g['sha256']],
                      'externalPinsChanged': [f['installedPath'] for f, g in zip(a['files'][4:], b['files'][4:]) if f['sha256'] != g['sha256']],
                      'externalPins': len(a['files'][4:])}))
else:
    sys.exit('MODE_REQUIRED')
