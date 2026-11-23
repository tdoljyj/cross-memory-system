"""Create a reviewable continuation of this template's failed rename, never run it.

The original generated launcher and prior public reports are retained. The
output still requires Owner execution; it repeats no service/configuration
removal and keeps the original package/install/verify preflights.
"""
import argparse
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import stat

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('resume_evidence', HERE / 'resume-evidence.py')
EVIDENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVIDENCE)
FILES = ['terminal.json', 'uninstall-preflight-report.json',
         'migrate-acl.dry-run.before-uninstall.stdout.json', 'parent-acl-report.json', 'quiesce-report.json']
OLD_STEPS = ('  Step-UninstallPreflight\n  $parentAcl = Step-ParentAcl   # r4.1 C2\n'
             '  $quiesce = Step-Quiesce\n  $uninstall = Step-Uninstall\n')
NEW_STEPS = ('  $resume = Step-FinishUninstall\n  $parentAcl = $resume.parentAcl\n'
             '  $quiesce = $resume.quiesce\n  $uninstall = $resume.uninstall\n')
LITERAL = r"'[\x20-\x26\x28-\x7e]*'"


def require(condition, code):
    if not condition:
        raise ValueError(code)


def read_plain(path):
    path = Path(path).absolute()
    for parent in [*path.parents]:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and not getattr(info, 'st_file_attributes', 0) & 0x400, 'RESUME_INPUT_PARENT_NOT_PLAIN')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 16 * 1024 * 1024
            and not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
            'RESUME_INPUT_NOT_PLAIN')
    return path.read_bytes()


def q(value):
    require(isinstance(value, str) and re.fullmatch(r'[\x20-\x26\x28-\x7e]*', value) is not None,
            'RESUME_UNSAFE_LITERAL')
    return "'" + value + "'"


def windows_path(value):
    # A local path: a drive letter, its root and plain parts. Any drive, as the reinstall configuration names its paths
    # (tools/rconfig.py WIN_PATH): the work directory, and a test's temporary one, may be on D:.
    require(re.fullmatch(r'[A-Za-z]:\\[A-Za-z0-9 ._\\-]+', value or '') is not None
            and not any(part in ('.', '..', '') for part in value[3:].split('\\')), 'RESUME_LOCAL_PATH_REQUIRED')
    return value


def output_path(value, work_directory):
    path = Path(value).absolute()
    work = windows_path(str(Path(work_directory).absolute()))
    windows_path(str(path))
    # both are local paths (windows_path): compared as Windows paths (ntpath), whatever host os.path is; on another drive
    # the output is outside (and ntpath.commonpath would refuse the pair)
    require(ntpath.normcase(ntpath.splitdrive(work)[0]) == ntpath.normcase(ntpath.splitdrive(str(path))[0])
            and ntpath.normcase(ntpath.commonpath([work, str(path)])) == ntpath.normcase(work)
            and ntpath.normcase(str(path)) != ntpath.normcase(work), 'RESUME_OUTPUT_OUTSIDE_WORKDIR')
    require(not os.path.lexists(path), 'RESUME_OUTPUT_MUST_BE_NEW')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and not getattr(info, 'st_file_attributes', 0) & 0x400, 'RESUME_OUTPUT_PARENT_NOT_PLAIN')
    return path


def parse_original(raw, expected_sha):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') is not None
            and hashlib.sha256(raw).hexdigest() == expected_sha, 'ORIGINAL_LAUNCHER_CHANGED')
    source = raw.decode('utf-8')
    require('\r' not in source and not source.startswith('\ufeff'), 'ORIGINAL_LAUNCHER_ENCODING')
    template = (HERE / 'template.ps1').read_text(encoding='utf-8')
    prefix, suffix = template.split('#PINS#')
    require(source.startswith(prefix) and source.endswith(suffix), 'ORIGINAL_NOT_THIS_EXACT_TEMPLATE')
    block = source[len(prefix):len(source) - len(suffix)]
    generator = (HERE / 'generate.py').read_text(encoding='utf-8')
    allowed = set(re.findall(r"'\$(\w+) = ", generator)) - {'Staged', 'Leftovers', 'R5c'}
    values, group, groups = {}, None, set()
    staged = set()
    for line in block.splitlines():
        if line.startswith('#'):
            continue
        if line in ('$Staged = [ordered]@{', '$Leftovers = [ordered]@{'):
            name = line.split(' ', 1)[0][1:]
            require(group is None and name not in groups, 'ORIGINAL_PINS_STRUCTURE')
            group = name; groups.add(name); continue
        if line == '}':
            require(group is not None, 'ORIGINAL_PINS_STRUCTURE')
            group = None; continue
        if group is not None:
            match = re.fullmatch('  (' + LITERAL + ') = @\\((' + LITERAL + '), (' + LITERAL + ')\\)', line)
            require(group == 'Staged' and match is not None, 'ORIGINAL_PINS_NOT_LITERAL')
            name = match[1][1:-1]
            require(name not in staged and re.fullmatch(r'[0-9a-f]{64}', match[3][1:-1]) is not None,
                    'ORIGINAL_STAGED_PINS_INVALID')
            staged.add(name); continue
        if line.startswith('$R5c = '):
            require(line == '$R5c = @{ applyPlanSha256 = $null; factsStaged = $null }   # r5c: set by Test-TokenPlan / Get-VerifyFactsArgs'
                    and 'R5c' not in groups, 'ORIGINAL_PINS_NOT_LITERAL')
            groups.add('R5c'); continue
        match = re.fullmatch(r'\$(\w+) = (' + LITERAL + r'|\$(?:true|false|null)|[0-9]+)(?: +#.*)?', line)
        require(match is not None and match[1] in allowed and match[1] not in values, 'ORIGINAL_PINS_NOT_LITERAL')
        values[match[1]] = match[2]
    require(group is None and set(values) == allowed and groups == {'Staged', 'Leftovers', 'R5c'}
            and staged == {'install-resident.ps1', 'verify-resident.ps1', 'migrate-acl.ps1', 'acl-model.json'},
            'ORIGINAL_PINS_INCOMPLETE')
    require(values['DraftOnly'] == '$false', 'DRAFT_CANNOT_RESUME')
    return source, block, values


def prior_evidence(prior_directory, pins, required=None):
    """The five retained public reports of the failed uninstall, read plain; the terminal and the preflight checked against the
    original pins. Shared with continue.py (a generic node package launcher passes its own completed steps as `required`)."""
    literal_value = lambda name: pins[name][1:-1] if pins[name].startswith("'") else None
    held = {name: read_plain(Path(prior_directory) / name) for name in FILES}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in held.items()}
    evidence = EVIDENCE.validate_terminal(held['terminal.json'], hashes['terminal.json'],
                                          literal_value('SourceSha'), literal_value('PackageHead'), required)
    before = json.loads(held['uninstall-preflight-report.json'])
    require(isinstance(before, dict) and before.get('codes') == []
            and before.get('installedReceiptSha256') == literal_value('InstalledReceiptSha256')
            and before.get('installedUninstallSha256') == literal_value('InstalledUninstallSha256'),
            'PRIOR_PREFLIGHT_NOT_THE_ORIGINAL_PINS')
    return held, hashes, evidence


def finish_pins(original_sha, prior_directory, hashes, plan_sha):
    """The pins Step-FinishUninstall (finish-uninstall.ps1) reads, appended to the original pins block. Shared with continue.py."""
    extra_pins = '\n$ResumeOriginalLauncherSha256 = ' + q(original_sha)
    extra_pins += '\n$ResumePriorRoot = ' + q(prior_directory) + '\n$ResumePriorPins = [ordered]@{\n'
    extra_pins += ''.join('  ' + q(name) + ' = ' + q(digest) + '\n' for name, digest in hashes.items())
    extra_pins += '}\n$ResumeUninstallPlanSha256 = ' + q(plan_sha)
    return extra_pins


def build(original, original_sha, prior_directory, launch_directory):
    source, block, pins = parse_original(original, original_sha)
    prior_directory = windows_path(str(Path(prior_directory).absolute()))
    launch_directory = windows_path(str(Path(launch_directory).absolute()))
    require(not Path(launch_directory).exists() and launch_directory != prior_directory, 'RESUME_OUTPUT_MUST_BE_NEW')
    literal_value = lambda name: pins[name][1:-1] if pins[name].startswith("'") else None
    output_path(launch_directory, literal_value('W'))
    require(literal_value('LaunchOutPin') == prior_directory, 'PRIOR_DIRECTORY_NOT_THE_ORIGINAL_LAUNCH')
    held, hashes, evidence = prior_evidence(prior_directory, pins)
    new_line = '$LaunchOutPin = ' + q(launch_directory) + '   # fresh continuation output, original evidence retained'
    new_block, count = re.subn(r'^\$LaunchOutPin = .*$', lambda _: new_line, block, flags=re.MULTILINE)
    require(count == 1 and source.count(OLD_STEPS) == 1 and source.count('#endregion generic') == 1,
            'ORIGINAL_CONTINUATION_BOUNDARY_CHANGED')
    extra_pins = finish_pins(original_sha, prior_directory, hashes, evidence['uninstallPlanSha256'])
    result = source.replace(block, new_block + extra_pins, 1)
    fragment = (HERE / 'finish-uninstall.ps1').read_text(encoding='utf-8')
    result = result.replace('#endregion generic', fragment + '\n#endregion generic', 1).replace(OLD_STEPS, NEW_STEPS, 1)
    return result.encode('utf-8'), evidence, hashes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--launcher', required=True)
    parser.add_argument('--launcher-sha', required=True)
    parser.add_argument('--prior-dir', required=True)
    parser.add_argument('--launch-dir', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    data, evidence, hashes = build(read_plain(args.launcher), args.launcher_sha, args.prior_dir, args.launch_dir)
    _, _, pins = parse_original(read_plain(args.launcher), args.launcher_sha)
    output = output_path(args.out, pins['W'][1:-1])
    command_path = output_path(str(output) + '.command.txt', pins['W'][1:-1])
    digest = hashlib.sha256(data).hexdigest()
    command = ("$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'; $b=[IO.File]::ReadAllBytes(" + q(str(output))
               + "); $h=-join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }); "
               + "if ($h -cne '" + digest + "') { throw 'CONTINUATION_CHANGED' }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -RunApprovedInstall\n")
    with output.open('xb') as handle:
        handle.write(data)
    with command_path.open('xb') as handle:
        handle.write(command.encode('utf-8'))
    print(json.dumps({'status': 'CONTINUATION_FOR_REVIEW_NOT_EXECUTED', 'launcher': str(output),
                      'sha256': digest, 'originalLauncherSha256': args.launcher_sha, 'priorFileSha256': hashes,
                      'elevatedCommand': str(command_path), 'elevatedCommandSha256': hashlib.sha256(command.encode('utf-8')).hexdigest(),
                      'evidence': evidence, 'launchDir': str(Path(args.launch_dir).absolute())}))


if __name__ == '__main__':
    main()
