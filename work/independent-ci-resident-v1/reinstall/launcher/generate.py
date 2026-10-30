"""Generate the elevated reinstall launcher for one node and one package (README.md section 4), from the committed launcher template
(template.ps1: the reviewed text the r4..r7 TURING reinstalls ran, its exact-literal patch history folded in; its sha is pinned below)
and the reinstall configuration (tools/rconfig.py). Every value the launcher pins comes from a file: the package, the configuration, the
node profile the package records, and what is installed on this host (read-only). Never elevates, never runs WSL, writes only new files.

A FINAL launcher needs, besides the Linux evidence and version facts of phase B, a PASS rehearsal of exactly this package and
configuration (rehearse.py: the installed tools' real read-only dry runs and the pin / role derivations against the new commit).

  python -I generate.py <config.json> --commit <40hex> --package <dir> --package-sha <64hex>
         --rebuild-record <dir> --rebuild-policy <file> --rebuild-source-files <file> --rebuild-upgrader-config <file>
         --rebuild-linux-external-pins <file> [--accept-halt-sha256 <64hex>] [--launch-dir <dir>]
         [--final --linux-evidence <file> --linux-version-facts <file> --rehearsal <rehearsal report>]

What the launcher does, and why each step is there (Q1..Q5, r4.1 C1..C3, r5 S1..S3, r5c, r7): README.md section 4 and the comments in
template.ps1.
"""
import datetime, hashlib, json, os, re, subprocess, sys

if sys.flags.optimize:   # the gates below are asserts
    sys.exit('RUN_WITHOUT_PYTHON_-O')
import importlib.util
BS = chr(92)
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('rconfig', os.path.join(HERE, '..', 'tools', 'rconfig.py'))
rconfig = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(rconfig)
CFG = rconfig.load(sys.argv[1])
A = sys.argv[2:]
def opt(name, default=None):
    return A[A.index(name) + 1] if name in A else default
FINAL = '--final' in A
COMMIT = opt('--commit'); PKG = os.path.abspath(opt('--package') or ''); PKG_SHA = opt('--package-sha')
assert COMMIT and re.fullmatch(r'[0-9a-f]{40}', COMMIT), 'COMMIT_40HEX_REQUIRED'
assert PKG_SHA and re.fullmatch(r'[0-9a-f]{64}', PKG_SHA), 'PACKAGE_SHA_REQUIRED'
# review 1-4: the rebuild and the pins read the extracted tree; it must be exactly the commit
_tspec = importlib.util.spec_from_file_location('tree', os.path.join(HERE, '..', 'tools', 'tree.py'))
_tree = importlib.util.module_from_spec(_tspec); _tspec.loader.exec_module(_tree)
_tree.verify(CFG['repo'], COMMIT, os.path.join(CFG['workDir'], 'tree-' + COMMIT[:8]))
LINUX_EVIDENCE = opt('--linux-evidence')
TOKEN_FILE = CFG['upgradeTokenFile']   # path only: its content is never opened here
REHEARSAL = opt('--rehearsal')
FACTS = opt('--linux-version-facts')   # r5c
R4 = CFG['workDir']
OUTDIR = os.path.join(R4, 'launcher')
GEN_UTC = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
LAUNCH_DIR = os.path.abspath(opt('--launch-dir', os.path.join(R4, 'launch-' + GEN_UTC))).replace('/', BS)
assert not os.path.exists(LAUNCH_DIR), ('LAUNCH_DIR_EXISTS_NEVER_REUSED', LAUNCH_DIR)

TEMPLATE = os.path.join(HERE, 'template.ps1')
TEMPLATE_SHA = '5e0a500c760ce695e3e3a141f428653434df0a75598ca222fec1b5641bccf44a'   # the r7 f4 TURING launcher text (6d32f2ba) with the host name as a pin ($NodeHostname)
EXPECTED_PLAN = os.path.join(HERE, 'expected-plan.ps1')
POWERSHELL = BS.join(['C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])
LIVE_ROOT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident'])
SPOOL = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'formal-spool'])
ARCHIVE_REASON = 'v1-leftover-none-r4'
ARCHIVE_KEY = hashlib.sha256(b'clued.independent-ci.v1-leftover/r4').hexdigest()
REARM_REASON = CFG['launcher']['rearmReason']
PAUSE_REASON = CFG['launcher']['pauseReason']
PAUSE_WAIT_SECONDS = 420          # Q3
FIRST_TRAIN_WAIT_SECONDS = 1500   # Q2 phase 1 (review M1): backfill + stage-11 role probe (invoker 420 s) + stage-10 train (300 s) + retention (<= 3 min) + margin
RUNNER_QUIET_WAIT_SECONDS = 900   # Q2 phase 2: always, before verify
assert FIRST_TRAIN_WAIT_SECONDS >= 1500
assert PAUSE_WAIT_SECONDS >= 420 and re.fullmatch(r'[a-z0-9-]{1,200}', PAUSE_REASON)
CI = 'source/work/actions-hosted-migration/independent-ci-v1/src/resident-v2/'
STAGED = [('install-resident.ps1', 'resident/windows/install-resident.ps1'), ('verify-resident.ps1', 'resident/windows/verify-resident.ps1'), ('migrate-acl.ps1', CI + 'migrate-acl.ps1'), ('acl-model.json', CI + 'acl-model.json')]


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def q(s):
    # review 1-3: printable ASCII only (PowerShell also ends a '...' string at U+2018..U+201B), and no ASCII quote
    if not re.fullmatch(r"[\x20-\x26\x28-\x7e]*", s):
        sys.exit('VALUE_NOT_SAFE_IN_A_POWERSHELL_STRING %r' % s)
    return "'" + s + "'"


def write_new(path, data):
    with open(path, 'xb') as f:
        f.write(data)


# ---- the committed template (no patches: its history is folded in and reviewed as text) ----
template = open(TEMPLATE, encoding='utf8').read()
assert hashlib.sha256(template.encode('utf8')).hexdigest() == TEMPLATE_SHA, 'TEMPLATE_NOT_THE_REVIEWED_ONE'
assert 'B30' not in template and 'b30' not in template

# ---- package pins (Q4) ----
pkg_path = os.path.join(PKG, 'package-manifest.json')
pkg_sha = sha(pkg_path)
assert pkg_sha == PKG_SHA, ('PACKAGE_NOT_THE_NAMED_ONE', pkg_sha)
pkg = json.load(open(pkg_path, encoding='utf8'))
# ---- r7: the package's Linux resident manifest has the installed one's shape; its own files may differ, the source-v2 pins are this
# commit's files (its tree under r4-work), every other external pin is the installed value (make-linux-pins-r7.py check, review BLOCKER-1) ----
INSTALLED_LINUX_MANIFEST = CFG['linux']['installedManifest']
assert INSTALLED_LINUX_MANIFEST, 'INSTALLED_LINUX_MANIFEST_REQUIRED'
with open(INSTALLED_LINUX_MANIFEST, 'rb') as f:
    installed_linux_manifest = f.read()
with open(os.path.join(PKG, 'linux', 'manifest.json'), 'rb') as f:
    package_linux_manifest = f.read()
assert pkg['linux']['manifestSha256'] == hashlib.sha256(package_linux_manifest).hexdigest()
_a, _b = json.loads(package_linux_manifest), json.loads(installed_linux_manifest)
assert (_a['contract'] == _b['contract'] and len(_a['files']) == len(_b['files']) and [f['installedPath'] for f in _a['files']] == [f['installedPath'] for f in _b['files']]), 'PACKAGE_LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE'
_SV2, _TREE = '/opt/clued-independent-ci/source-v2/', os.path.join(R4, 'tree-' + COMMIT[:8])
for _f, _g in zip(_a['files'][4:], _b['files'][4:]):
    if _f['installedPath'].startswith(_SV2):
        _rel = _f['installedPath'][len(_SV2):]
        assert '..' not in _rel.split('/') and _f['sha256'] == hashlib.sha256(open(os.path.join(_TREE, *_rel.split('/')), 'rb').read()).hexdigest(), ('PACKAGE_LINUX_PIN_NOT_THE_NEW_SOURCE', _f)
    else:
        assert _f == _g, ('PACKAGE_LINUX_PIN_NOT_THE_INSTALLED_ONE', _f)
R7_LINUX_CHANGED = [f['installedPath'] for f, g in zip(_a['files'], _b['files']) if f['sha256'] != g['sha256']]
by_path = {f['path']: f for f in pkg['files']}
staged = []
for name, rel in STAGED:
    entry = by_path[rel]
    assert sha(os.path.join(PKG, *rel.split('/'))) == entry['sha256'], rel
    staged.append((name, rel, entry['sha256']))
record_manifest = os.path.join(PKG, 'record', 'source-manifest.json')
assert sha(record_manifest) == pkg['ciSourceManifestSha256'], 'PACKAGE_RECORD_NOT_ITS_CI_SOURCE'
source_sha = json.load(open(record_manifest, encoding='utf8'))['sourceSha']
assert source_sha == COMMIT, ('PACKAGE_NOT_THIS_COMMIT', source_sha)
acceptance = json.load(open(os.path.join(PKG, 'record', 'acceptance.json'), encoding='utf8'))
node = acceptance['node']
TREE = os.path.join(R4, 'tree-' + COMMIT[:8])
profile, _profile_sha = rconfig.node_profile(CFG, TREE)
assert node == profile, ('PACKAGE_NODE_NOT_THE_CONFIGURED_PROFILE', node.get('nodeName'))
OWNER, CONTROLLER = node['ownerSid'], node['controllerSid']
RUNNER = {'service': node['runnerService'], 'binary': CFG['runner']['binary'], 'sddl': CFG['runner']['sddl']}
policy = json.load(open(os.path.join(PKG, 'config', 'policy.json'), encoding='utf8'))
assert policy['residentManifestSha256'] == pkg['residentManifestSha256'] and policy['ciSourceManifestSha256'] == pkg['ciSourceManifestSha256']
installer = open(os.path.join(PKG, 'resident', 'windows', 'install-resident.ps1'), encoding='utf8').read()
exact_guard = "if ($back -cne $sddl) { throw ('ACL_READBACK_MISMATCH:' + $path) }" in installer
canonical = "$back -cne $acl.GetSecurityDescriptorSddlForm('All')" in installer
assert exact_guard != canonical
rearm = by_path['resident/windows/rearm-resident.ps1']
# ---- r5c: package /4 placing the upgrader (fresh install), its configuration, the installer's token constants ----
assert pkg['contract'] == 'clued.independent-ci.resident-package/4', ('PACKAGE_4_REQUIRED', pkg['contract'])
UPG_SECTION = pkg['upgrader']
upg_targets = [f for f in pkg['files'] if f['target'].startswith('upgrader' + BS)]
assert len(upg_targets) == len(UPG_SECTION['files']) + 3, ('UPGRADER_NOT_PLACED_BY_THIS_PACKAGE', len(upg_targets))
ucfg_entry = [f for f in pkg['files'] if f['target'] == 'upgrader' + BS + 'config' + BS + 'upgrader.json']
assert len(ucfg_entry) == 1, 'UPGRADER_CONFIG_NOT_IN_PACKAGE'
ucfg = json.load(open(os.path.join(PKG, *ucfg_entry[0]['path'].split('/')), encoding='utf8'))
TOKEN_TARGET = re.search(r"(?m)^\$UpgradeTokenTarget = '([^']+)'", installer).group(1)
SECRET_WORK_PARENT = re.search(r"(?m)^\$SecretWorkParent = '([^']+)'", installer).group(1)
SECRET_WORK_SDDL = re.search(r"(?m)^\$SecretWorkSddl = '([^']+)'", installer).group(1)
assert TOKEN_TARGET == LIVE_ROOT + BS + 'secrets' + BS + 'resident-upgrade.token', TOKEN_TARGET
PKG_INST = json.load(open(os.path.join(PKG, 'record', 'installation.json'), encoding='utf8'))
UCFG_WANT = {'contract': 'clued.independent-ci.resident-upgrader-config/1', 'node': node['nodeName'], 'nodeProfileSha256': pkg['nodeProfileSha256'], 'ownerSid': OWNER,
             'root': LIVE_ROOT, 'supabaseUrl': PKG_INST['supabaseUrl'], 'publishableKey': PKG_INST['publishableKey'],   # the package record's public values
             'confirmOrigin': 'https://kooyumi.pixelgrav.com', 'tokenFile': TOKEN_TARGET,
             'timeouts': {'drainMaxMinutes': 120, 'drainRetryMinutes': 60, 'deferMaxHours': 24, 'pauseConfirmMs': 600000, 'verifyMaxMs': 2700000, 'grantPollMs': [30000, 120000]},
             'keepGenerations': 3}
assert ucfg == UCFG_WANT, ('UPGRADER_CONFIG_NOT_AS_GENERATED', ucfg)
assert re.fullmatch(r'[A-Za-z]:\\[^\s"\']+', TOKEN_FILE), ('UPGRADE_TOKEN_FILE_PATH_SHAPE', TOKEN_FILE)   # Invoke-Child refuses blanks and quotes
token_file_present = os.path.isfile(TOKEN_FILE)   # stat only: the token's content is never opened here
upgrader_service_present = subprocess.run([BS.join(['C:', 'Windows', 'System32', 'sc.exe']), 'query', 'CluedCIUpgrader'], capture_output=True).returncode != 1060
# review m7: never trust --package-sha alone. Every package file must match its manifest, and the package is rebuilt here from the
# named inputs (build-package.mjs of this commit's tree, into a NEW directory) and must give the same manifest sha.
for f in pkg['files']:
    assert sha(os.path.join(PKG, *f['path'].split('/'))) == f['sha256'], ('PACKAGE_FILE_NOT_ITS_MANIFEST', f['path'])
REB = {k: opt('--rebuild-' + k) for k in ('record', 'policy', 'source-files', 'upgrader-config', 'linux-external-pins')}
REB['companion'] = CFG['companionInput']
assert all(REB.values()), 'REBUILD_INPUTS_REQUIRED'
rebuild_dir = os.path.join(R4, 'rebuild-' + COMMIT[:8] + '-' + GEN_UTC)
rb_out = subprocess.run(['node', 'tools/build-package.mjs', '--out', rebuild_dir, '--policy', REB['policy'], '--companion', REB['companion'],
                         '--node', CFG['nodeExe'], '--record', REB['record'], '--source-root', TREE,
                         '--source-files', REB['source-files'], '--fresh-install', '--upgrader-config', REB['upgrader-config'], '--linux-external-pins', REB['linux-external-pins']], cwd=os.path.join(TREE, 'work', 'independent-ci-resident-v1'), capture_output=True, text=True)
assert rb_out.returncode == 0, ('REBUILD_FAILED', rb_out.stderr[-600:])
rebuilt = json.loads(rb_out.stdout)
assert rebuilt['packageManifestSha256'] == pkg_sha == sha(os.path.join(rebuild_dir, 'package-manifest.json')), ('REBUILD_DIFFERS', rebuilt['packageManifestSha256'], pkg_sha)

# ---- r4.1 C1: every *Script path of the built companion config is a file of this package's installed Source ----
comp = json.load(open(os.path.join(PKG, 'config', 'companion.json'), encoding='utf8'))
targets = {f['target']: f for f in pkg['files']}
SRC_PREFIX = 'C:' + BS + 'ProgramData' + BS + 'CluedIndependentCI' + BS + 'resident' + BS + 'source' + BS + pkg['ciSourceManifestSha256'] + BS
script_paths = []
def walk(v, at):
    if isinstance(v, dict):
        for k, x in v.items():
            if k.endswith('Script'):
                script_paths.append((at + '.' + k, x))
            walk(x, at + '.' + k)
walk(comp, '')
assert len(script_paths) >= 2, ('COMPANION_SCRIPTS_MISSING', script_paths)
for at, pth in script_paths:
    assert isinstance(pth, str) and pth.startswith(SRC_PREFIX), ('COMPANION_SCRIPT_NOT_UNDER_THIS_SOURCE', at, pth)
    tgt = 'source' + BS + pkg['ciSourceManifestSha256'] + BS + pth[len(SRC_PREFIX):]
    assert tgt in targets and os.path.isfile(os.path.join(PKG, *targets[tgt]['path'].split('/'))), ('COMPANION_SCRIPT_NOT_IN_PACKAGE', at, pth)

# ---- r5 S3 (review d-m1): every absolute path in config/*.json and record/*.json ----
RES_ROOT = 'C:' + BS + 'ProgramData' + BS + 'CluedIndependentCI' + BS + 'resident' + BS
target_dirs = set()
for tg in targets:
    parts = tg.split(BS)
    for i in range(1, len(parts)):
        target_dirs.add(BS.join(parts[:i]))
win_paths, posix_paths = [], []
def walk_all(v, at):
    if isinstance(v, dict):
        for k, x in v.items():
            walk_all(x, at + '.' + k)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            walk_all(x, at + '[' + str(i) + ']')
    elif isinstance(v, str):
        if re.match(r'^[A-Za-z]:\\', v):
            win_paths.append((at, v))
        elif v.startswith('/'):
            posix_paths.append((at, v))
for d in ('config', 'record'):
    for f in sorted(os.listdir(os.path.join(PKG, d))):
        if f.endswith('.json'):
            walk_all(json.load(open(os.path.join(PKG, d, f), encoding='utf8')), d + '/' + f)
path_report = []
for at, pth in win_paths:
    if pth.lower().startswith(RES_ROOT.lower()):
        rel = pth[len(RES_ROOT):].rstrip(BS)
        ok = (rel in targets and os.path.isfile(os.path.join(PKG, *targets[rel]['path'].split('/')))) or rel in target_dirs
        kind = 'package'
    else:
        ok = os.path.exists(pth); kind = 'host'
    path_report.append({'at': at, 'path': pth, 'kind': kind, 'ok': ok})
    assert ok, ('ABSOLUTE_PATH_NOT_PRESENT', at, pth)
assert len(win_paths) >= 2

# ---- Q5: the reviewed post-uninstall plan, computed now (non-elevated installer dry run, read-only) ----
os.makedirs(os.path.join(R4, 'dryrun'), exist_ok=True)
dry_file = os.path.join(R4, 'dryrun', 'install.dry-run.post-uninstall.' + COMMIT[:8] + '.' + GEN_UTC + '.json')
SECRETS_EXIST = ['true' if x else 'false' for x in CFG['secretTargetsExist']]   # r5 S1: app key target, ci token target (elevated truth, checked by the launcher)
p = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', EXPECTED_PLAN, '-View', 'post-uninstall', '-PackageRoot', PKG, '-PackageManifestSha256', pkg_sha,
                    '-AppKeyTargetExists', SECRETS_EXIST[0], '-CiTokenTargetExists', SECRETS_EXIST[1], '-OwnerSid', OWNER, '-ControllerSid', CONTROLLER],
                   capture_output=True, check=False)
write_new(dry_file, p.stdout)
assert p.returncode == 0, ('EXPECTED_PLAN_FAILED', p.stderr.decode('utf8', 'replace')[-800:])
dry = json.loads(p.stdout.decode('utf-8-sig'))
assert dry['status'] == 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'
plan = dry['plan']
assert plan['packageManifestSha256'] == pkg_sha and plan['installScriptSha256'] == staged[0][2] and plan['startAfterInstall'] is True
assert plan['ownerSid'] == OWNER and plan['controllerSid'] == CONTROLLER and plan['rootExists'] is False and plan['servicesExist'] is False and plan['openBatches'] == 0
assert plan['residentManifestSha256'] == pkg['residentManifestSha256'] and plan['ciSourceManifestSha256'] == pkg['ciSourceManifestSha256']
# r5c: plan /8, the upgrader, generation 1, and no token in the reviewed (non-elevated) plan
assert plan['contract'] == 'clued.independent-ci.resident-install-plan/8', plan['contract']
pu = plan['upgrader']
assert pu['service'] == 'CluedCIUpgrader' and pu['account'] == 'LocalSystem' and pu['manifestSha256'] == UPG_SECTION['manifestSha256'] and pu['configSha256'] == ucfg_entry[0]['sha256'], pu
assert pu['token']['target'] == TOKEN_TARGET and pu['token']['supplied'] is False and pu['token']['targetExists'] is False and pu['token']['fingerprint'] is None, pu['token']
assert plan['secretsFingerprintDirectory'] is None
assert plan['generation']['number'] == 1 and plan['generation']['linux'] == {'generation': 1, 'manifestSha256': pkg['linux']['manifestSha256'], 'ciSourceManifestSha256': pkg['ciSourceManifestSha256']}, plan['generation']
rb = plan['runnerBefore']
runner_usable = bool(rb['originalBinary'] and rb['stoppedPid0'] and rb['manual'] and rb['accountIsController'] and rb['sddl'] == RUNNER['sddl'])

# ---- Q5b: Linux gate (evidence file, never WSL from here) ----
linux_live = None; linux_evidence_sha = None
if LINUX_EVIDENCE:
    text = open(LINUX_EVIDENCE, encoding='utf-8').read()
    m = re.findall(r'(?m)^sha256: ([0-9a-f]{64})$', text)
    assert len(m) == 1 and re.search(r'(?m)^exit: 0$', text), 'LINUX_EVIDENCE_UNPARSABLE'
    linux_live = m[0]; linux_evidence_sha = sha(LINUX_EVIDENCE)
    assert linux_live == pkg['ciSourceManifestSha256'], ('LIVE_LINUX_SOURCE_NOT_THIS_RECORD', linux_live)
# r5c: the Linux version facts written by Linux phase B (after --apply-upgrade-v1 and --adopt-generation 1): verify's two-sides-consistent
facts_sha = None
if LINUX_EVIDENCE:   # r5c (review): Linux generation 1 was adopted with THIS package (prep-linux-r5c phase B writes `package:` into the evidence)
    pk = re.findall(r'(?m)^package: ([0-9a-f]{64})$', text)
    assert pk == [pkg_sha], ('LINUX_ADOPTED_ANOTHER_PACKAGE', pk, pkg_sha)
if FACTS:
    FACTS = os.path.abspath(FACTS)
    assert re.fullmatch(r'[A-Za-z]:\\[^\s"\']+', FACTS), ('FACTS_PATH_SHAPE', FACTS)
    facts_doc = json.load(open(FACTS, encoding='utf-8'))
    assert (facts_doc.get('contract') == 'clued.independent-ci.linux-version-facts/1' and type(facts_doc.get('generation')) is int and facts_doc.get('generation') == 1 and facts_doc.get('staged') is None
            and facts_doc.get('ciSourceManifestSha256') == pkg['ciSourceManifestSha256'] and facts_doc.get('manifestSha256') == pkg['linux']['manifestSha256']
            and facts_doc.get('pinsOk') is True), ('LINUX_VERSION_FACTS_NOT_THIS_PACKAGE', facts_doc)
    facts_sha = sha(FACTS)

# ---- spool: no v1 protocol record may be present ----
seq = ['%02d' % i for i in range(1, 33)]
names = {'incoming': ['result'] + ['challenge-' + n for n in seq], 'outgoing': ['issue'] + ['response-' + n for n in seq]}
present = [f + '/' + n + x for f in names for n in names[f] for x in ('.json', '.ready.json') if os.path.exists(os.path.join(SPOOL, f, n + x))]
present += ['outgoing/active.lock'] if os.path.exists(os.path.join(SPOOL, 'outgoing', 'active.lock')) else []
# (a batch in flight has its records here; --final refuses, the launcher's preflight refuses them too)

# ---- installed (old) resident, read live ----
live_receipt = os.path.join(LIVE_ROOT, 'install', 'install-receipt.json')
installed_resident = json.load(open(live_receipt, encoding='utf-8-sig'))['residentManifestSha256']
u_sha = sha(os.path.join(LIVE_ROOT, 'resident', installed_resident, 'windows', 'uninstall-resident.ps1'))
halt_present = os.path.exists(os.path.join(LIVE_ROOT, 'state', 'HALT.json'))
ACCEPT_HALT = opt('--accept-halt-sha256')
halt_sha = sha(os.path.join(LIVE_ROOT, 'state', 'HALT.json')) if halt_present else None
halt_doc = json.load(open(os.path.join(LIVE_ROOT, 'state', 'HALT.json'), encoding='utf-8-sig')) if halt_present else None
halt_accepted = bool(halt_present and ACCEPT_HALT and halt_sha == ACCEPT_HALT)
PARENT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI'])
parent_before = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:R41_PARENT).Sddl'],
                               capture_output=True, text=True, env=dict(os.environ, R41_PARENT=PARENT)).stdout.strip()
paused_present = os.path.exists(os.path.join(LIVE_ROOT, 'state', 'PAUSED.json'))
paused_sha = sha(os.path.join(LIVE_ROOT, 'state', 'PAUSED.json')) if paused_present else None   # review m6: pinned into the launcher
status = json.load(open(os.path.join(LIVE_ROOT, 'state', 'status.json'), encoding='utf-8-sig'))
current = status.get('current')
ledger = os.path.join(LIVE_ROOT, 'state', 'ledger')
entries = sorted(os.listdir(ledger))
open_entries = [e for e in entries if not os.path.exists(os.path.join(ledger, e, '90-terminal.json'))]
terminal = [e for e in entries if e not in open_entries]
if not terminal:   # the launcher pins a kept terminal ledger entry
    sys.exit('NO_TERMINAL_LEDGER_ENTRY')
newest_key = max(terminal, key=lambda e: os.path.getmtime(os.path.join(ledger, e, '90-terminal.json')))
if halt_accepted:   # r4.1 C3: the kept ledger must hold the HALTed batch, terminal
    newest_key = halt_doc['facts']['key']
    assert newest_key in terminal, ('HALTED_BATCH_NOT_TERMINAL', newest_key)
quiet = {'haltPresent': halt_present, 'paused': paused_present, 'current': current, 'executorState': status.get('executor', {}).get('state'),
         'openLedgerEntries': open_entries, 'statusWrittenAt': status.get('writtenAt')}
refusals = []
if halt_present and not halt_accepted: refusals.append('HALT_PRESENT_NOT_ACCEPTED')
if halt_accepted and (status.get('halt') or {}).get('code') != halt_doc.get('code'): refusals.append('STATUS_HALT_NOT_THE_PINNED_ONE')
if current: refusals.append('OLD_RESIDENT_BATCH_CURRENT')
if open_entries: refusals.append('OPEN_BATCH')
if not paused_present and not halt_accepted: refusals.append('OLD_RESIDENT_NOT_PAUSED')
if paused_present and not halt_accepted and json.load(open(os.path.join(LIVE_ROOT, 'state', 'PAUSED.json'), encoding='utf-8-sig')).get('source', {}).get('reason') != CFG['launcher']['w1PauseReason']: refusals.append('OLD_RESIDENT_PAUSE_NOT_THE_W1_ONE')
if not runner_usable: refusals.append('DRY_RUN_RUNNER_NOT_ORIGINAL_STOPPED')
if not linux_live: refusals.append('FINAL_NEEDS_LINUX_EVIDENCE')
if not token_file_present: refusals.append('UPGRADE_TOKEN_FILE_MISSING')
if not facts_sha: refusals.append('FINAL_NEEDS_LINUX_VERSION_FACTS')
# r7: CluedCIUpgrader is expected here (the r5c2 install); uninstall-resident.ps1 stops and deletes it, the after-uninstall check stays
R5C_REPORT = {'packageContract': pkg['contract'], 'upgraderManifestSha256': UPG_SECTION['manifestSha256'], 'upgraderTargets': len(upg_targets), 'upgraderConfig': ucfg,
              'upgraderConfigSha256': ucfg_entry[0]['sha256'], 'tokenFile': TOKEN_FILE, 'tokenFilePresent': token_file_present, 'tokenTarget': TOKEN_TARGET,
              'linuxManifestSha256': pkg['linux']['manifestSha256'], 'linuxVersionFacts': FACTS, 'linuxVersionFactsSha256': facts_sha,
              'upgraderServicePresent': upgrader_service_present, 'secretWorkParent': SECRET_WORK_PARENT, 'secretWorkSddl': SECRET_WORK_SDDL}
if present: refusals.append('SPOOL_PROTOCOL_RECORDS_PRESENT')
quiet['spoolRecords'] = present
# review r5-1: a FINAL launcher never carries the dddddddd-/eeeeeeee- placeholder refs (regen-r4.ps1 -Final refuses them too)
if any(re.match(r'^(d{8}|e{8})-', str(acceptance.get(k, ''))) for k in ('sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'ownerPackageAcceptanceRef',
                                                                       'publisherQualificationRef', 'ownerDecisionRef', 'ownerReceiptRef', 'installationReceiptRef')):
    refusals.append('PLACEHOLDER_OWNER_REFS_DRAFT_ONLY')
# README section 5: no FINAL without a PASS rehearsal of exactly this package and configuration. Its 24-hour bound (review 1-8) is checked
# by prep.py, before the node changes; here, after W1 and Linux B, a node half reinstalled could never rehearse again (review 2).
rehearsal_doc = json.load(open(REHEARSAL, encoding='utf-8')) if REHEARSAL else None
if not (rehearsal_doc and rehearsal_doc.get('contract') == 'clued.independent-ci.reinstall-rehearsal/1' and rehearsal_doc.get('status') == 'REHEARSAL_PASS'
        and rehearsal_doc.get('findings') == [] and rehearsal_doc.get('packageManifestSha256') == pkg_sha and rehearsal_doc.get('commit') == COMMIT
        and rehearsal_doc.get('configSha256') == CFG['_sha256']):
    refusals.append('FINAL_NEEDS_A_PASSING_REHEARSAL_OF_THIS_PACKAGE')
if FINAL and refusals:
    print(json.dumps({'status': 'REFUSED', 'codes': refusals, 'quiet': quiet, 'dryRun': dry_file, 'runnerBefore': rb}, indent=1))
    sys.exit(3)
# r4.1 C2: the parent ACL before/after, computed exactly as the launcher does (Get-Acl + AddAccessRule), pinned
parent_after = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command',
    '$a=New-Object Security.AccessControl.DirectorySecurity; $a.SetSecurityDescriptorSddlForm($env:R41_BEFORE); '
    '$r=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($env:R41_SID)),[Security.AccessControl.FileSystemRights]0x120080,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); '
    '$a.AddAccessRule($r); $a.GetSecurityDescriptorSddlForm("All")'], capture_output=True, text=True,
    env=dict(os.environ, R41_BEFORE=parent_before, R41_SID=plan['residentSid'])).stdout.strip()
ace = '(A;;0x120080;;;' + plan['residentSid'] + ')'
parent_live = parent_before
if ace in parent_before:   # already added by an earlier r4.1 run: before == after
    parent_after = parent_before
    parent_before = parent_before.replace(ace, '')
assert parent_before.startswith('O:BAG:') and parent_after == parent_before + ace and parent_after.count(plan['residentSid']) == 1, ('PARENT_ACL_UNEXPECTED', parent_before, parent_after)
pause_dacl = 'D:P(A;;FR;;;OW)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + OWNER + ')(A;;0x1301bf;;;' + plan['residentSid'] + ')'

lines = [
    '# Generated by reinstall/launcher/generate.py at ' + GEN_UTC + ' for node ' + node['nodeName'] + ' (configuration sha256 ' + CFG['_sha256'] + '); every value comes from a file.',
    '$DraftOnly = ' + ('$false' if FINAL else '$true') + '   # P2: a draft refuses to run',
    '$SourceSha = ' + q(source_sha) + '   # record/source-manifest.json sourceSha',
    '$PackageHead = ' + q(COMMIT) + '   # Q4: the commit this launcher was generated for',
    '$W = ' + q(R4),
    '$PackageRootPin = ' + q(PKG.replace('/', BS)),
    '$ReviewedDryRunPath = ' + q(dry_file.replace('/', BS)),
    '$StageParent = ' + q('C:' + BS + 'ProgramData' + BS + 'CluedIndependentCI' + BS + 'resident-launch-' + COMMIT[:8]),
    '$NodeHostname = ' + q(node['hostname']) + '   # the node profile: Step-Identity, the child COMPUTERNAME, the runner account',
    '$OwnerSid = ' + q(OWNER),
    '$ControllerSid = ' + q(CONTROLLER),
    '$ResidentSid = ' + q(plan['residentSid']),
    '$PackageManifestSha256 = ' + q(pkg_sha),
    '$PlanSha256 = ' + q(dry['planSha256']) + '   # non-elevated post-uninstall view (Q5)',
    '$ResidentManifestSha256 = ' + q(plan['residentManifestSha256']),
    '$CiSourceManifestSha256 = ' + q(pkg['ciSourceManifestSha256']),
    '$Staged = [ordered]@{',
] + ['  ' + q(n) + ' = @(' + q(rel) + ', ' + q(d) + ')' for n, rel, d in staged] + [
    '}',
    '$ExactAclReadbackGuard = ' + ('$true' if exact_guard else '$false'),
    '$RunnerService = ' + q(RUNNER['service']),
    '$RunnerBinary = ' + q(RUNNER['binary']),
    '$RunnerSddl = ' + q(RUNNER['sddl']),
    '$ArchiveBatchKey = ' + q(ARCHIVE_KEY) + '   # unused: r4 archives nothing (no v1 leftover allowed)',
    '$ArchiveReason = ' + q(ARCHIVE_REASON),
    '$Leftovers = [ordered]@{',
    '}',
    '$InstalledResidentManifestSha256 = ' + q(installed_resident) + '   # the installed (Source34) resident tree',
    '$InstalledUninstallSha256 = ' + q(u_sha),
    '$InstalledReceiptSha256 = ' + q(sha(live_receipt)),
    '$InstalledHaltSha256 = ' + (q(halt_sha) if halt_accepted else '$null') + '   # r4.1 C3: the accepted HALT.json of the installed resident (--accept-halt-sha256)',
    '$InstalledHaltCode = ' + (q(halt_doc['code']) if halt_accepted else '$null'),
    '$ParentAclPath = ' + q(PARENT) + '   # r4.1 C2',
    '$ParentSddlBefore = ' + q(parent_live) + '   # r5 S2: the CI root DACL at generation (read-only check; the installer appends the ACE if missing)',
    '$HaltedBatchKey = ' + q(newest_key) + '   # the HALTed batch (r4.1 C3) or the newest terminal ledger entry; must be in the kept ledger',
    '$LaunchOutPin = ' + q(LAUNCH_DIR) + '   # F1: output directory of this generation',
    '$PauseRequestDacl = ' + q(pause_dacl) + '   # F2: the DACL a request in requests\\ inherits',
    '$LinuxLiveSourceManifestSha256 = ' + (q(linux_live) if linux_live else '$null') + '   # Q5b: formal-source-manifest-v2.json (evidence file below)',
    '$LinuxLiveEvidenceSha256 = ' + (q(linux_evidence_sha) if linux_evidence_sha else '$null'),
    '$PauseReason = ' + q(PAUSE_REASON),
    '$PauseWaitSeconds = ' + str(PAUSE_WAIT_SECONDS) + '   # Q3: >= 420',
    '$FirstTrainWaitSeconds = ' + str(FIRST_TRAIN_WAIT_SECONDS) + '   # Q2 phase 1 (review M1: >= 1500)',
    '$RunnerQuietWaitSeconds = ' + str(RUNNER_QUIET_WAIT_SECONDS) + '   # Q2 phase 2: runner original+stopped, executor not RUNNING, before any verify',
    '$InstalledPausedSha256 = ' + (q(paused_sha) if paused_sha else '$null') + '   # review m6: the W1 PAUSED.json (null in a DRAFT generated before W1)',
    '$RearmSha256 = ' + q(rearm['sha256']),
    '$RearmReason = ' + q(REARM_REASON),
    '$UpgradeTokenFile = ' + q(TOKEN_FILE) + '   # r5c: the resident-upgrade token placed by the Owner (path only; read by install-resident.ps1, never here)',
    '$UpgradeTokenTarget = ' + q(TOKEN_TARGET) + '   # install-resident.ps1 of this package',
    '$SecretWorkParent = ' + q(SECRET_WORK_PARENT) + '   # install-resident.ps1 of this package (the fingerprint directory the token adds to the plan)',
    '$SecretWorkSddl = ' + q(SECRET_WORK_SDDL),
    '$LinuxVersionFactsSource = ' + (q(FACTS) if FACTS else '$null') + '   # r5c: Linux phase B version facts (verify -LinuxVersionFactsFile)',
    '$LinuxVersionFactsSha256 = ' + (q(facts_sha) if facts_sha else '$null'),
    '$UpgraderManifestSha256 = ' + q(UPG_SECTION['manifestSha256']),
    '$R5c = @{ applyPlanSha256 = $null; factsStaged = $null }   # r5c: set by Test-TokenPlan / Get-VerifyFactsArgs',
]
assert template.count('#PINS#') == 1
text = template.replace('#PINS#', '\n'.join(lines))
data = text.encode('utf-8')
assert not data.startswith(b'\xef\xbb\xbf') and b'\r' not in data
os.makedirs(OUTDIR, exist_ok=True)
kind = 'final' if FINAL else 'DRAFT'
out = os.path.join(OUTDIR, 'run-reinstall.' + node['nodeName'] + '.' + COMMIT[:8] + '.' + kind + '.' + GEN_UTC + '.ps1')
write_new(out, data)
launcher_sha = hashlib.sha256(data).hexdigest()
# The elevated command: hash-checked bytes, run from memory, with -RunApprovedInstall (same form as r3).
cmd = ("$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'; $b=[IO.File]::ReadAllBytes(" + q(out) + "); "
       "$h=-join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }); "
       "if ($h -cne '" + launcher_sha + "') { throw ('LAUNCHER_CHANGED ' + $h) }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -RunApprovedInstall\n")
cmd_path = os.path.join(OUTDIR, 'elevated-command.' + node['nodeName'] + '.' + COMMIT[:8] + '.' + kind + '.' + GEN_UTC + '.txt')
write_new(cmd_path, cmd.encode('utf-8'))
print(json.dumps({'launcher': out, 'sha256': launcher_sha, 'bytes': len(data), 'draft': not FINAL, 'commit': COMMIT,
                  'elevatedCommand': cmd_path, 'elevatedCommandSha256': sha(cmd_path),
                  'template': TEMPLATE, 'templateSha256': TEMPLATE_SHA, 'node': node['nodeName'], 'configSha256': CFG['_sha256'], 'rehearsal': REHEARSAL,
                  'packageManifestSha256': pkg_sha, 'residentManifestSha256': pkg['residentManifestSha256'], 'ciSourceManifestSha256': pkg['ciSourceManifestSha256'],
                  'planSha256': dry['planSha256'], 'dryRun': dry_file, 'runnerBeforeUsable': runner_usable, 'runnerBefore': rb,
                  'linuxLiveSourceManifest': linux_live, 'linuxEvidenceSha256': linux_evidence_sha,
                  'oldRoot': {'installedResident': installed_resident, 'receiptSha256': sha(live_receipt), 'uninstallSha256': u_sha, 'newestTerminalKey': newest_key, **quiet},
                  'finalWouldRefuse': refusals, 'launchDir': LAUNCH_DIR, 'pauseRequestDacl': pause_dacl,
                  'pauseWaitSeconds': PAUSE_WAIT_SECONDS, 'firstTrainWaitSeconds': FIRST_TRAIN_WAIT_SECONDS, 'runnerQuietWaitSeconds': RUNNER_QUIET_WAIT_SECONDS,
                  'installedPausedSha256': paused_sha, 'haltAccepted': halt_accepted, 'haltSha256': halt_sha, 'parentSddlNow': parent_live, 'secretTargetsExist': SECRETS_EXIST,
                  'companionScripts': script_paths, 'windowsPaths': path_report, 'posixPathsForLinuxReview': sorted(set(p for _, p in posix_paths)), 'rebuild': {'dir': rebuild_dir, 'packageManifestSha256': rebuilt['packageManifestSha256']}, 'r5c': R5C_REPORT, 'r5c2': {'installedLinuxManifest': INSTALLED_LINUX_MANIFEST, 'linuxManifestSha256': pkg['linux']['manifestSha256'], 'linuxEntries': len(json.loads(installed_linux_manifest)['files'])}, 'r7': {'installedLinuxManifestSha256': hashlib.sha256(installed_linux_manifest).hexdigest(), 'linuxOwnFilesChanged': R7_LINUX_CHANGED, 'upgraderServicePresentBefore': upgrader_service_present}}, indent=1, default=str))
