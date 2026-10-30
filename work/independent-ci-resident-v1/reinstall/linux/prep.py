"""Linux kit generator for a full reinstall (README.md section 6): writes the root scripts the Owner runs in the node's WSL distribution
under `env -i` (phase A: checks and staging only; phase B: the Source switch, then backup, uninstall and reinstall of the Linux resident
half, the upgrade tool, generation 1, the version facts and verify; resume: the rest of B after a failure past the Source switch).
Windows, non-elevated, no WSL. Every Windows-provided byte is pinned into the scripts (sha256sum -c) and the scripts are hashed here.

The INSTALLED Linux state the scripts expect is read from the node, not written by hand: the Linux version facts the companion keeps on
the Windows side (resident/upgrade/mailbox/responses/version-facts.json: Source commit, ciSource, resident manifest, generation, roles)
and the generation record (resident/upgrade/current.json: the installed package). Pass copies of both files.

History (r4 .. r7 on TURING, with the reviews that shaped each check): README.md section 9.
  python -I prep.py <config.json> <commit40> <new-manifest> <decision-uuid> <package-dir> <out-suffix> <in-dir-name>
                    <installed-version-facts.json> <installed-generation.json> [<rehearsal report> (required unless out-suffix draft*)]
"""
import datetime, hashlib, json, os, re, shlex, sys

if sys.flags.optimize:   # the gates below are asserts
    sys.exit('RUN_WITHOUT_PYTHON_-O')
import importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod
rconfig = _load('rconfig', os.path.join(HERE, '..', 'tools', 'rconfig.py'))
CFG = rconfig.load(sys.argv[1])
R = CFG['workDir']
COMMIT, NEW, REF, PKG, SUFFIX = sys.argv[2:7]
assert re.fullmatch(r'[0-9a-f]{40}', COMMIT) and re.fullmatch(r'[0-9a-f]{64}', NEW) and re.fullmatch(r'[a-z0-9-]{1,20}', SUFFIX)
assert re.fullmatch(r'[A-Za-z0-9._-]{1,64}', sys.argv[7]) and sys.argv[7] not in ('.', '..'), 'IN_DIR_NAME_SHAPE'
DRAFT = SUFFIX.startswith('draft')
# review 1-4: root runs the tree's Linux scripts; the tree must be exactly the commit
_load('tree', os.path.join(HERE, '..', 'tools', 'tree.py')).verify(CFG['repo'], COMMIT, os.path.join(R, 'tree-' + COMMIT[:8]))
# The installed Linux state, from the node's own files (copies): the Linux version facts and the generation record.
_facts = json.load(open(sys.argv[8], encoding='utf-8'))
_gen = json.load(open(sys.argv[9], encoding='utf-8'))
assert _facts.get('contract') == 'clued.independent-ci.linux-version-facts/1' and _facts.get('staged') is None and _facts.get('pinsOk') is True, 'INSTALLED_FACTS_NOT_A_SETTLED_GENERATION'
assert _gen.get('contract') == 'clued.independent-ci.resident-generation/1' and _gen['linux'] == {'generation': _facts['generation'], 'manifestSha256': _facts['manifestSha256'], 'ciSourceManifestSha256': _facts['ciSourceManifestSha256']}, 'INSTALLED_FACTS_NOT_THE_GENERATION_RECORD'
OLD_COMMIT = _facts['sourceCommit']
OLD_MANIFEST = _facts['ciSourceManifestSha256']
OLD_LINUX_RES_MANIFEST = _facts['manifestSha256']
OLD_GENERATION = _facts['generation']
OLD_PKG_SHA = _gen['packageManifestSha256']
assert re.fullmatch(r'[0-9a-f]{40}', OLD_COMMIT) and all(re.fullmatch(r'[0-9a-f]{64}', x) for x in (OLD_MANIFEST, OLD_LINUX_RES_MANIFEST, OLD_PKG_SHA)) and type(OLD_GENERATION) is int and OLD_GENERATION >= 1
# review 1-1: the node's own host facts (configuration linux.host), not TURING's
NODE_SHA = CFG['linux']['host']['toolchainNodeSha256']
PUB_SHA = CFG['linux']['host']['resultPublicKeySha256']
V1_HEAD = CFG['linux']['host']['v1SourceHead']
SIGN_SHA = '9ee06a93b11353b49270c774ae988060994e7a4aaae606b4736b4597c3f20aff'   # reviewed 10-21, used 10-21/10-22/10-23
IN = os.path.join(R, 'linux', sys.argv[7])
REVIEW_TOOLS = os.path.join(HERE, 'tools')   # the reviewed signer and verify-source-v2 template, committed
VERIFY_TEMPLATE_SHA = '05314df488cbeee96a3cf97c56e17e1a72de5db3e5b7c10b9752330d758c82ae'

sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
pkg = json.load(open(os.path.join(PKG, 'package-manifest.json'), encoding='utf-8'))
assert pkg['ciSourceManifestSha256'] == NEW and sha(os.path.join(IN, 'record', 'source-manifest.json')) == NEW
for f in ('acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json'):
    assert sha(os.path.join(IN, 'record', f)) == sha(os.path.join(PKG, 'record', f)), f
acc = json.load(open(os.path.join(IN, 'record', 'acceptance.json'), encoding='utf-8'))
assert acc['sourceAcceptanceRef'] == REF and acc['hostQualificationRef'] == REF
RECEIPT = acc['installationReceiptRef']
assert acc['ownerReceiptRef'] == RECEIPT
PLACEHOLDER = re.compile(r'^(d{8}|e{8})-')
DRAFT_REFS = bool(PLACEHOLDER.match(REF) or PLACEHOLDER.match(RECEIPT) or PLACEHOLDER.match(acc['ownerDecisionRef']))
# review r5-1: placeholder refs may only ever produce scripts named *.draft*; the scripts themselves refuse them too (below)
assert not (DRAFT_REFS and not DRAFT), 'FINAL_SCRIPTS_NEED_THE_REAL_OWNER_REFS'
# README section 5: final scripts only after a PASS rehearsal of exactly this package, commit and configuration (10th argument), at
# most 24 hours old (review 1-8). Draft scripts refuse to run at all (DRAFT=1 below, review 1-2), whatever their refs.
if not DRAFT:
    _r = json.load(open(sys.argv[10], encoding='utf-8')) if len(sys.argv) > 10 else {}
    try:
        _age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.strptime(_r.get('observedAt', ''), '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        _age = None
    assert (_r.get('contract') == 'clued.independent-ci.reinstall-rehearsal/1' and _r.get('status') == 'REHEARSAL_PASS' and _r.get('findings') == []
            and _r.get('packageManifestSha256') == sha(os.path.join(PKG, 'package-manifest.json')) and _r.get('commit') == COMMIT
            and _r.get('configSha256') == CFG['_sha256']), 'FINAL_SCRIPTS_NEED_A_PASSING_REHEARSAL_OF_THIS_PACKAGE'
    assert _age is not None and datetime.timedelta(0) <= _age <= datetime.timedelta(hours=24), 'REHEARSAL_OLDER_THAN_24_HOURS'
assert sha(os.path.join(IN, 'tools', 'clued-ci-install-source-v2')) == sha(os.path.join(PKG, 'linux', 'bin', 'clued-ci-install-source-v2'))
import re as _re
sign_src = os.path.join(REVIEW_TOOLS, 'sign-qualification-v2.mjs'); vt_src = os.path.join(REVIEW_TOOLS, 'verify-source-v2.template.sh')
assert sha(sign_src) == SIGN_SHA and sha(vt_src) == VERIFY_TEMPLATE_SHA, 'REVIEW_COPY_TOOLS_CHANGED'
vt = open(vt_src, 'rb').read().decode('utf-8')
v2, n1 = _re.subn(r'(?m)^COMMIT=[0-9a-f]{40}$', 'COMMIT=' + COMMIT, vt); v2, n2 = _re.subn(r'(?m)^MANIFEST_SHA=[0-9a-f]{64}$', 'MANIFEST_SHA=' + NEW, v2)
v2, n3 = _re.subn(r'(?m)^V1_HEAD=[0-9a-f]{40}$', 'V1_HEAD=' + V1_HEAD, v2)
assert n1 == 1 and n2 == 1 and n3 == 1
for name, data in (('sign-qualification-v2.mjs', open(sign_src, 'rb').read()), ('verify-source-v2.sh', v2.encode('utf-8'))):
    p = os.path.join(IN, 'tools', name)
    if os.path.exists(p):
        assert open(p, 'rb').read() == data, ('INPUT_DIFFERS', name)
    else:
        open(p, 'xb').write(data)
# the root-side tools assemble.py copied are the committed ones (an older copy would still carry another node's pins)
for src, name in (('check-host.py', 'check-host-r4.py'), ('verify-signed.mjs', 'verify-signed-r4.mjs'), ('derive-roles.py', 'derive-roles-r7.py')):
    assert sha(os.path.join(IN, 'tools', name)) == sha(os.path.join(REVIEW_TOOLS, src)), ('TOOL_NOT_THE_COMMITTED_ONE', name)
# r5c: the package's upgrade tool files, the tree's install-resident-linux.sh and verify-resident-linux.sh, the package hash
PKG_SHA = sha(os.path.join(PKG, 'package-manifest.json'))
LINUX_RES_MANIFEST = pkg['linux']['manifestSha256']
assert LINUX_RES_MANIFEST == sha(os.path.join(PKG, 'linux', 'manifest.json'))
UPG_FILES = ['upgrade-v1/bin/clued-ci-upgrade-linux', 'upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', 'upgrade-v1/manifest.json']
for f in UPG_FILES:
    assert sha(os.path.join(IN, 'linux-pkg', *f.split('/'))) == sha(os.path.join(PKG, 'linux', *f.split('/'))), ('UPGRADE_FILE_NOT_THE_PACKAGES', f)
TREE_LINUX = os.path.join(R, 'tree-' + COMMIT[:8], 'work', 'independent-ci-resident-v1', 'linux')
for f in ('install-resident-linux.sh', 'verify-resident-linux.sh', 'uninstall-resident-linux.sh'):   # r7: + uninstall
    assert sha(os.path.join(IN, 'tools', f)) == sha(os.path.join(TREE_LINUX, f)), ('TOOL_NOT_THE_TREES', f)
# r7: the package's Linux resident files (install-resident-linux.sh FILES, in its order) and their install plan on the host as it will
# be after the uninstall: systemd enabled in wsl.conf, systemd pid 1, cgroup v2 (verify-resident-linux showed all three on r5c2),
# no resident-v1, no unit file. Phase A and B0 recompute it live (with those lines) and phase B applies exactly it.
RES_FILES = ['bin/clued-ci-resident-linux', 'manifest.json', 'systemd/clued-ci-worker@.service', 'systemd/clued-ci-wsprep@.service', 'systemd/clued-ci-archive@.service']
for f in RES_FILES:
    assert sha(os.path.join(IN, 'linux-res-pkg', *f.split('/'))) == sha(os.path.join(PKG, 'linux', *f.split('/'))), ('RESIDENT_FILE_NOT_THE_PACKAGES', f)
assert sha(os.path.join(IN, 'linux-res-pkg', 'manifest.json')) == LINUX_RES_MANIFEST
UNITS = ['clued-ci-worker@.service', 'clued-ci-wsprep@.service', 'clued-ci-archive@.service']
res_text = '\n'.join(['install-script.sha256=' + sha(os.path.join(IN, 'tools', 'install-resident-linux.sh'))]
                      + [sha(os.path.join(IN, 'linux-res-pkg', *f.split('/'))) + '  ' + f for f in RES_FILES]
                      + ['wsl.conf.boot=enabled', 'pid1=systemd', 'cgroup2=yes', 'opt.exists=no'] + ['unit.' + u + '.exists=no' for u in UNITS])
INSTALL_PLAN = hashlib.sha256(res_text.encode('utf-8')).hexdigest()
UPG_TOOL_SHA = sha(os.path.join(IN, 'linux-pkg', 'upgrade-v1', 'bin', 'clued-ci-upgrade-linux'))   # the version facts' upgradeToolSha256
# install-resident-linux.sh --plan-upgrade-v1 (plan_upgrade_text + plan_sha), computed here from the same bytes and the expected host:
# the resident half installed, no upgrade tool, no generation record yet. Phase A recomputes it on the host and must get this value.
upg_text = '\n'.join(['install-script.sha256=' + sha(os.path.join(IN, 'tools', 'install-resident-linux.sh'))]
                     + [sha(os.path.join(IN, 'linux-pkg', *f.split('/'))) + '  ' + f for f in UPG_FILES]
                     + ['resident.exists=yes', 'upgrade-v1.exists=no', 'generation.current.exists=no'])
UPG_PLAN = hashlib.sha256(upg_text.encode('utf-8')).hexdigest()
files = ['tools/install-resident-linux.sh', 'tools/uninstall-resident-linux.sh'] + ['linux-pkg/' + f for f in UPG_FILES] + ['linux-res-pkg/' + f for f in RES_FILES] + ['tools/clued-ci-install-source-v2', 'tools/verify-resident-linux.sh', 'tools/derive-roles-r7.py', 'tools/verify-signed-r4.mjs', 'tools/check-host-r4.py',
         'tools/sign-qualification-v2.mjs', 'tools/verify-source-v2.sh'] + \
        ['record/' + f for f in ('acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json')]
for f in files:
    assert b'\r' not in open(os.path.join(IN, *f.split('/')), 'rb').read(), ('CR', f)
sums = ''.join(f'{sha(os.path.join(IN, *f.split("/")))}  {f}\n' for f in files)
W = shlex.quote('/mnt/' + IN[0].lower() + '/' + IN[3:].replace('\\', '/'))   # review 1-3: quoted; the path shape is checked by rconfig
BASE = '/root/clued-ci-reinstall-' + COMMIT[:8]
CI = 'work/actions-hosted-migration/independent-ci-v1'
COMMON = f"""set -euo pipefail
set -C   # create-only redirections: no evidence file is ever overwritten
refuse() {{ echo "{{\\"status\\":\\"REFUSED\\",\\"code\\":\\"$1\\"}}"; exit 1; }}
# M-1: the Owner runs this under `/usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc`
[ "${{R4_CLEAN_ENV:-}}" = 1 ] || refuse RUN_UNDER_ENV_I_AS_IN_RUN_ORDER
for v in BASH_ENV ENV NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT PYTHONPATH PYTHONHOME PYTHONSTARTUP GIT_DIR GIT_EXEC_PATH GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT WSLENV; do
  [ -z "${{!v+x}}" ] || refuse "ENVIRONMENT_NOT_CLEAN:$v"
done
export PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
umask 077
# review 1-2: scripts generated without a passing rehearsal (out-suffix draft*) are for reading only and never run
DRAFT={int(DRAFT)}
[ "$DRAFT" = 0 ] || refuse DRAFT_SCRIPTS_ARE_FOR_REVIEW_ONLY
W={W}
BASE={BASE}
STG=$BASE/stg
COMMIT={COMMIT}
NEW_MANIFEST={NEW}
NEW_REF={REF}
RECEIPT_REF={RECEIPT}
# review r5-1: never sign or install with the dddddddd-/eeeeeeee- placeholders of a DRAFT
case "$NEW_REF $RECEIPT_REF" in dddddddd-*|eeeeeeee-*|*" dddddddd-"*|*" eeeeeeee-"*) refuse PLACEHOLDER_OWNER_REFS_DRAFT_ONLY ;; esac
OLD_COMMIT={OLD_COMMIT}
OLD_MANIFEST={OLD_MANIFEST}
PKG_SHA={PKG_SHA}
LINUX_RES_MANIFEST={LINUX_RES_MANIFEST}
UPG_PLAN={UPG_PLAN}
INSTALL_PLAN={INSTALL_PLAN}
UPG_TOOL_SHA={UPG_TOOL_SHA}
OLD_LINUX_RES_MANIFEST={OLD_LINUX_RES_MANIFEST}
OLD_PKG_SHA={OLD_PKG_SHA}
OLD_GENERATION={OLD_GENERATION}
SUFFIX={SUFFIX}
BACKUP_PATHS='/var/lib/clued-independent-ci/resident /opt/clued-independent-ci/resident-v1 /opt/clued-independent-ci/upgrade-v1 /etc/systemd/system/clued-ci-worker@.service /etc/systemd/system/clued-ci-wsprep@.service /etc/systemd/system/clued-ci-archive@.service'
UPG=/opt/clued-independent-ci/upgrade-v1
NODE=/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
NODE_SHA={NODE_SHA}
PUB_SHA={PUB_SHA}
SIGN_SHA={SIGN_SHA}
PY=/usr/bin/python3.12
CLEAN="/usr/bin/env -i PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C GIT_NO_REPLACE_OBJECTS=1"
[ "$(id -u)" = 0 ] || refuse ROOT_REQUIRED
G() {{ git --git-dir="$STG/src.git" -c core.hooksPath=/nonexistent "$@"; }}
# run-linux-p2.py quiet_and_installed(), failing closed (minor 1)
quiet_and_installed() {{
  u=$(systemctl list-units --all --no-legend --plain --state=active,activating,deactivating,reloading 'clued-ci-*') || refuse SYSTEMCTL_FAILED
  [ -z "$u" ] || refuse LINUX_UNITS_ACTIVE
  [ ! -e /var/lib/clued-independent-ci/formal-role.lock ] || refuse ROLE_LOCK_PRESENT
  h=$(git -C /opt/clued-independent-ci/source-v2 -c safe.directory=/opt/clued-independent-ci/source-v2 rev-parse HEAD) || refuse INSTALLED_SOURCE_UNREADABLE
  [ "$h" = "$OLD_COMMIT" ] || refuse INSTALLED_SOURCE_NOT_SOURCE34
  m=$(sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json) || refuse INSTALLED_MANIFEST_UNREADABLE
  [ "${{m%% *}}" = "$OLD_MANIFEST" ] || refuse INSTALLED_MANIFEST_NOT_SOURCE34
}}
# r7: a plan text as it will be after the uninstall (no resident-v1, no unit file, no upgrade tool, no generation record)
plan_after_uninstall() {{ head -n -1 "$1" | sed -e 's/^opt\\.exists=yes$/opt.exists=no/' -e 's/^\\(unit\\..*\\.exists=\\)yes$/\\1no/' -e 's/^upgrade-v1\\.exists=yes$/upgrade-v1.exists=no/' -e 's/^generation\\.current\\.exists=yes$/generation.current.exists=no/'; }}
# r7: the same quiet checks after the Source switch: the NEW Source is the installed one
quiet_and_installed_after_switch() {{
  u=$(systemctl list-units --all --no-legend --plain --state=active,activating,deactivating,reloading 'clued-ci-*') || refuse SYSTEMCTL_FAILED
  [ -z "$u" ] || refuse LINUX_UNITS_ACTIVE
  [ ! -e /var/lib/clued-independent-ci/formal-role.lock ] || refuse ROLE_LOCK_PRESENT
  [ -z "$(ls -A /var/lib/clued-independent-ci/runs 2>/dev/null)" ] || refuse RUNS_NOT_EMPTY
  h=$(git -C /opt/clued-independent-ci/source-v2 -c safe.directory=/opt/clued-independent-ci/source-v2 rev-parse HEAD) || refuse INSTALLED_SOURCE_UNREADABLE
  [ "$h" = "$COMMIT" ] || refuse NEW_SOURCE_NOT_INSTALLED
  m=$(sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json) || refuse INSTALLED_MANIFEST_UNREADABLE
  [ "${{m%% *}}" = "$NEW_MANIFEST" ] || refuse NEW_SOURCE_NOT_INSTALLED
}}
# r7: everything after the Source switch. Each step is done once and checked when it is found done, so reinstall-linux-B-resume.sh can run
# this again after a failure without repeating a step; nothing here rolls a step back.
reinstall_tail() {{
  T="$STG/tail-$(date -u +%Y%m%dT%H%M%SZ)"; install -d -m 0700 "$T"
  quiet_and_installed_after_switch
  systemctl is-active --quiet docker.service || refuse DOCKER_SERVICE_NOT_ACTIVE
  UPA=$(grep -o '"planSha256":"[0-9a-f]\\{{64\\}}"' "$STG/uninstall-plan.A.stdout.txt" | cut -d'"' -f4) || refuse UNINSTALL_PLAN_UNREADABLE
  # (1) backup of what the uninstall moves and of the resident state it leaves, once, before the uninstall
  if [ -e "$BASE/pre-uninstall-backup.tar.sha256" ]; then
    sha256sum --quiet -c "$BASE/pre-uninstall-backup.tar.sha256" || refuse BACKUP_CHANGED_SEE_RECOVERY
  else
    [ ! -e "$BASE/pre-uninstall-backup.tar" ] && [ ! -e "$BASE/uninstall-apply.stdout.json" ] || refuse BACKUP_INCOMPLETE_SEE_RECOVERY
    tar --create --file "$BASE/pre-uninstall-backup.tar" --absolute-names $BACKUP_PATHS || refuse BACKUP_FAILED
    sha256sum "$BASE/pre-uninstall-backup.tar" > "$BASE/pre-uninstall-backup.tar.sha256" || refuse BACKUP_FAILED
  fi
  # (2) the uninstall, once, with exactly the plan phase A pinned, recomputed now
  if [ ! -e "$BASE/uninstall-apply.stdout.json" ]; then
    bash --noprofile --norc "$STG/tools/uninstall-resident-linux.sh" --plan > "$T/uninstall-plan.stdout.txt" || {{ cat "$T/uninstall-plan.stdout.txt"; refuse UNINSTALL_PLAN_REFUSED; }}
    UPN=$(grep -o '"planSha256":"[0-9a-f]\\{{64\\}}"' "$T/uninstall-plan.stdout.txt" | cut -d'"' -f4) || refuse UNINSTALL_PLAN_UNREADABLE
    [ "$UPN" = "$UPA" ] || {{ cat "$T/uninstall-plan.stdout.txt"; refuse UNINSTALL_PLAN_CHANGED_SINCE_PHASE_A; }}
    bash --noprofile --norc "$STG/tools/uninstall-resident-linux.sh" --apply "$UPA" > "$BASE/uninstall-apply.stdout.json" || {{ cat "$BASE/uninstall-apply.stdout.json"; refuse UNINSTALL_FAILED_SEE_RECOVERY; }}
  fi
  grep -q RESIDENT_LINUX_UNINSTALLED_EVIDENCE_KEPT "$BASE/uninstall-apply.stdout.json" || {{ cat "$BASE/uninstall-apply.stdout.json"; refuse UNINSTALL_FAILED_SEE_RECOVERY; }}
  KEPT=$(grep -o '"kept":"[^"]*"' "$BASE/uninstall-apply.stdout.json" | cut -d'"' -f4) || refuse UNINSTALL_RESULT_UNREADABLE
  # (3) the resident install with exactly the plan generated on Windows; when an earlier run saved that plan it is finished, not redone
  if [ -e /opt/clued-independent-ci/resident-v1 ] || [ -e /var/lib/clued-independent-ci/resident/install-plan.json ]; then
    bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --continue-after-boot "$INSTALL_PLAN" > "$T/install.stdout.json" || {{ cat "$T/install.stdout.json"; refuse RESIDENT_INSTALL_FAILED_SEE_RECOVERY; }}
  else
    bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --apply "$STG/linux-res-pkg" "$INSTALL_PLAN" > "$T/install.stdout.json" || {{ cat "$T/install.stdout.json"; refuse RESIDENT_INSTALL_FAILED_SEE_RECOVERY; }}
  fi
  grep -q '"status":"RESIDENT_LINUX_INSTALLED"' "$T/install.stdout.json" || {{ cat "$T/install.stdout.json"; refuse RESIDENT_INSTALL_FAILED_SEE_RECOVERY; }}
  [ "$(sha256sum /opt/clued-independent-ci/resident-v1/manifest.json | cut -d' ' -f1)" = "$LINUX_RES_MANIFEST" ] || refuse LINUX_RESIDENT_MANIFEST_NOT_THIS_PACKAGE
  # (4) the frozen upgrade tool with exactly the plan generated on Windows; found installed, it must have been this plan
  if [ -e "$UPG" ]; then
    grep -q "\\"planSha256\\":\\"$UPG_PLAN\\"" /var/lib/clued-independent-ci/resident/upgrade-v1-install-plan.json || refuse UPGRADE_TOOL_PRESENT_NOT_THIS_PLAN_SEE_RECOVERY
  else
    bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --apply-upgrade-v1 "$STG/linux-pkg" "$UPG_PLAN" > "$T/upgrade-apply.stdout.json" || {{ cat "$T/upgrade-apply.stdout.json"; refuse UPGRADE_TOOL_INSTALL_FAILED_SEE_RECOVERY; }}
    grep -q UPGRADE_TOOL_INSTALLED "$T/upgrade-apply.stdout.json" || refuse UPGRADE_TOOL_INSTALL_FAILED_SEE_RECOVERY
  fi
  # (5) generation 1 = what is live now (adopt replays when it already recorded this package)
  bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --adopt-generation 1 "$PKG_SHA" > "$T/upgrade-adopt.stdout.json" || {{ cat "$T/upgrade-adopt.stdout.json"; refuse GENERATION_ADOPT_FAILED_SEE_RECOVERY; }}
  grep -q LINUX_GENERATION_ADOPTED "$T/upgrade-adopt.stdout.json" || refuse GENERATION_ADOPT_FAILED_SEE_RECOVERY
  # (6) the version facts for the Windows verify (-LinuxVersionFactsFile), from the installed frozen tool, read-only
  VF="$W/../linux-version-facts.$(date -u +%Y%m%dT%H%M%SZ).json"
  $CLEAN $PY -I "$UPG/bin/clued-ci-upgrade-linux" version-facts > "$VF" || {{ cat "$VF"; refuse VERSION_FACTS_FAILED; }}
  $CLEAN $PY -I -c 'import json,sys; f=json.load(open(sys.argv[1])); sys.exit(not (f.get("contract")=="clued.independent-ci.linux-version-facts/1" and f.get("generation")==1 and f.get("staged") is None and f.get("ciSourceManifestSha256")==sys.argv[2] and f.get("manifestSha256")==sys.argv[3] and f.get("pinsOk") is True and f.get("sourceCommit")==sys.argv[4] and f.get("upgradeToolSha256")==sys.argv[5]))' "$VF" "$NEW_MANIFEST" "$LINUX_RES_MANIFEST" "$COMMIT" "$UPG_TOOL_SHA" || refuse VERSION_FACTS_NOT_THIS_PACKAGE
  # (7) verify-resident-linux, every check fatal (the resident half and the upgrade channel were just installed)
  bash --noprofile --norc "$STG/tools/verify-resident-linux.sh" > "$T/l7-verify.stdout.json" || true
  grep -q RESIDENT_LINUX_VERIFIED "$T/l7-verify.stdout.json" && grep -q '"upgrade-v1-pins":true' "$T/l7-verify.stdout.json" && grep -q '"generation-current":true' "$T/l7-verify.stdout.json" || {{ cat "$T/l7-verify.stdout.json"; refuse RESIDENT_LINUX_NOT_VERIFIED_SEE_RECOVERY; }}
  # (8) evidence for the Windows generator, and a public review copy in a new directory each run
  E="$W/../linux-live-manifest.$(date -u +%Y%m%dT%H%M%SZ).txt"
  {{ echo "source: reinstall-linux-B (root, Owner)"; echo "package: $PKG_SHA"; echo "capturedAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "command: /usr/bin/sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json"; echo "exit: 0"; echo "sha256: $(sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json | cut -d' ' -f1)"; }} > "$E"
  RO="$W/../out-B-$SUFFIX-${{T##*/tail-}}"; [ ! -e "$RO" ] || refuse OUT_DIR_EXISTS
  install -d -m 0755 "$RO" "$RO/roles-signed" "$RO/tail"; install -m 0644 "$STG"/roles-signed/* "$RO/roles-signed/"; install -m 0644 "$T"/* "$RO/tail/"
  for f in host-B0.stdout.json host-B4.stdout.json sign.stdout.json verify-signed.stdout.json package.stdout.json l4-plan.stdout.json l5-apply.stdout.json l5-verify.stdout.json; do [ ! -e "$STG/$f" ] || install -m 0644 "$STG/$f" "$RO/"; done
  install -m 0644 "$BASE/uninstall-apply.stdout.json" "$BASE/pre-uninstall-backup.tar.sha256" "$BASE/superseded-suffix.txt" "$RO/"
  echo "{{\\"status\\":\\"LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1\\",\\"evidence\\":\\"$E\\",\\"versionFacts\\":\\"$VF\\",\\"superseded\\":\\"$(cat "$BASE/superseded-suffix.txt")\\",\\"kept\\":\\"$KEPT\\",\\"backup\\":\\"$BASE/pre-uninstall-backup.tar\\",\\"outputs\\":\\"$RO\\"}}"
}}
# B-2: the staged bare repo may hold exactly refs/heads/main at the accepted commit: no replace refs, alternates, grafts, shallow or links
src_git_clean() {{
  [ -z "$(find "$STG/src.git" -type l -print -quit)" ] || refuse SRC_GIT_SYMLINK
  for x in refs/replace objects/info/alternates objects/info/http-alternates info/grafts shallow; do [ ! -e "$STG/src.git/$x" ] || refuse "SRC_GIT_FORBIDDEN:$x"; done
  r=$(G for-each-ref --format='%(refname)') || refuse SRC_GIT_REFS_UNREADABLE
  [ "$r" = refs/heads/accepted ] || refuse SRC_GIT_UNEXPECTED_REFS
  h=$(G rev-parse --verify 'HEAD^{{commit}}') || refuse SRC_GIT_HEAD_UNREADABLE
  [ "$h" = "$COMMIT" ] || refuse SOURCE_REPOSITORY_NOT_THE_ACCEPTED_COMMIT
}}
"""
A = "#!/bin/bash\n" + f"""# r7 Linux phase A (root, NO private key, changes nothing outside $BASE): checks the r5c2 install, stages, derives, host pins, the
# resident pins and three plans (uninstall, resident install, upgrade tool). Decision 0b8cab03 (+ the Source acceptance {REF[:8]}), commit {COMMIT[:8]}.
# = 10-23 stage-root.sh (b7ff5a32) + the read-only part of run-linux-p2.py, Source values changed; derive-roles-r4.py
# replaces derive-linux-v2.mjs. Writes only under $BASE, then (after staging) a review copy of public data next to $W.
#   /usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc /root/reinstall-linux-A-stage.sh
""" + COMMON + f"""quiet_and_installed
# The installed Linux half (from the node's version facts): its resident (OLD_LINUX_RES_MANIFEST), the frozen upgrade tool and its generation are EXPECTED;
# the installed tool's read-only version-facts must say exactly that (generation 1 of the old Source and resident, nothing staged)
[ "$(sha256sum /opt/clued-independent-ci/resident-v1/manifest.json | cut -d' ' -f1)" = "$OLD_LINUX_RES_MANIFEST" ] || refuse LINUX_RESIDENT_MANIFEST_NOT_THE_INSTALLED_R5C2
[ -e "$UPG/bin/clued-ci-upgrade-linux" ] && [ -e /var/lib/clued-independent-ci/resident/upgrade/current.json ] || refuse UPGRADE_CHANNEL_NOT_THE_R5C2_ONE
OLDF=$($CLEAN $PY -I "$UPG/bin/clued-ci-upgrade-linux" version-facts) || refuse OLD_VERSION_FACTS_FAILED
printf '%s\\n' "$OLDF" | $CLEAN $PY -I -c 'import json,sys; f=json.load(sys.stdin); sys.exit(not (f.get("generation")==int(sys.argv[4]) and f.get("staged") is None and f.get("ciSourceManifestSha256")==sys.argv[1] and f.get("sourceCommit")==sys.argv[2] and f.get("manifestSha256")==sys.argv[3] and f.get("pinsOk") is True))' "$OLD_MANIFEST" "$OLD_COMMIT" "$OLD_LINUX_RES_MANIFEST" "$OLD_GENERATION" || {{ printf '%s\\n' "$OLDF"; refuse OLD_VERSION_FACTS_NOT_THE_INSTALLED_GENERATION; }}
# r7: the resident install refuses a non-empty runs directory and needs docker.service active (continue-after-boot): fail here, before B
[ -z "$(ls -A /var/lib/clued-independent-ci/runs 2>/dev/null)" ] || refuse RUNS_NOT_EMPTY
systemctl is-active --quiet docker.service || refuse DOCKER_SERVICE_NOT_ACTIVE
# r7: what phase B backs up before the uninstall: at most 2 GiB, room for it in /root, and no key, pem or token file in it
BK_BYTES=$(du -scb $BACKUP_PATHS | tail -1 | cut -f1) || refuse BACKUP_SIZE_UNREADABLE
[ "$BK_BYTES" -le 2147483648 ] || refuse BACKUP_TOO_LARGE
AVAIL=$(df --output=avail -B1 /root | tail -1 | tr -d ' ') || refuse ROOT_FREE_SPACE_UNREADABLE
[ "$AVAIL" -ge $((BK_BYTES + 1073741824)) ] || refuse NOT_ENOUGH_ROOM_FOR_THE_BACKUP
SECRET=$(find $BACKUP_PATHS \\( -name '*.pem' -o -name '*.key' -o -name '*.token' -o -name '*secret*' \\) -print -quit) || refuse BACKUP_SCAN_FAILED
[ -z "$SECRET" ] || refuse "BACKUP_WOULD_HOLD_A_SECRET:$SECRET"
[ ! -e "$BASE" ] || refuse STAGING_EXISTS_PRESERVE
install -d -o root -g root -m 0700 "$BASE" "$STG" "$STG/tools" "$STG/record" "$STG/linux-pkg" "$STG/linux-pkg/upgrade-v1" "$STG/linux-pkg/upgrade-v1/bin" "$STG/linux-res-pkg" "$STG/linux-res-pkg/bin" "$STG/linux-res-pkg/systemd"
for f in {' '.join(UPG_FILES)}; do install -o root -g root -m 0400 "$W/linux-pkg/$f" "$STG/linux-pkg/$f"; done   # r5c
for f in {' '.join(RES_FILES)}; do install -o root -g root -m 0400 "$W/linux-res-pkg/$f" "$STG/linux-res-pkg/$f"; done   # r7
for f in install-resident-linux.sh uninstall-resident-linux.sh clued-ci-install-source-v2 verify-resident-linux.sh derive-roles-r7.py verify-signed-r4.mjs check-host-r4.py sign-qualification-v2.mjs verify-source-v2.sh; do install -o root -g root -m 0400 "$W/tools/$f" "$STG/tools/$f"; done
for f in acceptance.json installation.json record-manifest.json signers.json source-manifest.json; do install -o root -g root -m 0400 "$W/record/$f" "$STG/record/$f"; done
cp -a --no-preserve=ownership "$W/src.git" "$STG/src.git"
chown -R root:root "$STG/src.git"
rm -rf -- "$STG/src.git/hooks"
rm -f -- "$STG/src.git/config"
printf '[core]\\n\\trepositoryformatversion = 0\\n\\tfilemode = true\\n\\tbare = true\\n' > "$STG/src.git/config"
src_git_clean
G fsck --strict --no-dangling --no-progress >/dev/null || refuse SOURCE_REPOSITORY_FSCK_FAILED
echo "$COMMIT" > "$STG/src-head.txt"
cd "$STG"
sha256sum --quiet -c - <<'EOF' || refuse STAGED_BYTES_NOT_THE_REVIEWED_ONES
{sums}EOF
# r5 L3: sign-qualification-v2.mjs (9ee06a93) and the generated verify-source-v2.sh are among the pinned files above
[ "$(sha256sum "$STG/tools/sign-qualification-v2.mjs" | cut -d' ' -f1)" = "$SIGN_SHA" ] || refuse SIGN_TOOL_NOT_THE_REVIEWED_ONE
PREV=windows-review-copy; VT=generated-on-windows-pinned
echo "{{\\"status\\":\\"ROOT_STAGING_VERIFIED\\",\\"staging\\":\\"$STG\\",\\"sourceCommit\\":\\"$COMMIT\\",\\"files\\":{len(files)},\\"signToolFrom\\":\\"$PREV\\",\\"verifyTemplateSha256\\":\\"$VT\\",\\"verifySourceV2Sha256\\":\\"$(sha256sum "$STG/tools/verify-source-v2.sh" | cut -d' ' -f1)\\"}}"
# derive (no key): policies v3 + unsigned payloads from the installed Source34 ones; the three Source values change (B-1)
$CLEAN $PY -I "$STG/tools/derive-roles-r7.py" --installed /etc/clued-independent-ci/roles-v3 --old-manifest-file /etc/clued-independent-ci/formal-source-manifest-v2.json --new-manifest-file "$STG/record/source-manifest.json" --src "$STG/src.git" --commit "$COMMIT" --source-acceptance-ref "$NEW_REF" --host-acceptance-ref "$NEW_REF" --out "$STG/roles-in" > "$STG/derive.stdout.json" || {{ cat "$STG/derive.stdout.json"; refuse DERIVE_FAILED; }}
cat "$STG/derive.stdout.json"
# M-2: the host binaries the derived policies pin, the toolchain node, the docker socket and the public key, as on 10-23
$CLEAN $PY -I "$STG/tools/check-host-r4.py" "$STG/roles-in" "$NODE_SHA" "$PUB_SHA" > "$STG/host-A.stdout.json" || {{ cat "$STG/host-A.stdout.json"; refuse HOST_PINS_CHANGED; }}
cat "$STG/host-A.stdout.json"
# r7 (review BLOCKER-1): the new resident manifest pins the NEW commit's source-v2 files (phase B installs that Source before the
# resident, whose continue-after-boot checks every pin), the toolchain node and exactly the staged resident files
$CLEAN $PY -I -c 'import json,sys,subprocess,hashlib
m=json.load(open(sys.argv[1])); s="/opt/clued-independent-ci/source-v2/"; e={{"PATH":"/usr/bin:/bin","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null"}}; bad=[]
own={{"/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux":"bin/clued-ci-resident-linux","/etc/systemd/system/clued-ci-worker@.service":"systemd/clued-ci-worker@.service","/etc/systemd/system/clued-ci-wsprep@.service":"systemd/clued-ci-wsprep@.service","/etc/systemd/system/clued-ci-archive@.service":"systemd/clued-ci-archive@.service"}}
for f in m["files"]:
  p=f["installedPath"]
  if p.startswith(s):
    b=subprocess.run(["git","--git-dir",sys.argv[2],"cat-file","blob",sys.argv[3]+":"+p[len(s):]],env=e,capture_output=True,check=True).stdout
    bad+=[p] if hashlib.sha256(b).hexdigest()!=f["sha256"] else []
  elif p==sys.argv[4]: bad+=[p] if f["sha256"]!=sys.argv[5] else []
  elif p in own: bad+=[p] if hashlib.sha256(open(sys.argv[6]+"/"+own[p],"rb").read()).hexdigest()!=f["sha256"] else []
  else: bad.append(p)
print(json.dumps({{"residentPinsNotTheNewSource":bad}})); sys.exit(1 if bad else 0)' "$STG/linux-res-pkg/manifest.json" "$STG/src.git" "$COMMIT" "$NODE" "$NODE_SHA" "$STG/linux-res-pkg" > "$STG/resident-pins.A.stdout.json" || {{ cat "$STG/resident-pins.A.stdout.json"; refuse RESIDENT_PINS_NOT_THE_NEW_SOURCE; }}
# r7: three read-only plans, pinned below. (1) the uninstall, live: phase B recomputes it and applies only the same sha.
bash --noprofile --norc "$STG/tools/uninstall-resident-linux.sh" --plan > "$STG/uninstall-plan.A.stdout.txt" || {{ cat "$STG/uninstall-plan.A.stdout.txt"; refuse UNINSTALL_PLAN_REFUSED; }}
grep -q '"status":"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN"' "$STG/uninstall-plan.A.stdout.txt" || refuse UNINSTALL_PLAN_REFUSED
for l in active= opt=yes upgrade-v1=yes generations= archive= staging=; do grep -qx "$l" "$STG/uninstall-plan.A.stdout.txt" || {{ cat "$STG/uninstall-plan.A.stdout.txt"; refuse "UNINSTALL_PLAN_NOT_THE_EXPECTED_HOST:$l"; }}; done
# (2) the resident install and (3) the upgrade-tool install, computed live on the staged copies with the lines that the uninstall
# changes set as they will be then: they must be the plans generated on Windows (phase B applies exactly them)
bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --plan "$STG/linux-res-pkg" > "$STG/install-plan.A.stdout.txt" || {{ cat "$STG/install-plan.A.stdout.txt"; refuse INSTALL_PLAN_REFUSED; }}
[ "$(printf '%s' "$(plan_after_uninstall "$STG/install-plan.A.stdout.txt")" | sha256sum | cut -d' ' -f1)" = "$INSTALL_PLAN" ] || {{ cat "$STG/install-plan.A.stdout.txt"; refuse INSTALL_PLAN_NOT_AS_GENERATED; }}
bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --plan-upgrade-v1 "$STG/linux-pkg" > "$STG/upgrade-plan.stdout.txt" || {{ cat "$STG/upgrade-plan.stdout.txt"; refuse UPGRADE_PLAN_REFUSED; }}
[ "$(printf '%s' "$(plan_after_uninstall "$STG/upgrade-plan.stdout.txt")" | sha256sum | cut -d' ' -f1)" = "$UPG_PLAN" ] || {{ cat "$STG/upgrade-plan.stdout.txt"; refuse UPGRADE_PLAN_NOT_AS_GENERATED; }}
printf '%s\\n' "$OLDF" > "$STG/old-version-facts.json"
(cd "$STG" && sha256sum roles-in/* tools/* record/* linux-pkg/upgrade-v1/manifest.json linux-pkg/upgrade-v1/bin/* linux-res-pkg/manifest.json linux-res-pkg/bin/* linux-res-pkg/systemd/* upgrade-plan.stdout.txt install-plan.A.stdout.txt uninstall-plan.A.stdout.txt resident-pins.A.stdout.json old-version-facts.json src-head.txt > "$STG/phaseA.sha256")
# review copy (public data only), written after staging (review minor 4)
RV="$W/../review-A-{SUFFIX}"
[ ! -e "$RV" ] || refuse REVIEW_COPY_EXISTS
install -d -m 0755 "$RV" "$RV/roles-in" "$RV/tools"
install -m 0644 "$STG"/roles-in/* "$RV/roles-in/"; install -m 0644 "$STG/tools/verify-source-v2.sh" "$STG/tools/sign-qualification-v2.mjs" "$RV/tools/"
install -m 0644 "$STG/derive.stdout.json" "$STG/host-A.stdout.json" "$STG/upgrade-plan.stdout.txt" "$STG/install-plan.A.stdout.txt" "$STG/uninstall-plan.A.stdout.txt" "$STG/resident-pins.A.stdout.json" "$STG/old-version-facts.json" "$STG/phaseA.sha256" "$RV/"
echo "{{\\"status\\":\\"PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED\\",\\"phaseAManifestSha256\\":\\"$(sha256sum "$STG/phaseA.sha256" | cut -d' ' -f1)\\"}}"
"""
MODS = ['worker/qualification-v2.mjs', 'src/worker-v2.mjs', 'src/job-v2.mjs', 'src/proof.mjs', 'src/queue.mjs']
B = "#!/bin/bash\n" + f"""# r7 Linux phase B (root; after the Source switch: backup, uninstall and reinstall of the Linux resident half, the upgrade tool,
# generation 1, the version facts and verify, each step fatal, nothing rolled back (reinstall-linux-B-resume.sh continues after a failure); STEP B1 READS THE PRIVATE KEY /etc/clued-independent-ci/verify-result-key.pem through the
# reviewed sign-qualification-v2.mjs; nothing prints it). = run-linux-p2.py from the signing on, Source values changed.
#   /usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc /root/reinstall-linux-B-switch.sh <phaseAManifestSha256 as reviewed>
""" + COMMON + f"""WANT_A="${{1:?phase A manifest sha256 required}}"
# B0: everything phase A staged is still as reviewed (minor 3): the manifest, every listed byte, the bare repo, the sign tool
[ "$(sha256sum "$STG/phaseA.sha256" | cut -d' ' -f1)" = "$WANT_A" ] || refuse PHASE_A_NOT_AS_REVIEWED
(cd "$STG" && sha256sum --quiet -c phaseA.sha256) || refuse STAGED_BYTES_CHANGED_SINCE_PHASE_A
src_git_clean
[ "$(sha256sum "$STG/tools/sign-qualification-v2.mjs" | cut -d' ' -f1)" = "$SIGN_SHA" ] || refuse SIGN_TOOL_CHANGED
[ ! -e "$STG/roles-signed" ] && [ ! -e "$STG/pkg" ] && [ ! -e "$STG/check" ] || refuse PHASE_B_OUTPUT_EXISTS_SEE_RECOVERY
# r7: still the r5c2 install as phase A saw it, and no output of an earlier B run in the way (a run that got past the Source switch
# continues with reinstall-linux-B-resume.sh)
[ "$(sha256sum /opt/clued-independent-ci/resident-v1/manifest.json | cut -d' ' -f1)" = "$OLD_LINUX_RES_MANIFEST" ] || refuse LINUX_RESIDENT_MANIFEST_NOT_THE_INSTALLED_R5C2
[ ! -e "$BASE/superseded-suffix.txt" ] || refuse SOURCE_ALREADY_SWITCHED_RUN_THE_RESUME_SCRIPT
for f in host-B0.stdout.json sign.stdout.json verify-signed.stdout.json package.stdout.json; do [ ! -e "$STG/$f" ] || refuse PHASE_B_OUTPUT_EXISTS_SEE_RECOVERY; done
[ ! -e "$BASE/pre-uninstall-backup.tar" ] && [ ! -e "$BASE/uninstall-apply.stdout.json" ] || refuse PHASE_B_OUTPUT_EXISTS_SEE_RECOVERY
# r7 (review MAJOR-1): what the reinstall needs is checked here, before the Source switch, read-only: docker, and the three plans again
systemctl is-active --quiet docker.service || refuse DOCKER_SERVICE_NOT_ACTIVE
B0T="$STG/b0-$(date -u +%Y%m%dT%H%M%SZ)"; install -d -m 0700 "$B0T"
bash --noprofile --norc "$STG/tools/uninstall-resident-linux.sh" --plan > "$B0T/uninstall-plan.stdout.txt" || {{ cat "$B0T/uninstall-plan.stdout.txt"; refuse UNINSTALL_PLAN_REFUSED; }}
UPA=$(grep -o '"planSha256":"[0-9a-f]\\{{64\\}}"' "$STG/uninstall-plan.A.stdout.txt" | cut -d'"' -f4) || refuse UNINSTALL_PLAN_UNREADABLE
UPN=$(grep -o '"planSha256":"[0-9a-f]\\{{64\\}}"' "$B0T/uninstall-plan.stdout.txt" | cut -d'"' -f4) || refuse UNINSTALL_PLAN_UNREADABLE
[ "$UPN" = "$UPA" ] || {{ cat "$B0T/uninstall-plan.stdout.txt"; refuse UNINSTALL_PLAN_CHANGED_SINCE_PHASE_A; }}
bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --plan "$STG/linux-res-pkg" > "$B0T/install-plan.stdout.txt" || {{ cat "$B0T/install-plan.stdout.txt"; refuse INSTALL_PLAN_REFUSED; }}
[ "$(printf '%s' "$(plan_after_uninstall "$B0T/install-plan.stdout.txt")" | sha256sum | cut -d' ' -f1)" = "$INSTALL_PLAN" ] || {{ cat "$B0T/install-plan.stdout.txt"; refuse INSTALL_PLAN_NOT_AS_GENERATED; }}
bash --noprofile --norc "$STG/tools/install-resident-linux.sh" --plan-upgrade-v1 "$STG/linux-pkg" > "$B0T/upgrade-plan.stdout.txt" || {{ cat "$B0T/upgrade-plan.stdout.txt"; refuse UPGRADE_PLAN_REFUSED; }}
[ "$(printf '%s' "$(plan_after_uninstall "$B0T/upgrade-plan.stdout.txt")" | sha256sum | cut -d' ' -f1)" = "$UPG_PLAN" ] || {{ cat "$B0T/upgrade-plan.stdout.txt"; refuse UPGRADE_PLAN_NOT_AS_GENERATED; }}
quiet_and_installed
$CLEAN $PY -I "$STG/tools/check-host-r4.py" "$STG/roles-in" "$NODE_SHA" "$PUB_SHA" > "$STG/host-B0.stdout.json" || {{ cat "$STG/host-B0.stdout.json"; refuse HOST_PINS_CHANGED; }}
# B1 [PRIVATE KEY]: sign the three qualifications v2 (the tool reads the key itself, adds only qualifiedAt, verifies, writes create-only)
$CLEAN "$NODE" "$STG/tools/sign-qualification-v2.mjs" --in "$STG/roles-in" --out "$STG/roles-signed" > "$STG/sign.stdout.json" || {{ cat "$STG/sign.stdout.json"; refuse SIGNING_FAILED; }}
grep -q QUALIFICATIONS_V2_SIGNED "$STG/sign.stdout.json" || refuse SIGNING_FAILED
# B2 (public key only, B-2): the five imported modules come straight from the pinned commit (no archive, no replace objects) and are
# checked against the record manifest pins inside verify-signed-r4.mjs before any import
install -d -m 0700 "$STG/check" "$STG/check/worker" "$STG/check/src"
for rel in {' '.join(MODS)}; do G cat-file blob "$COMMIT:{CI}/$rel" > "$STG/check/$rel" || refuse "MODULE_EXTRACT_FAILED:$rel"; done
$CLEAN "$NODE" "$STG/tools/verify-signed-r4.mjs" "$STG/check" "$STG/roles-signed" "$STG/roles-in" /etc/clued-independent-ci/verify-result-public.pem "$STG/record/source-manifest.json" > "$STG/verify-signed.stdout.json" || {{ cat "$STG/verify-signed.stdout.json"; refuse SIGNED_SET_REFUSED; }}
cat "$STG/verify-signed.stdout.json"
# B3: the Linux Source v2 package (offline; the installer sets GIT_NO_REPLACE_OBJECTS itself)
$CLEAN $PY -I "$STG/tools/clued-ci-install-source-v2" package --record "$STG/record" --source-root "$STG/src.git" --roles "$STG/roles-signed" --out "$STG/pkg" > "$STG/package.stdout.json" || {{ cat "$STG/package.stdout.json"; refuse PACKAGE_FAILED; }}
grep -q LINUX_SOURCE_V2_PACKAGE_WRITTEN "$STG/package.stdout.json" || refuse PACKAGE_FAILED
# B4 (L1): quiet, host pins and every path checked BEFORE the first rename (minor 5); then move the Source34 Linux Source v2 aside,
# never delete (10-23: *.superseded-<old8>-<tag>-<UTC>)
quiet_and_installed
$CLEAN $PY -I "$STG/tools/check-host-r4.py" "$STG/roles-in" "$NODE_SHA" "$PUB_SHA" > "$STG/host-B4.stdout.json" || {{ cat "$STG/host-B4.stdout.json"; refuse HOST_PINS_CHANGED; }}
S=superseded-${{OLD_COMMIT:0:8}}-r5c2-$(date -u +%Y%m%dT%H%M%SZ)
P4="/opt/clued-independent-ci/source-v2 /etc/clued-independent-ci/formal-source-manifest-v2.json /etc/clued-independent-ci/roles-v3 /var/lib/clued-independent-ci/resident/source-v2-install-receipt.json"
for p in $P4; do [ -e "$p" ] || refuse "MOVE_ASIDE_SOURCE_MISSING:$p"; [ ! -e "$p.$S" ] || refuse "MOVE_ASIDE_TARGET_EXISTS:$p.$S"; done
echo "$S" > "$BASE/superseded-suffix.txt"
for p in $P4; do
  mv -T --no-clobber "$p" "$p.$S" || refuse "MOVE_ASIDE_FAILED_SEE_RECOVERY:$p"; [ ! -e "$p" ] && [ -e "$p.$S" ] || refuse "MOVE_ASIDE_UNCONFIRMED:$p"; echo "moved $p -> $p.$S"
done
# B5 (L4): plan, read-only; every target absent, receipt absent, role lock absent, this commit and manifest, the toolchain node
$CLEAN $PY -I "$STG/tools/clued-ci-install-source-v2" --plan "$STG/pkg" > "$STG/l4-plan.stdout.json" || {{ cat "$STG/l4-plan.stdout.json"; refuse PLAN_REFUSED_SEE_RECOVERY; }}
PLAN=$($CLEAN $PY -I -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["plan"]; h=p["host"]; ok=d["status"]=="DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN" and p["sourceCommit"]==sys.argv[2] and p["ciSourceManifestSha256"]==sys.argv[3] and all(h["targetsAbsent"].values()) and h["receiptAbsent"] and h["roleLockAbsent"] and h["gitPresent"] and h["nodeSha256"]==sys.argv[4]; print(d["planSha256"] if ok else "")' "$STG/l4-plan.stdout.json" "$COMMIT" "$NEW_MANIFEST" "$NODE_SHA")
[ -n "$PLAN" ] || refuse PLAN_NOT_AS_EXPECTED_SEE_RECOVERY
# B6 (L5): apply exactly that plan; readiness = loadQualifiedPolicyV2 per role with the pinned node
$CLEAN $PY -I "$STG/tools/clued-ci-install-source-v2" --apply "$STG/pkg" "$PLAN" > "$STG/l5-apply.stdout.json" || {{ cat "$STG/l5-apply.stdout.json"; refuse APPLY_NOT_CONFIRMED_SEE_RECOVERY; }}
grep -q INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED "$STG/l5-apply.stdout.json" || refuse APPLY_NOT_CONFIRMED_SEE_RECOVERY
# B7: verify (read-only). verify-source-v2 is fatal; verify-resident-linux is reported, not fatal, as on 10-23 (minor 10)
bash --noprofile --norc "$STG/tools/verify-source-v2.sh" "$STG/roles-signed" > "$STG/l5-verify.stdout.json" || true
cat "$STG/l5-verify.stdout.json"
grep -q LINUX_SOURCE_V2_VERIFIED "$STG/l5-verify.stdout.json" || refuse SOURCE_V2_VERIFY_FAILED_AFTER_APPLY_SEE_RECOVERY
# r7 B7b-B8: backup, uninstall and reinstall of the Linux resident half, the upgrade tool, generation 1, the version facts, verify and
# the evidence (reinstall_tail above). After a failure from here on, reinstall-linux-B-resume.sh runs the same again.
reinstall_tail
"""
# r7: resume after a failure past the Source switch (phase A as reviewed, the Source switched and verified by B, then reinstall_tail again)
RESUME = "#!/bin/bash\n" + f"""# r7 Linux phase B resume (root, no private key): after reinstall-linux-B-switch.sh switched and verified the Source and then stopped,
# runs the rest again; each step found done is checked, not repeated. Commit {COMMIT[:8]}.
#   /usr/bin/env -i R4_CLEAN_ENV=1 PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc /root/reinstall-linux-B-resume.sh <phaseAManifestSha256 as reviewed>
""" + COMMON + f"""WANT_A="${{1:?phase A manifest sha256 required}}"
# everything phase A staged is still as reviewed
[ "$(sha256sum "$STG/phaseA.sha256" | cut -d' ' -f1)" = "$WANT_A" ] || refuse PHASE_A_NOT_AS_REVIEWED
(cd "$STG" && sha256sum --quiet -c phaseA.sha256) || refuse STAGED_BYTES_CHANGED_SINCE_PHASE_A
src_git_clean
# only after reinstall-linux-B-switch.sh switched the Source and verified it (otherwise run B; a failed Source switch needs the recovery)
[ -e "$BASE/superseded-suffix.txt" ] || refuse SOURCE_NOT_SWITCHED_RUN_B
grep -q INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED "$STG/l5-apply.stdout.json" && grep -q LINUX_SOURCE_V2_VERIFIED "$STG/l5-verify.stdout.json" || refuse SOURCE_SWITCH_NOT_VERIFIED_SEE_RECOVERY
reinstall_tail
"""
out = {}
for name, text in (('reinstall-linux-A-stage.' + SUFFIX + '.sh', A), ('reinstall-linux-B-switch.' + SUFFIX + '.sh', B), ('reinstall-linux-B-resume.' + SUFFIX + '.sh', RESUME)):
    p = os.path.join(R, 'linux', name)
    with open(p, 'xb') as f:
        f.write(text.encode('utf-8'))
    out[name] = sha(p)
print(json.dumps({'scripts': out, 'pinnedFiles': len(files), 'W': W, 'base': BASE, 'packageManifestSha256': PKG_SHA, 'linuxResidentManifest': LINUX_RES_MANIFEST, 'upgradePlanSha256': UPG_PLAN, 'installPlanSha256': INSTALL_PLAN, 'oldPackage': OLD_PKG_SHA}, indent=1))
