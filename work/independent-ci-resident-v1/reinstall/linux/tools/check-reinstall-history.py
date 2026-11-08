"""Root-side read-only checks of the history an accepted uninstaller moves intact.

No historical file contents are scanned: lstat identities/modes/sizes/mtime bind
the complete tree before/after its same-filesystem move. Public current-generation
JSON and Windows operation status are the only file contents read. No mutation
except create-only capture of the public metadata snapshot named by phase A.
"""
import contextlib
import datetime
import hashlib
import json
import os
import re
import stat
import sys

OPT = '/opt/clued-independent-ci'
STATE = '/var/lib/clued-independent-ci/resident'
WINDOWS = '/mnt/c/ProgramData/CluedIndependentCI/resident/upgrade'
GROUPS = {'upgrade-v1': (OPT + '/upgrade-v1', 'upgrade-v1'),
          'generations': (OPT + '/generations', 'generations'),
          'archive': (OPT + '/archive', 'opt-archive'),
          'upgrade-state': (STATE + '/upgrade', 'upgrade-state'),
          'install-plan': (STATE + '/install-plan.json', 'install-plan.json'),
          'upgrade-plan': (STATE + '/upgrade-v1-install-plan.json', 'upgrade-v1-install-plan.json')}


def need(value, reason):
    if not value:
        raise ValueError(reason)


# The snapshot of the kept history is the one large file: DESK (2026-11-08, 29 upgraded generations, g1-g26 archived) has about
# 300 000 history entries, so the snapshot is tens of MB. Every other JSON read here stays bounded at 4 MB.
MAX_ENTRIES = 1000000
MAX_SNAPSHOT_BYTES = 256 << 20


def read_json(path, limit=4 << 20):
    st = os.lstat(path)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and 0 < st.st_size <= limit, 'HISTORY_JSON_NOT_REGULAR')
    with open(path, encoding='utf-8-sig') as f:
        return json.load(f)


def tree(path):
    if not os.path.lexists(path):
        return None
    result = {}

    def visit(p, rel):
        s = os.lstat(p)
        need(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode), 'HISTORY_LINK_OR_SPECIAL_FILE')
        need(len(result) < MAX_ENTRIES, 'HISTORY_TREE_TOO_LARGE')
        result[rel] = [s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns]
        if stat.S_ISDIR(s.st_mode):
            for n in sorted(os.listdir(p)):
                visit(os.path.join(p, n), rel + '/' + n if rel else n)
    visit(path, '')
    return result


def parse_plan(text):
    lines = text.strip().splitlines()
    need(bool(lines), 'UNINSTALL_PLAN_EMPTY')
    last = json.loads(lines.pop())
    need(last.get('status') == 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', 'UNINSTALL_PLAN_REFUSED')
    need(last.get('planSha256') == hashlib.sha256('\n'.join(lines).encode()).hexdigest(), 'UNINSTALL_PLAN_HASH_MISMATCH')
    fields = {}
    for line in lines:
        k, sep, v = line.partition('=')
        need(sep and k not in fields, 'UNINSTALL_PLAN_FIELD_INVALID')
        fields[k] = v
    need(set(fields) == {'active', 'opt', 'units', 'saved-wsl-conf', 'upgrade-v1', 'generations', 'archive', 'staging', 'upgrade-state', 'saved-plans'}, 'UNINSTALL_PLAN_FIELDS_CHANGED')
    need(fields['active'] == '' and fields['opt'] == 'yes' and fields['upgrade-v1'] == 'yes', 'UNINSTALL_PLAN_HOST_NOT_QUIET')
    need(fields['staging'] == '', 'UPGRADE_STAGING_PRESENT')
    need(fields['archive'] in ('', 'yes'), 'HISTORY_ARCHIVE_SHAPE')
    gens = fields['generations'].split()
    need(len(gens) == len(set(gens)) and all(re.fullmatch(r'g[1-9][0-9]{0,8}', n) for n in gens), 'HISTORY_GENERATIONS_SHAPE')
    names = fields['upgrade-state'].split()
    need(len(names) == len(set(names)) and 'current.json' in names and
         all(n in ('current.json', 'given-up') or re.fullmatch(r'g[1-9][0-9]{0,8}\.json', n) for n in names), 'HISTORY_STATE_SHAPE')
    return fields


def windows_idle(windows, facts):
    ws = read_json(os.path.join(windows, 'status.json'))
    need(ws.get('contract') == 'clued.independent-ci.resident-upgrade-status/1' and 'op' in ws and ws['op'] is None, 'WINDOWS_UPGRADE_OPERATION_PRESENT_OR_UNKNOWN')
    written = datetime.datetime.fromisoformat(str(ws.get('writtenAt', '')).replace('Z', '+00:00'))
    need(written.tzinfo is not None and abs((datetime.datetime.now(datetime.timezone.utc) - written).total_seconds()) <= 300, 'WINDOWS_UPGRADE_STATUS_STALE')
    wc = read_json(os.path.join(windows, 'current.json'))
    need(wc.get('contract') == 'clued.independent-ci.resident-generation/1' and
         isinstance(wc.get('linux'), dict) and type(wc['linux'].get('generation')) is int and
         wc.get('linux') == {'generation': facts['generation'], 'manifestSha256': facts['manifestSha256'],
                            'ciSourceManifestSha256': facts['ciSourceManifestSha256']}, 'HISTORY_WINDOWS_GENERATION_MISMATCH')


@contextlib.contextmanager
def idle_tool_lock(state):
    """The installed tool retains this hidden file; never create or unlink it."""
    path = os.path.join(state, '.tool.lock')
    if not os.path.lexists(path):
        yield
        return
    before = os.lstat(path)
    need(stat.S_ISREG(before.st_mode), 'HISTORY_TOOL_LOCK_NOT_REGULAR')
    try:
        import fcntl
    except ImportError:
        raise ValueError('HISTORY_TOOL_LOCK_PROBE_UNAVAILABLE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'HISTORY_TOOL_LOCK_CHANGED')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError('HISTORY_UPGRADE_TOOL_BUSY')
        yield
    finally:
        os.close(fd)


def capture(plan_text, facts, groups=GROUPS, windows=WINDOWS):
    with idle_tool_lock(groups['upgrade-state'][0]):
        return capture_locked(plan_text, facts, groups, windows)


def capture_locked(plan_text, facts, groups, windows):
    fields = parse_plan(plan_text)
    need(facts.get('contract') == 'clued.independent-ci.linux-version-facts/1' and
         type(facts.get('generation')) is int and facts['generation'] > 0 and
         'staged' in facts and facts['staged'] is None and facts.get('pinsOk') is True, 'HISTORY_FACTS_NOT_SETTLED')
    state = groups['upgrade-state'][0]
    cur = read_json(os.path.join(state, 'current.json'))
    need(cur.get('contract') == 'clued.independent-ci.linux-upgrade-current/1' and type(cur.get('generation')) is int and
         cur.get('generation') == facts['generation'] and
         cur.get('sourceCommit') == facts['sourceCommit'] and
         cur.get('ciSourceManifestSha256') == facts['ciSourceManifestSha256'] and
         cur.get('linuxManifestSha256') == facts['manifestSha256'], 'HISTORY_CURRENT_NOT_THE_FACTS')
    generation = read_json(os.path.join(state, 'g%d.json' % facts['generation']))
    need(generation.get('contract') == 'clued.independent-ci.linux-upgrade-generation/1' and type(generation.get('generation')) is int and
         generation.get('generation') == cur['generation'] and
         all(generation.get(k) == cur.get(k) for k in ('sourceCommit', 'ciSourceManifestSha256', 'linuxManifestSha256', 'packageManifestSha256')), 'HISTORY_CURRENT_RECORD_MISMATCH')
    # A retained current.opId is historical, not proof of an ongoing operation.
    # The live Windows upgrader status plus the empty Linux .next/staged gates
    # distinguish it from a transaction which is still in progress.
    windows_idle(windows, facts)
    for key, field in (('generations', 'generations'), ('upgrade-state', 'upgrade-state')):
        p = groups[key][0]
        names = sorted(os.listdir(p)) if os.path.isdir(p) else []
        # uninstall --plan uses ls -1 (no hidden entries). Only the protocol's
        # retained lock is expected; its identity remains in the full snapshot.
        if key == 'upgrade-state' and '.tool.lock' in names:
            names.remove('.tool.lock')
        need(names == sorted(fields[field].split()), 'HISTORY_PLAN_NOT_LIVE')
    need(bool(os.path.lexists(groups['archive'][0])) == (fields['archive'] == 'yes'), 'HISTORY_ARCHIVE_NOT_LIVE')
    return {'contract': 'clued.independent-ci.reinstall-history/1', 'generation': facts['generation'], 'facts': facts,
            'groups': {key: {'source': src, 'kept': kept, 'entries': tree(src)} for key, (src, kept) in groups.items()}}


def verify(snapshot, kept=None, windows=WINDOWS):
    need(snapshot.get('contract') == 'clued.independent-ci.reinstall-history/1', 'HISTORY_SNAPSHOT_CONTRACT')
    group = snapshot['groups']['upgrade-state']
    state = os.path.join(kept, group['kept']) if kept else group['source']
    with idle_tool_lock(state):
        verify_locked(snapshot, kept, windows)


def verify_locked(snapshot, kept, windows):
    if kept is None:
        windows_idle(windows, snapshot['facts'])
    for value in snapshot['groups'].values():
        path = os.path.join(kept, value['kept']) if kept else value['source']
        need(tree(path) == value['entries'], 'KEPT_HISTORY_CHANGED_OR_INCOMPLETE' if kept else 'HISTORY_CHANGED_SINCE_PHASE_A')


def main(argv):
    need(len(argv) in (2, 3, 4), 'HISTORY_USAGE')
    if argv[0] == 'capture' and len(argv) == 4:
        result = capture(open(argv[1], encoding='utf-8').read(), read_json(argv[2]))
        data = json.dumps(result, sort_keys=True, separators=(',', ':')) + '\n'
        need(len(data.encode('utf-8')) <= MAX_SNAPSHOT_BYTES, 'HISTORY_SNAPSHOT_TOO_LARGE')
        with open(argv[3], 'x', encoding='utf-8', newline='\n') as f:
            f.write(data)
    elif argv[0] in ('verify-live', 'verify-kept'):
        kept = argv[2] if len(argv) == 3 else None
        need((argv[0] == 'verify-live' and kept is None) or
             (argv[0] == 'verify-kept' and kept is not None and re.fullmatch(r'/var/lib/clued-independent-ci/resident-uninstalled-[0-9TZ]+', kept)), 'HISTORY_KEPT_PATH')
        verify(read_json(argv[1], MAX_SNAPSHOT_BYTES), kept)
    else:
        raise ValueError('HISTORY_USAGE')
    print(json.dumps({'status': 'REINSTALL_HISTORY_VERIFIED', 'mode': argv[0],
                      'historyPayloadContentsRead': False, 'publicGenerationMetadataRead': True}))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        print(json.dumps({'status': 'REFUSED', 'code': str(error) if isinstance(error, ValueError) else 'HISTORY_UNREADABLE'}))
        sys.exit(1)
