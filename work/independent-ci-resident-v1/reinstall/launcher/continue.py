"""Continue a generic-node-package reinstall whose launch stopped, or was cut off, part of the way.

  python -I generate.py --fleet-continue <the prior launcher.ps1> --out <new launcher.ps1>

The same command on every node: no node value is given. Everything comes from the prior launcher (its pins: package, receipts,
fingerprints, work and launch directories), the prior launch directory (terminal.json when the launch stopped; its progress records,
one per completed step, when it was cut off without one) and the node as it is now. The prior launcher must be this template's,
unchanged (the template and the injected fragment are the pinned, reviewed bytes); when install-plan.json beside it records the
launcher, its hash must be that one.

Where a prior launch can be continued from (the last completed step decides; anything else is refused with the reason, never guessed):

  before-uninstall   phase B's output was checked and the uninstall had not begun (the Windows preflight refused, or the launch was cut
                     off there). Linux is the new generation 1, the old resident is still installed: a new `prepare` cannot describe
                     that node, so this is the way on. The continuation skips Linux and runs the launcher from its uninstall preflight.
  b-timeout          phase B ran into the launcher's timeout. The same, except that B's output is looked for, elevated, when the
                     continuation runs: finished and passing the rules -> on; not finished -> LINUX_PHASE_STILL_RUNNING_RETRY (the same
                     command again later); finished with a refusal -> LINUX_PHASE_B_FAILED_AFTER_ITS_TIMEOUT (a person looks).
  inside-uninstall   the quiesce was done and the installed uninstall's -Apply failed (terminal UNINSTALL_NOT_COMPLETED with exactly the
                     evidence launcher/resume.py was reviewed for, checked by its own code with this launcher's completed steps). The
                     continuation skips Linux, carries the tokens from the live root (not renamed yet), finishes the uninstall with
                     resume.py's reviewed Step-FinishUninstall (finish-uninstall.ps1, pinned: every live guard again, then only the rename
                     and the receipt of the original plan digest) and runs the launcher from its install preflight.
  after-uninstall    the uninstall completed and the install did not. The continuation skips Linux and the uninstall, carries the
                     tokens from the kept root and runs the launcher from its install preflight.
  after-install      the install completed and one of first-train, verify, pause, companion, rearm, companion-headless did not pass (or
                     the launch was cut off after the install). Nothing up to and including the install runs again and no token is
                     carried; the continuation runs the launcher's own lines from the first step that did not pass ($ContinueAfterInstallFrom),
                     each repeatable or checked first; the steps before it are proven again, elevated.

  a-timeout          phase A ran into the launcher's timeout. Looked for, elevated, when the continuation runs: A's stdout (on a companion
                     node the registrar's capture) ends with A's final status -> everything of the launcher again except A, and B from
                     the prior A (Step-LinuxRoot as it is); not finished -> LINUX_PHASE_STILL_RUNNING_RETRY; refused -> a person looks.
  cut off inside the uninstall (no terminal): read from the node (sc query, the root): nothing uninstalled -> before-uninstall; renamed and
                     all three services gone, the newest kept root after the quiesce -> after-uninstall (the kept receipt proven against the
                     prior dry run's plan digest); anything else -> PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN with what was seen.

The prior launcher may itself be a continuation made here: it is read back (its pins are a launcher's plus literal Continue*/Resume* pins,
and transform() of that launcher must give its exact bytes) and its launch directory is the prior launch. A continuation that stopped
before its own step completed changed nothing: the launch it continued is continued instead.

NOT continued by this version (refused, named): a launch that stopped before phase A ran (nothing changed: prepare again); phase A done
and phase B or its resume failed (the node stays paused, a person looks: the root scripts' own recovery); inside the uninstall, anything
but resume.py's failed -Apply or the two cut-off states above; a launch that ran the companion maintenance path.

Windows, non-elevated, writes only the new launcher (create-only) and prints one line of JSON; nothing is run.
"""
import datetime, hashlib, importlib.util, json, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('resume', HERE / 'resume.py')
RESUME = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(RESUME)
BS = chr(92)
CI_ROOT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI'])
CONTINUE_FRAGMENT_SHA = 'be71114f2e8e820b9e464340a66359831544d6fbef57ca769d66e70d97dc536c'   # continue-install.ps1, the reviewed bytes (independent review 2026-11-13: PASS-WITH-FIXES, fixes applied)
FINISH_FRAGMENT_SHA = '2211dce65916ca9acdee4412016f41d6f913a2c1ccc4fa5e9825d6b22ff81ae2'   # finish-uninstall.ps1, resume.py's fragment + the cut-off evidence branch (independent review 2026-11-13: PASS-WITH-FIXES)
KEPT = re.compile(r'resident-uninstalled-\d{8}T\d{6}Z-[0-9a-f]{12}')
LINUX_FILES = ['linux-report.json', 'linux-version-facts.json', 'linux-live-manifest.txt']
AFTER_FILES = ['uninstall-report.json', 'migrate-acl.dry-run.before-uninstall.stdout.json']
OLD_FIRST, OLD_PREFLIGHT, OLD_LAST = '  $fileLocks = $null; $linux = $null\n', '  Step-UninstallPreflight\n', '  $uninstall = Step-Uninstall\n'
OLD_INSTALLED = '  if ($FleetPlanSha256) { Remove-FleetCarry }   # the installer has placed the tokens\n'
# what a generic node package launcher has completed when its uninstall -Apply failed (carry-swept first when a sweep found something)
INSIDE_STEPS = ['output', 'package', 'stage', 'windows-preflight-before-linux', 'tokens-carried', 'file-locks', 'linux-A', 'linux-B', 'linux-output-checked',
                'uninstall-preflight', 'parent-acl-checked', 'quiesce']
# after the install, in the launcher's order; each but the last has one line in #region main (prefix, the variable it assigns)
POST_INSTALL = ['first-train', 'verify', 'pause', 'companion', 'rearm', 'companion-headless']
POST_LINES = {'first-train': '  $train = ', 'verify': '  $verify = ', 'pause': '  $pause = ', 'companion': '  $companion = ', 'rearm': '  $rearm = '}
POST_INSTALL_STATUSES = {'R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED', 'PAUSE_NOT_CONFIRMED', 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED'}
SERVICES = ['CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader']
UPTO_LINUX = INSIDE_STEPS[:9]
# a continuation's own step (the call in #region main -> its mode and the progress record it writes when it completed) and what that record
# stands for in a later continuation of it: the steps of the original launch it skipped because its prior had done them
MARKERS = {'Step-ContinueBeforeUninstall': ('before-uninstall', 'continued-before-uninstall'), 'Step-ContinueInsideUninstall': ('inside-uninstall', 'continued-inside-uninstall'),
           'Step-ContinueAfterUninstall': ('after-uninstall', 'continued-after-uninstall'), 'Step-ContinueAfterInstall': ('after-install', 'continued-after-install'),
           'Step-ContinueAfterATimeout': ('a-timeout', 'continued-a-timeout')}
CREDITED = {'continued-before-uninstall': UPTO_LINUX, 'continued-inside-uninstall': INSIDE_STEPS + ['uninstall'], 'continued-after-uninstall': INSIDE_STEPS + ['uninstall'],
            'continued-after-install': INSIDE_STEPS + ['uninstall', 'preflight', 'install'], 'continued-a-timeout': []}
# what a launch has completed when its uninstall -Apply failed: an original launch, an A-timeout continuation, a before-uninstall continuation
INSIDE_ALLOWED = [INSIDE_STEPS, ['output', 'package', 'stage', 'continued-a-timeout'] + INSIDE_STEPS[3:],
                  ['output', 'package', 'stage', 'file-locks', 'tokens-carried', 'continued-before-uninstall', 'uninstall-preflight', 'parent-acl-checked', 'quiesce']]
_CARRIED = ("  $UpgradeTokenFile = $continue.carried['upgradeToken']; $HeartbeatTokenFile = $(if ($continue.carried.Contains('heartbeatToken')) { $continue.carried['heartbeatToken'] } else { $null })\n"
            '  $LinuxVersionFactsSource = $continue.linux.factsSource; $LinuxVersionFactsSha256 = $continue.linux.factsSha256\n')
NEW_BEFORE = ('  $continue = Step-ContinueBeforeUninstall   # the prior launch finished Linux and had not begun the uninstall: no Linux step runs again\n'
              '  $fileLocks = $continue.fileLocks; $linux = $continue.linux\n' + _CARRIED)
NEW_AFTER = ('  $continue = Step-ContinueAfterUninstall   # the prior launch completed the uninstall: no Linux step and no uninstall runs again\n'
             '  $fileLocks = $null; $linux = $continue.linux; $parentAcl = $continue.parentAcl; $quiesce = $continue.quiesce; $uninstall = $continue.uninstall\n' + _CARRIED)
NEW_INSIDE = ('  $continue = Step-ContinueInsideUninstall   # the prior launch stopped inside the uninstall: its rename is finished, no Linux step and no uninstall runs again\n'
              '  $fileLocks = $null; $linux = $continue.linux; $parentAcl = $continue.parentAcl; $quiesce = $continue.quiesce; $uninstall = $continue.uninstall\n' + _CARRIED)
NEW_INSTALLED = ('  $continue = Step-ContinueAfterInstall   # the prior launch installed: nothing up to and including the install runs again\n'
                 '  $fileLocks = $null; $linux = $continue.linux; $parentAcl = $continue.parentAcl; $quiesce = $continue.quiesce; $uninstall = $continue.uninstall; $archive = $continue.archive; $install = $continue.install\n'
                 '  $LinuxVersionFactsSource = $continue.linux.factsSource; $LinuxVersionFactsSha256 = $continue.linux.factsSha256\n')
NEW_A_TIMEOUT = '    $continue = Step-ContinueAfterATimeout   # the prior phase A ran into the timeout: proven finished, then B from it\n'
CARRIED_LINE = '   # passed in the prior launch; proven again by Step-ContinueAfterInstall\n'
sha = lambda b: hashlib.sha256(b).hexdigest()


class Refused(Exception):
    def __init__(self, code, detail=None):
        super().__init__(code); self.code = code; self.detail = detail


def need(ok, code, detail=None):
    if not ok:
        raise Refused(code, detail)


def q(value):
    need(isinstance(value, str) and re.fullmatch(r'[\x20-\x26\x28-\x7e]*', value) is not None, 'CONTINUE_UNSAFE_LITERAL', value)
    return "'" + value + "'"


def reviewed_sources():
    """The template (generate.py's pin) and the fragment (the pin above): only the reviewed bytes are ever built from."""
    with open(HERE / 'generate.py', encoding='utf-8') as stream:
        pins = re.findall(r"(?m)^TEMPLATE_SHA = '([0-9a-f]{64})'", stream.read())
    with open(HERE / 'template.ps1', encoding='utf-8') as stream:
        template = stream.read()
    need(len(pins) == 1 and sha(template.encode('utf-8')) == pins[0], 'TEMPLATE_NOT_THE_REVIEWED_ONE')
    with open(HERE / 'continue-install.ps1', 'rb') as stream:
        raw = stream.read()
    need(sha(raw.replace(b'\r\n', b'\n')) == CONTINUE_FRAGMENT_SHA, 'CONTINUE_FRAGMENT_NOT_THE_REVIEWED_ONE')
    with open(HERE / 'finish-uninstall.ps1', 'rb') as stream:
        finish = stream.read().replace(b'\r\n', b'\n')
    need(sha(finish) == FINISH_FRAGMENT_SHA, 'FINISH_FRAGMENT_NOT_THE_REVIEWED_ONE')
    return raw.replace(b'\r\n', b'\n').decode('utf-8'), finish.decode('utf-8')


def parse_json_text(data):
    """template.ps1 Parse-Json: the whole text, else the last top-level object (from a line that starts with '{')."""
    try:
        text = data.decode('utf-8').strip('\ufeff \r\n\t')
    except UnicodeDecodeError:
        return None
    for candidate in (text, text[text.rfind('\n{') + 1:] if '\n{' in text else None):
        try:
            value = json.loads(candidate) if candidate else None
        except ValueError:
            continue
        return value if isinstance(value, dict) else None
    return None


def post_install_start(done, read, terminal):
    """The first step of POST_INSTALL that did not pass in the prior launch, and the prior files the continuation proves the earlier ones
    by. done: the completed steps; read(name): a prior file's bytes; terminal: the prior terminal (None when the launch was cut off)."""
    field = lambda name, key: (parse_json_text(read(name)) or {}).get(key)
    companion = terminal.get('companion') if isinstance(terminal, dict) else None
    need(not ('companion-headless' in done and 'companion' not in done) and not (isinstance(companion, dict) and companion.get('maintenanceDeferred')),
         'PRIOR_LAUNCH_RAN_COMPANION_MAINTENANCE_NOT_CONTINUED')
    trained = bool(done & {'first-train', 'first-train-not-applicable', 'first-train-not-observed'})
    need(not trained or field('first-train-report.json', 'runnerQuiet') is True, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT', 'first-train-report.json')
    need(trained or 'verify' not in done, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT', 'verify')
    verified = 'verify' in done and field('verify.stdout.json', 'status') == 'RESIDENT_VERIFIED'
    need(verified or 'pause' not in done, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT', 'pause')
    need('pause' not in done or (field('pause-report.json', 'confirmed') is True and field('pause-report.json', 'verified') is True), 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT', 'pause-report.json')
    need('pause' in done or 'companion' not in done, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT', 'companion')
    need('companion' in done or not done & {'rearm', 'rearm-not-needed'}, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT', 'rearm')
    started = 'companion' in done and isinstance(companion, dict) and companion.get('started') is True   # cut off: unknown, so not passed
    passed = {'first-train': trained, 'verify': verified, 'pause': 'pause' in done, 'companion': started,
              'rearm': started and ('rearm-not-needed' in done or ('rearm' in done and field('rearm-report.json', 'cleared') is True)),
              'companion-headless': 'companion-headless' in done and field('companion-headless-report.json', 'status') == 'COMPANION_HEADLESS_QUALIFIED'}
    start = next((step for step in POST_INSTALL if not passed[step]), None)
    need(start is not None, 'PRIOR_LAUNCH_COMPLETED_NOTHING_TO_CONTINUE')
    at = POST_INSTALL.index(start)
    used = ['install-receipt.json'] + [name for i, name in ((1, 'first-train-report.json'), (2, 'verify.stdout.json'), (3, 'pause-report.json'), (5, 'rearm-report.json')) if at >= i]
    return start, used


def linux_output_codes(evidence, facts_text, source, package, linux_manifest):
    """template.ps1 Test-FleetLinuxOutput, the same rules."""
    codes = []
    m = re.findall(r'(?m)^sha256: ([0-9a-f]{64})$', evidence)
    if len(m) != 1 or not re.search(r'(?m)^exit: 0$', evidence):
        codes.append('LINUX_EVIDENCE_UNPARSABLE')
    elif m[0] != source:
        codes.append('LIVE_LINUX_SOURCE_NOT_THIS_RECORD')
    if re.findall(r'(?m)^package: ([0-9a-f]{64})$', evidence) != [package]:
        codes.append('LINUX_ADOPTED_ANOTHER_PACKAGE')
    try:
        f = json.loads(facts_text)
    except ValueError:
        f = None
    if not isinstance(f, dict):
        codes.append('LINUX_VERSION_FACTS_UNREADABLE')
    elif not (f.get('contract') == 'clued.independent-ci.linux-version-facts/1' and type(f.get('generation')) is int and f['generation'] == 1 and 'staged' in f and f['staged'] is None
              and f.get('ciSourceManifestSha256') == source and f.get('manifestSha256') == linux_manifest and f.get('pinsOk') is True):
        codes.append('LINUX_VERSION_FACTS_NOT_THIS_PACKAGE')
    return codes


def progress_records(prior, source_sha, package_head):
    """<launch>\\progress\\NNN-<step>.json, one per completed step, in order: (file names, steps, the last record)."""
    directory = os.path.join(prior, 'progress')
    names = sorted(os.listdir(directory)) if os.path.isdir(directory) else []
    steps, last, index = [], None, None
    for name in names:
        need(re.fullmatch(r'[0-9]{3}-[A-Za-z0-9_-]{1,80}\.json', name), 'PRIOR_PROGRESS_REFUSED', name)
        try:
            doc = json.loads(RESUME.read_plain(os.path.join(directory, name)).decode('utf-8'))
        except (ValueError, OSError):
            raise Refused('PRIOR_PROGRESS_REFUSED', name)
        pins = doc.get('pins') if isinstance(doc, dict) else None
        need(isinstance(pins, dict) and doc.get('contract') == 'clued.independent-ci.reinstall-launch-progress/1' and type(doc.get('index')) is int and name.startswith('%03d-' % doc['index'])
             and isinstance(doc.get('step'), str) and pins.get('sourceSha') == source_sha and pins.get('packageHead') == package_head
             and type(doc.get('pid')) is int and isinstance(doc.get('processStart'), str) and (index is None or doc['index'] > index), 'PRIOR_PROGRESS_REFUSED', name)
        index = doc['index']; steps.append(doc['step']); last = doc
    return names, steps, last


def service_present(name):
    """sc.exe query, not elevated: True (there), False (1060: no such service), None (anything else: not known)."""
    try:
        r = subprocess.run([BS.join(['C:', 'Windows', 'System32', 'sc.exe']), 'query', name], capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return True if r.returncode == 0 else False if r.returncode == 1060 else None


def uninstall_plan_sha(data):
    """The prior launch's uninstall dry run (uninstall.dry-run.stdout.json): its plan digest, by template.ps1 Test-UninstallPlan's rules."""
    v = parse_json_text(data) or {}
    plan = v.get('plan') if isinstance(v.get('plan'), dict) else {}
    need(v.get('status') == 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN' and re.fullmatch(r'[0-9a-f]{64}', v.get('planSha256') or '')
         and plan.get('contract') == 'clued.independent-ci.resident-uninstall-plan/3' and type(plan.get('openBatches')) is int and plan['openBatches'] == 0
         and plan.get('runnerOriginalStopped') is True and plan.get('runnerSddlUnchanged') is True and plan.get('deletesEvidence') is False
         and plan.get('upgraderService') is True and 'upgradeOpState' in plan and plan['upgradeOpState'] is None and plan.get('executorAlive') is False,
         'PRIOR_UNINSTALL_DRY_RUN_REFUSED')
    return v['planSha256']


def transform(source, block, new_block, extra, mode, start, fragment, finish):
    """The continuation's text from a launcher's: its pins block plus `extra`, the fragment(s) before #endregion generic, and #region main
    from the first step that did not complete. The same function reads a continuation back (read_launcher), so the two cannot differ."""
    a, mid, b = source.find(OLD_FIRST), source.find(OLD_PREFLIGHT), source.find(OLD_LAST)
    need(source.count(OLD_FIRST) == 1 and source.count(OLD_PREFLIGHT) == 1 and source.count(OLD_LAST) == 1 and 0 < a < mid < b and source.count('#endregion generic') == 1
         and '$linux = Step-LinuxRoot' in source[a:mid] and '$quiesce = Step-Quiesce' in source[mid:b] and source.count(block) == 1, 'PRIOR_LAUNCHER_STEP_BOUNDARY_CHANGED')
    old_steps = new_steps = None
    if mode == 'after-install':
        e = source.find(OLD_INSTALLED)
        need(source.count(OLD_INSTALLED) == 1 and b < e, 'PRIOR_LAUNCHER_STEP_BOUNDARY_CHANGED')
        old_steps, new_steps = source[a:e + len(OLD_INSTALLED)], NEW_INSTALLED
    elif mode in ('after-uninstall', 'inside-uninstall'):
        old_steps, new_steps = source[a:b + len(OLD_LAST)], (NEW_AFTER if mode == 'after-uninstall' else NEW_INSIDE)
    elif mode in ('before-uninstall', 'b-timeout'):
        old_steps, new_steps = source[a:mid], NEW_BEFORE
    injected = fragment + (finish if mode == 'inside-uninstall' else '')
    result = source.replace(block, new_block + extra, 1).replace('#endregion generic', injected + '#endregion generic', 1)
    if old_steps is not None:
        result = result.replace(old_steps, new_steps, 1)
    head, main = result.split('#region main', 1)
    if mode == 'after-install':
        # the steps that passed: their results, proven again elevated; from `start` on, the launcher's own lines (the pause checked first)
        need(start in POST_INSTALL, 'CONTINUE_NOT_APPLIED', start)
        for step in POST_INSTALL[:POST_INSTALL.index(start)]:
            lines = [line for line in main.split('\n') if line.startswith(POST_LINES[step])]
            need(len(lines) == 1, 'PRIOR_LAUNCHER_STEP_BOUNDARY_CHANGED', step)
            main = main.replace(lines[0] + '\n', POST_LINES[step] + '$continue.' + POST_LINES[step].strip()[1:-2] + CARRIED_LINE, 1)
        if POST_INSTALL.index(start) <= POST_INSTALL.index('pause'):
            need(main.count('$pause = Step-PauseAfterInstall (') == 1, 'PRIOR_LAUNCHER_STEP_BOUNDARY_CHANGED', 'pause')
            main = main.replace('$pause = Step-PauseAfterInstall (', '$pause = Step-ContinuePauseAfterInstall (', 1)
    elif mode == 'a-timeout':
        # everything of the launcher again, phase A excepted: the prior A is proven first, Step-LinuxRoot then runs B as it is
        for prefix, new in (('    Step-WindowsPreflightBeforeLinux', NEW_A_TIMEOUT), ('    $linux = Step-LinuxRoot', None)):
            lines = [line for line in main.split('\n') if line.startswith(prefix)]
            need(len(lines) == 1, 'PRIOR_LAUNCHER_STEP_BOUNDARY_CHANGED', prefix.strip())
            main = main.replace(lines[0] + '\n', (new + lines[0] if new else lines[0].replace('Step-LinuxRoot', 'Step-ContinueLinuxRoot $continue')) + '\n', 1)
    result = head + '#region main' + main
    need(main.count('$continue = Step-Continue') == 1 and 'Step-LinuxRoot' not in main and ('$uninstall = Step-Uninstall' in main) == (mode in ('before-uninstall', 'b-timeout', 'a-timeout'))
         and ('Step-Install' in main) == (mode != 'after-install') and ('function Step-FinishUninstall {' in result) == (mode == 'inside-uninstall'), 'CONTINUE_NOT_APPLIED')
    return result


def read_launcher(raw, fragment, finish):
    """A launcher (template.ps1 with literal pins: resume.parse_original), or a continuation of one made by this file: its pins block is a
    launcher's plus literal Continue*/Resume* pins, and transform() of that launcher gives exactly its bytes. Returns (source, block, pins,
    None or what the continuation names: its step's marker, the launch it continued and that launcher's hash, the root launcher's hash)."""
    try:
        source, block, pins = RESUME.parse_original(raw, sha(raw))
        return source, block, pins, None
    except ValueError as error:
        first = str(error)
    try:
        text = raw.decode('utf-8')
        with open(HERE / 'template.ps1', encoding='utf-8') as stream:
            prefix, suffix = stream.read().split('#PINS#')
    except (UnicodeDecodeError, ValueError):
        raise Refused('PRIOR_LAUNCHER_REFUSED', first)
    i = text.find('\n$ContinueOriginalLauncherSha256 = ', len(prefix))
    j = text.find('\n#endregion pins\n', max(i, 0))
    need(text.startswith(prefix) and suffix.startswith('\n#endregion pins\n') and len(prefix) < i < j, 'PRIOR_LAUNCHER_REFUSED', first)
    block, extra = text[len(prefix):i], text[i:j]
    launcher = (prefix + block + suffix).encode('utf-8')
    try:
        source, block, pins = RESUME.parse_original(launcher, sha(launcher))
    except ValueError as error:
        raise Refused('PRIOR_LAUNCHER_REFUSED', str(error)[:200])
    values = {}
    for line in extra.split('\n')[1:]:
        if re.fullmatch(r'\$(?:Continue|Resume)PriorPins = \[ordered\]@\{', line) or re.fullmatch(r"  '[A-Za-z0-9._-]{1,120}' = '[0-9a-f]{64}'", line) or line == '}':
            continue
        m = re.fullmatch(r'\$((?:Continue|Resume)\w+) = (' + RESUME.LITERAL + r'|\$null|[0-9]{1,10})', line)
        need(m is not None and m[1] not in values, 'PRIOR_LAUNCHER_REFUSED', line[:100])
        values[m[1]] = m[2][1:-1] if m[2].startswith("'") else None if m[2] == '$null' else m[2]
    calls = re.findall(r'(?m)^ *\$continue = (Step-Continue\w+)', text)
    need(len(calls) == 1 and calls[0] in MARKERS and re.fullmatch(r'[0-9a-f]{64}', values.get('ContinueRootLauncherSha256') or '')
         and re.fullmatch(r'[0-9a-f]{64}', values.get('ContinueOriginalLauncherSha256') or '') and values.get('ContinuePriorRoot'), 'PRIOR_LAUNCHER_REFUSED', 'NOT_A_CONTINUATION')
    mode, marker = MARKERS[calls[0]]
    need(transform(source, block, block, extra, mode, values.get('ContinueAfterInstallFrom'), fragment, finish) == text, 'PRIOR_LAUNCHER_REFUSED', 'NOT_A_CONTINUATION_OF_THIS_TEMPLATE')
    return source, block, pins, {'mode': mode, 'marker': marker, 'priorRoot': values['ContinuePriorRoot'], 'priorLauncherSha256': values['ContinueOriginalLauncherSha256'],
                                 'rootLauncherSha256': values['ContinueRootLauncherSha256'], 'resumePlanSha256': values.get('ResumeUninstallPlanSha256')}


def build(prior_launcher, ci_root=CI_ROOT, now=None, services=service_present):
    """Returns (continuation bytes, facts for the output line). ci_root and services are the tests' only: the node's are the constant and
    sc.exe. The prior launcher may itself be a continuation: then its launch directory is the prior launch."""
    fragment, finish = reviewed_sources()
    prior_launcher = os.path.abspath(prior_launcher)
    try:
        raw = RESUME.read_plain(prior_launcher)
    except (ValueError, OSError) as error:
        raise Refused('PRIOR_LAUNCHER_REFUSED', str(error)[:200])
    source, block, pins, chained = read_launcher(raw, fragment, finish)
    lit = lambda name: pins[name][1:-1] if pins[name].startswith("'") else None
    need(lit('FleetPlanSha256') and pins['DraftOnly'] == '$false', 'PRIOR_LAUNCHER_NOT_A_PACKAGE_LAUNCHER')
    launcher_sha = sha(raw); root_sha = chained['rootLauncherSha256'] if chained else launcher_sha
    plan_path = os.path.join(os.path.dirname(prior_launcher), 'install-plan.json')
    if os.path.isfile(plan_path):
        with open(plan_path, 'rb') as stream:
            plan = json.loads(stream.read().decode('utf-8'))
        if isinstance(plan, dict) and isinstance(plan.get('launcher'), dict):
            need(plan['launcher'].get('sha256') == root_sha, 'PRIOR_LAUNCHER_NOT_THE_PLANS', plan['launcher'].get('sha256'))
    prior = lit('LaunchOutPin')

    def records(prior):
        need(prior and os.path.isdir(prior), 'PRIOR_LAUNCH_NEVER_STARTED', prior)
        need(os.path.isfile(os.path.join(prior, 'intent.json')), 'PRIOR_LAUNCH_NEVER_STARTED', prior)
        names, steps, last = progress_records(prior, lit('SourceSha'), lit('PackageHead'))
        need(steps, 'PRIOR_LAUNCH_HAS_NO_PROGRESS_RECORDS', prior)
        return names, steps, last
    names, steps, last = records(prior)
    live_root = os.path.join(ci_root, 'resident')
    delegated = renamed_by = None
    if chained and (chained['marker'] not in steps or (chained['marker'] == 'continued-a-timeout' and 'linux-A' not in steps)) and (
            'uninstall-finish-only' in steps or 'uninstall' in steps or (chained['mode'] == 'inside-uninstall' and not os.path.lexists(live_root))):
        # it stopped (or was cut off) after it finished the uninstall's rename: that is not undone, so it is continued itself, after the uninstall
        renamed_by = chained
    elif chained and (chained['marker'] not in steps or (chained['marker'] == 'continued-a-timeout' and 'linux-A' not in steps)):
        # the continuation stopped before its own step completed (an A-timeout continuation: before its B): nothing it did is relied on
        # (each such step changes nothing on the node before it completes), so the launch it continued is continued instead
        delegated = prior
        prior, launcher_sha = chained['priorRoot'], chained['priorLauncherSha256']
        names, steps, last = records(prior)

    def held_file(name, missing):
        need(os.path.isfile(os.path.join(prior, name)), missing, name)
        try:
            return RESUME.read_plain(os.path.join(prior, name))
        except (ValueError, OSError):
            raise Refused('PRIOR_EVIDENCE_NOT_PLAIN', name)
    doc = lambda data: json.loads(data.decode('utf-8-sig'))
    # what the prior launch completed: its progress records, what a continuation's own step stands for, and its terminal when it wrote one
    done = set(steps) | (set(INSIDE_STEPS + ['uninstall']) if renamed_by else set())
    for marker, implied in CREDITED.items():
        if marker in done:
            done |= set(implied)
    held, stop_code, detail, t = {}, None, {}, None
    if os.path.isfile(os.path.join(prior, 'terminal.json')):
        held['terminal.json'] = held_file('terminal.json', 'PRIOR_EVIDENCE_MISSING')
        t = doc(held['terminal.json'])
        need(isinstance(t, dict) and t.get('contract') == 'clued.independent-ci.source-v2-windows-launch-terminal/1' and t.get('sourceSha') == lit('SourceSha')
             and t.get('packageHead') == lit('PackageHead') and isinstance(t.get('completed'), list), 'PRIOR_TERMINAL_NOT_THIS_LAUNCHERS')
        need(t.get('status') == 'STOPPED' or ('install' in done and t.get('status') in POST_INSTALL_STATUSES), 'PRIOR_LAUNCH_DID_NOT_STOP_NOTHING_TO_CONTINUE', t.get('status'))
        # the two records of the same launch must agree (a step completed before the launch directory existed has no progress record)
        need(set(steps) <= set(t['completed']) and set(t['completed']) - set(steps) <= {'carry-swept'}, 'PRIOR_PROGRESS_NOT_THE_TERMINALS', sorted(set(t['completed']) ^ set(steps)))
        stop_code = t.get('code'); detail = t.get('detail') if isinstance(t.get('detail'), dict) else {}
    extra_pins, start, plan_sha, cut_off = '', None, None, False
    if 'install' in done:
        mode = 'after-install'
    elif 'uninstall' in done:
        mode = 'after-uninstall'
    elif 'quiesce' in done and t is None:
        # cut off inside the uninstall: where its -Apply was is read from the node (not elevated, read only) and proven again elevated
        state = {'residentRootExists': os.path.lexists(live_root), 'services': {name: services(name) for name in SERVICES}}
        known = all(isinstance(v, bool) for v in state['services'].values())
        if state['residentRootExists'] and known and all(state['services'].values()):
            mode = 'before-uninstall'   # nothing was uninstalled: from the uninstall preflight again (a stopped service counts as quiesced)
        elif state['residentRootExists'] and known:
            # the -Apply deleted services and did not rename: resume.py's Step-FinishUninstall proves every guard again, elevated (a service
            # still there stops it), from the prior launch's own dry run instead of a terminal
            mode, cut_off = 'inside-uninstall', True
        elif not state['residentRootExists'] and known and not any(state['services'].values()):
            mode, cut_off = 'after-uninstall', True   # the -Apply renamed the root: the newest kept root, its receipt proven elevated
        else:
            raise Refused('PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN', state)
    elif 'quiesce' in done:
        # resume.py's case: the -Apply ran and failed, as the terminal says
        need(stop_code == 'UNINSTALL_NOT_COMPLETED', 'PRIOR_LAUNCH_STOPPED_INSIDE_THE_UNINSTALL_NOT_A_FAILED_APPLY', stop_code)
        mode = 'inside-uninstall'
    elif 'linux-output-checked' in done:
        mode = 'before-uninstall'
    elif 'linux-A' in done and stop_code in ('LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', 'LINUX_PHASE_B_OUTPUT_NOT_CAPTURED'):   # B's output not read yet
        mode = 'b-timeout'
    elif 'linux-A' in done:
        raise Refused('PRIOR_LINUX_PHASE_B_DID_NOT_COMPLETE_NODE_STAYS_PAUSED', stop_code)
    elif 'file-locks' in done and stop_code in ('LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', 'LINUX_PHASE_A_OUTPUT_NOT_CAPTURED'):   # A's output not read yet
        mode = 'a-timeout'
    else:
        raise Refused('PRIOR_LAUNCH_STOPPED_BEFORE_LINUX_PHASE_A_COMPLETED_PREPARE_AGAIN', stop_code)
    if mode in ('a-timeout', 'b-timeout'):
        phase = ('A',) if mode == 'a-timeout' else ('B', 'BResume')
        held['linux-report.json'] = held_file('linux-report.json', 'PRIOR_EVIDENCE_MISSING')
        runs = doc(held['linux-report.json']).get('runs')
        need(isinstance(runs, list) and runs and isinstance(runs[-1], dict) and runs[-1].get('name') in phase
             and (runs[-1].get('outcome') == 'TIMEOUT' if stop_code == 'LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED' else runs[-1].get('outcome') == 'EXITED' and isinstance(runs[-1].get('captureRefused'), str) and runs[-1]['captureRefused'] != '')
             and isinstance(runs[-1].get('directory'), str) and re.fullmatch(r'linux-run-[0-9a-f]{32}', os.path.basename(runs[-1]['directory']))
             and os.path.dirname(runs[-1]['directory']) == os.path.join(live_root, 'install'), 'PRIOR_LINUX_TIMEOUT_NOT_PHASE_' + phase[0] + 'S', runs[-1].get('name') if isinstance(runs, list) and runs and isinstance(runs[-1], dict) else None)
        need(os.path.isdir(live_root), 'RESIDENT_ROOT_MISSING_NOT_CONTINUED')
        extra_pins = ("\n$ContinueLinuxFrom = 'out-directory'" if mode == 'b-timeout' else '') + '\n$ContinueLastRunDirectory = ' + q(runs[-1]['directory'])
    else:
        for name in LINUX_FILES:
            held[name] = held_file(name, 'PRIOR_EVIDENCE_MISSING')
        lr = doc(held['linux-report.json'])
        need(isinstance(lr, dict) and lr.get('codes') == [] and lr.get('planSha256') == lit('FleetPlanSha256') and lr.get('versionFactsSha256') == sha(held['linux-version-facts.json'])
             and lr.get('evidenceSha256') == sha(held['linux-live-manifest.txt']), 'PRIOR_LINUX_OUTPUT_NOT_THE_REPORTED_BYTES')
        try:
            codes = linux_output_codes(held['linux-live-manifest.txt'].decode('utf-8'), held['linux-version-facts.json'].decode('utf-8'),
                                       lit('CiSourceManifestSha256'), lit('PackageManifestSha256'), lit('FleetLinuxManifestSha256'))
        except UnicodeDecodeError:
            codes = ['LINUX_OUTPUT_NOT_UTF8']
        need(not codes, 'PRIOR_LINUX_OUTPUT_NOT_AS_EXPECTED', codes)
    kept = None
    if mode == 'inside-uninstall' and cut_off:
        names_ = ['uninstall.dry-run.stdout.json', 'uninstall-preflight-report.json', 'migrate-acl.dry-run.before-uninstall.stdout.json', 'parent-acl-report.json', 'quiesce-report.json']
        finish_held = {name: held_file(name, 'PRIOR_EVIDENCE_MISSING') for name in names_}
        before = parse_json_text(finish_held['uninstall-preflight-report.json']) or {}
        need(before.get('codes') == [] and before.get('installedReceiptSha256') == lit('InstalledReceiptSha256') and before.get('installedUninstallSha256') == lit('InstalledUninstallSha256'),
             'PRIOR_UNINSTALL_NOT_RESUMES_CASE', 'PRIOR_PREFLIGHT_NOT_THE_ORIGINAL_PINS')
        plan_sha = uninstall_plan_sha(finish_held['uninstall.dry-run.stdout.json'])
        held.update(finish_held)
        extra_pins = RESUME.finish_pins(launcher_sha, prior, {name: sha(data) for name, data in finish_held.items()}, plan_sha)
    elif mode == 'inside-uninstall':
        need(os.path.isdir(live_root), 'RESIDENT_ROOT_MISSING_NOT_CONTINUED')
        lead = ['carry-swept'] if t['completed'][:1] == ['carry-swept'] else []
        required = next((lead + list(r) for r in INSIDE_ALLOWED if t['completed'] == lead + list(r)), lead + INSIDE_STEPS)
        try:   # resume.py's own reading and rules (resume-evidence.py), with this launcher's completed steps
            finish_held, finish_hashes, evidence = RESUME.prior_evidence(prior, pins, required)
        except (ValueError, OSError) as error:
            raise Refused('PRIOR_UNINSTALL_NOT_RESUMES_CASE', str(error)[:200])
        need(finish_held['terminal.json'] == held['terminal.json'], 'PRIOR_EVIDENCE_NOT_PLAIN', 'terminal.json')
        held.update(finish_held)
        plan_sha = evidence['uninstallPlanSha256']
        extra_pins = RESUME.finish_pins(launcher_sha, prior, finish_hashes, plan_sha)
    elif mode == 'after-install':
        need(os.path.isdir(live_root), 'RESIDENT_ROOT_MISSING_NOT_CONTINUED')
        start, used = post_install_start(done, lambda name: held_file(name, 'PRIOR_EVIDENCE_MISSING'), t)
        for name in used:
            held[name] = held_file(name, 'PRIOR_EVIDENCE_MISSING')
        extra_pins = '\n$ContinueAfterInstallFrom = ' + q(start)
    elif mode == 'before-uninstall':
        need(os.path.isdir(live_root), 'RESIDENT_ROOT_MISSING_NOT_CONTINUED')
        extra_pins = "\n$ContinueLinuxFrom = 'prior-launch'\n$ContinueLastRunDirectory = $null"
    elif mode == 'after-uninstall':
        need(not (stop_code == 'INSTALL_NOT_COMPLETED' and detail.get('residentRootExists') is not False), 'PRIOR_INSTALL_LEFT_A_ROOT_NOT_CONTINUED', stop_code)
        held['migrate-acl.dry-run.before-uninstall.stdout.json'] = held_file('migrate-acl.dry-run.before-uninstall.stdout.json', 'PRIOR_EVIDENCE_MISSING')
        kept_roots = sorted(n for n in os.listdir(ci_root) if KEPT.fullmatch(n) and os.path.isdir(os.path.join(ci_root, n))) if os.path.isdir(ci_root) else []
        if cut_off:
            held['uninstall.dry-run.stdout.json'] = held_file('uninstall.dry-run.stdout.json', 'PRIOR_EVIDENCE_MISSING')
            plan_sha = uninstall_plan_sha(held['uninstall.dry-run.stdout.json'])
            after = re.sub(r'[-:]', '', str(last.get('at', ''))[:19])   # the quiesce, the prior launch's last record: the rename came after it
            need(kept_roots and re.fullmatch(r'\d{8}T\d{6}', after) and kept_roots[-1][len('resident-uninstalled-'):][:15] >= after, 'PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN', {'keptRoots': kept_roots[-3:], 'after': after})
            kept, receipt = os.path.join(ci_root, kept_roots[-1]), None
        elif renamed_by and not os.path.isfile(os.path.join(prior, 'uninstall-report.json')) and os.path.isfile(os.path.join(prior, 'finish-uninstall-report.json')):
            # it stopped right after resume.py's finish: that step's own report names the kept root and its receipt
            held['finish-uninstall-report.json'] = held_file('finish-uninstall-report.json', 'PRIOR_EVIDENCE_MISSING')
            fu = (parse_json_text(held['finish-uninstall-report.json']) or {}).get('uninstall') or {}
            kept, receipt, plan_sha = fu.get('keptAt'), fu.get('uninstallReceiptSha256'), renamed_by['resumePlanSha256']
            need(isinstance(kept, str) and os.path.dirname(kept) == ci_root and KEPT.fullmatch(os.path.basename(kept)) and re.fullmatch(r'[0-9a-f]{64}', receipt or '')
                 and fu.get('planSha256') == plan_sha, 'PRIOR_UNINSTALL_REPORT_REFUSED', kept)
            plan_sha = None
        elif renamed_by and not os.path.isfile(os.path.join(prior, 'uninstall-report.json')):
            # cut off inside resume.py's finish after its rename: the newest kept root, its receipt proven elevated against the plan it names
            plan_sha = renamed_by['resumePlanSha256']
            after = re.sub(r'[-:]', '', str(last.get('at', ''))[:19])
            need(re.fullmatch(r'[0-9a-f]{64}', plan_sha or '') and kept_roots and re.fullmatch(r'\d{8}T\d{6}', after) and kept_roots[-1][len('resident-uninstalled-'):][:15] >= after,
                 'PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN', {'keptRoots': kept_roots[-3:], 'after': after})
            kept, receipt = os.path.join(ci_root, kept_roots[-1]), None
        else:
            held['uninstall-report.json'] = held_file('uninstall-report.json', 'PRIOR_EVIDENCE_MISSING')
            u = doc(held['uninstall-report.json'])
            apply_, evidence = (u.get('apply') or {}), (u.get('evidence') or {})
            kept = apply_.get('keptAt')
            need(isinstance(kept, str) and os.path.dirname(kept) == ci_root and KEPT.fullmatch(os.path.basename(kept)) and apply_.get('status') == 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT'
                 and u.get('deletedAndRenamed') is True and evidence.get('keptAt') == kept, 'PRIOR_UNINSTALL_REPORT_REFUSED', kept)
            need(evidence.get('installReceiptSha256') == lit('InstalledReceiptSha256') and re.fullmatch(r'[0-9a-f]{64}', evidence.get('uninstallReceiptSha256') or '')
                 and evidence.get('terminalEvidenceMatches') is True, 'PRIOR_UNINSTALL_NOT_OF_THE_PINNED_INSTALL')
            receipt = evidence['uninstallReceiptSha256']
        need(not os.path.lexists(live_root), 'RESIDENT_ROOT_PRESENT_NOT_CONTINUED')
        need(os.path.isdir(kept), 'KEPT_ROOT_MISSING', kept)
        need(kept_roots and kept_roots[-1] == os.path.basename(kept), 'KEPT_ROOT_NOT_THE_NEWEST_SOMETHING_WAS_UNINSTALLED_SINCE', kept_roots[-3:])
        extra_pins = ('\n$ContinueKeptRoot = ' + q(kept) + '\n$ContinueUninstallReceiptSha256 = ' + (q(receipt) if receipt else '$null')
                      + '\n$ContinueUninstallPlanSha256 = ' + (q(plan_sha) if plan_sha else '$null'))
    stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    launch = os.path.join(lit('W'), 'launch-continue-' + stamp)
    need(not os.path.lexists(launch) and launch != prior, 'CONTINUE_LAUNCH_DIRECTORY_EXISTS', launch)
    new_block, count = re.subn(r'(?m)^\$LaunchOutPin = .*$', lambda _: '$LaunchOutPin = ' + q(launch) + '   # the continuation writes here; the prior launch is kept as it is', block)
    need(count == 1, 'PRIOR_PINS_STRUCTURE')
    hashes = {name: sha(data) for name, data in held.items()}
    extra = ('\n$ContinueOriginalLauncherSha256 = ' + q(launcher_sha) + '\n$ContinueRootLauncherSha256 = ' + q(root_sha) + '\n$ContinuePriorRoot = ' + q(prior)
             + '\n$ContinuePriorPins = [ordered]@{\n' + ''.join('  ' + q(name) + ' = ' + q(digest) + '\n' for name, digest in hashes.items()) + '}\n$ContinuePriorProgress = ' + q('|'.join(names))
             + '\n$ContinuePriorPid = ' + str(last['pid']) + '\n$ContinuePriorProcessStart = ' + q(last['processStart']) + extra_pins)
    data = transform(source, block, new_block, extra, mode, start, fragment, finish).encode('utf-8')
    return data, {'mode': mode, 'originalLauncher': prior_launcher, 'originalLauncherSha256': launcher_sha, 'rootLauncherSha256': root_sha, 'priorLaunchDir': prior,
                  'priorIsAContinuation': chained is not None, 'skippedContinuationLaunchDir': delegated, 'continuationRenamedTheRoot': renamed_by is not None, 'priorCutOff': t is None, 'priorStopCode': stop_code, 'priorHadTerminal': 'terminal.json' in held,
                  'priorLastStep': steps[-1], 'keptRoot': kept, 'afterInstallFrom': start, 'uninstallPlanSha256': plan_sha, 'priorFileSha256': hashes, 'launchDir': launch, 'node': lit('NodeName'), 'packageManifestSha256': lit('PackageManifestSha256')}


def main(argv):
    try:
        need(len(argv) == 4 and argv[0] == '--fleet-continue' and argv[2] == '--out', 'USAGE: --fleet-continue <prior launcher.ps1> --out <new launcher.ps1>')
        data, facts = build(argv[1])
        out = os.path.abspath(argv[3])
        need(not os.path.lexists(out), 'CONTINUE_OUTPUT_MUST_BE_NEW', out)
        digest = sha(data)
        command = ("$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'; $b=[IO.File]::ReadAllBytes(" + q(out) + "); "
                   "$h=-join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }); "
                   "if ($h -cne '" + digest + "') { throw ('LAUNCHER_CHANGED ' + $h) }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -RunApprovedInstall")
        with open(out, 'xb') as stream:
            stream.write(data)
    except Refused as refused:
        print(json.dumps({'status': 'REFUSED', 'code': refused.code, 'detail': refused.detail}, default=str))
        return 3
    print(json.dumps(dict({'status': 'FLEET_CONTINUATION_GENERATED', 'launcher': {'path': out, 'sha256': digest}, 'bytes': len(data), 'elevatedCommand': command}, **facts)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
