"""在隔离节点中执行包内 generate.py --check，替代仅主机才能回答的查询。"""
import builtins
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
from unittest.mock import patch


def run_prep(observed_at, tool, *args):
    # prep.py 检查演练时效。用同一时刻生成演练回执和脚本，方便跨日复跑。
    instant = datetime.datetime.fromisoformat(observed_at)

    class FixtureDateTime(datetime.datetime):
        @classmethod
        def now(cls, tz):
            return instant.astimezone(tz)

    sys.argv = [tool, *args]
    with patch('datetime.datetime', FixtureDateTime):
        runpy.run_path(tool, run_name='__main__')


if sys.argv[1] == '--prep':
    run_prep(*sys.argv[2:])
    sys.exit(0)


root, sddl, generator, plan_flag, plan_file, check_flag = sys.argv[1:]
assert (plan_flag, check_flag) == ('--fleet-plan', '--check')
plan = json.loads(Path(plan_file).read_bytes())
work = Path(plan_file).parent
package = Path(plan['packageDir'])
node = json.loads((package / 'record' / 'acceptance.json').read_bytes())['node']
live = r'C:\ProgramData\CluedIndependentCI'
live_resident = live + r'\resident'
parent_sddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
resident_sid = 'S-1-5-80-1-2-3-4-5'
sc = r'C:\Windows\System32\sc.exe'
ps = r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
ps_args = [ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
host_files = work / 'host-fixture'
host_files.mkdir(exist_ok=True)
(host_files / 'formal-spool').mkdir(exist_ok=True)
(host_files / 'owner').mkdir(exist_ok=True)
host_locations = {
    node['ownerProfileDirectory'].lower(): host_files / 'owner',
    r'c:\program files\github cli\gh.exe': host_files / 'gh.exe',
    r'c:\program files\wsl\wsl.exe': host_files / 'wsl.exe',
    ps.lower(): host_files / 'powershell.exe',
}
for target in host_locations.values():
    if not target.is_dir():
        target.touch()


def fixture_path(file):
    if isinstance(file, int):
        return file
    name = os.fspath(file)
    if not isinstance(name, str):
        return file
    name = os.path.normpath(name)
    if name.lower() in host_locations:
        return host_locations[name.lower()]
    for prefix, target in ((live_resident, Path(root)), (live, host_files),
                           (r'C:\clued-ci', host_files / 'clued-ci')):
        if name.lower() == prefix.lower() or name.lower().startswith(prefix.lower() + '\\'):
            return target / name[len(prefix):].lstrip('\\')
    return file


def isolated(call):
    return lambda file, *args, **kwargs: call(fixture_path(file), *args, **kwargs)


def reviewed_dry_run():
    # expected-plan.ps1 通过安装器读取本机账户、SCM 和 ACL。
    # 按实际组装的包和隔离主机数据构造卸载后预览响应。
    manifest_bytes = (package / 'package-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    files = {entry['target']: entry['sha256'] for entry in manifest['files']}
    document = {
        'contract': 'clued.independent-ci.resident-install-plan/8',
        'packageManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'installScriptSha256': hashlib.sha256((package / 'resident' / 'windows' / 'install-resident.ps1').read_bytes()).hexdigest(),
        'startAfterInstall': True, 'ownerSid': node['ownerSid'], 'controllerSid': node['controllerSid'],
        'rootExists': False, 'servicesExist': False, 'openBatches': 0, 'residentSid': resident_sid,
        'residentManifestSha256': manifest['residentManifestSha256'],
        'ciSourceManifestSha256': manifest['ciSourceManifestSha256'],
        'upgrader': {'service': 'CluedCIUpgrader', 'account': 'LocalSystem',
                     'manifestSha256': manifest['upgrader']['manifestSha256'],
                     'configSha256': files[r'upgrader\config\upgrader.json'],
                     'token': {'target': live_resident + r'\secrets\resident-upgrade.token',
                               'supplied': False, 'targetExists': False, 'fingerprint': None}},
        'secretsFingerprintDirectory': None,
        'generation': {'number': 1, 'linux': {'generation': 1, 'manifestSha256': manifest['linux']['manifestSha256'],
                                               'ciSourceManifestSha256': manifest['ciSourceManifestSha256']}},
        'runnerBefore': {'originalBinary': True, 'stoppedPid0': True, 'manual': True,
                         'accountIsController': True, 'sddl': sddl},
    }
    sha = hashlib.sha256(json.dumps(document).encode()).hexdigest()
    return {'status': 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', 'plan': document, 'planSha256': sha}


def host_query(argv, **kwargs):
    if argv == [sc, 'query', 'CluedCIUpgrader']:
        return subprocess.CompletedProcess(argv, 0, b'')
    if argv == [sc, 'sdshow', node['runnerService']]:
        return subprocess.CompletedProcess(argv, 0, sddl)
    if argv[:7] == ps_args + ['-File', str(Path(generator).with_name('expected-plan.ps1'))]:
        assert '-Apply' not in argv and argv[7:11] == ['-View', 'post-uninstall', '-PackageRoot', plan['packageDir']]
        return subprocess.CompletedProcess(argv, 0, json.dumps(reviewed_dry_run()).encode(), b'')
    if argv[:6] == ps_args + ['-Command']:
        env = kwargs['env']
        if argv[6] == '(Get-Acl -LiteralPath $env:R41_PARENT).Sddl':
            assert env['R41_PARENT'] == live
            return subprocess.CompletedProcess(argv, 0, parent_sddl)
        if argv[6].startswith('$a=New-Object Security.AccessControl.DirectorySecurity;'):
            assert env['R41_BEFORE'] == parent_sddl and env['R41_SID'] == resident_sid
            return subprocess.CompletedProcess(argv, 0, parent_sddl + f'(A;;0x120080;;;{resident_sid})')
    raise AssertionError(f'未声明的主机调用: {argv[:6]}')


sys.argv = [generator, plan_flag, plan_file, check_flag]
with (patch('builtins.open', isolated(builtins.open)),
      patch('io.open', isolated(io.open)),
      patch('os.stat', isolated(os.stat)), patch('os.lstat', isolated(os.lstat)),
      patch('os.path.exists', isolated(os.path.exists)), patch('os.path.lexists', isolated(os.path.lexists)),
      patch('os.path.isfile', isolated(os.path.isfile)), patch('os.path.isdir', isolated(os.path.isdir)),
      patch('os.listdir', isolated(os.listdir)), patch('subprocess.run', host_query)):
    runpy.run_path(generator, run_name='__main__')
