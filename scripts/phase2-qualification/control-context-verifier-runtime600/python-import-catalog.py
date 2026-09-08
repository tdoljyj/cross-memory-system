"""Read-only fixed host import catalog; no host operation is called."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

repo = Path(__file__).resolve().parents[3]
host = repo / 'scripts/phase2-qualification/preentry-parent/runtime-successor/host-runtime600/fixed_host.py'
expected = 'cb444459f207037976200505593f96a2dd0b2e796438c62fc94206349f995e42'
if hashlib.sha256(host.read_bytes()).hexdigest() != expected:
    raise SystemExit('FROZEN_HOST_SOURCE_DRIFT')
spec = importlib.util.spec_from_file_location('fixed_host_import_catalog', host)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
files = {str(host)}
for loaded in tuple(sys.modules.values()):
    filename = getattr(loaded, '__file__', None)
    if filename and Path(filename).is_file():
        files.add(str(Path(filename).resolve()))
    cached = getattr(loaded, '__cached__', None)
    if cached and Path(cached).is_file():
        files.add(str(Path(cached).resolve()))
# load_exact does not register its modules in sys.modules; their fixed code
# dependencies are listed separately in the reviewed manifest builder.
print(json.dumps({'state': 'OBSERVED_IMPORTS_NO_HOST_EFFECT', 'files': sorted(files)}, ensure_ascii=False))
