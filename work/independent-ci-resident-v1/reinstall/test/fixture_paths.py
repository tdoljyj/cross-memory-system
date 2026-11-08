"""Windows-shaped stand-ins for the fixture paths a reinstall configuration names (tools/rconfig.py), on any test host.

A reinstall configuration names Windows paths only (rconfig.WIN_PATH, a regular expression: the same check on every host), and the
tools read those paths on the Windows node they run on. The offline tests also run on the Linux CI host, where a temporary directory is
no Windows path, so a fixture configuration never names one: it names C:\\fixture\\<path relative to the configuration's directory>,
which rconfig validates exactly as written, and the test reads that path at <the configuration's directory>/<relative path>:
  localize(cfg, cfg_path)          in process, on the configuration rconfig.load returned
  python -I fixture_paths.py <tool> <args...>   a tool in its own process, with its rconfig.load wrapped the same way (run_tool)
The stand-ins are parsed as Windows paths (PureWindowsPath), never with the host's os.path.
"""
import importlib.util, os, runpy, sys
from pathlib import PureWindowsPath

HERE = os.path.abspath(__file__)
ROOT = PureWindowsPath('C:\\fixture')
PATH_KEYS = ('workDir', 'repo', 'basePackage', 'nodeExe', 'policyInput', 'companionInput', 'upgradeTokenFile')
LINUX_PATH_KEYS = ('installedManifest', 'installedRoles')


def win(cfg_path, local):
    """The stand-in a configuration at cfg_path names for local (a path under the configuration's directory)."""
    rel = os.path.relpath(local, os.path.dirname(os.path.abspath(cfg_path)))
    assert rel != os.curdir and rel.split(os.sep)[0] != os.pardir, ('FIXTURE_PATH_OUTSIDE_THE_CONFIGURATION_DIRECTORY', local)
    return str(ROOT.joinpath(*rel.split(os.sep)))


def local(cfg_path, value):
    """The local path of a stand-in; any other value (a fixture's own C:\\ constant, null) is returned as it is."""
    if not isinstance(value, str):
        return value
    try:
        rel = PureWindowsPath(value).relative_to(ROOT)
    except ValueError:
        return value
    return os.path.join(os.path.dirname(os.path.abspath(cfg_path)), *rel.parts)


def localize(cfg, cfg_path):
    """A copy of a loaded (validated) configuration whose stand-in paths are the local fixture paths."""
    out = dict(cfg)
    for k in PATH_KEYS:
        if k in out:
            out[k] = local(cfg_path, out[k])
    if isinstance(out.get('heartbeat'), dict):
        out['heartbeat'] = dict(out['heartbeat'], tokenFile=local(cfg_path, out['heartbeat']['tokenFile']))
    if isinstance(out.get('linux'), dict):
        out['linux'] = dict(out['linux'], **{k: local(cfg_path, out['linux'][k]) for k in LINUX_PATH_KEYS if k in out['linux']})
    return out


def run_tool(argv_prefix):
    """The argv that runs a tool (loading tools/rconfig.py by path, like linux/prep.py) with its rconfig.load localized."""
    return [sys.executable, '-I', HERE] + list(argv_prefix)


def _localize_rconfig_loads():
    real = importlib.util.spec_from_file_location

    def spec_from_file_location(name, location=None, *a, **k):
        spec = real(name, location, *a, **k)
        if name == 'rconfig':
            exec_module = spec.loader.exec_module

            def exec_and_localize(module):
                exec_module(module)
                load = module.load
                module.load = lambda path: localize(load(path), path)
            spec.loader.exec_module = exec_and_localize
        return spec
    importlib.util.spec_from_file_location = spec_from_file_location


if __name__ == '__main__':
    sys.argv = sys.argv[1:]
    _localize_rconfig_loads()
    runpy.run_path(sys.argv[0], run_name='__main__')
