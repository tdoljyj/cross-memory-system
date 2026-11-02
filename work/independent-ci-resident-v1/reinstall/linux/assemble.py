"""Assemble linux\\<in-name>\\ for prep.py from one built package: the record files and the Source v2 installer of the package, the
package's linux/upgrade-v1/** as linux-pkg/upgrade-v1/** and its Linux resident files as linux-res-pkg/**, the tree's
install/verify/uninstall-resident-linux.sh, the committed helper tools (check-host.py, verify-signed.mjs, derive-roles.py), and a bare
repo whose HEAD and only ref (refs/heads/accepted) is the accepted commit. Create-only.
  python -I assemble.py <config.json> <package-dir> <repo> <in-name>"""
import hashlib, json, os, shutil, subprocess, sys

import importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('rconfig', os.path.join(HERE, '..', 'tools', 'rconfig.py'))
rconfig = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(rconfig)
R = rconfig.load(sys.argv[1])['workDir']
PKG, REPO, NAME = sys.argv[2:5]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
COMMIT = json.load(open(os.path.join(PKG, 'record', 'source-manifest.json'), encoding='utf-8'))['sourceSha']
TREE_LINUX = os.path.join(R, 'tree-' + COMMIT[:8], 'work', 'independent-ci-resident-v1', 'linux')
IN = os.path.join(R, 'linux', NAME)
assert not os.path.exists(IN), IN
for d in ('record', 'tools', os.path.join('linux-pkg', 'upgrade-v1', 'bin'), os.path.join('linux-res-pkg', 'bin'), os.path.join('linux-res-pkg', 'systemd')):
    os.makedirs(os.path.join(IN, d))
for f in ('acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json'):
    shutil.copyfile(os.path.join(PKG, 'record', f), os.path.join(IN, 'record', f))
shutil.copyfile(os.path.join(PKG, 'linux', 'bin', 'clued-ci-install-source-v2'), os.path.join(IN, 'tools', 'clued-ci-install-source-v2'))
for f in ('upgrade-v1/bin/clued-ci-upgrade-linux', 'upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', 'upgrade-v1/manifest.json'):
    shutil.copyfile(os.path.join(PKG, 'linux', *f.split('/')), os.path.join(IN, 'linux-pkg', *f.split('/')))
manifest = json.load(open(os.path.join(PKG, 'package-manifest.json'), encoding='utf-8'))
sv2 = manifest.get('linux', {}).get('sourceV2')
if sv2 is not None:
    assert sv2['commit'] == COMMIT and sv2['bundlePath'] == 'linux/source-v2/source.bundle', 'SOURCE_V2_NOT_THE_ACCEPTED_COMMIT'
    bundle = os.path.join(PKG, 'linux', 'source-v2', 'source.bundle')
    assert sha(bundle) == sv2['bundleSha256'], 'SOURCE_V2_BUNDLE_CHANGED'
    os.makedirs(os.path.join(IN, 'linux-pkg', 'source-v2'))
    shutil.copyfile(bundle, os.path.join(IN, 'linux-pkg', 'source-v2', 'source.bundle'))
for f in ('install-resident-linux.sh', 'verify-resident-linux.sh', 'uninstall-resident-linux.sh'):   # r7: + uninstall
    shutil.copyfile(os.path.join(TREE_LINUX, f), os.path.join(IN, 'tools', f))
# r7: the Linux resident half of the package, laid out as install-resident-linux.sh's FILES expect
for f in ('bin/clued-ci-resident-linux', 'manifest.json', 'systemd/clued-ci-worker@.service', 'systemd/clued-ci-wsprep@.service', 'systemd/clued-ci-archive@.service'):
    shutil.copyfile(os.path.join(PKG, 'linux', *f.split('/')), os.path.join(IN, 'linux-res-pkg', *f.split('/')))
# the committed helper tools, under the names the root scripts use
for src, dst in (('check-host.py', 'check-host-r4.py'), ('verify-signed.mjs', 'verify-signed-r4.mjs'), ('derive-roles.py', 'derive-roles-r7.py')):
    shutil.copyfile(os.path.join(HERE, 'tools', src), os.path.join(IN, 'tools', dst))
git = os.path.join(IN, 'src.git')
subprocess.run(['git', 'init', '-q', '--bare', '--initial-branch=accepted', git], check=True)   # r7 (review BLOCKER-2): HEAD = the only ref
subprocess.run(['git', '-C', git, 'fetch', '-q', '--no-tags', REPO, COMMIT + ':refs/heads/accepted'], check=True)
head = subprocess.run(['git', '-C', git, 'rev-parse', 'refs/heads/accepted'], check=True, capture_output=True, text=True).stdout.strip()
assert head == COMMIT
assert subprocess.run(['git', '-C', git, 'rev-parse', '--verify', 'HEAD^{commit}'], check=True, capture_output=True, text=True).stdout.strip() == COMMIT   # r7
print(json.dumps({'in': IN, 'accepted': head, 'packageManifestSha256': sha(os.path.join(PKG, 'package-manifest.json')),
                  'files': {os.path.relpath(os.path.join(dp, f), IN).replace('\\', '/'): sha(os.path.join(dp, f))
                            for dp, _, fs in os.walk(IN) if 'src.git' not in dp for f in fs}}, indent=1))
