"""Derive concrete edit resources and use the holder's original Native calls.

The caller keeps its private key and authenticated transports in memory. This
module stores no credentials, never widens a CI grant, and creates no claims or
Tasks on a failed renewal. Unknown shell writes require a structured editor.
"""
from __future__ import annotations

import copy
from pathlib import Path
import re


class WriteSetError(ValueError):
    """A bounded diagnostic that never includes editor content or credentials."""


def _require(ok, code):
    if not ok:
        raise WriteSetError(code)


def _literal_path(value, root, cwd):
    _require(isinstance(value, str) and value and value == value.strip(), 'edit_path_invalid')
    text = value.replace('\\', '/')
    _require(not any(ord(c) < 32 or ord(c) == 127 for c in text), 'edit_path_not_representable')
    _require(not any(c in text for c in '*?[]<>|"'), 'edit_path_not_literal')
    _require(not text.startswith('//') and not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', text), 'edit_path_invalid')
    _require(not re.match(r'^[a-zA-Z]:(?!/)', text), 'edit_drive_relative_refused')
    _require('..' not in text.split('/'), 'edit_path_escape')
    try:
        candidate = Path(text)
        candidate = candidate if candidate.is_absolute() else cwd / candidate
        lexical = candidate.relative_to(root)
        cursor = root
        for part in lexical.parts:
            cursor = cursor / part
            _require(not cursor.is_symlink() and not getattr(cursor, 'is_junction', lambda: False)(), 'edit_link_target_refused')
        candidate = candidate.resolve()
        relative = candidate.relative_to(root).as_posix()
        _require(not any(c.isspace() for c in relative), 'edit_path_not_representable')
        _require(relative not in ('', '.') and not candidate.is_dir(), 'edit_file_target_required')
        _require('.git' not in [part.casefold() for part in relative.split('/')], 'edit_repository_metadata_refused')
        return relative
    except (OSError, RuntimeError, ValueError) as exc:
        if isinstance(exc, WriteSetError):
            raise
        raise WriteSetError('edit_path_escape') from None


def _patch_paths(text):
    _require(isinstance(text, str) and len(text) <= 2_000_000 and '\0' not in text, 'edit_patch_invalid')
    lines = text.replace('\r\n', '\n').splitlines()
    while lines and not lines[-1]:
        lines.pop()
    _require(len(lines) >= 3 and lines[0] == '*** Begin Patch' and lines[-1] == '*** End Patch', 'edit_patch_invalid')
    paths, mode, moved, body = [], None, False, False
    for line in lines[1:-1]:
        header = re.fullmatch(r'\*\*\* (Add|Update|Delete) File: (.+)', line)
        if header:
            mode, value = header.groups()
            paths.append(value)
            moved, body = False, False
        elif line.startswith('*** Move to: '):
            _require(mode == 'Update' and not moved and not body, 'edit_patch_invalid')
            paths.append(line[len('*** Move to: '):])
            moved = True
        elif line == '*** End of File':
            _require(mode == 'Update', 'edit_patch_invalid')
        else:
            _require(mode is not None and not line.startswith('*** '), 'edit_patch_invalid')
            _require(not line or mode != 'Delete', 'edit_patch_invalid')
            _require(not line or line.startswith((' ', '+', '-', '@@')), 'edit_patch_invalid')
            body = body or bool(line)
    _require(bool(paths), 'edit_patch_invalid')
    return paths


def derive_edit_targets(tool_name, tool_input, *, root, cwd=None):
    """Return exact repository paths, including both ends of a patch move."""
    _require(isinstance(tool_name, str), 'edit_tool_unknown')
    root = Path(root).resolve()
    cwd = Path(cwd).resolve() if cwd is not None else root
    try:
        cwd.relative_to(root)
    except ValueError:
        raise WriteSetError('edit_cwd_escape') from None
    name = tool_name.rsplit('__', 1)[-1].rsplit('.', 1)[-1].lower()
    if name == 'apply_patch':
        text = tool_input.get('patch') if isinstance(tool_input, dict) else tool_input
        paths = _patch_paths(text)
    elif name in ('edit', 'write', 'notebookedit'):
        _require(isinstance(tool_input, dict), 'edit_input_invalid')
        key = 'notebook_path' if name == 'notebookedit' else 'file_path'
        paths = [tool_input.get(key)]
    else:
        raise WriteSetError('edit_targets_unknown')
    return tuple(sorted({_literal_path(p, root, cwd) for p in paths}))


def _covers(pattern, target):
    tail = pattern.endswith('/**')
    if tail:
        pattern = pattern[:-3]
    regex = re.escape(pattern).replace(r'\*\*', '.*').replace(r'\*', '[^/]*')
    if tail:
        regex += r'(?:/.*)?'
    return re.fullmatch(regex, target) is not None


def required_write_set(current, targets):
    """Expand only; preserve every other PR, planned edit and execution resource."""
    _require(isinstance(current, (tuple, list)) and all(isinstance(x, str) and x for x in current), 'claim_write_set_invalid')
    _require(isinstance(targets, (tuple, list)) and all(isinstance(x, str) and x for x in targets), 'edit_targets_invalid')
    existing = set(current)
    additions = {target for target in targets if not any(_covers(pattern, target) for pattern in existing)}
    return tuple(sorted(existing | additions))


def _claim(value, session_ref):
    _require(isinstance(value, dict), 'claim_response_invalid')
    for field in ('claim_id', 'task_id', 'context_key'):
        _require(isinstance(value.get(field), str) and value[field], 'claim_identity_invalid')
    for field in ('fence', 'execution_epoch', 'lease_version'):
        _require(type(value.get(field)) is int and value[field] > 0, 'claim_generation_invalid')
    _require(value.get('status') == 'ACTIVE' and value.get('execution_handover_pending') is False, 'claim_not_editable')
    _require(value.get('holder_session_ref') == session_ref, 'claim_session_mismatch')
    _require(isinstance(value.get('write_set'), list) and bool(value['write_set']), 'claim_write_set_invalid')
    return value


def _same(expected, actual, *, renewed=False):
    for field in ('claim_id', 'task_id', 'context_key', 'fence', 'execution_epoch', 'holder_session_ref'):
        _require(expected.get(field) == actual.get(field), 'claim_generation_changed')
    _require(actual['lease_version'] == expected['lease_version'] + int(renewed), 'claim_version_changed')


def _call(callback, args, code):
    try:
        result = callback(args)
    except Exception:
        raise WriteSetError(code) from None
    _require(isinstance(result, dict), code)
    return result


def _verified(callback, expected, targets, session_ref, lease_key):
    # This is the original Native verify RPC's holder-key-only, non-metering
    # edit branch. A normal context:read ADMITTED reply cannot authorize edits.
    reply = _call(callback, {'action': 'verify_edit', 'scope': expected['context_key'],
                             'claim_id': expected['claim_id'], 'fence': expected['fence'],
                             'execution_epoch': expected['execution_epoch'], 'lease_version': expected['lease_version'],
                             'lease_key': lease_key, 'changed_paths': list(targets)}, 'claim_verify_failed')
    _require(reply.get('status') == 'ok' and reply.get('verdict') == 'ADMITTED'
             and reply.get('holder_edit_authorized') is True, 'claim_verify_rejected')
    fresh = _claim(reply.get('claim'), session_ref)
    _same(expected, fresh)
    _require(set(fresh['write_set']) == set(expected['write_set']), 'claim_write_set_changed')
    return fresh


def _identities(root, targets):
    result = {}
    for target in targets:
        cursor = root / target
        leaf = True
        while True:
            try:
                stat = cursor.lstat()
                identity = (stat.st_dev, stat.st_ino, stat.st_mode)
                if leaf:
                    identity += (stat.st_size, stat.st_mtime_ns)
            except FileNotFoundError:
                identity = None
            result[str(cursor)] = identity
            if cursor == root:
                break
            cursor, leaf = cursor.parent, False
    return result


def _canonical_input(tool_name, tool_input, root):
    name = tool_name.rsplit('__', 1)[-1].rsplit('.', 1)[-1].lower()
    if name == 'apply_patch':
        text = tool_input.get('patch') if isinstance(tool_input, dict) else tool_input
        def replace(match):
            return match[1] + str(root / _literal_path(match[2], root, root))
        text = re.sub(r'(?m)^(\*\*\* (?:(?:Add|Update|Delete) File:|Move to:) )(.+)$', replace, text.replace('\r\n', '\n'))
        if isinstance(tool_input, dict):
            payload = copy.deepcopy(tool_input)
            payload['patch'] = text
            return payload
        return text
    payload = copy.deepcopy(tool_input)
    key = 'notebook_path' if name == 'notebookedit' else 'file_path'
    payload[key] = str(root / _literal_path(payload[key], root, root))
    return payload


def execute_claimed_edit(*, tool_name, tool_input, root, claim, session_ref,
                         progress_ref, lease_key, renew, verify, perform):
    """Use fresh Native authority, then renew if needed, then perform the edit.

    Transports are the original holder session's authenticated calls. The key
    is used only in that original renewal and never returned or persisted.
    """
    root = Path(root).resolve()
    targets = derive_edit_targets(tool_name, tool_input, root=root)
    identities = _identities(root, targets)
    expected = copy.deepcopy(_claim(claim, session_ref))
    _require(isinstance(lease_key, str) and bool(lease_key), 'holder_key_required')
    desired = required_write_set(expected['write_set'], targets)
    expanding = set(desired) != set(expected['write_set'])
    current = _verified(verify, expected, () if expanding else targets, session_ref, lease_key)
    if expanding:
        _require(isinstance(lease_key, str) and bool(lease_key), 'holder_key_required')
        _require(isinstance(progress_ref, str) and 0 < len(progress_ref) <= 200, 'fresh_progress_required')
        args = {'scope': current['context_key'], 'claim_id': current['claim_id'],
                'fence': current['fence'], 'lease_version': current['lease_version'],
                'lease_key': lease_key, 'progress_ref': progress_ref, 'write_set': list(desired)}
        reply = _call(renew, args, 'claim_renew_failed')
        _require(reply.get('status') == 'committed', 'claim_renew_rejected')
        renewed = _claim(reply.get('claim'), session_ref)
        _same(current, renewed, renewed=True)
        _require(set(renewed['write_set']) == set(desired), 'claim_write_set_changed')
        current = _verified(verify, renewed, targets, session_ref, lease_key)
    _require(all(any(_covers(pattern, target) for pattern in current['write_set']) for target in targets), 'claim_paths_uncovered')
    _require(derive_edit_targets(tool_name, tool_input, root=root) == targets
             and _identities(root, targets) == identities, 'edit_target_changed')
    payload = _canonical_input(tool_name, tool_input, root)
    public = {key: copy.deepcopy(current[key]) for key in (
        'claim_id', 'task_id', 'context_key', 'fence', 'execution_epoch', 'lease_version',
        'status', 'holder_session_ref', 'execution_handover_pending', 'write_set')}
    try:
        result = perform(payload, public)
    except Exception:
        raise WriteSetError('edit_failed') from None
    return {'result': result, 'claim': public, 'changed_paths': list(targets)}
