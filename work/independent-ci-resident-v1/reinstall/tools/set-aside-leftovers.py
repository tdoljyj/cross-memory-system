"""Set aside what a FAILED earlier packaging attempt left behind, so the next attempt is not blocked by it (Task 09052ffe / gen 8 tooling).

Every output of build.ps1 / rollout\\build-upgrade.ps1 is create-only. When the first attempt dies half way (a refused final, a
failed rebuild, a closed window), its inputs, record and package directories stay and the next run stops at the first
CreateNew with an unrelated-looking "file exists". Nothing is ever deleted here: an incomplete attempt's files are RENAMED into
<workDir>\\failed-attempts\\<UTC stamp>\\<same relative path>, where they stay as evidence.

  python -I set-aside-leftovers.py <workDir> --pattern <glob> [--pattern ...] [--done <glob> ...] [--dry-run]

--pattern  what one attempt creates (relative to workDir, forward slashes, "*" and "?" inside a name only). Shared inputs that a
           later attempt reuses on purpose (tree-<c8>, the bare repository and the bundle) are simply not listed.
--done     what only a COMPLETED attempt has written. If any of these exist the attempt is complete: nothing is moved and the
           exit code is 3 (ATTEMPT_ALREADY_COMPLETE): a finished package may already be in the Owner's hands and is never set
           aside; use another -Tag for a new attempt.
Prints one JSON line: { moved: [{from, to}], count }. Exit 0 ok, 2 refused input, 3 attempt already complete.
"""
import datetime
import glob
import json
import os
import re
import sys

SEGMENT = re.compile(r'^[A-Za-z0-9._*?-]+$')


def refuse(code, **more):
    print(json.dumps({'code': code, **more}))
    sys.exit(2)


def clean_pattern(p):
    parts = p.replace('\\', '/').split('/')
    if not p or p.startswith('/') or ':' in p or any(s in ('', '.', '..') or not SEGMENT.match(s) for s in parts):
        refuse('PATTERN_REFUSED', pattern=p)
    return parts


def matches(work, patterns):
    found = []
    for p in patterns:
        parts = clean_pattern(p)
        for hit in sorted(glob.glob(os.path.join(work, *parts))):
            rel = os.path.relpath(hit, work).replace('\\', '/')
            if rel.split('/')[0] == 'failed-attempts':
                continue
            if rel not in found:
                found.append(rel)
    return found


def main(argv):
    work = None
    patterns, done, dry = [], [], False
    it = iter(argv)
    for a in it:
        if a == '--pattern':
            patterns.append(next(it, ''))
        elif a == '--done':
            done.append(next(it, ''))
        elif a == '--dry-run':
            dry = True
        elif work is None and not a.startswith('--'):
            work = a
        else:
            refuse('ARGUMENT_REFUSED', argument=a)
    if work is None or not os.path.isdir(work) or not patterns:
        refuse('WORK_DIR_OR_PATTERN_MISSING')
    work = os.path.abspath(work)
    complete = matches(work, done)
    if complete:
        print(json.dumps({'code': 'ATTEMPT_ALREADY_COMPLETE', 'done': complete, 'moved': [], 'count': 0}))
        return 3
    found = matches(work, patterns)
    moved = []
    if found and not dry:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        base = os.path.join(work, 'failed-attempts', stamp)
        for rel in found:
            src = os.path.join(work, *rel.split('/'))
            dst = os.path.join(base, *rel.split('/'))
            if os.path.lexists(dst):
                refuse('SET_ASIDE_TARGET_EXISTS', to=rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.rename(src, dst)   # a rename within the work directory: nothing is copied or deleted
            moved.append({'from': rel, 'to': os.path.relpath(dst, work).replace('\\', '/')})
    elif found:
        moved = [{'from': rel, 'to': None} for rel in found]
    print(json.dumps({'moved': moved, 'count': len(moved)}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
