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
Output: one create-only JSON report (clued.independent-ci.reinstall-rehearsal/1) with `findings` (the difference list) and every
observed value; exit 0 only on REHEARSAL_PASS.

  python -I rehearse.py <config.json> --commit <40hex> --package <dir> [--report-dir <dir>] [--skip-roles]
"""
import datetime, hashlib, importlib.util, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BS = chr(92)
ROOT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident'])
POWERSHELL = BS.join(['C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])
SC = BS.join(['C:', 'Windows', 'System32', 'sc.exe'])
CONTRACT = 'clued.independent-ci.reinstall-rehearsal/1'
VERIFY_OK = ('RESIDENT_VERIFIED', 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED')


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

    def sha(self, p):
        return sha_file(p)

    def powershell(self, script, args):
        p = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] + list(args),
                           capture_output=True, timeout=900)
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')

    def service_present(self, name):
        return subprocess.run([SC, 'query', name], capture_output=True).returncode != 1060

    def wsl_python(self, distribution, argv, user=None):
        """python3 -I in the node's WSL distribution, clean environment: as the default user (the role derivation, which refuses root
        itself), or as root for the read-only host probe (user='root')."""
        p = subprocess.run(['wsl.exe', '-d', distribution] + (['-u', user] if user else []) + ['--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
                            'LANG=C', 'LC_ALL=C', 'GIT_OPTIONAL_LOCKS=0', '/usr/bin/python3', '-I'] + list(argv), capture_output=True, timeout=600)
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


def rehearse(cfg, commit, pkg_dir, host, skip_roles=False, template_path=None):
    findings, checks = [], {}

    def find(finding, **detail):
        findings.append({'code': finding, **detail})

    tree = os.path.join(cfg['workDir'], 'tree-' + commit[:8])
    pkg = read_json(os.path.join(pkg_dir, 'package-manifest.json'))
    pkg_sha = sha_file(os.path.join(pkg_dir, 'package-manifest.json'))
    template = open(template_path or os.path.join(HERE, 'launcher', 'template.ps1'), encoding='utf-8').read()

    # node: the package's profile is the configured one
    profile, _ = rconfig.node_profile(cfg, tree)
    pkg_node = read_json(os.path.join(pkg_dir, 'record', 'acceptance.json'))['node']
    checks['node'] = {'configured': profile['nodeName'], 'package': pkg_node.get('nodeName')}
    if pkg_node != profile:
        find('PACKAGE_NODE_NOT_THE_CONFIGURED_PROFILE', package=pkg_node.get('nodeName'))

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
    checks['verify'] = {'script': vscript, 'exit': code, 'status': v.get('status'), 'failed': failed, 'notRunnableUnelevated': denied, 'stderr': err[-300:]}
    if not denied and (v.get('status') not in VERIFY_OK or failed):
        find('INSTALLED_VERIFY_NOT_PASSING', status=v.get('status'), failed=failed)

    # status: the fields the template (Test-OldRootQuiet) and prep.py read, and the upgrade state contracts
    st = host.read_json(host.path('state', 'status.json'))
    ust = host.read_json(host.path('upgrade', 'status.json')) if host.exists(host.path('upgrade', 'status.json')) else None
    gen = host.read_json(host.path('upgrade', 'current.json'))
    facts = host.read_json(host.path('upgrade', 'mailbox', 'responses', 'version-facts.json'))
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
    copy_sha = sha_file(cfg['linux']['installedManifest'])
    lin['installedManifestCopySha256'] = copy_sha
    if copy_sha != facts.get('manifestSha256'):
        find('INSTALLED_LINUX_MANIFEST_COPY_STALE', copy=copy_sha, installed=facts.get('manifestSha256'))
    rd = cfg['linux']['installedRoles']
    lin['rolesCopy'] = {}
    for role, want in sorted((facts.get('roles') or {}).items()):
        got = {'policySha256': sha_file(os.path.join(rd, role + '.json')), 'qualificationSha256': sha_file(os.path.join(rd, role + '.qualification.json'))}
        lin['rolesCopy'][role] = got
        if got != {'policySha256': want.get('policySha256'), 'qualificationSha256': want.get('qualificationSha256')}:
            find('INSTALLED_ROLES_COPY_STALE', role=role, copy=got, installed=want)
    if not facts.get('roles'):
        find('LINUX_FACTS_WITHOUT_ROLES')
    if sha_file(os.path.join(rd, 'formal-source-manifest-v2.json')) != facts.get('ciSourceManifestSha256'):
        find('INSTALLED_SOURCE_MANIFEST_COPY_STALE')

    # pins: the package's Linux resident manifest against the installed one and the new commit's tree
    p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'tools', 'linux-pins.py'), 'check', os.path.join(pkg_dir, 'linux', 'manifest.json'),
                        cfg['linux']['installedManifest'], tree], capture_output=True, text=True)
    checks['pins'] = {'exit': p.returncode, 'out': p.stdout.strip()[-1500:], 'err': p.stderr.strip()[-600:]}
    if p.returncode != 0:
        code = 'LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE' if 'NOT_THE_NEW_SOURCE' in p.stderr else 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE'
        find(code, detail=p.stderr.strip().splitlines()[-1:] if p.stderr.strip() else None)

    # linuxHost (review 1-1): the host facts the root scripts pin are this node's. As root and read-only: the committed check-host.py
    # (what phase A, B0 and B4 run) on the installed role policies with the configured pins, the Source v1 HEAD that verify-source-v2
    # requires, and the v1 qualifications the signer reads. Nothing is written; git takes no optional locks.
    lh = cfg['linux']['host']
    probe = ("import json,os,subprocess,sys\n"
             "env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}\n"
             "p=subprocess.run(['/usr/bin/python3','-I']+sys.argv[1:5],capture_output=True,text=True,env=env)\n"
             "g=subprocess.run(['/usr/bin/git','--git-dir=/opt/clued-independent-ci/source-first-formal-v1/.git','rev-parse','HEAD'],capture_output=True,text=True,env=env)\n"
             "q={r:os.path.isfile('/etc/clued-independent-ci/roles/'+r+'.qualification.json') for r in ('gitleaks','trivy','contract-placement')}\n"
             "print(json.dumps({'checkHostExit':p.returncode,'checkHost':p.stdout.strip()[-800:],'v1Head':g.stdout.strip() if g.returncode==0 else None,'v1Qualifications':q}))")
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
        if hp.get('v1Head') != lh['v1SourceHead']:
            find('LINUX_V1_SOURCE_HEAD_NOT_THE_CONFIGURED', installed=hp.get('v1Head'), configured=lh['v1SourceHead'])
        if not all((hp.get('v1Qualifications') or {}).values()) or not hp.get('v1Qualifications'):
            find('LINUX_V1_QUALIFICATIONS_MISSING', present=hp.get('v1Qualifications'))

    # roles: the derivation phase A runs, on the copies, as a normal user in the node's WSL distribution
    if skip_roles:
        checks['roles'] = {'skipped': True}
        find('ROLE_DERIVATION_NOT_REHEARSED')
    else:
        record_manifest = os.path.join(pkg_dir, 'record', 'source-manifest.json')
        acc = read_json(os.path.join(pkg_dir, 'record', 'acceptance.json'))
        bare = os.path.join(cfg['workDir'], 'rehearsal', 'src-' + commit[:8] + '.git')
        if not os.path.exists(bare):
            os.makedirs(os.path.dirname(bare), exist_ok=True)
            subprocess.run(['git', 'init', '-q', '--bare', '--initial-branch=accepted', bare], check=True)
            subprocess.run(['git', '-C', bare, 'fetch', '-q', '--no-tags', cfg['repo'], commit + ':refs/heads/accepted'], check=True)
        out_dir = '/tmp/clued-rehearsal-roles-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(4).hex()
        # review 1-9: the derivation runs as a normal user; a distribution whose default user is root is refused here, not used
        runner = ("import os,runpy,sys,shutil\n"
                  "if os.getuid() == 0: print('{\"status\":\"REFUSED\",\"code\":\"REHEARSAL_DEFAULT_USER_IS_ROOT\"}'); sys.exit(3)\n"
                  "os.geteuid=lambda:0; t=sys.argv[1]; sys.argv=sys.argv[1:]\n"
                  "try: runpy.run_path(t, run_name='__main__')\nfinally: shutil.rmtree(sys.argv[sys.argv.index('--out')+1], ignore_errors=True)")
        code, out, err = host.wsl_python(cfg['linux']['distribution'], ['-c', runner, to_wsl(os.path.join(HERE, 'linux', 'tools', 'derive-roles.py')),
            '--installed', to_wsl(rd), '--old-manifest-file', to_wsl(os.path.join(rd, 'formal-source-manifest-v2.json')), '--new-manifest-file', to_wsl(record_manifest),
            '--src', to_wsl(bare), '--commit', commit, '--source-acceptance-ref', acc['sourceAcceptanceRef'], '--host-acceptance-ref', acc['hostQualificationRef'], '--out', out_dir])
        r = last_json(out) or {}
        checks['roles'] = {'exit': code, 'status': r.get('status'), 'code': r.get('code'), 'repinned': {k: v.get('repinned') for k, v in (r.get('roles') or {}).items()},
                           'stderr': err[-400:]}
        if code != 0 or r.get('status') != 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN':
            find('ROLE_DERIVATION_REFUSED', refusal=r.get('code'), role=r.get('role'), key=r.get('key'))

    return {'contract': CONTRACT, 'status': 'REHEARSAL_PASS' if not findings else 'REHEARSAL_FAILED', 'findings': findings,
            'node': cfg['node'], 'commit': commit, 'packageManifestSha256': pkg_sha, 'configSha256': cfg['_sha256'],
            'installedResidentManifestSha256': installed, 'checks': checks,
            'observedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}


def main(argv):
    cfg = rconfig.load(argv[0])
    a = argv[1:]
    opt = lambda n, d=None: a[a.index(n) + 1] if n in a else d
    commit, pkg_dir = opt('--commit'), opt('--package')
    assert commit and re.fullmatch(r'[0-9a-f]{40}', commit) and pkg_dir, 'USAGE: <config> --commit <40hex> --package <dir>'
    report = rehearse(cfg, commit, os.path.abspath(pkg_dir), Host(), skip_roles='--skip-roles' in a)
    out_dir = opt('--report-dir', os.path.join(cfg['workDir'], 'rehearsal'))
    os.makedirs(out_dir, exist_ok=True)
    name = 'rehearsal.%s.%s.%s.%s.json' % (cfg['node'], commit[:8], report['packageManifestSha256'][:8], report['observedAt'].replace('-', '').replace(':', ''))
    data = (json.dumps(report, indent=1, sort_keys=True) + '\n').encode('utf-8')
    with open(os.path.join(out_dir, name), 'xb') as f:
        f.write(data)
    print(json.dumps({'status': report['status'], 'report': os.path.join(out_dir, name), 'findings': report['findings']}, indent=1))
    return 0 if report['status'] == 'REHEARSAL_PASS' else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
