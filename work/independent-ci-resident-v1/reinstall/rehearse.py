"""Full read-only rehearsal against the INSTALLED node before a reinstall (README.md section 5). No FINAL without it: the launcher
generator refuses a final unless a REHEARSAL_PASS report names exactly this package, commit and configuration.

Every check runs the node's real tools or reads its real files, non-elevated, and changes nothing; each mismatch becomes a finding:
  uninstall   the INSTALLED uninstall-resident.ps1, real dry run: its plan contract must be the one the launcher template accepts, with
              every field the template reads; no upgrade op recorded; upgraderService = the service's presence
  verify      the INSTALLED verify-resident.ps1, real run against the installed receipt: VERIFIED, or PARTIALLY (admin-only parts)
  status      state/status.json, upgrade/status.json, upgrade/current.json: the fields and contracts the template and prep.py read
  upgrader    an installed CluedCIUpgrader must be stopped through SCM by the template's quiesce (never killed)
  linux       the Linux version facts (Windows side) agree with the generation record; the configuration's root-made copies of the
              installed Linux resident manifest and roles-v3 are the installed ones (facts: manifestSha256, roles policy/qualification)
  pins        the package's Linux resident manifest: the installed shape, its source-v2 pins = the NEW commit's files (linux-pins.py check)
  roles       the role derivation the Linux phase A will run (linux/tools/derive-roles.py, as a normal user in the node's WSL distribution
              on the copies): it must succeed for the new commit; every repinned Source file is listed
  node        the package's node profile is the configured one
A node whose resident distribution is registered to the companion's own account (M5-b, ADR 0023: install\\companion-account.json and
install\\companion-wsl.json, stage qualified) is not visible to the Owner's WSL: there the rehearsal calls no wsl at all. The installed
roles come from the companion's public copy (upgrade\\mailbox\\responses\\roles-public.json, checked against the facts), the derivation
runs the same derive-roles.py with this Windows Python, and the root host probe is deferred to launch phase A (it checks the host as
root before anything changes).
Output: one create-only JSON report (clued.independent-ci.reinstall-rehearsal/1) with `findings` (the difference list) and every
observed value; exit 0 only on REHEARSAL_PASS.

  python -I rehearse.py <config.json> --commit <40hex> --package <dir> [--report-dir <dir>] [--skip-roles]
         [--linux-version-facts <original frozen-tool stdout snapshot>]
"""
import base64, binascii, datetime, hashlib, importlib.util, json, os, re, shutil, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BS = chr(92)
ROOT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident'])
POWERSHELL = BS.join(['C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])
SC = BS.join(['C:', 'Windows', 'System32', 'sc.exe'])
CONTRACT = 'clued.independent-ci.reinstall-rehearsal/1'
VERIFY_OK = ('RESIDENT_VERIFIED', 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED')
FACTS_CONTRACT = 'clued.independent-ci.linux-version-facts/1'
FACTS_MAX_BYTES = 32 * 1024
FACTS_MAX_AGE = datetime.timedelta(hours=1)
FACTS_FUTURE_TOLERANCE = datetime.timedelta(seconds=30)
FACTS_ROLES = ('gitleaks', 'trivy', 'contract-placement')
# M5-b (ADR 0023): the install's records of a companion account and of the resident distribution registered to it
COMPANION_ACCOUNT_CONTRACT = 'clued.independent-ci.companion-account/1'
COMPANION_WSL_CONTRACT = 'clued.independent-ci.companion-wsl/1'
COMPANION_RECORD_MAX_BYTES = 64 * 1024
USER_SID = re.compile(r'S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}')
# the companion's public copy of the live roles-v3 (src/roles-public.mjs; its other reader is rollout/tools/roles-derived.py)
ROLES_PUBLIC_CONTRACT = 'clued.independent-ci.linux-roles-public/1'
ROLES_PUBLIC_NAMES = tuple(r + s for r in FACTS_ROLES for s in ('.json', '.qualification.json'))
ROLES_PUBLIC_MAX_BYTES = 192 * 1024
ROLES_PUBLIC_FILE_MAX_BYTES = 16 * 1024
DEFERRED_HOST_PROBE = {'deferredTo': 'launch-phase-A', 'reason': 'COMPANION_ACCOUNT_DISTRIBUTION'}
# The generic node package's launcher (launcher/template.ps1 Step-FileLocks, generate.py --fleet-plan) runs tools/file-locks.ps1 ELEVATED,
# before anything changes; only from there are a companion account's processes and task readable.
DEFERRED_FILE_LOCKS = {'deferredTo': 'launch-elevated-file-locks', 'reason': 'COMPANION_PROCESS_IDENTITY_UNREADABLE_NON_ELEVATED'}
# derive-roles.py, unchanged, with this (Windows) Python: only the tool's POSIX-only parts are supplied. The tool requires root
# (os.geteuid); like the WSL runner this first refuses a privileged runner (here an elevated token), then simulates it. Windows has no
# O_NOFOLLOW: the tool's create is O_CREAT|O_EXCL in a new private directory, here with O_BINARY (no newline translation). Its fixed
# /usr/bin/git is the given Windows git, with the tool's own clean environment and arguments.
WINDOWS_ROLE_RUNNER = ("import ctypes,os,runpy,subprocess,sys\n"
                       "if ctypes.windll.shell32.IsUserAnAdmin(): print('{\"status\":\"REFUSED\",\"code\":\"REHEARSAL_RUNNER_IS_ELEVATED\"}'); sys.exit(3)\n"
                       "t,git=sys.argv[1],sys.argv[2]; sys.argv=[t]+sys.argv[3:]\n"
                       "os.geteuid=lambda:0; os.O_NOFOLLOW=os.O_BINARY; real=subprocess.run\n"
                       "subprocess.run=lambda argv,*a,**k: real([git]+list(argv[1:]) if argv[:1]==['/usr/bin/git'] else argv,*a,**k)\n"
                       "runpy.run_path(t, run_name='__main__')")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


rconfig = load_module('rconfig', os.path.join(HERE, 'tools', 'rconfig.py'))


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    with open(p, 'rb') as f:
        return sha_bytes(f.read())


def read_json(p):
    with open(p, 'rb') as f:
        return json.loads(f.read().decode('utf-8-sig'))


def strict_json(raw, code):
    """UTF-8 JSON without duplicate keys, else ValueError(code)."""
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError(code)
            obj[key] = value
        return obj
    try:
        return json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique)
    except (ValueError, RecursionError):
        raise ValueError(code) from None


class Finding(Exception):
    def __init__(self, code, **detail):
        super().__init__(code)
        self.code, self.detail = code, detail


def bounded_json(raw, limit):
    try:
        return strict_json(raw, 'SHAPE') if raw is not None and 0 < len(raw) <= limit else None
    except ValueError:
        return None


def companion_records(account_raw, wsl_raw, owner_sid, distribution):
    """The install's companion-account record and the qualified resident distribution registered to that account, each checked
    strictly (the readers in windows/companion-headless.ps1); a Finding otherwise. None for an input: that file does not exist."""
    if account_raw is None:
        raise Finding('COMPANION_ACCOUNT_RECORD_REFUSED', reason='MISSING')
    a = bounded_json(account_raw, COMPANION_RECORD_MAX_BYTES)
    if (not isinstance(a, dict) or set(a) != {'contract', 'companionSid', 'operatorSid'} or a['contract'] != COMPANION_ACCOUNT_CONTRACT
            or not all(isinstance(a[k], str) and USER_SID.fullmatch(a[k]) for k in ('companionSid', 'operatorSid'))
            or a['companionSid'] == a['operatorSid']):
        raise Finding('COMPANION_ACCOUNT_RECORD_REFUSED', reason='SHAPE')
    if a['companionSid'] != owner_sid:   # on an M5-b node the profile's ownerSid is the companion account
        raise Finding('COMPANION_ACCOUNT_RECORD_REFUSED', reason='COMPANION_NOT_THE_PROFILE_OWNER')
    if wsl_raw is None:
        raise Finding('COMPANION_WSL_RECORD_REFUSED', reason='MISSING')
    w = bounded_json(wsl_raw, COMPANION_RECORD_MAX_BYTES)
    if (not isinstance(w, dict) or w.get('contract') != COMPANION_WSL_CONTRACT
            or not all(isinstance(w.get(k), str) for k in ('distro', 'target', 'companionSid', 'stage'))):
        raise Finding('COMPANION_WSL_RECORD_REFUSED', reason='SHAPE')
    if w['stage'] != 'qualified':
        raise Finding('COMPANION_WSL_RECORD_REFUSED', reason='NOT_QUALIFIED', stage=w['stage'][:40])
    if w['distro'] != distribution or w['companionSid'] != a['companionSid']:
        raise Finding('COMPANION_WSL_RECORD_REFUSED', reason='NOT_THIS_DISTRIBUTION_AND_ACCOUNT')
    return a


def roles_public(raw, facts):
    """{name: bytes} of the companion's public role copy: its own generation and entries, and every file the one the facts name."""
    doc = bounded_json(raw, ROLES_PUBLIC_MAX_BYTES)
    iso = lambda v: isinstance(v, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)', v) is not None
    if (not isinstance(doc, dict) or set(doc) != {'contract', 'generation', 'factsObservedAt', 'observedAt', 'files'}
            or doc['contract'] != ROLES_PUBLIC_CONTRACT or type(doc['generation']) is not int or doc['generation'] < 1
            or not iso(doc['factsObservedAt']) or not iso(doc['observedAt'])
            or not isinstance(doc['files'], dict) or set(doc['files']) != set(ROLES_PUBLIC_NAMES)):
        raise Finding('ROLES_PUBLIC_COPY_INVALID')
    if doc['generation'] != facts['generation']:
        raise Finding('ROLES_PUBLIC_COPY_OTHER_GENERATION', copy=doc['generation'], facts=facts['generation'])
    files = {}
    for name in ROLES_PUBLIC_NAMES:
        entry = doc['files'][name]
        try:
            if (not isinstance(entry, dict) or set(entry) != {'sha256', 'base64'} or not isinstance(entry['sha256'], str)
                    or re.fullmatch(r'[0-9a-f]{64}', entry['sha256']) is None or not isinstance(entry['base64'], str)):
                raise ValueError()
            data = base64.b64decode(entry['base64'].encode('ascii'), validate=True)
        except (ValueError, binascii.Error):
            raise Finding('ROLES_PUBLIC_COPY_INVALID', file=name) from None
        if (not 0 < len(data) <= ROLES_PUBLIC_FILE_MAX_BYTES or base64.b64encode(data).decode('ascii') != entry['base64']
                or sha_bytes(data) != entry['sha256']):
            raise Finding('ROLES_PUBLIC_COPY_INVALID', file=name)
        want = facts['roles'][name.split('.', 1)[0]]['qualificationSha256' if name.endswith('.qualification.json') else 'policySha256']
        if entry['sha256'] != want:
            raise Finding('ROLES_PUBLIC_COPY_NOT_THE_FACTS', file=name, copy=entry['sha256'], installed=want)
        files[name] = data
    return files


def remove_tree(path):
    """A private temporary directory, with the read-only (0400) files derive-roles.py creates."""
    def writable(func, p, _):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    shutil.rmtree(path, **({'onexc': writable} if sys.version_info >= (3, 12) else {'onerror': writable}))


def version_facts(raw):
    """Bounded public facts only. An invalid document never supplies role names or comparison values."""
    if not 0 < len(raw) <= FACTS_MAX_BYTES:
        raise ValueError('LINUX_FACTS_INVALID')
    f = strict_json(raw, 'LINUX_FACTS_INVALID')
    required = {'contract', 'generation', 'staged', 'pinsOk', 'sourceCommit', 'ciSourceManifestSha256',
                'manifestSha256', 'roles', 'upgradeToolSha256', 'observedAt'}
    digest = lambda value: isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None
    if (not isinstance(f, dict) or set(f) != required or f.get('contract') != FACTS_CONTRACT
            or type(f.get('generation')) is not int or not 1 <= f['generation'] <= 999999999
            or type(f.get('pinsOk')) is not bool
            or not isinstance(f.get('sourceCommit'), str) or re.fullmatch(r'[0-9a-f]{40}', f['sourceCommit']) is None
            or not all(digest(f.get(k)) for k in ('ciSourceManifestSha256', 'manifestSha256', 'upgradeToolSha256'))
            or not isinstance(f.get('roles'), dict) or set(f['roles']) != set(FACTS_ROLES)
            or any(not isinstance(v, dict) or set(v) != {'policySha256', 'qualificationSha256'}
                   or not all(digest(x) for x in v.values()) for v in f['roles'].values())):
        raise ValueError('LINUX_FACTS_INVALID')
    if f['staged'] is not None or f['pinsOk'] is not True:
        raise ValueError('LINUX_FACTS_NOT_A_SETTLED_GENERATION')
    try:
        observed = datetime.datetime.fromisoformat(f['observedAt'].replace('Z', '+00:00'))
        if observed.tzinfo is None:
            raise ValueError()
    except (AttributeError, TypeError, ValueError):
        raise ValueError('LINUX_FACTS_OBSERVATION_INVALID') from None
    age = datetime.datetime.now(datetime.timezone.utc) - observed
    if age > FACTS_MAX_AGE:
        raise ValueError('LINUX_FACTS_NOT_FRESH')
    if age < -FACTS_FUTURE_TOLERANCE:
        raise ValueError('LINUX_FACTS_OBSERVED_IN_FUTURE')
    return f


class Host:
    """What the rehearsal reads or runs on the node. Tests replace it; every method is read-only."""
    def __init__(self, root=ROOT):
        self.root = root

    def path(self, *rel):
        return os.path.join(self.root, *rel)

    def exists(self, p):
        return os.path.exists(p)

    def read_json(self, p):
        return read_json(p)

    def read_facts(self, p):
        with open(p, 'rb') as f:
            return f.read(FACTS_MAX_BYTES + 1)

    def live_version_facts(self, distribution):
        """Existing frozen, root-only read command: no signing, staging, lock or mailbox writes."""
        p = subprocess.run(['wsl.exe', '-d', distribution, '-u', 'root', '--exec', '/usr/bin/env', '-i',
                            'PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C', 'LC_ALL=C', 'GIT_NO_REPLACE_OBJECTS=1',
                            '/usr/bin/python3.12', '-I', '/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux',
                            'version-facts'], capture_output=True, timeout=90)
        return p.returncode, p.stdout

    def read_bounded(self, p, limit):
        with open(p, 'rb') as f:
            return f.read(limit + 1)

    def sha(self, p):
        return sha_file(p)

    def powershell(self, script, args):
        p = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] + list(args),
                           capture_output=True, timeout=900)
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')

    def service_present(self, name):
        return subprocess.run([SC, 'query', name], capture_output=True).returncode != 1060

    def file_locks(self):
        code, out, _ = self.powershell(os.path.join(HERE, 'tools', 'file-locks.ps1'), ['-Root', self.root])
        if code != 0:
            raise ValueError('RESTART_MANAGER_PROBE_FAILED:' + str(code))
        return last_json(out)

    def wsl_python(self, distribution, argv, user=None):
        """python3 -I in the node's WSL distribution, clean environment: as the configured/default user (role derivation refuses root
        itself), or as root for the read-only host probe (user='root')."""
        p = subprocess.run(['wsl.exe', '-d', distribution] + (['-u', user] if user else []) + ['--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
                            'LANG=C', 'LC_ALL=C', 'GIT_OPTIONAL_LOCKS=0', '/usr/bin/python3', '-I'] + list(argv), capture_output=True, timeout=600)
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


    def windows_python(self, argv):
        """This (Windows) Python, isolated, as the non-elevated Owner who runs the rehearsal; no WSL."""
        p = subprocess.run([sys.executable, '-I'] + list(argv), capture_output=True, timeout=600)
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


def last_json(text):
    """The whole text as JSON, else the last line that parses."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    for line in reversed([l for l in text.splitlines() if l.strip()]):
        try:
            return json.loads(line)
        except ValueError:
            continue
    return None


def template_contract(template_text):
    """The uninstall plan contract and fields the launcher template's Test-UninstallPlan accepts."""
    m = re.search(r'(?ms)^function Test-UninstallPlan\(\$plan\) \{(.*?)^\}', template_text)
    if not m:
        return None, []
    body = m.group(1)
    contracts = re.findall(r"clued\.independent-ci\.resident-uninstall-plan/(\d+)", body)
    fields = sorted(set(re.findall(r"Get-Key \$plan '([A-Za-z]+)'", body)) | set(re.findall(r"ContainsKey\('([A-Za-z]+)'\)", body)))
    return (contracts[0] if len(contracts) == 1 else None), fields


def to_wsl(p):
    p = os.path.abspath(p)
    return '/mnt/' + p[0].lower() + p[2:].replace(BS, '/')


def rehearse(cfg, commit, pkg_dir, host, skip_roles=False, template_path=None, linux_version_facts=None, file_locks_in_launcher=False, installed_linux_in_phase_a=False):
    rconfig.need_installed_linux(cfg)   # a rehearsal is against an installed node; a first install has nothing to rehearse
    findings, checks = [], {}

    def find(finding, **detail):
        findings.append({'code': finding, **detail})

    tree = os.path.join(cfg['workDir'], 'tree-' + commit[:8])
    pkg = read_json(os.path.join(pkg_dir, 'package-manifest.json'))
    pkg_sha = sha_file(os.path.join(pkg_dir, 'package-manifest.json'))
    template = open(template_path or os.path.join(HERE, 'launcher', 'template.ps1'), encoding='utf-8').read()

    # node: the package's profile is the installed one
    profile, _ = rconfig.node_profile(cfg)
    pkg_node = read_json(os.path.join(pkg_dir, 'record', 'acceptance.json'))['node']
    checks['node'] = {'configured': profile['nodeName'], 'package': pkg_node.get('nodeName')}
    if pkg_node != profile:
        find('PACKAGE_NODE_NOT_THE_CONFIGURED_PROFILE', package=pkg_node.get('nodeName'))

    # companion: M5-b (ADR 0023), the resident distribution registered to the companion's own account. Either install record there makes
    # this a companion node: the Owner's WSL cannot see that distribution, so nothing below calls wsl. Records that do not check out
    # are a finding (fail closed), never a reason to fall back to the Owner's WSL.
    account_path, wsl_path = host.path('install', 'companion-account.json'), host.path('install', 'companion-wsl.json')
    companion = host.exists(account_path) or host.exists(wsl_path)
    if companion:
        checks['companionAccount'] = {'records': True}
        try:
            raws = [host.read_bounded(p, COMPANION_RECORD_MAX_BYTES) if host.exists(p) else None for p in (account_path, wsl_path)]
            account = companion_records(raws[0], raws[1], profile['ownerSid'], cfg['linux']['distribution'])
            checks['companionAccount'].update({'companionSid': account['companionSid'], 'operatorSid': account['operatorSid'], 'wslStage': 'qualified'})
            if cfg.get('operatorSid') != account['operatorSid']:   # the launcher's operator (README section 8, M5-b)
                find('COMPANION_ACCOUNT_NOT_THE_CONFIGURED', installed=account['operatorSid'], configured=cfg.get('operatorSid'))
        except Finding as refused:
            find(refused.code, **refused.detail)
        except OSError as error:
            find('COMPANION_ACCOUNT_RECORD_REFUSED', reason='UNREADABLE', error=type(error).__name__)

    # This covers installed public binary files, not directories or protected
    # secrets. A later rename still has its own exact completion evidence.
    try:
        locks = host.file_locks()
        checks['fileLocks'] = locks
        if (not isinstance(locks, dict) or locks.get('contract') != 'clued.independent-ci.rehearsal-file-locks/1'
                or locks.get('status') != 'OBSERVED' or locks.get('coverage') != 'installed-public-binaries-only'
                or type(locks.get('fileCount')) is not int or locks['fileCount'] < 1
                or locks.get('secretsEnumerated') is not False or locks.get('directoryHandlesCovered') is not False
                or not isinstance(locks.get('external'), list) or not isinstance(locks.get('lockers'), list)
                or any(not isinstance(row, dict) or type(row.get('pid')) is not int or row['pid'] < 1
                       or type(row.get('startedFileTime')) is not int or row['startedFileTime'] < 1
                       or type(row.get('expected')) is not bool for row in locks['lockers'])
                or locks['external'] != [row for row in locks['lockers'] if row['expected'] is False]):
            find('RESIDENT_FILE_LOCK_OBSERVATION_INVALID')
        elif locks['external'] and companion and file_locks_in_launcher:
            # The launcher of the generic node package observes the locks again, elevated, where the account's processes can be told
            # apart, and stops before anything changes on any external one. Only then, and only on a companion node (where this
            # non-elevated observation cannot tell them apart), is the finding left to it; what was seen here is kept in the report.
            if 'function Step-FileLocks' not in template or '$fileLocks = Step-FileLocks' not in template:
                find('LAUNCHER_HAS_NO_ELEVATED_FILE_LOCK_STEP')
            checks['fileLocksFinding'] = dict(DEFERRED_FILE_LOCKS, processes=locks['external'])
        elif locks['external']:
            # On a companion node the account's processes stay external non-elevated: neither their token (owner SID) nor the
            # account's task is readable to the Owner (README section 5), and a name or path is no identity.
            find('EXTERNAL_RESIDENT_BINARY_LOCK', processes=locks['external'],
                 **({'companionProcessIdentity': 'UNREADABLE_NON_ELEVATED'} if companion else {}))
    except Exception as error:
        find('RESIDENT_FILE_LOCK_OBSERVATION_UNAVAILABLE', reason=str(error)[:400])

    # uninstall: the INSTALLED tool's real dry run against what the launcher template accepts
    receipt = host.read_json(host.path('install', 'install-receipt.json'))
    installed = receipt['residentManifestSha256']
    uninstall = host.path('resident', installed, 'windows', 'uninstall-resident.ps1')
    want_contract, want_fields = template_contract(template)
    code, out, err = host.powershell(uninstall, [])
    u = last_json(out) or {}
    plan = u.get('plan') if isinstance(u, dict) else None
    upgrader_present = host.service_present('CluedCIUpgrader')
    checks['uninstall'] = {'script': uninstall, 'exit': code, 'status': u.get('status') if isinstance(u, dict) else None, 'planSha256': u.get('planSha256') if isinstance(u, dict) else None,
                           'plan': plan, 'templateAcceptsContract': want_contract, 'templateReadsFields': want_fields, 'stderr': err[-400:]}
    if code != 0 or not isinstance(plan, dict) or u.get('status') != 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN':
        find('INSTALLED_UNINSTALL_DRY_RUN_FAILED', exit=code)
    else:
        got = (re.fullmatch(r'clued\.independent-ci\.resident-uninstall-plan/(\d+)', str(plan.get('contract'))) or [None, None])[1]
        if want_contract is None or got != want_contract:
            find('UNINSTALL_PLAN_CONTRACT_NOT_ACCEPTED_BY_LAUNCHER', installed=plan.get('contract'), launcherAccepts=want_contract)
        missing = [k for k in want_fields if k not in plan]
        if missing:
            find('UNINSTALL_PLAN_FIELDS_MISSING', fields=missing)
        if 'upgradeOpState' in plan and plan['upgradeOpState'] is not None:
            find('INSTALLED_UPGRADE_OP_RECORDED', state=plan['upgradeOpState'])
        if 'upgraderService' in plan and plan['upgraderService'] is not upgrader_present:
            find('UNINSTALL_PLAN_UPGRADER_NOT_THE_SERVICE', plan=plan['upgraderService'], service=upgrader_present)
        if 'upgraderService' in plan and plan['upgraderService'] is not True:   # review 1-7: Test-UninstallPlan requires $true
            find('UNINSTALL_PLAN_UPGRADER_SERVICE_NOT_TRUE', plan=plan['upgraderService'])
        for k, v in (('openBatches', 0), ('runnerOriginalStopped', True), ('runnerSddlUnchanged', True), ('deletesEvidence', False)):
            if k in plan and plan[k] != v:
                find('UNINSTALL_PLAN_' + re.sub(r'(?<!^)(?=[A-Z])', '_', k).upper(), value=plan[k])

    # upgrader: an installed upgrader is stopped through SCM by the quiesce, never killed with the processes under the root
    checks['upgrader'] = {'servicePresent': upgrader_present, 'templateStopsIt': bool(re.search(r"& \$Sc stop CluedCIUpgrader", template))}
    if upgrader_present and not checks['upgrader']['templateStopsIt']:
        find('LAUNCHER_DOES_NOT_STOP_THE_INSTALLED_UPGRADER')

    # verify, (a): the PACKAGE's verify-resident.ps1 is what the launcher runs after the install; Step-Verify reads `status` and every
    # `checks.<name>.ok` of its JSON. Its output statement and verdict strings must still be those.
    new_verify = open(os.path.join(pkg_dir, 'resident', 'windows', 'verify-resident.ps1'), encoding='utf-8').read()
    shape = bool(re.search(r"\[ordered\]@\{ status = \$verdict\.status; checks = \$checks \} \| ConvertTo-Json", new_verify)
                 or re.search(r"\[ordered\]@\{ status = if \(\$allOk\)", new_verify)) and all(s in new_verify for s in VERIFY_OK + ('RESIDENT_VERIFICATION_FAILED',))
    checks['verifyOutputShape'] = {'package': shape}
    if not shape:
        find('PACKAGE_VERIFY_OUTPUT_NOT_WHAT_THE_LAUNCHER_READS')
    # verify, (b): the INSTALLED verify, real run. Non-elevated it can stop on an admin-only file (Access is denied): then it is reported
    # as not runnable unelevated, not as a finding; when it runs, its verdict must be VERIFIED or PARTIALLY (unreadable parts only).
    vscript = host.path('resident', installed, 'windows', 'verify-resident.ps1')
    code, out, err = host.powershell(vscript, ['-ExpectedInstallReceiptSha256', host.sha(host.path('install', 'install-receipt.json'))])
    v = last_json(out)
    denied = v is None and bool(re.search(r'Access is denied|UnauthorizedAccess', err))
    v = v if isinstance(v, dict) else {}
    failed = sorted(k for k, c in (v.get('checks') or {}).items() if isinstance(c, dict) and c.get('ok') is not True and c.get('ok') != 'unreadable')
    # Since verify's bounded JSON verdict (Get-VerifyInputFailure), an admin-only input it cannot open non-elevated (DESK,
    # 2026-11-08: broker\token.json) no longer ends without JSON: it ends as RESIDENT_VERIFICATION_FAILED with the one check
    # verify-inputs = VERIFY_INPUT_UNREADABLE. That alone is the same "not runnable unelevated"; any other failed check, or
    # another code (a changed receipt, profile or config), is still a finding. The launcher runs this verify elevated.
    checks_v = v.get('checks') or {}
    if (not denied and failed == ['verify-inputs'] and v.get('status') == 'RESIDENT_VERIFICATION_FAILED'
            and isinstance(checks_v.get('verify-inputs'), dict) and checks_v['verify-inputs'].get('detail') == 'VERIFY_INPUT_UNREADABLE'):
        denied = True
    checks['verify'] = {'script': vscript, 'exit': code, 'status': v.get('status'), 'failed': failed, 'notRunnableUnelevated': denied, 'stderr': err[-300:]}
    if not denied and (v.get('status') not in VERIFY_OK or failed):
        find('INSTALLED_VERIFY_NOT_PASSING', status=v.get('status'), failed=failed)

    # status: the fields the template (Test-OldRootQuiet) and prep.py read, and the upgrade state contracts
    st = host.read_json(host.path('state', 'status.json'))
    ust = host.read_json(host.path('upgrade', 'status.json')) if host.exists(host.path('upgrade', 'status.json')) else None
    gen = host.read_json(host.path('upgrade', 'current.json'))
    facts_path = linux_version_facts if linux_version_facts is not None else host.path('upgrade', 'mailbox', 'responses', 'version-facts.json')
    facts = {}
    checks['linuxFactsInput'] = {'source': 'explicit-snapshot' if linux_version_facts is not None else 'installed-mailbox', 'path': facts_path}
    try:
        raw_facts = host.read_facts(facts_path)
        checks['linuxFactsInput']['sha256'] = sha_bytes(raw_facts)
        facts = version_facts(raw_facts)
    except FileNotFoundError:
        find('LINUX_FACTS_MISSING')
    except OSError:
        find('LINUX_FACTS_UNREADABLE')
    except ValueError as error:
        find(str(error))
    if facts:
        if linux_version_facts is not None and companion:
            # the frozen tool's live read needs the account's distribution: no corroboration, so the snapshot is not accepted
            find('LINUX_FACTS_LIVE_OBSERVATION_UNAVAILABLE', reason='COMPANION_ACCOUNT_DISTRIBUTION')
        elif linux_version_facts is not None:
            # A supplied path and its timestamp are not authority. Corroborate every business field with the installed
            # frozen tool on THIS configured distro; the two collection timestamps may differ. The normal host probe and
            # real normal-user role derivation below still run, and none of the supplied bytes enter the installed cache.
            # Unlike an in-place upgrade, a full reinstall may replace the frozen tool: its live, pinsOk-verified digest
            # must agree with the snapshot, not necessarily with the NEW commit's tool.
            try:
                live_exit, live_raw = host.live_version_facts(cfg['linux']['distribution'])
                checks['linuxFactsInput']['liveExit'] = live_exit
                if live_exit != 0:
                    find('LINUX_FACTS_LIVE_OBSERVATION_REFUSED', exit=live_exit)
                else:
                    live = version_facts(live_raw)
                    checks['linuxFactsInput']['liveSha256'] = sha_bytes(live_raw)
                    checks['linuxFactsInput']['liveObservedAt'] = live['observedAt']
                    if {k: v for k, v in facts.items() if k != 'observedAt'} != {k: v for k, v in live.items() if k != 'observedAt'}:
                        find('LINUX_FACTS_SNAPSHOT_NOT_THE_LIVE_NODE')
            except ValueError as error:
                find('LINUX_FACTS_LIVE_OBSERVATION_INVALID', refusal=str(error))
            except (OSError, subprocess.SubprocessError):
                find('LINUX_FACTS_LIVE_OBSERVATION_UNAVAILABLE')
    checks['status'] = {'statusKeys': sorted(st), 'executorState': (st.get('executor') or {}).get('state'), 'current': st.get('current'), 'halt': st.get('halt'),
                        'upgradeOp': (ust or {}).get('op'), 'generation': gen.get('generation'), 'generationContract': gen.get('contract')}
    for k in ('writtenAt', 'executor', 'current', 'halt'):
        if k not in st:
            find('STATUS_FIELD_MISSING', field=k)
    if gen.get('contract') != 'clued.independent-ci.resident-generation/1':
        find('GENERATION_RECORD_CONTRACT', contract=gen.get('contract'))
    if ust is not None and ust.get('op') is not None:
        find('UPGRADE_OP_IN_PROGRESS', op=ust.get('op'))

    # linux: facts vs generation record; the configuration's root-made copies are the installed ones
    lin = {'factsContract': facts.get('contract'), 'generation': facts.get('generation'), 'sourceCommit': facts.get('sourceCommit'),
           'ciSourceManifestSha256': facts.get('ciSourceManifestSha256'), 'manifestSha256': facts.get('manifestSha256'), 'pinsOk': facts.get('pinsOk'), 'staged': facts.get('staged')}
    checks['linux'] = lin
    if not (facts.get('contract') == 'clued.independent-ci.linux-version-facts/1' and facts.get('staged') is None and facts.get('pinsOk') is True):
        find('LINUX_FACTS_NOT_A_SETTLED_GENERATION', facts=lin)
    if gen.get('linux') != {'generation': facts.get('generation'), 'manifestSha256': facts.get('manifestSha256'), 'ciSourceManifestSha256': facts.get('ciSourceManifestSha256')}:
        find('LINUX_FACTS_NOT_THE_GENERATION_RECORD', record=gen.get('linux'))
    if installed_linux_in_phase_a:
        # The generic node package: the installed Linux manifest's bytes do not exist on the Windows side (only its hash, in the version
        # facts), so the configuration's file is no copy of it. Linux phase A, as root and before it stages anything, requires the live
        # manifest to hash to exactly this value (prep.py: LINUX_RESIDENT_MANIFEST_NOT_THE_INSTALLED_R5C2), like linuxHost on a companion node.
        lin['installedManifestCopy'] = {'deferredTo': 'linux-phase-a', 'reason': 'INSTALLED_MANIFEST_BYTES_NOT_ON_WINDOWS', 'expectedSha256': facts.get('manifestSha256')}
    else:
        copy_sha = sha_file(cfg['linux']['installedManifest'])
        lin['installedManifestCopySha256'] = copy_sha
        if copy_sha != facts.get('manifestSha256'):
            find('INSTALLED_LINUX_MANIFEST_COPY_STALE', copy=copy_sha, installed=facts.get('manifestSha256'))
    rd = cfg['linux']['installedRoles']
    lin['rolesCopy'] = {}
    role_files = None   # a companion node's role files for the derivation: the companion's public copy, once it checks out
    if companion:
        # The root copy in the configuration needs the Owner's WSL; the companion keeps the public copy of the live roles-v3 instead.
        lin['rolesCopySource'] = 'companion-roles-public'
        try:
            if facts:
                role_files = roles_public(host.read_bounded(host.path('upgrade', 'mailbox', 'responses', 'roles-public.json'), ROLES_PUBLIC_MAX_BYTES), facts)
        except Finding as refused:
            find(refused.code, **refused.detail)
        except FileNotFoundError:
            find('ROLES_PUBLIC_COPY_MISSING')
        except OSError:
            find('ROLES_PUBLIC_COPY_UNREADABLE')
        for name, data in sorted((role_files or {}).items()):
            role = name.split('.', 1)[0]
            lin['rolesCopy'].setdefault(role, {})['qualificationSha256' if name.endswith('.qualification.json') else 'policySha256'] = sha_bytes(data)
            # the configuration's root-made copy, where there is one, must be the same bytes
            try:
                with open(os.path.join(rd, name), 'rb') as f:
                    same = f.read(ROLES_PUBLIC_FILE_MAX_BYTES + 1) == data
            except FileNotFoundError:
                continue
            except OSError:
                same = False
            if not same:
                find('INSTALLED_ROLES_COPY_NOT_THE_COMPANION_COPY', file=name)
    for role, want in sorted((facts.get('roles') or {}).items()) if not companion else ():
        got = {'policySha256': sha_file(os.path.join(rd, role + '.json')), 'qualificationSha256': sha_file(os.path.join(rd, role + '.qualification.json'))}
        lin['rolesCopy'][role] = got
        if got != {'policySha256': want.get('policySha256'), 'qualificationSha256': want.get('qualificationSha256')}:
            find('INSTALLED_ROLES_COPY_STALE', role=role, copy=got, installed=want)
    if not facts.get('roles'):
        find('LINUX_FACTS_WITHOUT_ROLES')
    if sha_file(os.path.join(rd, 'formal-source-manifest-v2.json')) != facts.get('ciSourceManifestSha256'):
        find('INSTALLED_SOURCE_MANIFEST_COPY_STALE')

    # pins: the package's Linux resident manifest against the installed one and the new commit's tree
    if installed_linux_in_phase_a:
        # No installed manifest to compare the shape with (above). What can be checked here is: every external pin of the package's
        # manifest is either a source-v2 file with the new commit's bytes or the node's toolchain node with the configured hash. The
        # same rule, against the live host and for every entry, is Linux phase A's (RESIDENT_PINS_NOT_THE_NEW_SOURCE).
        sv2, node_path, bad = '/opt/clued-independent-ci/source-v2/', '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', []
        external = read_json(os.path.join(pkg_dir, 'linux', 'manifest.json'))['files'][4:]
        for f in external:
            path, rel = f.get('installedPath', ''), f.get('installedPath', '')[len(sv2):]
            if path.startswith(sv2) and rel and '..' not in rel.split('/') and os.path.isfile(os.path.join(tree, *rel.split('/'))):
                ok = sha_file(os.path.join(tree, *rel.split('/'))) == f.get('sha256')
            else:
                ok = path == node_path and f.get('sha256') == cfg['linux']['host']['toolchainNodeSha256']
            if not ok:
                bad.append(path)
        checks['pins'] = {'externalPins': len(external), 'notTheNewSource': bad, 'installedShape': {'deferredTo': 'linux-phase-a', 'reason': 'INSTALLED_MANIFEST_BYTES_NOT_ON_WINDOWS'}}
        if bad:
            find('LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE', entries=bad)
    else:
        p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'tools', 'linux-pins.py'), 'check', os.path.join(pkg_dir, 'linux', 'manifest.json'),
                            cfg['linux']['installedManifest'], tree], capture_output=True, text=True)
        checks['pins'] = {'exit': p.returncode, 'out': p.stdout.strip()[-1500:], 'err': p.stderr.strip()[-600:]}
        if p.returncode != 0:
            code = 'LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE' if 'NOT_THE_NEW_SOURCE' in p.stderr else 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE'
            find(code, detail=p.stderr.strip().splitlines()[-1:] if p.stderr.strip() else None)

    # linuxHost (review 1-1): the host facts the root scripts pin are this node's. As root and read-only: the committed check-host.py
    # (what phase A, B0 and B4 run) on the installed role policies with the configured pins, and the installed roles-v3 qualifications
    # sign-qualification.mjs reads (Source v1 is retired: phase A moves any leftover of it aside). Nothing is written.
    lh = cfg['linux']['host']
    probe = ("import json,os,subprocess,sys\n"
             "env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}\n"
             "p=subprocess.run(['/usr/bin/python3','-I']+sys.argv[1:5],capture_output=True,text=True,env=env)\n"
             "q2={r:os.path.isfile('/etc/clued-independent-ci/roles-v3/'+r+'.qualification.json') for r in ('gitleaks','trivy','contract-placement')}\n"
             "print(json.dumps({'checkHostExit':p.returncode,'checkHost':p.stdout.strip()[-800:],'v2Qualifications':q2}))")
    if companion:   # not visible to the Owner's WSL; launch phase A runs check-host.py as root before anything changes
        checks['linuxHost'] = dict(DEFERRED_HOST_PROBE)
    else:
        # the live installed role policies (the derivation keeps their host pins), not the Windows copy (review 2)
        code, out, err = host.wsl_python(cfg['linux']['distribution'], ['-c', probe, to_wsl(os.path.join(HERE, 'linux', 'tools', 'check-host.py')), '/etc/clued-independent-ci/roles-v3',
                                         lh['toolchainNodeSha256'], lh['resultPublicKeySha256']], user='root')
        hp = last_json(out) or {}
        checks['linuxHost'] = {'exit': code, **hp, 'configured': lh, 'stderr': err[-300:]}
        if code != 0 or not hp:
            find('LINUX_HOST_PROBE_FAILED', exit=code)
        else:
            if hp.get('checkHostExit') != 0:
                find('LINUX_HOST_PINS_NOT_THE_CONFIGURED', refusal=(last_json(hp.get('checkHost') or '') or {}).get('code'))
            if not all((hp.get('v2Qualifications') or {}).values()) or not hp.get('v2Qualifications'):   # the signer's lineage
                find('LINUX_INSTALLED_V2_QUALIFICATIONS_MISSING', present=hp.get('v2Qualifications'))

    # roles: the derivation phase A runs, on the copies, as a normal user in the node's WSL distribution
    # A record-only reinstall (README section 8b): the package's CI Source and Linux half are the installed ones, Linux phases A/B do not
    # run, so there is nothing to derive; the launcher generator then needs --linux-adopted-package.
    same_linux = (facts.get('ciSourceManifestSha256') is not None and facts.get('manifestSha256') is not None
                  and pkg.get('ciSourceManifestSha256') == facts.get('ciSourceManifestSha256') and (pkg.get('linux') or {}).get('manifestSha256') == facts.get('manifestSha256'))
    if same_linux:
        checks['roles'] = {'notApplicable': 'SAME_SOURCE_AND_LINUX_HALF_NO_LINUX_PHASE'}
    elif skip_roles:
        checks['roles'] = {'skipped': True}
        find('ROLE_DERIVATION_NOT_REHEARSED')
    elif companion and role_files is None:   # the companion's public copy did not check out (its finding is above)
        checks['roles'] = {'notRun': 'ROLES_PUBLIC_COPY_NOT_ACCEPTED'}
        find('ROLE_DERIVATION_NOT_REHEARSED', reason='ROLES_PUBLIC_COPY_NOT_ACCEPTED')
    else:
        record_manifest = os.path.join(pkg_dir, 'record', 'source-manifest.json')
        acc = read_json(os.path.join(pkg_dir, 'record', 'acceptance.json'))
        bare = os.path.join(cfg['workDir'], 'rehearsal', 'src-' + commit[:8] + '.git')
        if not os.path.exists(bare):
            os.makedirs(os.path.dirname(bare), exist_ok=True)
            subprocess.run(['git', 'init', '-q', '--bare', '--initial-branch=accepted', bare], check=True)
            subprocess.run(['git', '-C', bare, 'fetch', '-q', '--no-tags', cfg['repo'], commit + ':refs/heads/accepted'], check=True)
        derive = os.path.join(HERE, 'linux', 'tools', 'derive-roles.py')
        refs = ['--commit', commit, '--source-acceptance-ref', acc['sourceAcceptanceRef'], '--host-acceptance-ref', acc['hostQualificationRef']]
        if companion:
            # The same derive-roles.py with this Windows Python on the companion's public copy (checked above), no WSL. Its private
            # temporary directory (the six files, the tool's create-only output) is removed afterwards.
            role_user, git = 'windows-non-elevated-operator', shutil.which('git')
            tmp = tempfile.mkdtemp(prefix='clued-rehearsal-roles-')
            try:
                os.mkdir(os.path.join(tmp, 'installed'))
                for name, data in role_files.items():
                    with open(os.path.join(tmp, 'installed', name), 'xb') as f:
                        f.write(data)
                if git is None:
                    code, out, err = None, json.dumps({'status': 'REFUSED', 'code': 'WINDOWS_GIT_NOT_FOUND'}), ''
                else:
                    code, out, err = host.windows_python(['-c', WINDOWS_ROLE_RUNNER, derive, git, '--installed', os.path.join(tmp, 'installed'),
                        '--old-manifest-file', os.path.join(rd, 'formal-source-manifest-v2.json'), '--new-manifest-file', record_manifest,
                        '--src', bare] + refs + ['--out', os.path.join(tmp, 'out')])
            finally:
                remove_tree(tmp)
        else:
            out_dir = '/tmp/clued-rehearsal-roles-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(4).hex()
            # review 1-9: role derivation must really run as a normal user. An
            # explicit existing rehearsalUser avoids changing a root-default distro.
            role_user = cfg['linux'].get('rehearsalUser')
            runner = ("import os,runpy,sys,shutil\n"
                      "if os.getuid() == 0 or os.geteuid() == 0: print('{\"status\":\"REFUSED\",\"code\":\"REHEARSAL_DEFAULT_USER_IS_ROOT\"}'); sys.exit(3)\n"
                      "os.geteuid=lambda:0; t=sys.argv[1]; sys.argv=sys.argv[1:]\n"
                      "try: runpy.run_path(t, run_name='__main__')\nfinally: shutil.rmtree(sys.argv[sys.argv.index('--out')+1], ignore_errors=True)")
            code, out, err = host.wsl_python(cfg['linux']['distribution'], ['-c', runner, to_wsl(derive),
                '--installed', to_wsl(rd), '--old-manifest-file', to_wsl(os.path.join(rd, 'formal-source-manifest-v2.json')), '--new-manifest-file', to_wsl(record_manifest),
                '--src', to_wsl(bare)] + refs + ['--out', out_dir], user=role_user)
        r = last_json(out) or {}
        checks['roles'] = {'runAsUser': role_user or 'distribution-default', 'exit': code, 'status': r.get('status'), 'code': r.get('code'), 'repinned': {k: v.get('repinned') for k, v in (r.get('roles') or {}).items()},
                           'stderr': err[-400:]}
        if code != 0 or r.get('status') != 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN':
            find('ROLE_DERIVATION_REFUSED', refusal=r.get('code'), role=r.get('role'), key=r.get('key'))

    return {'contract': CONTRACT, 'status': 'REHEARSAL_PASS' if not findings else 'REHEARSAL_FAILED', 'findings': findings,
            'node': profile['nodeName'], 'commit': commit, 'packageManifestSha256': pkg_sha, 'configSha256': cfg['_sha256'],
            'installedResidentManifestSha256': installed, 'checks': checks,
            'observedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}


def main(argv):
    assert '--fleet' not in argv or '--file-locks-in-launcher' in argv, 'USAGE: --fleet goes with --file-locks-in-launcher'
    cfg = rconfig.load(argv[0])
    a = argv[1:]
    opt = lambda n, d=None: a[a.index(n) + 1] if n in a else d
    commit, pkg_dir = opt('--commit'), opt('--package')
    assert commit and re.fullmatch(r'[0-9a-f]{40}', commit) and pkg_dir, 'USAGE: <config> --commit <40hex> --package <dir> [--file-locks-in-launcher] [--fleet]'
    report = rehearse(cfg, commit, os.path.abspath(pkg_dir), Host(), skip_roles='--skip-roles' in a,
                      linux_version_facts=opt('--linux-version-facts'), file_locks_in_launcher='--file-locks-in-launcher' in a, installed_linux_in_phase_a='--fleet' in a)
    out_dir = opt('--report-dir', os.path.join(cfg['workDir'], 'rehearsal'))
    os.makedirs(out_dir, exist_ok=True)
    name = 'rehearsal.%s.%s.%s.%s.json' % (report['node'], commit[:8], report['packageManifestSha256'][:8], report['observedAt'].replace('-', '').replace(':', ''))
    data = (json.dumps(report, indent=1, sort_keys=True) + '\n').encode('utf-8')
    with open(os.path.join(out_dir, name), 'xb') as f:
        f.write(data)
    print(json.dumps({'status': report['status'], 'report': os.path.join(out_dir, name), 'findings': report['findings']}, indent=1))
    return 0 if report['status'] == 'REHEARSAL_PASS' else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
