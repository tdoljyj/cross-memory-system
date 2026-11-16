"""First install of a node's Linux half (Z1; a new node's Linux host qualification is derived from a template node's reviewed
roles-v3, README section 8c). Windows, non-elevated, no WSL: writes the two root scripts the Owner runs in the node's WSL distribution under
`env -i`, and adds to the assembled input directory (linux/assemble.py) the first-install tools and the template.

  phase A (root, NO private key, writes only under $BASE): the node has no Linux CI yet (no Source v2, no roles, no resident, no
          upgrade tool, no Source v1), its toolchain node and its new result key are the configured ones (linux.host), docker, systemd
          and cgroup v2; stages every pinned byte; derives the role policies v3 from the TEMPLATE node's reviewed, signed roles-v3 for
          this record (derive-roles-r7.py: the Source values) and puts in this node's facts (first-node-facts.py); host pins
          (check-host-r4.py); the resident install plan.
  phase B (root, READS THE NEW PRIVATE KEY through sign-first-qualification.mjs; nothing prints it): signs, verifies the signed set
          (verify-signed-r4.mjs), installs Source v2 (clued-ci-install-source-v2 package / --plan / --apply), verifies it (verify-source-v2,
          no Source v1), installs the Linux resident half, the upgrade tool, adopts generation 1 with this package, writes the version
          facts and runs verify-resident-linux. Each step is done once and checked when found done, so running B again continues.

The template: the template node's installed roles-v3 (policies, signed qualifications, formal-source-manifest-v2.json), pinned by that
node's own Linux version facts (roles policySha256 / qualificationSha256, ciSourceManifestSha256), and its public key from the BASE
package's record signers.json (the reviewed package; its SHA-256 is the payloads' resultPublicKeySha256).

  python -I first-install.py <config.json> <commit40> <package-dir> <out-suffix> <in-dir-name> <template-roles-dir> <template-version-facts.json>
      [<the in-dir's path on the node as its WSL sees it, when the in-dir is copied there; default: this machine's /mnt path>]

The generic node package's first install (rollout/fleet/install.mjs prepare on a node without an install receipt; one UAC, the elevated
launcher runs the scripts): --in-dir/--out-dir as prep.py's (the scripts read only <in-dir> and write their evidence, version facts and
review copies only to <out-dir>, which the launcher makes), the template from the version's first-install kit:
  python -I first-install.py <config.json> <commit40> <package-dir> <out-suffix> --in-dir <Windows path> --out-dir <Windows path>
      --template <roles dir> --template-facts <version facts> --template-public <the template's public key PEM>
Then the scripts are <workDir>/linux/A.sh, B.sh and B-resume.sh (B again: B continues where it stopped), take no argument and need no
clean-environment variable (the registrar's fixed environment has none; the dirty-environment check stays); B ends with the launcher's
contract: the evidence (linux-live-manifest.<UTC>.txt) and version facts (linux-version-facts.<UTC>.json) in <out-dir> and
{"status":"LINUX_FIRST_INSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1","evidence":...,"versionFacts":...}. Every local role image's
archive must be in <in-dir>/images (the version's role-image asset): no script is written that would wait for one.
"""
import datetime, hashlib, json, os, re, shlex, shutil, sys

if sys.flags.optimize:   # the gates below are asserts
    sys.exit('RUN_WITHOUT_PYTHON_-O')
import importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod
rconfig = _load('rconfig', os.path.join(HERE, '..', 'tools', 'rconfig.py'))
ARGV = list(sys.argv)
def _take(flag):
    if flag not in ARGV:
        return None
    i = ARGV.index(flag); v = ARGV[i + 1]; del ARGV[i:i + 2]
    return v
IN_DIR, OUT_DIR = _take('--in-dir'), _take('--out-dir')
T_DIR, T_FACTS, T_PUBLIC = _take('--template'), _take('--template-facts'), _take('--template-public')
FLEET = IN_DIR is not None
assert (not FLEET and OUT_DIR is None and T_DIR is None) or (FLEET and None not in (OUT_DIR, T_DIR, T_FACTS, T_PUBLIC) and len(ARGV) == 5), 'FLEET_ARGUMENTS_GO_TOGETHER'
CFG = rconfig.load(ARGV[1])
rconfig.need_first_install_linux(CFG)
R = CFG['workDir']
if FLEET:
    COMMIT, PKG, SUFFIX = ARGV[2:5]
    IN_NAME, TEMPLATE, TFACTS = None, T_DIR, T_FACTS
else:
    COMMIT, PKG, SUFFIX, IN_NAME, TEMPLATE, TFACTS = ARGV[2:8]
    assert re.fullmatch(r'[A-Za-z0-9._-]{1,64}', IN_NAME) and IN_NAME not in ('.', '..'), 'IN_DIR_NAME_SHAPE'
assert re.fullmatch(r'[0-9a-f]{40}', COMMIT) and re.fullmatch(r'[a-z0-9-]{1,20}', SUFFIX), 'ARGUMENT_SHAPE'
DRAFT = SUFFIX.startswith('draft')
assert not (FLEET and DRAFT), 'FLEET_SCRIPTS_ARE_FINAL'
def _wsl(p, code):   # a Windows path the registrar's WslPath rule accepts, as WSL sees it (prep.py's)
    a = os.path.abspath(p)
    assert re.fullmatch(r'[A-Za-z]:(?:\\(?!\.{1,2}(?:\\|$))[A-Za-z0-9._-]*[A-Za-z0-9_-])+', a), code
    return '/mnt/' + a[0].lower() + '/' + a[3:].replace('\\', '/')
WSL_IN = WSL_OUT = None
if FLEET:   # the generic node package: this file's own tree is the unpacked, hash-checked archive of the commit
    WSL_IN, WSL_OUT = _wsl(IN_DIR, 'IN_DIR_PATH_SHAPE'), _wsl(OUT_DIR, 'OUT_DIR_PATH_SHAPE')
    assert IN_DIR.lower() != OUT_DIR.lower() and not (OUT_DIR.lower() + '\\').startswith(IN_DIR.lower() + '\\'), 'OUT_DIR_INSIDE_IN_DIR'
else:
    _load('tree', os.path.join(HERE, '..', 'tools', 'tree.py')).verify(CFG['repo'], COMMIT, os.path.join(R, 'tree-' + COMMIT[:8]))
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
shab = lambda b: hashlib.sha256(b).hexdigest()
ROLES = ('gitleaks', 'trivy', 'contract-placement')
IN = os.path.abspath(IN_DIR) if FLEET else os.path.join(R, 'linux', IN_NAME)
TOOLS = os.path.join(HERE, 'tools')
NODE_SHA = CFG['linux']['host']['toolchainNodeSha256']
PUB_SHA = CFG['linux']['host']['resultPublicKeySha256']
SIGNER = CFG['signer']

# ---- the package is this node's, for this commit, with this node's signer ----
pkg = json.load(open(os.path.join(PKG, 'package-manifest.json'), encoding='utf-8'))
PKG_SHA = sha(os.path.join(PKG, 'package-manifest.json'))
NEW = pkg['ciSourceManifestSha256']
acc = json.load(open(os.path.join(PKG, 'record', 'acceptance.json'), encoding='utf-8'))
src_manifest = json.load(open(os.path.join(PKG, 'record', 'source-manifest.json'), encoding='utf-8'))
NODE_NAME = acc['node']['nodeName']   # the package's record names the node (no configuration does: rconfig has no node key)
assert acc['node']['wslDistribution'] == CFG['linux']['distribution'] and src_manifest['sourceSha'] == COMMIT and sha(os.path.join(PKG, 'record', 'source-manifest.json')) == NEW, 'PACKAGE_NOT_THIS_NODE_AND_COMMIT'
signers = json.load(open(os.path.join(PKG, 'record', 'signers.json'), encoding='utf-8'))['signers']
assert [(s['keyId'], s['runtimeId'], s['publicKeyPem']) for s in signers] == [(SIGNER['keyId'], SIGNER['runtimeId'], SIGNER['publicKeyPem'])], 'PACKAGE_SIGNERS_NOT_THIS_NODES'
REF, HREF, RECEIPT = acc['sourceAcceptanceRef'], acc['hostQualificationRef'], acc['installationReceiptRef']
assert acc['ownerReceiptRef'] == RECEIPT, 'OWNER_RECEIPT_NOT_THE_INSTALLATION_RECEIPT'
PLACEHOLDER = re.compile(r'^(d{8}|e{8})-')
assert DRAFT or not any(PLACEHOLDER.match(x) for x in (REF, HREF, RECEIPT, acc['ownerDecisionRef'])), 'FINAL_SCRIPTS_NEED_THE_REAL_OWNER_REFS'
for role in ROLES:   # derive-roles-r7.py takes the two refs from the record manifest's controllerRelay
    rel = src_manifest['roles'][role]['controllerRelay']
    assert rel['sourceAcceptanceRef'] == REF and rel['hostQualificationRef'] == HREF, ('RECORD_RELAY_REFS', role)

# ---- the template: pinned by the template node's version facts; its public key from the BASE package's record ----
tf = json.load(open(TFACTS, encoding='utf-8'))
assert tf.get('contract') == 'clued.independent-ci.linux-version-facts/1' and tf.get('staged') is None and tf.get('pinsOk') is True, 'TEMPLATE_FACTS_NOT_SETTLED'
assert sha(os.path.join(TEMPLATE, 'formal-source-manifest-v2.json')) == tf['ciSourceManifestSha256'], 'TEMPLATE_MANIFEST_NOT_THE_FACTS'
for role in ROLES:
    assert {'policySha256': sha(os.path.join(TEMPLATE, role + '.json')), 'qualificationSha256': sha(os.path.join(TEMPLATE, role + '.qualification.json'))} == \
        {k: tf['roles'][role][k] for k in ('policySha256', 'qualificationSha256')}, ('TEMPLATE_ROLE_NOT_THE_FACTS', role)
if FLEET:   # the kit's template key (install.mjs readKit held it to every payload); one key for the three
    TEMPLATE_PUB = open(T_PUBLIC, 'rb').read()
    TEMPLATE_KEY_ID = json.load(open(os.path.join(TEMPLATE, ROLES[0] + '.qualification.json'), encoding='utf-8'))['payload']['keyId']
else:
    base_signers = json.load(open(os.path.join(CFG['basePackage'], 'record', 'signers.json'), encoding='utf-8'))['signers']
    base_pm = json.load(open(os.path.join(CFG['basePackage'], 'package-manifest.json'), encoding='utf-8'))
    assert sha(os.path.join(CFG['basePackage'], 'record', 'signers.json')) == {f['target']: f['sha256'] for f in base_pm['files']}.get('record\\signers.json'), 'BASE_SIGNERS_NOT_ITS_PACKAGE'
    assert len(base_signers) == 1, 'BASE_RECORD_HAS_NOT_ONE_SIGNER'
    TEMPLATE_PUB = base_signers[0]['publicKeyPem'].encode('ascii')
    TEMPLATE_KEY_ID = base_signers[0]['keyId']
TEMPLATE_PUB_SHA = shab(TEMPLATE_PUB)
for role in ROLES:
    tq = json.load(open(os.path.join(TEMPLATE, role + '.qualification.json'), encoding='utf-8'))
    assert tq['payload']['resultPublicKeySha256'] == TEMPLATE_PUB_SHA and tq['payload']['keyId'] == TEMPLATE_KEY_ID, ('TEMPLATE_KEY_NOT_THE_BASE_SIGNER', role)
assert TEMPLATE_PUB_SHA != PUB_SHA, 'NODE_KEY_IS_THE_TEMPLATE_KEY'
# the run roots readiness requires as root directories (loadQualifiedPolicyV2); a first install creates them in phase B
ROOTS = ('/var/lib/clued-independent-ci/workspaces', '/var/lib/clued-independent-ci/runs')
# the role images: the worker runs them with --pull=never, so they must be in the node's docker before the first job. A registry
# image pinned by digest is pulled by that digest; a local image id (built on the template node) is loaded from
# <in-dir>/images/<hex>.tar (docker save on the template node); docker checks the id against the loaded content.
PULL_IMAGES, LOCAL_IMAGES = [], []
for role in ROLES:
    tp = json.load(open(os.path.join(TEMPLATE, role + '.json'), encoding='utf-8'))
    assert (tp['workspaceRoot'], tp['runsRoot']) == ROOTS, ('TEMPLATE_RUN_ROOTS', role)
    if re.fullmatch(r'sha256:[0-9a-f]{64}', tp['image']):
        LOCAL_IMAGES += [tp['image'][7:]] if tp['image'][7:] not in LOCAL_IMAGES else []
    else:
        assert re.fullmatch(r'[a-z0-9][a-z0-9./-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}', tp['image']), ('IMAGE_REF_SHAPE', role)
        PULL_IMAGES += [tp['image']] if tp['image'] not in PULL_IMAGES else []

# ---- the assembled input (linux/assemble.py) + the first-install tools, the generated verify-source-v2.sh and the template ----
SIGN_SHA = '2158d29184e7568abb0a24fc62ea1a38c95c13f7b29810f699b1404dcf636cfa'   # sign-qualification.mjs (= prep.py's), imported by the first-install signer
VERIFY_TEMPLATE_SHA = '4dd35484578ebd01c8296543980c095ad7a809690b2713dd4c2354f3f61dcfd9'   # = prep.py's
# the two first-install root tools as reviewed (Z1 review round 1); a change needs a new review and new pins here
SIGN_FIRST_SHA = '03f789904cb1fa6e48af13a6a71dc610c84be6552377c0ae383e408fa4eb50fb'
NODE_FACTS_SHA = 'f315be5aa89498405c5ff4e4d090c9ca08c172b877e59df8ac20b54f6dfe54e5'
assert sha(os.path.join(TOOLS, 'sign-first-qualification.mjs')) == SIGN_FIRST_SHA and sha(os.path.join(TOOLS, 'first-node-facts.py')) == NODE_FACTS_SHA, 'FIRST_INSTALL_TOOLS_CHANGED'
assert sha(os.path.join(TOOLS, 'sign-qualification.mjs')) == SIGN_SHA and sha(os.path.join(TOOLS, 'verify-source-v2.template.sh')) == VERIFY_TEMPLATE_SHA, 'REVIEW_COPY_TOOLS_CHANGED'
for src, name in (('check-host.py', 'check-host-r4.py'), ('verify-signed.mjs', 'verify-signed-r4.mjs'), ('derive-roles.py', 'derive-roles-r7.py')):
    assert sha(os.path.join(IN, 'tools', name)) == sha(os.path.join(TOOLS, src)), ('TOOL_NOT_THE_COMMITTED_ONE', name)
vt = open(os.path.join(TOOLS, 'verify-source-v2.template.sh'), 'rb').read().decode('utf-8')
v2, n1 = re.subn(r'(?m)^COMMIT=[0-9a-f]{40}$', 'COMMIT=' + COMMIT, vt)
v2, n2 = re.subn(r'(?m)^MANIFEST_SHA=[0-9a-f]{64}$', 'MANIFEST_SHA=' + NEW, v2)
assert n1 == 1 and n2 == 1
extra = {'tools/sign-qualification.mjs': open(os.path.join(TOOLS, 'sign-qualification.mjs'), 'rb').read(),
         'tools/sign-first-qualification.mjs': open(os.path.join(TOOLS, 'sign-first-qualification.mjs'), 'rb').read(),
         'tools/first-node-facts.py': open(os.path.join(TOOLS, 'first-node-facts.py'), 'rb').read(),
         'tools/verify-source-v2.sh': v2.encode('utf-8'), 'template/public.pem': TEMPLATE_PUB}
for role in ROLES:
    for n in (role + '.json', role + '.qualification.json'):
        extra['template/' + n] = open(os.path.join(TEMPLATE, n), 'rb').read()
extra['template/formal-source-manifest-v2.json'] = open(os.path.join(TEMPLATE, 'formal-source-manifest-v2.json'), 'rb').read()
os.makedirs(os.path.join(IN, 'template'), exist_ok=True)
for rel, data in extra.items():
    p = os.path.join(IN, *rel.split('/'))
    if os.path.exists(p):
        assert open(p, 'rb').read() == data, ('INPUT_DIFFERS', rel)
    else:
        open(p, 'xb').write(data)

# ---- the package's Linux files and the plans the root scripts must reproduce (as prep.py) ----
assert sha(os.path.join(IN, 'tools', 'clued-ci-install-source-v2')) == sha(os.path.join(PKG, 'linux', 'bin', 'clued-ci-install-source-v2'))
for f in ('acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json'):
    assert sha(os.path.join(IN, 'record', f)) == sha(os.path.join(PKG, 'record', f)), f
LINUX_RES_MANIFEST = pkg['linux']['manifestSha256']
assert LINUX_RES_MANIFEST == sha(os.path.join(PKG, 'linux', 'manifest.json')) == sha(os.path.join(IN, 'linux-res-pkg', 'manifest.json')), 'LINUX_MANIFEST_NOT_THE_PACKAGES'
UPG_FILES = ['upgrade-v1/bin/clued-ci-upgrade-linux', 'upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', 'upgrade-v1/manifest.json']
RES_FILES = ['bin/clued-ci-resident-linux', 'manifest.json', 'systemd/clued-ci-worker@.service', 'systemd/clued-ci-wsprep@.service', 'systemd/clued-ci-archive@.service']
for f in UPG_FILES:
    assert sha(os.path.join(IN, 'linux-pkg', *f.split('/'))) == sha(os.path.join(PKG, 'linux', *f.split('/'))), ('UPGRADE_FILE_NOT_THE_PACKAGES', f)
for f in RES_FILES:
    assert sha(os.path.join(IN, 'linux-res-pkg', *f.split('/'))) == sha(os.path.join(PKG, 'linux', *f.split('/'))), ('RESIDENT_FILE_NOT_THE_PACKAGES', f)
TREE_LINUX = os.path.join(HERE, '..', '..', 'linux') if FLEET else os.path.join(R, 'tree-' + COMMIT[:8], 'work', 'independent-ci-resident-v1', 'linux')
for f in ('install-resident-linux.sh', 'verify-resident-linux.sh'):
    assert sha(os.path.join(IN, 'tools', f)) == sha(os.path.join(TREE_LINUX, f)), ('TOOL_NOT_THE_TREES', f)
UNITS = ['clued-ci-worker@.service', 'clued-ci-wsprep@.service', 'clued-ci-archive@.service']
res_text = '\n'.join(['install-script.sha256=' + sha(os.path.join(IN, 'tools', 'install-resident-linux.sh'))]
                     + [sha(os.path.join(IN, 'linux-res-pkg', *f.split('/'))) + '  ' + f for f in RES_FILES]
                     + ['wsl.conf.boot=enabled', 'pid1=systemd', 'cgroup2=yes', 'opt.exists=no'] + ['unit.' + u + '.exists=no' for u in UNITS])
INSTALL_PLAN = shab(res_text.encode('utf-8'))
upg_text = '\n'.join(['install-script.sha256=' + sha(os.path.join(IN, 'tools', 'install-resident-linux.sh'))]
                     + [sha(os.path.join(IN, 'linux-pkg', *f.split('/'))) + '  ' + f for f in UPG_FILES]
                     + ['resident.exists=yes', 'upgrade-v1.exists=no', 'generation.current.exists=no'])
UPG_PLAN = shab(upg_text.encode('utf-8'))
files = (['tools/' + f for f in ('install-resident-linux.sh', 'verify-resident-linux.sh', 'clued-ci-install-source-v2', 'derive-roles-r7.py', 'verify-signed-r4.mjs',
                                 'check-host-r4.py', 'sign-qualification.mjs', 'sign-first-qualification.mjs', 'first-node-facts.py', 'verify-source-v2.sh')]
         + ['linux-pkg/' + f for f in UPG_FILES] + ['linux-res-pkg/' + f for f in RES_FILES]
         + ['record/' + f for f in ('acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json')]
         + ['template/' + r + s for r in ROLES for s in ('.json', '.qualification.json')] + ['template/formal-source-manifest-v2.json', 'template/public.pem'])
for f in files:
    assert b'\r' not in open(os.path.join(IN, *f.split('/')), 'rb').read(), ('CR', f)
sums = ''.join('%s  %s\n' % (sha(os.path.join(IN, *f.split('/'))), f) for f in files)
# where the node's root shell finds the in-dir: this machine's path as WSL sees it, or (the in-dir copied to the node) the 8th argument
NODE_IN = WSL_IN if FLEET else ARGV[8] if len(ARGV) > 8 else '/mnt/' + IN[0].lower() + '/' + IN[3:].replace('\\', '/')
assert re.fullmatch(r'/[A-Za-z0-9._/-]+', NODE_IN) and '..' not in NODE_IN.split('/'), 'NODE_IN_DIR_SHAPE'
W = shlex.quote(NODE_IN)
BASE = '/root/clued-ci-first-install-' + COMMIT[:8]   # one staging per commit: the package path continues in it (CONTINUE below)
MODS = ['worker/qualification-v2.mjs', 'src/worker-v2.mjs', 'src/job-v2.mjs', 'src/proof.mjs', 'src/queue.mjs']
CI = 'work/actions-hosted-migration/independent-ci-v1'

DOCKER_READY = r"""# Docker may still be starting after the WSL cold boot. Observe only: never
# start/restart a unit, and never turn failed/inactive/unknown into a retry.
docker_ready() {
  local started=$SECONDS remaining state
  while :; do
    remaining=$((60 - (SECONDS - started)))
    [ "$remaining" -gt 0 ] || refuse DOCKER_SERVICE_ACTIVATION_TIMEOUT
    state=$(timeout --signal=KILL "${remaining}s" systemctl show --property=ActiveState --value docker.service) || refuse SYSTEMCTL_FAILED
    case "$state" in
      active) return 0 ;;
      activating)
        [ "$((SECONDS - started))" -lt 60 ] || refuse DOCKER_SERVICE_ACTIVATION_TIMEOUT
        sleep 1 || refuse DOCKER_SERVICE_WAIT_FAILED
        ;;
      *) refuse DOCKER_SERVICE_NOT_ACTIVE ;;
    esac
  done
}
"""

COMMON = DOCKER_READY + r"""set -euo pipefail
set -C   # create-only redirections: no evidence file is ever overwritten
refuse() { echo "{\"status\":\"REFUSED\",\"code\":\"$1\"}"; exit 1; }
@@ENV_GATE@@for v in BASH_ENV ENV NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT PYTHONPATH PYTHONHOME PYTHONSTARTUP GIT_DIR GIT_EXEC_PATH GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT WSLENV; do
  [ -z "${!v+x}" ] || refuse "ENVIRONMENT_NOT_CLEAN:$v"
done
export PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
umask 077
# scripts generated with an out-suffix draft* (placeholder refs allowed) are for reading only and never run
DRAFT=@@DRAFT@@
[ "$DRAFT" = 0 ] || refuse DRAFT_SCRIPTS_ARE_FOR_REVIEW_ONLY
W=@@W@@
@@O_LINE@@BASE=@@BASE@@
STG=$BASE/stg
COMMIT=@@COMMIT@@
NEW_MANIFEST=@@NEW@@
NEW_REF=@@REF@@
HOST_REF=@@HREF@@
RECEIPT_REF=@@RECEIPT@@
case "$NEW_REF $HOST_REF $RECEIPT_REF" in dddddddd-*|eeeeeeee-*|*" dddddddd-"*|*" eeeeeeee-"*) refuse PLACEHOLDER_OWNER_REFS_DRAFT_ONLY ;; esac
PKG_SHA=@@PKG_SHA@@
LINUX_RES_MANIFEST=@@LINUX_RES_MANIFEST@@
UPG_PLAN=@@UPG_PLAN@@
INSTALL_PLAN=@@INSTALL_PLAN@@
KEY_ID=@@KEY_ID@@
RUNTIME_ID=@@RUNTIME_ID@@
TEMPLATE_PUB_SHA=@@TEMPLATE_PUB_SHA@@
UPG=/opt/clued-independent-ci/upgrade-v1
NODE=/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
NODE_SHA=@@NODE_SHA@@
PUB_SHA=@@PUB_SHA@@
SIGN_SHA=@@SIGN_SHA@@
PY=/usr/bin/python3.12
CLEAN="/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C GIT_NO_REPLACE_OBJECTS=1"
[ "$(id -u)" = 0 ] || refuse ROOT_REQUIRED
G() { git --git-dir="$STG/src.git" -c core.hooksPath=/nonexistent "$@"; }
src_git_clean() {
  [ -z "$(find "$STG/src.git" -type l -print -quit)" ] || refuse SRC_GIT_SYMLINK
  for x in refs/replace objects/info/alternates objects/info/http-alternates info/grafts shallow; do [ ! -e "$STG/src.git/$x" ] || refuse "SRC_GIT_FORBIDDEN:$x"; done
  r=$(G for-each-ref --format='%(refname)') || refuse SRC_GIT_REFS_UNREADABLE
  [ "$r" = refs/heads/accepted ] || refuse SRC_GIT_UNEXPECTED_REFS
  h=$(G rev-parse --verify 'HEAD^{commit}') || refuse SRC_GIT_HEAD_UNREADABLE
  [ "$h" = "$COMMIT" ] || refuse SOURCE_REPOSITORY_NOT_THE_ACCEPTED_COMMIT
}
# the host this first install expects: the toolchain node and this node's new result key in place, docker under systemd, cgroup v2
host_ready() {
  [ "$(cat /proc/1/comm)" = systemd ] || refuse SYSTEMD_NOT_PID1
  [ -e /sys/fs/cgroup/cgroup.controllers ] || refuse CGROUP_V2_REQUIRED
  docker_ready
  [ "$(sha256sum "$NODE" | cut -d' ' -f1)" = "$NODE_SHA" ] || refuse TOOLCHAIN_NODE_NOT_THE_CONFIGURED_ONE
  [ "$(sha256sum /etc/clued-independent-ci/verify-result-public.pem | cut -d' ' -f1)" = "$PUB_SHA" ] || refuse RESULT_PUBLIC_KEY_NOT_THE_CONFIGURED_ONE
  [ -f /etc/clued-independent-ci/verify-result-key.pem ] || refuse RESULT_KEY_MISSING
  [ ! -e /var/lib/clued-independent-ci/formal-role.lock ] || refuse ROLE_LOCK_PRESENT
  u=$(systemctl list-units --all --no-legend --plain --state=active,activating,deactivating,reloading 'clued-ci-*') || refuse SYSTEMCTL_FAILED
  [ -z "$u" ] || refuse LINUX_UNITS_ACTIVE
}
"""

A = "#!/bin/bash\n" + r"""# First install of this node's Linux half, phase A (root, NO private key, writes only under $BASE). Commit @@C8@@, node @@NODE_NAME@@.
@@HOW_A@@""" + COMMON + r"""host_ready
@@CONTINUE@@# a first install: nothing of a Linux CI here yet
for p in /opt/clued-independent-ci/source-v2 /opt/clued-independent-ci/resident-v1 /opt/clued-independent-ci/upgrade-v1 \
         /etc/clued-independent-ci/roles-v3 /etc/clued-independent-ci/formal-source-manifest-v2.json \
         /var/lib/clued-independent-ci/resident/source-v2-install-receipt.json /var/lib/clued-independent-ci/resident/upgrade/current.json; do
  [ ! -e "$p" ] || refuse "NOT_A_FIRST_INSTALL:$p"
done
[ -z "$(ls -A /var/lib/clued-independent-ci/runs 2>/dev/null)" ] || refuse RUNS_NOT_EMPTY
@@BASE_GATE@@install -d -o root -g root -m 0700 "$BASE" "$STG" "$STG/tools" "$STG/record" "$STG/template" "$STG/linux-pkg" "$STG/linux-pkg/upgrade-v1" "$STG/linux-pkg/upgrade-v1/bin" "$STG/linux-res-pkg" "$STG/linux-res-pkg/bin" "$STG/linux-res-pkg/systemd"
printf '%s\n' "$PKG_SHA" > "$BASE/package.sha256"
for f in @@FILES@@; do install -o root -g root -m 0400 "$W/$f" "$STG/$f"; done
cp -a --no-preserve=ownership "$W/src.git" "$STG/src.git"
chown -R root:root "$STG/src.git"
rm -rf -- "$STG/src.git/hooks"
rm -f -- "$STG/src.git/config"
printf '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n' > "$STG/src.git/config"
src_git_clean
G fsck --strict --no-dangling --no-progress >/dev/null || refuse SOURCE_REPOSITORY_FSCK_FAILED
cd "$STG"
sha256sum --quiet -c - <<'EOF' || refuse STAGED_BYTES_NOT_THE_REVIEWED_ONES
@@SUMS@@EOF
[ "$(sha256sum "$STG/tools/sign-qualification.mjs" | cut -d' ' -f1)" = "$SIGN_SHA" ] || refuse SIGN_TOOL_NOT_THE_REVIEWED_ONE
[ "$(sha256sum "$STG/template/public.pem" | cut -d' ' -f1)" = "$TEMPLATE_PUB_SHA" ] || refuse TEMPLATE_PUBLIC_KEY_CHANGED
# derive (no key): the template node's reviewed policies v3 and signed payloads, for this record (Source values; every pin checked in the commit)
$CLEAN $PY -I "$STG/tools/derive-roles-r7.py" --installed "$STG/template" --old-manifest-file "$STG/template/formal-source-manifest-v2.json" --new-manifest-file "$STG/record/source-manifest.json" --src "$STG/src.git" --commit "$COMMIT" --source-acceptance-ref "$NEW_REF" --host-acceptance-ref "$HOST_REF" --out "$STG/roles-derived" > "$STG/derive.stdout.json" || { cat "$STG/derive.stdout.json"; refuse DERIVE_FAILED; }
cat "$STG/derive.stdout.json"
# this node's facts (no key): its result signer, its public key, its docker / git / toolchain node
$CLEAN $PY -I "$STG/tools/first-node-facts.py" --in "$STG/roles-derived" --key-id "$KEY_ID" --runtime-id "$RUNTIME_ID" --out "$STG/roles-in" > "$STG/node-facts.stdout.json" || { cat "$STG/node-facts.stdout.json"; refuse NODE_FACTS_FAILED; }
cat "$STG/node-facts.stdout.json"
$CLEAN $PY -I "$STG/tools/check-host-r4.py" "$STG/roles-in" "$NODE_SHA" "$PUB_SHA" > "$STG/host-A.stdout.json" || { cat "$STG/host-A.stdout.json"; refuse HOST_PINS_CHANGED; }
cat "$STG/host-A.stdout.json"
# the resident manifest pins this commit's source-v2 files, the toolchain node and exactly the staged resident files (= prep.py r7)
$CLEAN $PY -I -c 'import json,sys,subprocess,hashlib
m=json.load(open(sys.argv[1])); s="/opt/clued-independent-ci/source-v2/"; e={"PATH":"/usr/bin:/bin","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null"}; bad=[]
own={"/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux":"bin/clued-ci-resident-linux","/etc/systemd/system/clued-ci-worker@.service":"systemd/clued-ci-worker@.service","/etc/systemd/system/clued-ci-wsprep@.service":"systemd/clued-ci-wsprep@.service","/etc/systemd/system/clued-ci-archive@.service":"systemd/clued-ci-archive@.service"}
for f in m["files"]:
  p=f["installedPath"]
  if p.startswith(s):
    b=subprocess.run(["git","--git-dir",sys.argv[2],"cat-file","blob",sys.argv[3]+":"+p[len(s):]],env=e,capture_output=True,check=True).stdout
    bad+=[p] if hashlib.sha256(b).hexdigest()!=f["sha256"] else []
  elif p==sys.argv[4]: bad+=[p] if f["sha256"]!=sys.argv[5] else []
  elif p in own: bad+=[p] if hashlib.sha256(open(sys.argv[6]+"/"+own[p],"rb").read()).hexdigest()!=f["sha256"] else []
  else: bad.append(p)
print(json.dumps({"residentPinsNotTheNewSource":bad})); sys.exit(1 if bad else 0)' "$STG/linux-res-pkg/manifest.json" "$STG/src.git" "$COMMIT" "$NODE" "$NODE_SHA" "$STG/linux-res-pkg" > "$STG/resident-pins.A.stdout.json" || { cat "$STG/resident-pins.A.stdout.json"; refuse RESIDENT_PINS_NOT_THE_NEW_SOURCE; }
# the run roots: absent (phase B creates them) or root directories nobody else can write
for d in @@ROOTS@@; do
  [ ! -e "$d" ] || { [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = 0 ] && [ $(( 0$(stat -c %a "$d") & 022 )) = 0 ]; } || refuse "RUN_ROOT_NOT_ROOT_PROTECTED:$d"
done
# the resident install plan, exactly as generated on Windows
bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --plan "$STG/linux-res-pkg" > "$STG/install-plan.A.stdout.txt" || { cat "$STG/install-plan.A.stdout.txt"; refuse INSTALL_PLAN_REFUSED; }
[ "$(printf '%s' "$(head -n -1 "$STG/install-plan.A.stdout.txt")" | sha256sum | cut -d' ' -f1)" = "$INSTALL_PLAN" ] || { cat "$STG/install-plan.A.stdout.txt"; refuse INSTALL_PLAN_NOT_AS_GENERATED; }
(cd "$STG" && sha256sum roles-in/* tools/* record/* template/* linux-pkg/upgrade-v1/manifest.json linux-pkg/upgrade-v1/bin/* linux-res-pkg/manifest.json linux-res-pkg/bin/* linux-res-pkg/systemd/* install-plan.A.stdout.txt resident-pins.A.stdout.json > phaseA.sha256)
echo "{\"status\":\"PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED\",\"phaseAManifestSha256\":\"$(sha256sum "$STG/phaseA.sha256" | cut -d' ' -f1)\"}"
"""

B = "#!/bin/bash\n" + r"""# First install of this node's Linux half, phase B (root). STEP B1 READS THIS NODE'S NEW PRIVATE KEY /etc/clued-independent-ci/verify-result-key.pem
# through sign-first-qualification.mjs; nothing prints it. Each step is done once and checked when found done: run B again to continue.
@@HOW_B@@""" + COMMON + r"""@@WANT_A@@(cd "$STG" && sha256sum --quiet -c phaseA.sha256) || refuse STAGED_BYTES_CHANGED_SINCE_PHASE_A
src_git_clean
[ "$(sha256sum "$STG/tools/sign-qualification.mjs" | cut -d' ' -f1)" = "$SIGN_SHA" ] || refuse SIGN_TOOL_CHANGED
T=$(mktemp -d "$STG/b-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")
if [ ! -e /var/lib/clued-independent-ci/resident/source-v2-install-receipt.json ]; then
  host_ready
  $CLEAN $PY -I "$STG/tools/check-host-r4.py" "$STG/roles-in" "$NODE_SHA" "$PUB_SHA" > "$T/host-B0.stdout.json" || { cat "$T/host-B0.stdout.json"; refuse HOST_PINS_CHANGED; }
  # B1 [PRIVATE KEY]: sign the three qualifications v2 with this node's key, each checked against the template node's signed one
  # signs into this run's directory and moves the result into place, so a failed run leaves nothing half-done in the way
  if [ ! -e "$STG/roles-signed" ]; then
    $CLEAN "$NODE" "$STG/tools/sign-first-qualification.mjs" --in "$STG/roles-in" --out "$T/roles-signed" --template "$STG/template" --template-public "$STG/template/public.pem" --template-public-sha256 "$TEMPLATE_PUB_SHA" --key-id "$KEY_ID" --runtime-id "$RUNTIME_ID" > "$T/sign.stdout.json" || { cat "$T/sign.stdout.json"; refuse SIGNING_FAILED; }
    grep -q FIRST_QUALIFICATIONS_V2_SIGNED "$T/sign.stdout.json" || refuse SIGNING_FAILED
    cp -f "$T/sign.stdout.json" "$STG/sign.stdout.json" && mv -T "$T/roles-signed" "$STG/roles-signed"
  fi
  grep -q FIRST_QUALIFICATIONS_V2_SIGNED "$STG/sign.stdout.json" || refuse SIGNED_OUTPUT_WITHOUT_ITS_REPORT_SEE_RECOVERY
  # B2 (public key only): the imported modules straight from the commit, checked against the record manifest pins before any import
  [ -e "$STG/check" ] || { install -d -m 0700 "$T/check" "$T/check/worker" "$T/check/src"; for rel in @@MODS@@; do G cat-file blob "$COMMIT:@@CI@@/$rel" > "$T/check/$rel" || refuse "MODULE_EXTRACT_FAILED:$rel"; done; mv -T "$T/check" "$STG/check"; }
  $CLEAN "$NODE" "$STG/tools/verify-signed-r4.mjs" "$STG/check" "$STG/roles-signed" "$STG/roles-in" /etc/clued-independent-ci/verify-result-public.pem "$STG/record/source-manifest.json" > "$T/verify-signed.stdout.json" || { cat "$T/verify-signed.stdout.json"; refuse SIGNED_SET_REFUSED; }
  grep -q SIGNED_QUALIFICATIONS_V2_VERIFIED "$T/verify-signed.stdout.json" || refuse SIGNED_SET_REFUSED
  # B3-B5: the Linux Source v2 package, its plan (every target absent, this commit and manifest, the toolchain node), apply
  if [ ! -e "$STG/pkg" ]; then
    $CLEAN $PY -I "$STG/tools/clued-ci-install-source-v2" package --record "$STG/record" --source-root "$STG/src.git" --roles "$STG/roles-signed" --out "$STG/pkg" > "$T/package.stdout.json" || { cat "$T/package.stdout.json"; refuse PACKAGE_FAILED_SEE_RECOVERY; }
    cp -f "$T/package.stdout.json" "$STG/package.stdout.json"
  fi
  grep -q LINUX_SOURCE_V2_PACKAGE_WRITTEN "$STG/package.stdout.json" || refuse PACKAGE_PARTIAL_SEE_RECOVERY
  # the run roots readiness requires (loadQualifiedPolicyV2): root directories, created here when absent
  for d in @@ROOTS@@; do
    [ -e "$d" ] || install -d -o root -g root -m 0755 "$d"
    { [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = 0 ] && [ $(( 0$(stat -c %a "$d") & 022 )) = 0 ]; } || refuse "RUN_ROOT_NOT_ROOT_PROTECTED:$d"
  done
  $CLEAN $PY -I "$STG/tools/clued-ci-install-source-v2" --plan "$STG/pkg" > "$T/source-plan.stdout.json" || { cat "$T/source-plan.stdout.json"; refuse SOURCE_PLAN_REFUSED; }
  PLAN=$($CLEAN $PY -I -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["plan"]; h=p["host"]; ok=d["status"]=="DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN" and p["sourceCommit"]==sys.argv[2] and p["ciSourceManifestSha256"]==sys.argv[3] and all(h["targetsAbsent"].values()) and h["receiptAbsent"] and h["roleLockAbsent"] and h["gitPresent"] and h["nodeSha256"]==sys.argv[4]; print(d["planSha256"] if ok else "")' "$T/source-plan.stdout.json" "$COMMIT" "$NEW_MANIFEST" "$NODE_SHA")
  [ -n "$PLAN" ] || refuse SOURCE_PLAN_NOT_AS_EXPECTED
  $CLEAN $PY -I "$STG/tools/clued-ci-install-source-v2" --apply "$STG/pkg" "$PLAN" > "$T/source-apply.stdout.json" || { cat "$T/source-apply.stdout.json"; refuse SOURCE_APPLY_NOT_CONFIRMED_SEE_RECOVERY; }
  cp -f "$T/source-apply.stdout.json" "$STG/source-apply.stdout.json"
fi
grep -q INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED "$STG/source-apply.stdout.json" || refuse SOURCE_APPLY_NOT_CONFIRMED_SEE_RECOVERY
# B6: verify the Source v2 install (read-only; no Source v1 on this node)
bash --noprofile --norc "$STG/tools/verify-source-v2.sh" "$STG/roles-signed" > "$T/verify-source.stdout.json" || true
cat "$T/verify-source.stdout.json"
grep -q LINUX_SOURCE_V2_VERIFIED "$T/verify-source.stdout.json" || refuse SOURCE_V2_VERIFY_FAILED_SEE_RECOVERY
h=$(git -C /opt/clued-independent-ci/source-v2 -c safe.directory=/opt/clued-independent-ci/source-v2 rev-parse HEAD) || refuse INSTALLED_SOURCE_UNREADABLE
[ "$h" = "$COMMIT" ] || refuse INSTALLED_SOURCE_NOT_THIS_COMMIT
# B7: the Linux resident half with exactly the plan generated on Windows. When the installer asks for a restart, the Owner restarts
# ONLY this distribution from Windows (wsl -t @@DISTRO@@, never wsl --shutdown) and runs this phase B command again: it continues.
if [ -e /opt/clued-independent-ci/resident-v1 ] || [ -e /var/lib/clued-independent-ci/resident/install-plan.json ]; then
  bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --continue-after-boot "$INSTALL_PLAN" > "$T/install.stdout.json" || { cat "$T/install.stdout.json"; refuse RESIDENT_INSTALL_FAILED_SEE_RECOVERY; }
else
  bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --apply "$STG/linux-res-pkg" "$INSTALL_PLAN" > "$T/install.stdout.json" || { cat "$T/install.stdout.json"; refuse RESIDENT_INSTALL_FAILED_SEE_RECOVERY; }
fi
if grep -q INSTALLED_NEEDS_WSL_RESTART "$T/install.stdout.json"; then   # its own text says wsl --shutdown: never; this distribution only
  echo '{"status":"RESTART_ONLY_THIS_DISTRIBUTION_THEN_RUN_B_AGAIN","windows":"wsl -t @@DISTRO@@","never":"wsl --shutdown"}'; exit 2
fi
grep -q '"status":"RESIDENT_LINUX_INSTALLED"' "$T/install.stdout.json" || { cat "$T/install.stdout.json"; refuse RESIDENT_INSTALL_FAILED_SEE_RECOVERY; }
# B7b: the role images (the worker never pulls): registry images by digest, local images from the template node's docker save
for ref in @@PULL_IMAGES@@; do
  docker image inspect "$ref" >/dev/null 2>&1 || docker pull -q "$ref" >/dev/null || refuse "IMAGE_PULL_FAILED:$ref"
  docker image inspect "$ref" >/dev/null 2>&1 || refuse "IMAGE_NOT_PRESENT:$ref"
done
# a local image's archive (pinned below when the generator saw it): images/<hex>.tar, or .tar.gz (gzip of the docker save)
while read -r hex name want; do
  [ -n "$hex" ] || continue
  if ! docker image inspect "sha256:$hex" >/dev/null 2>&1; then
    [ "$name" != - ] && [ -f "$W/images/$name" ] || refuse "IMAGE_NOT_LOADED_PUT_THE_TEMPLATE_DOCKER_SAVE_AT:images/$hex.tar(.gz)"
    [ "$(sha256sum "$W/images/$name" | cut -d' ' -f1)" = "$want" ] || refuse "IMAGE_ARCHIVE_NOT_THE_PINNED_ONE:$name"
    case "$name" in
      *.tar.gz) gzip -dc "$W/images/$name" | docker load -q >/dev/null || refuse "IMAGE_LOAD_FAILED:$hex" ;;
      *) docker load -q -i "$W/images/$name" >/dev/null || refuse "IMAGE_LOAD_FAILED:$hex" ;;
    esac
  fi
  [ "$(docker image inspect --format '{{.Id}}' "sha256:$hex")" = "sha256:$hex" ] || refuse "IMAGE_NOT_PRESENT:$hex"
done <<'IMAGES'
@@LOCAL_IMAGES@@IMAGES
[ "$(sha256sum /opt/clued-independent-ci/resident-v1/manifest.json | cut -d' ' -f1)" = "$LINUX_RES_MANIFEST" ] || refuse LINUX_RESIDENT_MANIFEST_NOT_THIS_PACKAGE
# B8: the frozen upgrade tool with exactly the plan generated on Windows; found installed, it must have been this plan
if [ -e "$UPG" ]; then
  grep -q "\"planSha256\":\"$UPG_PLAN\"" /var/lib/clued-independent-ci/resident/upgrade-v1-install-plan.json || refuse UPGRADE_TOOL_PRESENT_NOT_THIS_PLAN_SEE_RECOVERY
else
  bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --plan-upgrade-v1 "$STG/linux-pkg" > "$T/upgrade-plan.stdout.txt" || { cat "$T/upgrade-plan.stdout.txt"; refuse UPGRADE_PLAN_REFUSED; }
  [ "$(printf '%s' "$(head -n -1 "$T/upgrade-plan.stdout.txt")" | sha256sum | cut -d' ' -f1)" = "$UPG_PLAN" ] || { cat "$T/upgrade-plan.stdout.txt"; refuse UPGRADE_PLAN_NOT_AS_GENERATED; }
  bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --apply-upgrade-v1 "$STG/linux-pkg" "$UPG_PLAN" > "$T/upgrade-apply.stdout.json" || { cat "$T/upgrade-apply.stdout.json"; refuse UPGRADE_TOOL_INSTALL_FAILED_SEE_RECOVERY; }
  grep -q UPGRADE_TOOL_INSTALLED "$T/upgrade-apply.stdout.json" || refuse UPGRADE_TOOL_INSTALL_FAILED_SEE_RECOVERY
fi
# B9: generation 1 = what is live now, with this package (adopt replays when it already recorded it)
bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --adopt-generation 1 "$PKG_SHA" > "$T/upgrade-adopt.stdout.json" || { cat "$T/upgrade-adopt.stdout.json"; refuse GENERATION_ADOPT_FAILED_SEE_RECOVERY; }
grep -q LINUX_GENERATION_ADOPTED "$T/upgrade-adopt.stdout.json" || refuse GENERATION_ADOPT_FAILED_SEE_RECOVERY
# B10: the version facts for the Windows side, from the installed frozen tool, read-only
VF="@@VF@@"
$CLEAN $PY -I "$UPG/bin/clued-ci-upgrade-linux" version-facts > "$VF" || { cat "$VF"; refuse VERSION_FACTS_FAILED; }
$CLEAN $PY -I -c 'import json,sys; f=json.load(open(sys.argv[1])); sys.exit(not (f.get("contract")=="clued.independent-ci.linux-version-facts/1" and f.get("generation")==1 and f.get("staged") is None and f.get("ciSourceManifestSha256")==sys.argv[2] and f.get("manifestSha256")==sys.argv[3] and f.get("pinsOk") is True))' "$VF" "$NEW_MANIFEST" "$LINUX_RES_MANIFEST" || { cat "$VF"; refuse VERSION_FACTS_NOT_THIS_INSTALL; }
# B11: verify-resident-linux, every check fatal
bash --noprofile --norc "$STG/tools/verify-resident-linux.sh" > "$T/verify-resident.stdout.json" || true
cat "$T/verify-resident.stdout.json"
grep -q '"status":"LINUX_RESIDENT_VERIFIED"' "$T/verify-resident.stdout.json" || refuse VERIFY_RESIDENT_LINUX_FAILED
@@B_DONE@@"""

# each local image's archive as it is in the in-dir now (pinned), or '-' (B then refuses until the image is loaded)
LOCAL_ARCHIVES, LOCAL_LINES = {}, ''
for h in LOCAL_IMAGES:
    found = [n for n in (h + '.tar', h + '.tar.gz') if os.path.isfile(os.path.join(IN, 'images', n))]
    assert len(found) <= 1, ('IMAGE_ARCHIVE_AMBIGUOUS', h)
    LOCAL_ARCHIVES[h] = {'archive': 'images/' + found[0], 'sha256': sha(os.path.join(IN, 'images', found[0]))} if found else None
    assert found or not FLEET, ('LOCAL_ROLE_IMAGE_ARCHIVE_MISSING', h)   # the package path never waits for a person to put one there
    LOCAL_LINES += '%s %s %s' % (h, found[0] if found else '-', LOCAL_ARCHIVES[h]['sha256'] if found else '-') + chr(10)
# The package path continues a stopped first install. A prepare again after a launch that stopped once Linux phase A had completed
# (B cut off, failed twice, or done while the Windows side stopped) finds this commit's staging: the same package (package.sha256), the
# staged bytes unchanged since A (phaseA.sha256), and this in-directory carrying exactly the staged inputs. A then stages nothing and
# B, whose every step checks what is already done, goes on from where it stopped. Anything else is refused by name, never redone over.
CONT_FLEET = r"""# ---- continue a stopped first install of this package (A done earlier; B goes on from where it stopped)
if [ -s "$STG/phaseA.sha256" ]; then
  [ "$(cat "$BASE/package.sha256" 2>/dev/null)" = "$PKG_SHA" ] || refuse STAGED_FIRST_INSTALL_OF_ANOTHER_PACKAGE
  (cd "$STG" && sha256sum --quiet -c phaseA.sha256) || refuse STAGED_BYTES_CHANGED_SINCE_PHASE_A
  (cd "$STG" && sha256sum --quiet -c - <<'STAGED_EOF') || refuse STAGED_INPUTS_NOT_THIS_PACKAGES
@@SUMS@@STAGED_EOF
  (cd "$W" && sha256sum --quiet -c - <<'IN_EOF') || refuse IN_DIR_NOT_THE_STAGED_INPUTS
@@SUMS@@IN_EOF
  echo "{\"status\":\"PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED\",\"continued\":true,\"phaseAManifestSha256\":\"$(sha256sum "$STG/phaseA.sha256" | cut -d' ' -f1)\"}"
  exit 0
fi
# ---- end continue
"""
# The two forms differ only in these pieces (reinstall/test/test_first_install.py holds every other line equal).
if FLEET:
    FORM = {'ENV_GATE': '# run by the elevated launcher under `/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc` (fixed by the registrar)\n',
            'O_LINE': 'O=' + shlex.quote(WSL_OUT) + '\n[ -d "$O" ] || refuse OUT_DIRECTORY_MISSING\n',
            'HOW_A': '#   run by the elevated first-install launcher only (no argument): A.sh\n',
            'HOW_B': '#   run by the elevated first-install launcher only (no argument): B.sh after A.sh; B-resume.sh (the same text) once after a failed B\n',
            'WANT_A': '[ -s "$STG/phaseA.sha256" ] || refuse PHASE_A_NOT_DONE\n',
            'CONTINUE': CONT_FLEET,
            # an A cut off before it completed left a staging without phaseA.sha256: kept aside whole (never deleted), A again
            'BASE_GATE': '[ ! -e "$BASE" ] || mv -n -T "$BASE" "$BASE.cut-$(date -u +%Y%m%dT%H%M%SZ)" || refuse STAGING_CUT_OFF_NOT_KEPT_ASIDE\n[ ! -e "$BASE" ] || refuse STAGING_EXISTS_PRESERVE\n',
            'VF': '$O/linux-version-facts.$(date -u +%Y%m%dT%H%M%SZ).json',
            'B_DONE': ('E="$O/linux-live-manifest.$(date -u +%Y%m%dT%H%M%SZ).txt"\n'
                       '{ echo "source: first-install-linux-B (root, launcher)"; echo "package: $PKG_SHA"; echo "capturedAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; '
                       'echo "command: /usr/bin/sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json"; echo "exit: 0"; '
                       'echo "sha256: $(sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json | cut -d\' \' -f1)"; } > "$E"\n'
                       'echo "{\\"status\\":\\"LINUX_FIRST_INSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1\\",\\"evidence\\":\\"$E\\",\\"versionFacts\\":\\"$VF\\",\\"node\\":\\"@@NODE_NAME@@\\"}"\n')}
else:
    FORM = {'ENV_GATE': '# The Owner runs this under `/usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc`\n'
                        '[ "${R4_CLEAN_ENV:-}" = 1 ] || refuse RUN_UNDER_ENV_I_AS_IN_RUN_ORDER\n',
            'O_LINE': '',
            'HOW_A': '#   /usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc /root/first-install-linux-A.@@SUFFIX@@.sh\n',
            'HOW_B': '#   /usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc /root/first-install-linux-B.@@SUFFIX@@.sh <phaseAManifestSha256 as reviewed>\n',
            'WANT_A': 'WANT_A="${1:?phase A manifest sha256 required}"\n[ "$(sha256sum "$STG/phaseA.sha256" | cut -d\' \' -f1)" = "$WANT_A" ] || refuse PHASE_A_NOT_AS_REVIEWED\n',
            'CONTINUE': '', 'BASE_GATE': '[ ! -e "$BASE" ] || refuse STAGING_EXISTS_PRESERVE\n',
            'VF': '$W/../linux-version-facts.@@NODE_NAME@@.$(date -u +%Y%m%dT%H%M%SZ).json',
            'B_DONE': 'echo "{\\"status\\":\\"LINUX_FIRST_INSTALL_DONE\\",\\"node\\":\\"@@NODE_NAME@@\\",\\"sourceCommit\\":\\"$COMMIT\\",\\"ciSourceManifestSha256\\":\\"$NEW_MANIFEST\\",\\"packageManifestSha256\\":\\"$PKG_SHA\\",\\"versionFacts\\":\\"$VF\\"}"\n'}
for _k, _v in FORM.items():   # the form's pieces first: they carry @@SUFFIX@@ / @@NODE_NAME@@ of their own
    A, B = A.replace('@@' + _k + '@@', _v), B.replace('@@' + _k + '@@', _v)
values = {'DRAFT': str(int(DRAFT)), 'W': W, 'BASE': BASE, 'COMMIT': COMMIT, 'NEW': NEW, 'REF': REF, 'HREF': HREF, 'RECEIPT': RECEIPT, 'PKG_SHA': PKG_SHA,
          'LINUX_RES_MANIFEST': LINUX_RES_MANIFEST, 'UPG_PLAN': UPG_PLAN, 'INSTALL_PLAN': INSTALL_PLAN, 'KEY_ID': SIGNER['keyId'], 'RUNTIME_ID': SIGNER['runtimeId'],
          'TEMPLATE_PUB_SHA': TEMPLATE_PUB_SHA, 'NODE_SHA': NODE_SHA, 'PUB_SHA': PUB_SHA, 'SIGN_SHA': SIGN_SHA, 'C8': COMMIT[:8], 'NODE_NAME': NODE_NAME,
          'ROOTS': ' '.join(ROOTS), 'PULL_IMAGES': ' '.join(PULL_IMAGES), 'LOCAL_IMAGES': LOCAL_LINES, 'SUFFIX': SUFFIX, 'DISTRO': CFG['linux']['distribution'], 'FILES': ' '.join(files), 'SUMS': sums, 'MODS': ' '.join(MODS), 'CI': CI}
for k, v in values.items():   # every value is hex, a validated name, a shlex-quoted path, or a list of fixed relative paths
    assert k in ('W', 'SUMS', 'FILES', 'MODS', 'ROOTS', 'PULL_IMAGES', 'LOCAL_IMAGES') or re.fullmatch(r'[A-Za-z0-9._/-]*', v), ('VALUE_SHAPE', k)
def render(text):
    for k, v in values.items():
        text = text.replace('@@' + k + '@@', v)
    assert '@@' not in text, 'UNRENDERED_PLACEHOLDER'
    return text
out, paths = {}, {}
NAMES = (('A.sh', A), ('B.sh', B), ('B-resume.sh', B)) if FLEET else (('first-install-linux-A.' + SUFFIX + '.sh', A), ('first-install-linux-B.' + SUFFIX + '.sh', B))
if FLEET:
    os.makedirs(os.path.join(R, 'linux'), exist_ok=True)
for name, text in NAMES:
    p = os.path.join(R, 'linux', name)
    with open(p, 'xb') as f:
        f.write(render(text).encode('utf-8'))
    out[name] = sha(p); paths[name] = p
print(json.dumps({'scripts': out, **({'paths': paths, 'inDir': IN, 'wslInDir': WSL_IN, 'outDir': OUT_DIR, 'wslOutDir': WSL_OUT} if FLEET else {}),
                  'pinnedFiles': len(files), 'W': W, 'base': BASE, 'node': NODE_NAME, 'packageManifestSha256': PKG_SHA,
                  'ciSourceManifestSha256': NEW, 'keyId': SIGNER['keyId'], 'runtimeId': SIGNER['runtimeId'], 'resultPublicKeySha256': PUB_SHA,
                  'templatePublicKeySha256': TEMPLATE_PUB_SHA, 'pullImages': PULL_IMAGES, 'localImages': LOCAL_ARCHIVES, 'restartOnlyThisDistribution': 'wsl -t ' + CFG['linux']['distribution'], 'installPlanSha256': INSTALL_PLAN, 'upgradePlanSha256': UPG_PLAN, 'draft': DRAFT}, indent=1))
