"""Explicit, offline installation of the unified BeamingFace Skill; no background updater."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid

__version__ = "1.0.2"

SOURCE = Path(__file__).resolve().parents[1] / 'skills'
NAME = 'clued'
RETIRED_NAMES = ('clued-developer', 'clued-user', 'clued-continuity')


def is_link(path):
    return path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction())


def hashes(folder):
    if is_link(folder):
        raise ValueError(f'Linked skill paths are unsupported: {folder}')
    if not folder.exists():
        return {}
    if not folder.is_dir():
        raise ValueError(f'Skill path must be a directory: {folder}')
    result = {}
    for path in folder.rglob('*'):
        if is_link(path):
            raise ValueError(f'Linked skill paths are unsupported: {path}')
        if path.is_file():
            result[path.relative_to(folder).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def update(target, check=False):
    target = target.resolve()
    source_root = SOURCE.resolve()
    if target == source_root or source_root in target.parents or target in source_root.parents:
        raise ValueError('Installation target must be separate from repository sources')
    wanted = hashes(SOURCE / NAME)
    if 'SKILL.md' not in wanted:
        raise ValueError(f'Missing source SKILL.md: {NAME}')
    names = (NAME, *RETIRED_NAMES)
    current = {name: hashes(target / name) for name in names}
    existing = [name for name in names if (target / name).exists()]
    results = {NAME: {'status': 'MATCH' if wanted == current[NAME] else 'DIFFERENT'}}
    if wanted == current[NAME]:
        results[NAME]['sha256'] = wanted
    results.update({name: {'status': 'DIFFERENT', 'action': 'RETIRE'}
                    for name in RETIRED_NAMES if name in existing})
    if check or all(value['status'] == 'MATCH' for value in results.values()):
        return results

    target.mkdir(parents=True, exist_ok=True)
    # Backups, staging and failed candidates are outside Skill discovery.
    backup_root = target.parent / 'clued-skill-backups'
    if is_link(backup_root):
        raise ValueError(f'Linked backup paths are unsupported: {backup_root}')
    backup_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='stage-', dir=backup_root) as temporary:
        staged = Path(temporary) / NAME
        shutil.copytree(SOURCE / NAME, staged)
        if hashes(staged) != wanted:
            raise ValueError('Source changed during copy; retry from a stable checkout')
        moved = {}
        installed = False
        try:
            for name in existing:
                destination = target / name
                if hashes(destination) != current[name]:
                    raise ValueError(f'Installed Skill changed during update: {name}')
                backup = backup_root / (name + '-' + uuid.uuid4().hex)
                destination.rename(backup)
                moved[name] = backup
            staged.rename(target / NAME)
            installed = True
            if hashes(target / NAME) != wanted:
                raise ValueError('Installed hashes do not match')
        except Exception:
            if installed and (target / NAME).exists():
                (target / NAME).rename(backup_root / ('failed-' + uuid.uuid4().hex))
            for name, backup in reversed(list(moved.items())):
                destination = target / name
                if destination.exists() or is_link(destination):
                    raise RuntimeError(f'Rollback path changed; preserve backup {backup}')
                backup.rename(destination)
            raise

    results = {NAME: {'status': 'UPDATED', 'sha256': wanted,
                      'backup': str(moved[NAME]) if NAME in moved else None}}
    for name in RETIRED_NAMES:
        if name in moved:
            results[name] = {'status': 'RETIRED', 'sha256': current[name],
                             'backup': str(moved[name])}
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true',
                        help='Read-only check; exit 1 on content drift or remaining retired entries')
    parser.add_argument('--target', type=Path,
                        default=Path(os.environ.get('CODEX_HOME') or str(Path.home() / '.codex')) / 'skills')
    args = parser.parse_args()
    result = update(args.target, args.check)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return int(any(value['status'] == 'DIFFERENT' for value in result.values()))


if __name__ == '__main__':
    raise SystemExit(main())
