"""Step W1 (Owner, NON-elevated, Windows): pause the INSTALLED resident before the Linux switch, with the configuration's w1PauseReason
(the launcher generator requires PAUSED.json to carry exactly that reason).
Same as the p2s2 pause_request.py (create-only, one write into the Owner's drop box requests\\), then read-only:
waits until state\\PAUSED.json names this request, status.json `current` is null AND no ledger entry is open (review M3:
a parked or hosted-wait batch keeps an open entry while `current` is null; the Linux switch must never happen then).
Never stops a service, never deletes anything. Prints PAUSED.json's sha256 for the final generator pin (review m6).
Exit 0 only on OLD_RESIDENT_PAUSED_NO_OPEN_BATCH; any other ending means: do NOT start Linux phase B.
  python -I pause-old-resident.py <config.json> [--wait-seconds N]      (default 5400 = the longest stage budget)"""
import hashlib, importlib.util, json, os, secrets, sys, time
spec = importlib.util.spec_from_file_location('rconfig', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rconfig.py'))
rconfig = importlib.util.module_from_spec(spec); spec.loader.exec_module(rconfig)
ROOT = r'C:\ProgramData\CluedIndependentCI\resident'
REASON = rconfig.load(sys.argv[1])['launcher']['w1PauseReason']
wait = int(sys.argv[sys.argv.index('--wait-seconds') + 1]) if '--wait-seconds' in sys.argv else 5400


def stop(code, **d):
    print(json.dumps({'status': code, **d}, default=str))
    sys.exit(2)


if os.path.exists(os.path.join(ROOT, 'state', 'HALT.json')):
    stop('HALT_PRESENT_GET_A_REVIEW_FIRST')
data = json.dumps({'contract': 'clued.independent-ci.resident-pause/1', 'reason': REASON}, separators=(',', ':')).encode('utf-8')
want = hashlib.sha256(data).hexdigest()
name = '%013d-%s.json' % (int(time.time() * 1000), secrets.token_hex(6))
with open(os.path.join(ROOT, 'requests', name), 'xb') as f:
    f.write(data)
print(json.dumps({'request': name, 'sha256': want, 'writtenAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}), flush=True)


def open_entries():
    led = os.path.join(ROOT, 'state', 'ledger')
    return sorted(e for e in os.listdir(led) if not os.path.exists(os.path.join(led, e, '90-terminal.json')))


deadline = time.time() + wait
state = None
while time.time() < deadline:
    try:
        pb = open(os.path.join(ROOT, 'state', 'PAUSED.json'), 'rb').read()
        p = json.loads(pb.decode('utf-8-sig'))
        s = json.load(open(os.path.join(ROOT, 'state', 'status.json'), encoding='utf-8-sig'))
        state = {'pausedRequestSha256': (p.get('source') or {}).get('requestSha256'), 'pausedSha256': hashlib.sha256(pb).hexdigest(),
                 'current': s.get('current'), 'executor': s.get('executor'), 'halt': s.get('halt'), 'openLedgerEntries': open_entries()}
        if s.get('halt') or os.path.exists(os.path.join(ROOT, 'state', 'HALT.json')):
            stop('OLD_RESIDENT_HALTED_GET_A_REVIEW', last=state)
        if state['pausedRequestSha256'] == want and not state['current'] and not state['openLedgerEntries']:
            print(json.dumps({'status': 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH', **state}, default=str))
            sys.exit(0)
    except (OSError, ValueError):
        pass
    time.sleep(10)
stop('PAUSE_NOT_CONFIRMED_OR_BATCH_STILL_OPEN_DO_NOT_START_LINUX', last=state)
