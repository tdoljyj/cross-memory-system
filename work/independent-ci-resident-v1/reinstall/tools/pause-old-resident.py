"""Step W1: request an exact pause and prove no current or open ledger batch.

An existing foreign PAUSED record is not an acknowledgement of this request.
Refuse it immediately, with its byte digest for the existing reviewed Resume
door; never silently replace, lift or wait ninety minutes on that other pause.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import sys
import time

spec = importlib.util.spec_from_file_location('rconfig', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rconfig.py'))
config = importlib.util.module_from_spec(spec); spec.loader.exec_module(config)

ROOT = r'C:\ProgramData\CluedIndependentCI\resident'
PAUSE_CONTRACT = 'clued.independent-ci.resident-pause/1'
STATUS_CONTRACTS = {'clued.independent-ci.resident-status/' + str(n) for n in (5, 6, 7, 8)}
EXECUTOR_STATES = {'STARTING', 'IDLE', 'RUNNING', 'WAITING', 'PARKED', 'DEFERRED', 'HALTED', 'PAUSED',
                   'BACKFILL_PENDING', 'STOPPED', 'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED'}


class PauseRefused(ValueError):
    def __init__(self, code, **details):
        self.report = {'status': code, **details}
        super().__init__(code)


def _json_bytes(path, maximum=256 * 1024):
    with open(path, 'rb') as handle:
        raw = handle.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError('JSON_TOO_LARGE')
    value = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('JSON_OBJECT_REQUIRED')
    return raw, value


def _resume_advice(paused_sha):
    return ('Use the installed rearm-resident.ps1 -Request Resume -ExpectedPausedSha256 ' + paused_sha
            + ' after reviewing this existing pause; confirm it is resumed, then rerun W1. W1 never resumes it itself.')


def read_snapshot(root, want):
    state_dir = os.path.join(root, 'state')
    if os.path.exists(os.path.join(state_dir, 'HALT.json')):
        raise PauseRefused('OLD_RESIDENT_HALTED_GET_A_REVIEW')
    paused_path = os.path.join(state_dir, 'PAUSED.json')
    paused_sha = paused_request = None
    if os.path.exists(paused_path):
        try:
            raw, paused = _json_bytes(paused_path, 16384)
            paused_sha = hashlib.sha256(raw).hexdigest()
            source = paused.get('source')
            if not isinstance(source, dict) or not isinstance(source.get('reason'), str) or not re.fullmatch(r'[0-9a-f]{64}', source.get('requestSha256', '')):
                raise ValueError('PAUSE_SOURCE_INVALID')
            paused_request = source['requestSha256']
            if paused_request == want:
                original = json.dumps({'contract': PAUSE_CONTRACT, 'reason': source['reason']}, separators=(',', ':')).encode('utf-8')
                if hashlib.sha256(original).hexdigest() != want:
                    raise ValueError('PAUSE_SOURCE_REASON_HASH_MISMATCH')
        except (OSError, UnicodeError, ValueError, TypeError) as error:
            raise PauseRefused('OLD_RESIDENT_PAUSE_STATE_UNREADABLE_RESUME_REQUIRED', detail=str(error)) from error
        if paused_request != want:
            raise PauseRefused('OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED', pausedRequestSha256=paused_request,
                               pausedSha256=paused_sha, advice=_resume_advice(paused_sha))
    try:
        status = json.loads(config.read_status_bytes(os.path.join(state_dir, 'status.json')).decode('utf-8-sig'))
        if not isinstance(status, dict):
            raise ValueError('STATUS_OBJECT_REQUIRED')
        executor = status.get('executor')
        if (status.get('contract') not in STATUS_CONTRACTS or not isinstance(executor, dict)
                or executor.get('state') not in EXECUTOR_STATES or type(status.get('paused')) is not bool
                or 'halt' not in status or 'current' not in status
                or status['current'] is not None and (not isinstance(status['current'], dict) or not status['current'])):
            raise ValueError('STATUS_SHAPE_OR_EXECUTOR_UNKNOWN')
        led = os.path.join(state_dir, 'ledger')
        open_ledger = sorted(name for name in os.listdir(led)
                             if not os.path.isfile(os.path.join(led, name, '90-terminal.json')))
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        raise PauseRefused('OLD_RESIDENT_STATE_UNREADABLE_DO_NOT_START_LINUX', detail=str(error)) from error
    snapshot = {'pausedRequestSha256': paused_request, 'pausedSha256': paused_sha, 'current': status['current'],
                'executor': executor, 'halt': status['halt'], 'openLedgerEntries': open_ledger}
    if status['halt'] is not None or executor['state'] == 'HALTED' or os.path.exists(os.path.join(state_dir, 'HALT.json')):
        raise PauseRefused('OLD_RESIDENT_HALTED_GET_A_REVIEW', last=snapshot)
    if paused_request is None and (status['paused'] or executor['state'] == 'PAUSED'):
        raise PauseRefused('OLD_RESIDENT_PAUSE_RECORD_MISSING_DO_NOT_START_LINUX', last=snapshot)
    snapshot['confirmed'] = (paused_request == want and executor['state'] == 'PAUSED' and status['paused']
                             and status['current'] is None and not open_ledger)
    return snapshot


def run_pause(reason, *, root=ROOT, wait_seconds=5400, clock=time.monotonic, wall_clock=time.time,
              sleep=time.sleep, token=secrets.token_hex, emit=None):
    if not isinstance(reason, str) or not reason or len(reason) > 200 or type(wait_seconds) is not int or not 0 <= wait_seconds <= 5400:
        raise PauseRefused('PAUSE_ARGUMENTS_INVALID')
    data = json.dumps({'contract': PAUSE_CONTRACT, 'reason': reason}, separators=(',', ':')).encode('utf-8')
    want = hashlib.sha256(data).hexdigest()
    state = read_snapshot(root, want)
    if state['confirmed']:
        return {'status': 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH', **state, 'reusedExistingRequest': True}
    reused_existing_request = state['pausedRequestSha256'] is not None
    if state['pausedRequestSha256'] is None:
        name = '%013d-%s.json' % (int(wall_clock() * 1000), token(6))
        with open(os.path.join(root, 'requests', name), 'xb') as handle:
            handle.write(data)
        if emit:
            emit({'request': name, 'sha256': want, 'writtenAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(wall_clock()))})
    deadline = clock() + wait_seconds
    while True:
        # Includes the race where another pause is accepted after our drop.
        state = read_snapshot(root, want)
        if state['confirmed']:
            return {'status': 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH', **state, 'reusedExistingRequest': reused_existing_request}
        remaining = deadline - clock()
        if remaining <= 0:
            raise PauseRefused('PAUSE_NOT_CONFIRMED_OR_BATCH_STILL_OPEN_DO_NOT_START_LINUX', last=state)
        sleep(min(10, remaining))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    parser.add_argument('--wait-seconds', type=int, default=5400)
    args = parser.parse_args(argv)
    try:
        result = run_pause(config.load(args.config)['launcher']['w1PauseReason'], wait_seconds=args.wait_seconds,
                           emit=lambda value: print(json.dumps(value), flush=True))
        print(json.dumps(result, default=str))
        return 0
    except PauseRefused as error:
        print(json.dumps(error.report, default=str))
        return 2


if __name__ == '__main__':
    sys.exit(main())
