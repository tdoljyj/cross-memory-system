"""Emit the repair as an in-database edit whose result is digest-asserted.

The full apply-once kit restates both corrected functions in full, which is 77 KB
of text that has to travel through whatever channel applies it -- wasteful, and
every byte is a transcription risk. This variant sends only the contiguous edits.
The database reads its own installed definition, applies them, and refuses unless
the result hashes to exactly the reviewed artifact, so a mistyped or truncated
fragment aborts the transaction instead of installing unreviewed text.

The transaction's pre and post guards come from the apply-once kit, with the one
substitution described in compact(): the activation event is pinned by whole-row
digest rather than field by field. Every other precondition and postimage check
is identical between the two forms.

  python3 build-root10-runtime-clock-repair-delta.py [outdir]
"""
import difflib
import hashlib
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]
RELATIVE = HERE.relative_to(REPO).as_posix()
SUBS = {
    '__AMEND_SHA256__': 'e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402',
    '__AMEND_BLOB_SHA1__': '492b2cc6a13554cf8760195c620bc7ea8b7f05f3',
    '__NEW_CONTROLLER_SHA256__': '5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6',
    '__NEW_QUALIFICATION_SHA256__': '6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849',
    '__NEW_ACCEPTANCE_SHA256__': '321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e',
}
# The activated event 119 row, measured live from the control store on
# 2026-09-15 after the activation committed. Any rewrite of that row -- which
# must never happen -- refuses this repair.
EVENT119_ROW_SHA256 = 'bc916928189aa7fff6bc1366520ae4bc424f386a106dc6aa5fecba6a734ae6fe'
TARGETS = [
    ('execution_transition.runtime-clock.sql', 'clued_control.execution_transition(jsonb)'),
    ('commit_gate_result.runtime-clock.sql', 'clued_control.commit_gate_result(text,text,text)'),
]


def substitute(text):
    for token, value in SUBS.items():
        if token not in text:
            raise ValueError('missing placeholder ' + token)
        text = text.replace(token, value)
    if re.search(r'__[A-Z][A-Z0-9_]*__', text):
        raise ValueError('unsubstituted placeholder survived')
    return text


def definition(text):
    """pg_get_functiondef form: the artifact is the catalog definition plus ';'."""
    trimmed = text.rstrip('\n').rstrip()
    if not trimmed.endswith('$function$;'):
        raise ValueError('artifact must end with $function$;')
    return trimmed[:-1] + '\n'


def regions(old, new):
    """Changed spans as character offsets, with the room each may grow into.

    Several of these statements are single 3 KB lines where a handful of
    characters move, so a line-grained edit would ship the whole line twice.
    Working in characters keeps each fragment to the part that actually changed
    plus whatever context it needs to be unique.
    """
    old_lines, new_lines = old.splitlines(keepends=True), new.splitlines(keepends=True)
    starts = lambda lines: [sum(len(x) for x in lines[:i]) for i in range(len(lines) + 1)]
    a_at, b_at = starts(old_lines), starts(new_lines)
    spans = [(a_at[i1], a_at[i2], b_at[j1], b_at[j2])
             for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes()
             if tag != 'equal']
    out = []
    for index, (a1, a2, b1, b2) in enumerate(spans):
        # Trim the context the two sides already share, then record how far this
        # fragment may grow without colliding with a neighbouring edit.
        while a1 < a2 and b1 < b2 and old[a1] == new[b1]:
            a1 += 1
            b1 += 1
        while a2 > a1 and b2 > b1 and old[a2 - 1] == new[b2 - 1]:
            a2 -= 1
            b2 -= 1
        low = spans[index - 1][1] if index else 0
        high = spans[index + 1][0] if index + 1 < len(spans) else len(old)
        out.append((a1, a2, b1, b2, low, high))
    return out


def blocks(old, new):
    """Minimal character edits, each widened with context until uniquely anchored."""
    out = []
    for a1, a2, b1, b2, low, high in regions(old, new):
        pad = 0
        while True:
            start, end = max(low, a1 - pad), min(high, a2 + pad)
            fragment = old[start:end]
            if fragment and old.count(fragment) == 1:
                out.append((fragment, new[b1 - (a1 - start):b2 + (end - a2)]))
                break
            if start == low and end == high:
                raise ValueError('edit could not be uniquely anchored')
            pad += 1
    return out


def literal(value):
    for tag in ('$f$', '$g$', '$h$', '$k$', '$m$'):
        if tag not in value:
            return tag + value + tag
    raise ValueError('no free dollar-quote tag for fragment')


def compact(guard):
    """Pin the activation event by whole-row digest instead of field by field.

    The apply-once kit restates the ~7 KB field-by-field shape check twice. Here
    the same row is pinned by the digest of its entire jsonb form, which is
    strictly tighter -- it also covers recorded_at and the recording transaction,
    which the field check never looked at -- and two orders of magnitude shorter.
    """
    start = guard.index(" if not (e.root_id=")
    end = guard.index('; end if;', start) + len('; end if;')
    label = re.search(r"raise exception '([A-Z0-9_]+_ACTIVATION_EVENT_DRIFT)'", guard[start:end]).group(1)
    return (guard[:start]
            + f" if encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')<>'{EVENT119_ROW_SHA256}'"
              f" then raise exception '{label}'; end if;"
            + guard[end:])


def main():
    out_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else HERE / 'root10-runtime-clock-repair-output')
    kit = (out_dir / 'root10-runtime-clock-repair.apply-once.sql').read_text(encoding='utf-8')
    if 'ROOT10_RUNTIME_CLOCK_FUNCTIONS_REPAIRED' not in kit:
        raise ValueError('apply-once kit not found; run build-root10-runtime-clock-repair.mjs first')

    statements, report = [], []
    for name, signature in TARGETS:
        head = subprocess.run(['git', 'show', f'HEAD:{RELATIVE}/{name}'], cwd=REPO,
                              capture_output=True, text=True, check=True).stdout
        old, new = definition(substitute(head)), definition(substitute((HERE / name).read_text(encoding='utf-8')))
        if old == new:
            raise ValueError(name + ' is unchanged; nothing to repair')
        edits = blocks(old, new)
        # Prove locally that these edits reconstruct the reviewed text exactly
        # before asking the database to trust them.
        check = old
        for fragment, replacement in edits:
            if check.count(fragment) != 1:
                raise ValueError('fragment is not unique: ' + fragment[:60])
            check = check.replace(fragment, replacement)
        if check != new:
            raise ValueError('edits do not reconstruct ' + name)
        old_sha, new_sha = hashlib.sha256(old.encode()).hexdigest(), hashlib.sha256(new.encode()).hexdigest()
        body = [f"  d:=pg_get_functiondef('{signature}'::regprocedure);",
                f"  if encode(sha256(convert_to(d,'UTF8')),'hex')<>'{old_sha}' then raise exception 'RC_REPAIR_PREIMAGE_{name}'; end if;"]
        for index, (fragment, replacement) in enumerate(edits, 1):
            body.append(f"  f:={literal(fragment)}; if (length(d)-length(replace(d,f,'')))/length(f)<>1"
                        f" then raise exception 'RC_REPAIR_FRAGMENT_{index}_{name}'; end if; d:=replace(d,f,{literal(replacement)});")
        body.append(f"  if encode(sha256(convert_to(d,'UTF8')),'hex')<>'{new_sha}' then raise exception 'RC_REPAIR_POSTIMAGE_{name}'; end if;")
        body.append('  execute d;')
        statements.append('\n'.join(body))
        report.append({'function': signature, 'edits': len(edits), 'old_sha256': old_sha, 'new_sha256': new_sha})

    pre = compact(kit[kit.index('do $pre$'):kit.index('end $pre$;') + len('end $pre$;')])
    post = compact(kit[kit.index('do $post$'):kit.index('end $post$;') + len('end $post$;')])
    header = kit[:kit.index('do $pre$')]
    tail = kit[kit.index('select jsonb_build_object'):]
    content = (header + pre + '\ndo $edit$ declare d text; f text; begin\n'
               + '\n'.join(statements) + '\nend $edit$;\n' + post + '\n' + tail)
    if 'CREATE OR REPLACE' in content.split('do $edit$')[0]:
        raise ValueError('the delta form must not restate a function')
    path = out_dir / 'root10-runtime-clock-repair.apply-delta.sql'
    with path.open('x', encoding='utf-8') as stream:
        stream.write(content)
    print(json.dumps({'state': 'ROOT10_RUNTIME_CLOCK_REPAIR_DELTA_NOT_EXECUTED', 'authority_effect': 'NONE',
                      'path': str(path), 'bytes': path.stat().st_size,
                      'sha256': hashlib.sha256(content.encode()).hexdigest(),
                      'functions': report}, indent=2))


if __name__ == '__main__':
    main()
