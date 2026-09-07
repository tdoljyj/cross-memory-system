"""Explicit, offline installation from this checkout; no background updater."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid

SOURCE = Path(__file__).resolve().parents[1] / 'skills'
NAMES = ('clued-developer', 'clued-user')


def hashes(folder):
    if not folder.exists():
        return {}
    result = {}
    for path in [folder, *folder.rglob('*')]:
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise ValueError(f'Linked skill paths are unsupported: {path}')
        if path.is_file():
            result[path.relative_to(folder).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def update(target, check=False):
    target = target.resolve()
    if target == SOURCE.resolve() or SOURCE.resolve() in target.parents or target in SOURCE.resolve().parents:
        raise ValueError('Installation target must be separate from repository sources')
    # Validate both sources and destinations before any replacement.
    wanted = {name: hashes(SOURCE / name) for name in NAMES}
    current = {name: hashes(target / name) for name in NAMES}
    for name in NAMES:
        if 'SKILL.md' not in wanted[name]:
            raise ValueError(f'Missing source SKILL.md: {name}')
    results = {}
    for name in NAMES:
        if wanted[name] == current[name]:
            results[name] = {'status': 'MATCH', 'sha256': wanted[name]}
            continue
        if check:
            results[name] = {'status': 'DIFFERENT'}
            continue
        target.mkdir(parents=True, exist_ok=True)
        destination = target / name
        # Staging and backups live outside the discovery directory.
        backup_root = target.parent / 'clued-skill-backups'
        backup_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='stage-', dir=backup_root) as temporary:
            staged = Path(temporary) / name
            shutil.copytree(SOURCE / name, staged)
            if hashes(staged) != wanted[name]:
                raise ValueError('Source changed during copy; retry from a stable checkout')
            backup = backup_root / (name + '-' + uuid.uuid4().hex)
            existed = destination.exists()
            if existed:
                destination.rename(backup)
            try:
                staged.rename(destination)
                if hashes(destination) != wanted[name]:
                    raise ValueError('Installed hashes do not match')
            except Exception:
                if destination.exists():
                    destination.rename(backup_root / ('failed-' + uuid.uuid4().hex))
                if existed:
                    backup.rename(destination)
                raise
        results[name] = {'status': 'UPDATED', 'sha256': wanted[name],
                         'backup': str(backup) if existed else None}
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only equality check; exit 1 on drift')
    parser.add_argument('--target', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'skills')
    args = parser.parse_args()
    result = update(args.target, args.check)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return int(any(value['status'] == 'DIFFERENT' for value in result.values()))


if __name__ == '__main__':
    raise SystemExit(main())
