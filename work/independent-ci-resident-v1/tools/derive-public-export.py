"""Derive the next generation's public six-role export from the reviewed previous one.

The formal form of the one-off C:\\w\\tmp\\activation\\make_export236/237/238.py generators.
Only pins change: package/source/commit/linux manifest, the six role hashes from the current version
facts, paths and labels, the generation number, the lease deadline, and the hash chain
python -> BODY -> START (and its UTF-16 base64 -EncodedCommand loader). Nothing else in the reviewed code
changes. Read-only on the facts and on the old export; writes only the new export directory and creates
the (empty) public-six output directory, both create-only.

  python -I tools/derive-public-export.py --old-dir <public-export237> --new-dir <public-export238>
      --old-label 237 --new-label 238 --facts <version-facts.json> --current <upgrade/current.json>
      --deadline-new 2026-11-04T20:00:00Z [--deadline-old ISO] [--public-six-dir DIR] [--dry-run]

Defects of the one-off scripts this tool closes (each has a test in test/test_derive_public_export.py):
  * the DEADLINE=datetime.datetime(...) literal is found by pattern, must be exactly one in the python file and
    must parse to the OLD deadline; no form of the old deadline may be left in any of the four texts;
  * a pin that did not change (old == new) is not an "old pin left"; two old values that are equal must map to
    the same new value (AMBIGUOUS_PIN);
  * everything is built in <new-dir>.partial-<pid> and renamed at the end, so a refusal half-way leaves nothing
    that blocks the next run; an existing target is refused and never touched (EXPORT_DIR_EXISTS);
  * the new deadline is UTC 'Z', later than the facts' observedAt and different from the old one.

Refusals exit 2 with `REFUSED <CODE>[: detail]` on stderr; nothing here reads C:\\ProgramData unless the default
--facts/--current are used.
"""
import argparse, base64, datetime as dt, hashlib, json, os, re, shutil, sys
from pathlib import Path

DEFAULT_FACTS = r'C:\ProgramData\CluedIndependentCI\resident\upgrade\mailbox\responses\version-facts.json'
DEFAULT_CURRENT = r'C:\ProgramData\CluedIndependentCI\resident\upgrade\current.json'
DEADLINE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
LITERAL_RE = re.compile(r'DEADLINE=datetime\.datetime\((\d+),(\d+),(\d+),(\d+),(\d+)(?:,(\d+))?,tzinfo=datetime\.timezone\.utc\)')
LOADER_RE = re.compile(r"'-EncodedCommand','([A-Za-z0-9+/=]+)'")
LABEL_RE = re.compile(r'^[0-9]{1,6}$')
HEX = re.compile(r'^[0-9a-f]{40}([0-9a-f]{24})?$')


class Refuse(Exception):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def sha(b):
    return hashlib.sha256(b).hexdigest()


def parse_iso(s, code):
    try:
        d = dt.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        raise Refuse(code, str(s))
    if d.tzinfo is None:
        raise Refuse(code, str(s))
    return d.astimezone(dt.timezone.utc)


def literal(d):
    sec = f',{d.second}' if d.second else ''
    return f'DEADLINE=datetime.datetime({d.year},{d.month},{d.day},{d.hour},{d.minute}{sec},tzinfo=datetime.timezone.utc)'


def read_json(path, code):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        raise Refuse(code, str(path))


def read_bytes(path):
    try:
        return Path(path).read_bytes()
    except OSError:
        raise Refuse('OLD_EXPORT_FILE_MISSING', str(path))


def loose_old_deadline(d):
    """Any spacing of the old deadline's date and time as call arguments (year, month, day, hour, minute)."""
    return re.compile(r'(?<![0-9])%d\s*,\s*%d\s*,\s*%d\s*,\s*%d\s*,\s*%d(?![0-9])' % (d.year, d.month, d.day, d.hour, d.minute))


def derive(a):
    ol, nl = a.old_label, a.new_label
    if not LABEL_RE.match(ol) or not LABEL_RE.match(nl) or ol == nl:
        raise Refuse('LABELS_INVALID')
    old_dir, new_dir = Path(a.old_dir), Path(a.new_dir)
    six_dir = Path(a.public_six_dir) if a.public_six_dir else new_dir.parent / ('public-six' + nl)
    if not old_dir.is_dir():
        raise Refuse('OLD_EXPORT_MISSING', str(old_dir))
    for p in (new_dir, six_dir):
        if os.path.lexists(p):
            raise Refuse('EXPORT_DIR_EXISTS', str(p))
    if not new_dir.parent.is_dir() or not six_dir.parent.is_dir():
        raise Refuse('PARENT_MISSING')

    facts = read_json(a.facts, 'FACTS_UNREADABLE')
    current = read_json(a.current, 'CURRENT_UNREADABLE')
    old = read_json(old_dir / f'expected-public{ol}.json', 'OLD_EXPECTED_UNREADABLE')
    try:
        gen_new, gen_old = facts['generation'], old['generation']
        if not (isinstance(gen_new, int) and isinstance(gen_old, int)) or isinstance(gen_new, bool):
            raise Refuse('FACTS_SHAPE', 'generation')
        if gen_new != current['generation']:
            raise Refuse('GENERATION_MISMATCH', f'facts {gen_new} current {current["generation"]}')
        if gen_new <= gen_old:
            raise Refuse('GENERATION_NOT_NEWER', f'{gen_old} -> {gen_new}')
        if facts['staged'] is not None:
            raise Refuse('FACTS_STAGED')
        if facts['pinsOk'] is not True:
            raise Refuse('FACTS_PINS_NOT_OK')
        if current['ciSourceManifestSha256'] != facts['ciSourceManifestSha256']:
            raise Refuse('CURRENT_SOURCE_NOT_FACTS_SOURCE')
        new_files = {f'{r}.json' if k == 'policySha256' else f'{r}.qualification.json': v
                     for r, d in facts['roles'].items() for k, v in d.items()}
        if set(new_files) != set(old['files']):
            raise Refuse('ROLE_FILES_CHANGED')
        observed = parse_iso(facts['observedAt'], 'FACTS_OBSERVED_AT_INVALID')
        pin_pairs = [(old['package'], current['packageManifestSha256']), (old['source'], facts['ciSourceManifestSha256']),
                     (old['sourceCommit'], facts['sourceCommit']), (old['linuxManifest'], facts['manifestSha256'])] + \
                    [(old['files'][k], new_files[k]) for k in old['files']]
        deadline_old_s = a.deadline_old or old['deadline']
    except (KeyError, TypeError, AttributeError):
        raise Refuse('INPUT_SHAPE')
    for o, n in pin_pairs:
        if not (isinstance(o, str) and isinstance(n, str) and HEX.match(o) and HEX.match(n)):
            raise Refuse('PIN_SHAPE')
    pins = {}
    for o, n in pin_pairs:
        if pins.setdefault(o, n) != n:
            raise Refuse('AMBIGUOUS_PIN', o[:12])

    for s in (deadline_old_s, a.deadline_new):
        if not isinstance(s, str) or not DEADLINE_RE.match(s):
            raise Refuse('DEADLINE_FORMAT', str(s))
    d_old, d_new = parse_iso(deadline_old_s, 'DEADLINE_FORMAT'), parse_iso(a.deadline_new, 'DEADLINE_FORMAT')
    if d_new == d_old:
        raise Refuse('DEADLINE_UNCHANGED')
    if d_new <= observed:
        raise Refuse('DEADLINE_NOT_AFTER_FACTS')
    old_lit, new_lit, loose = literal(d_old), literal(d_new), loose_old_deadline(d_old)

    names = {'py': f'copy-desk-six-public{ol}.py', 'body': f'DESK_PUBLIC_SIX{ol}_BODY.ps1', 'start': f'DESK_PUBLIC_SIX{ol}_START.ps1'}
    old_py, old_body, old_start = (read_bytes(old_dir / names[k]) for k in ('py', 'body', 'start'))
    try:
        old_py_t, old_body_t, old_start_t = old_py.decode('utf8'), old_body.decode('utf8'), old_start.decode('utf8')
    except UnicodeDecodeError:
        raise Refuse('OLD_EXPORT_NOT_UTF8')
    label_ok = re.compile(r'(SIX|six|export|inputs|PUBLIC|public|Need|Lease|Digest)' + ol)

    def hold(text, extra):
        """Swap every old pin (and chained hash) for a placeholder; return text and the fill map."""
        table = dict(pins)
        for o, n in extra.items():
            if table.setdefault(o, n) != n:
                raise Refuse('AMBIGUOUS_PIN', o[:12])
        fill = {}
        for i, (o, n) in enumerate(table.items()):
            if o in text:
                tok = f'@@PIN{i}@@'
                text = text.replace(o, tok)
                fill[tok] = n
        return text, fill

    def relabel(text, name):
        for m in re.finditer(ol, text):
            if not label_ok.search(text[max(0, m.start() - 16):m.end()]):
                raise Refuse('UNEXPECTED_LABEL_CONTEXT', f'{name}: {text[max(0, m.start() - 16):m.end() + 8]!r}')
        return text.replace(ol, nl)

    def finish(text, fill):
        for tok, n in fill.items():
            text = text.replace(tok, n)
        if '@@PIN' in text:
            raise Refuse('PLACEHOLDER_LEFT')
        return text

    def swap_deadline(text, name, require_literal):
        """The literal form by pattern (each must be the OLD deadline), then the ISO form."""
        found = LITERAL_RE.findall(text)
        if require_literal and len(found) != 1:
            raise Refuse('DEADLINE_LITERAL_COUNT', f'{name}: {len(found)}')
        for g in found:
            try:
                have = dt.datetime(int(g[0]), int(g[1]), int(g[2]), int(g[3]), int(g[4]), int(g[5] or 0), tzinfo=dt.timezone.utc)
            except ValueError:
                raise Refuse('DEADLINE_LITERAL_NOT_OLD', name)
            if have != d_old:
                raise Refuse('DEADLINE_LITERAL_NOT_OLD', f'{name}: {have.isoformat()}')
        text = LITERAL_RE.sub(lambda m: new_lit, text)
        return text.replace(deadline_old_s, a.deadline_new)

    def gen_swap(text, pattern, label, minimum):
        n = len(re.findall(pattern, text))
        if n < minimum:
            raise Refuse('GENERATION_MARKER_COUNT', f'{label}: {n} < {minimum}')
        return re.sub(pattern, lambda m: m.group(1) + str(gen_new), text)

    stage = Path(str(new_dir) + f'.partial-{os.getpid()}')
    made_six = False
    summary = None
    try:
        if not a.dry_run:
            try:
                stage.mkdir(exist_ok=False)
            except OSError:
                raise Refuse('STAGING_UNAVAILABLE', str(stage))

        def emit(name, data):
            if not a.dry_run:
                (stage / name).write_bytes(data)

        # 1) python
        py, f1 = hold(old_py_t, {})
        py = gen_swap(py, r'(EXPECTED_GENERATION=)%d\b' % gen_old, 'py EXPECTED_GENERATION', 1)
        if len(re.findall(r'EXPECTED_GENERATION=', py)) != 1:
            raise Refuse('GENERATION_MARKER_COUNT', 'py: not exactly one EXPECTED_GENERATION')
        py = swap_deadline(py, 'py', True)
        py = finish(relabel(py, 'py'), f1)
        pyb = py.encode('utf8')
        emit(names['py'].replace(ol, nl), pyb)
        # 2) body
        body, f2 = hold(old_body_t, {sha(old_py): sha(pyb)})
        body = gen_swap(body, r'(generation-eq )%d\b' % gen_old, 'body generation-eq', 3)
        if deadline_old_s not in body:
            raise Refuse('DEADLINE_NOT_IN_BODY')
        body = swap_deadline(body, 'body', False)
        body = finish(relabel(body, 'body'), f2)
        bodyb = body.encode('utf8')
        emit(names['body'].replace(ol, nl), bodyb)
        # 3) start and its encoded elevated loader
        m = LOADER_RE.search(old_start_t)
        if not m:
            raise Refuse('START_LOADER_NOT_FOUND')
        try:
            loader_old = base64.b64decode(m.group(1), validate=True).decode('utf-16-le')
        except (ValueError, UnicodeDecodeError):
            raise Refuse('START_LOADER_UNREADABLE')
        chain = {sha(old_body): sha(bodyb)}
        loader, f3 = hold(loader_old, chain)
        loader = finish(relabel(swap_deadline(loader, 'loader', False), 'loader'), f3)
        start = old_start_t.replace(m.group(1), '@@LOADER@@')
        start, f4 = hold(start, chain)
        if start.count(deadline_old_s) != 1:
            raise Refuse('DEADLINE_COUNT_IN_START', str(start.count(deadline_old_s)))
        start = swap_deadline(start, 'start', False)
        start = finish(relabel(start, 'start'), f4).replace('@@LOADER@@', base64.b64encode(loader.encode('utf-16-le')).decode('ascii'))
        startb = start.encode('utf8')
        emit(names['start'].replace(ol, nl), startb)
        # residue: no form of the old deadline, no changed pin still in its old form
        for name, txt in (('py', py), ('body', body), ('loader', loader), ('start', start)):
            if deadline_old_s in txt or old_lit in txt or loose.search(txt):
                raise Refuse('OLD_DEADLINE_LEFT', name)
            for o, n in pins.items():
                if o != n and o in txt:
                    raise Refuse('OLD_PIN_LEFT', f'{name} {o[:12]}')
        expected = {'package': current['packageManifestSha256'], 'source': facts['ciSourceManifestSha256'], 'generation': gen_new,
                    'linuxManifest': facts['manifestSha256'], 'sourceCommit': facts['sourceCommit'], 'deadline': a.deadline_new,
                    'factsObservedAt': facts['observedAt'], 'files': new_files, 'derivedFrom': f'public-export{ol}',
                    'pythonSha256': sha(pyb), 'bodySha256': sha(bodyb)}
        emit(f'expected-public{nl}.json', (json.dumps(expected, indent=2) + '\n').encode('utf8'))
        summary = {'python': sha(pyb), 'body': sha(bodyb), 'start': sha(startb), 'loader_has_body_hash': sha(bodyb) in loader,
                   'start_has_body_hash': sha(bodyb) in start, 'newDir': str(new_dir), 'publicSixDir': str(six_dir), 'dryRun': bool(a.dry_run)}
        if not a.dry_run:
            try:
                six_dir.mkdir(exist_ok=False)
                made_six = True
            except OSError:
                raise Refuse('EXPORT_DIR_EXISTS', str(six_dir))
            try:
                os.rename(stage, new_dir)
            except OSError:
                raise Refuse('EXPORT_DIR_EXISTS', str(new_dir))
    except BaseException:
        if made_six:
            try:
                six_dir.rmdir()
            except OSError:
                pass
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
    return summary


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--old-dir', required=True)
    p.add_argument('--new-dir', required=True)
    p.add_argument('--old-label', required=True)
    p.add_argument('--new-label', required=True)
    p.add_argument('--facts', default=DEFAULT_FACTS)
    p.add_argument('--current', default=DEFAULT_CURRENT)
    p.add_argument('--deadline-new', required=True)
    p.add_argument('--deadline-old', default=None)
    p.add_argument('--public-six-dir', default=None)
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args(argv)
    try:
        out = derive(a)
    except Refuse as e:
        sys.stderr.write('REFUSED ' + e.code + (': ' + e.detail if e.detail else '') + '\n')
        return 2
    print(json.dumps(out, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
