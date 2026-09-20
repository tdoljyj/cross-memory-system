#!/usr/bin/env python3
"""Two native qualification builds after exact repository landing.

Never runs the Owner binary, provisions a Guard/qualification parent, issues a
Profile, changes a Git ref or downloads a toolchain. All newly written logs,
receipts and compiler outputs stay in new direct children of the existing fixed
qualification root. Run only after the r3 source has been committed and reviewed
for this non-model qualification purpose. This driver is NOT a completed run.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
import ctypes
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

BASE = 'd09b6365f9d93941cd59c3c2ee89e0f6fc0ab2c4'
SOURCE_MANIFEST_SHA256 = '40eaa69913ade714d2e717a94a317d1b2ecce9b73b9ef0824b9aeeff345dc801'
SOURCE_REL = Path('scripts/model-program/m1-runtime-lifecycle-owner')
ALLOWED_CHANGED = {str(SOURCE_REL / n).replace('\\', '/') for n in (
    'owner.go', 'finalization.go', 'owner_test.go', 'remediation_test.go', 'source-manifest.json')}
REQUIRED = (
    'TestR4CaptureRequiresSignedClassBeforeFileOrLaunchEffect',
    'TestR4CaptureRequiresExactCodePairBeforeFileOrLaunchEffect',
    'TestR4ExpiredCaptureIsDrainedButNotPersisted',
    'TestR4FinalizationRevokesCaptureEvenWhenOwnedProcessCleanupFails',
    'TestR3ExpiredLowerEvidenceGateIsFailClosed',
    'TestR3FailureFinalizationRevokesNormalAndTerminalReuse',
    'TestR3SuccessFinalizationCannotStartSecondLifecycle',
    'TestR3ForensicsRecordsLiveIdentityDigestsAndCurrent',
    'TestR3ForensicsRejectsUnknownAndUnsafeStateWithoutDeleting',
    'TestR3EvidenceModeAndSignedCeiling',
    'TestR3NormalEvidenceCannotSpendForensicReserve',
    'TestR3ExpiryDuringEvidenceHandleValidationWritesNoBytes',
    'TestR3ExpiryCleanupKillsOnlyOwnedFixtureProcess',
    'TestR3TerminalStateLimitsEnvelopeReuseAndTime',
    'TestR3ForensicsDistinguishesObservedAndCachedCurrent',
    'TestWindowsRemediationRetainedGuardParentAndRelativeCreate',
    'TestWindowsRemediationImmutablePayloadHandleRejectsWriter',
    'TestWindowsRemediationNativeFailureLeavesOldAndTemp',
    'TestWindowsRemediationNativeReplacementPreservesOldReader',
    'TestWindowsRemediationNativeCrossDirectoryRenameRejected',
    'TestWindowsReparsePointDetection',
)

def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()

def computer_name() -> str:
    buf = ctypes.create_unicode_buffer(256)
    size = ctypes.c_uint32(len(buf))
    if not ctypes.windll.kernel32.GetComputerNameW(buf, ctypes.byref(size)):
        raise RuntimeError('OS_COMPUTER_NAME_UNAVAILABLE')
    return buf.value

def run_read(argv: list[str], cwd: Path) -> str:
    e = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    p = subprocess.run(argv, cwd=cwd, env=e, capture_output=True, text=True, timeout=60)
    if p.returncode:
        raise RuntimeError(f'read-only command failed: {argv!r}; exit={p.returncode}; {p.stderr}')
    return p.stdout.strip()

def observe(windows: str, candidate: dict) -> dict:
    ps = Path(windows) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    # Read-only, limited observations. Absence is measured, never inferred from
    # a successful build. These are time points, not continuous monitoring.
    command = r'''$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=@(Get-Process | Where-Object { $_.ProcessName -in @('llama-server','m1-08-owner') } | Select-Object Id,ProcessName); $l=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 18088 } | Select-Object LocalAddress,LocalPort,OwningProcess); [pscustomobject]@{processes=$p;listeners=$l} | ConvertTo-Json -Depth 5 -Compress'''
    p = subprocess.run([str(ps), '-NoProfile', '-NonInteractive', '-Command', command],
                       capture_output=True, timeout=30)
    if p.returncode:
        raise RuntimeError('HOST_OBSERVATION_UNAVAILABLE: ' + p.stderr.decode('utf-8', 'replace'))
    values = json.loads(p.stdout.decode('utf-8-sig'))
    ec = candidate['execution_control']
    paths = {'guard': ec['attempt_guard_path'], 'current': ec['current_manifest_path'],
             'evidence': ec['evidence_output_dir']}
    paths['runtime_root'] = str(Path(ec['current_manifest_path']).parent.parent)
    state = {}
    for name, path in paths.items():
        try:
            st = os.lstat(path)
            state[name] = {'path': path, 'exists': True, 'bytes': st.st_size,
                           'file_attributes': getattr(st, 'st_file_attributes', None)}
        except FileNotFoundError:
            state[name] = {'path': path, 'exists': False}
    return {'at_utc': utc(), 'computer_name': computer_name(), 'paths': state,
            **values, 'continuous_monitoring': False}

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repository', required=True, type=Path)
    ap.add_argument('--source-freeze-sha', required=True)
    ap.add_argument('--toolchain-archive', required=True, type=Path)
    args = ap.parse_args()
    if os.name != 'nt':
        raise SystemExit('WINDOWS_NATIVE_REQUIRED; no qualification was executed')
    if not re.fullmatch('[0-9a-f]{40}', args.source_freeze_sha) or args.source_freeze_sha == BASE:
        raise SystemExit('An exact NEW repository Source Freeze commit is required')
    if computer_name().upper() != 'DESK-W-591':
        raise SystemExit('EXACT_QUALIFICATION_DEVICE_REQUIRED: DESK-W-591')
    git = shutil.which('git')
    if not git:
        raise SystemExit('Git is required for read-only exact commit checks')
    repo = args.repository.resolve(strict=True)
    src = repo / SOURCE_REL
    gitread = lambda *a: run_read([git, '-C', str(repo), *a], repo)
    if gitread('rev-parse', 'HEAD') != args.source_freeze_sha:
        raise SystemExit('HEAD is not the requested exact Source Freeze')
    gitread('merge-base', '--is-ancestor', BASE, args.source_freeze_sha)
    if gitread('status', '--porcelain'):
        raise SystemExit('A clean isolated worktree is required; nothing was reset or deleted')
    changed = set(gitread('diff', '--name-only', BASE, args.source_freeze_sha).splitlines())
    if changed != ALLOWED_CHANGED:
        raise SystemExit('Changed-file scope differs from the five-file r3 remediation')
    if digest(src / 'source-manifest.json') != SOURCE_MANIFEST_SHA256:
        raise SystemExit('Source manifest does not match this local validated r3')
    manifest = json.loads((src / 'source-manifest.json').read_bytes())
    for row in manifest['files']:
        f = src / row['path']
        data = f.read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if (len(data), hashlib.sha256(data).hexdigest(), blob) != (row['bytes'], row['sha256'], row['git_blob_sha1']):
            raise SystemExit('Source identity mismatch: ' + row['path'])
    if {p.name for p in src.iterdir()} != {r['path'] for r in manifest['files']} | {'source-manifest.json'}:
        raise SystemExit('Unexpected source closure entry')
    sys.path.insert(0, str(src))
    spec = importlib.util.spec_from_file_location('clued_m108_exact_build', src / 'build.py')
    if spec is None or spec.loader is None:
        raise SystemExit('Exact build helper could not be loaded')
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    build.verify_source_manifest()
    build.verify_exact_file(build.CONTRACT, size=build.CONTRACT_BYTES, sha256=build.CONTRACT_SHA256, blob=build.CONTRACT_BLOB)
    build.verify_exact_file(build.CANDIDATE, size=build.CANDIDATE_BYTES, sha256=build.CANDIDATE_SHA256, blob=build.CANDIDATE_BLOB)
    build.validate_toolchain_archive(args.toolchain_archive)
    from qualification_scope import QualificationScope, QUALIFICATION_ROOT, require_go_test_report
    root = Path(QUALIFICATION_ROOT)
    label = 'm108-r4-capture-boundary-' + SOURCE_MANIFEST_SHA256[:12]
    outputs = [root / (label + '-a'), root / (label + '-b')]
    control = root / (label + '-control')
    if any(p.exists() for p in [control, *outputs]):
        raise SystemExit('A qualification output already exists; no evidence was overwritten')
    candidate = json.loads(build.CANDIDATE.read_bytes())
    result = {'status': 'NOT_COMPLETED', 'source_freeze_sha': args.source_freeze_sha,
              'source_manifest_sha256': SOURCE_MANIFEST_SHA256, 'repair_base_sha': BASE,
              'independent_review_pass': False, 'owner_binary_invoked_by_driver': False,
              'authority_effect': 'NONE / AUTHOR_SIDE_NON_MODEL_QUALIFICATION_ONLY'}
    with QualificationScope(control, repo) as scope:
        write = lambda name, value: (control / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        try:
            pre = observe(build.windows_directory(), candidate)
            write('PRE_QUALIFICATION.json', pre)
            if pre['processes'] or pre['listeners'] or any(v['exists'] for v in pre['paths'].values()):
                raise RuntimeError('Pre-observation is not an unused/quiescent M1-08 boundary; no process was terminated')
            runs = []
            for i, output in enumerate(outputs):
                argv = [sys.executable, '-B', str(src / 'build.py'), '--toolchain-archive', str(args.toolchain_archive), '--output', str(output)]
                start = utc()
                p = subprocess.run(argv, cwd=repo, capture_output=True, timeout=900)
                (control / f'build-{i+1}.stdout.log').write_bytes(p.stdout)
                (control / f'build-{i+1}.stderr.log').write_bytes(p.stderr)
                write(f'build-{i+1}.command.json', {'argv': argv, 'started_at_utc': start, 'finished_at_utc': utc(), 'exit_code': p.returncode})
                if p.returncode:
                    raise RuntimeError(f'Build {i+1} failed; retained all logs and partial qualification outputs')
                receipt = json.loads((output / 'build-receipt.json').read_bytes())
                report = require_go_test_report((output / 'go-test.log').read_text(encoding='utf-8'), REQUIRED)
                measured = {}
                for role in ('owner_binary', 'windows_test_binary'):
                    f = Path(receipt[role]['path'])
                    if f.parent != output:
                        raise RuntimeError('Build receipt binary path outside exact run output')
                    identity = {'bytes': f.stat().st_size, 'sha256': digest(f)}
                    if any(identity[k] != receipt[role][k] for k in identity):
                        raise RuntimeError('Measured binary differs from build receipt')
                    measured[role] = identity
                if receipt['native_source_manifest_sha256'] != SOURCE_MANIFEST_SHA256:
                    raise RuntimeError('Build/source binding drift')
                runs.append({'output': str(output), 'report': report, 'measured_artifacts': measured, 'toolchain': receipt['toolchain']})
            if runs[0]['measured_artifacts'] != runs[1]['measured_artifacts'] or runs[0]['toolchain'] != runs[1]['toolchain']:
                raise RuntimeError('Two clean native builds did not match')
            build.verify_source_manifest()
            if gitread('rev-parse', 'HEAD') != args.source_freeze_sha or gitread('status', '--porcelain'):
                raise RuntimeError('Repository changed during qualification')
            post = observe(build.windows_directory(), candidate)
            write('POST_QUALIFICATION.json', post)
            if post['processes'] or post['listeners'] or post['paths'] != pre['paths']:
                raise RuntimeError('Post-observation differs from unused/quiescent M1-08 boundary')
            result.update(status='WINDOWS_QUALIFICATION_PASS / AUTHOR_SIDE_ONLY', runs=runs,
                          qualification_namespace=scope.evidence(),
                          limitations=['PRE/POST are time-point observations, not continuous monitoring',
                                       'Inspect raw reparse logs: junction execution is not symlink-specific native execution',
                                       'No independent closure, Final Issuance, merge, model run or release authority'])
        except BaseException as error:
            result.update(status='WINDOWS_QUALIFICATION_NOT_PASSED', error=repr(error))
            try:
                write('POST_FAILURE_OBSERVATION.json', observe(build.windows_directory(), candidate))
            except BaseException as obs:
                result['post_failure_observation_error'] = repr(obs)
            write('QUALIFICATION_RESULT.json', result)
            raise
        write('QUALIFICATION_RESULT.json', result)
        inventory = []
        for directory in [control, *outputs]:
            for f in sorted(directory.rglob('*')):
                if f.is_file():
                    inventory.append({'path': str(f), 'bytes': f.stat().st_size, 'sha256': digest(f)})
        write('EVIDENCE_CONTENT_MANIFEST.json', {'entries': inventory, 'self_excluded': True})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
