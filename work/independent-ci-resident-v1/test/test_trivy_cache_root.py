"""The trivy role's cache root is created by the worker unit itself (StateDirectory=), not by any install path. Offline, any OS:
python -I -B -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1).

Why: the role session checks the cache root as a protected path (root-owned at every level, no group/other write, not a link), and
the worker cannot create it (ProtectSystem=strict leaves /var/lib read-only). No installer created it, so a new node could not run a
single trivy job. systemd creates it as root:root 0700 before ExecStartPre on every worker start; first install, reinstall and the
universal upgrade all install this same unit file.

The same path is named in three places; changing one of them alone fails here:
  - the worker unit: /var/lib/ + StateDirectory=;
  - the resident tool: TRIVY_CACHE (the view check);
  - the role material every node is qualified with: roles.trivy.formalTrivy.cacheRoot, as the accepted fleet record carries it
    (fleetRefs.formalRoles, the material that enters the Source manifest; the kit's template roles are the installed node's)."""
import importlib.machinery
import importlib.util
import json
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent
R = HERE.parent
loader = importlib.machinery.SourceFileLoader('resident_linux_trivy_cache', str(R / 'linux' / 'bin' / 'clued-ci-resident-linux'))
spec = importlib.util.spec_from_loader('resident_linux_trivy_cache', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

WORKER_UNIT = (R / 'linux' / 'systemd' / 'clued-ci-worker@.service').read_text(encoding='utf8')
ACCEPTED = R / 'rollout' / 'fleet' / 'test' / 'fixtures' / 'fleet-node-2026.11.19-78ad314b.acceptance.json'
STATE_BASE = '/var/lib/'   # systemd's StateDirectory= base for a system unit


def service_settings(unit_text, key):
    """Every value of one [Service] key, in order."""
    section, values = None, []
    for line in unit_text.splitlines():
        if re.fullmatch(r'\[[A-Za-z]+\]', line.strip()):
            section = line.strip()
            continue
        k, sep, v = line.partition('=')
        if section == '[Service]' and sep and k == key:
            values.append(v)
    return values


def role_cache_root():
    roles = json.loads(ACCEPTED.read_text(encoding='utf8'))['fleetRefs']['formalRoles']
    return roles['trivy']['formalTrivy']['cacheRoot']


class TrivyCacheRootIsTheUnits(unittest.TestCase):
    def test_the_unit_the_view_check_and_the_role_material_name_the_same_cache_root(self):
        dirs = service_settings(WORKER_UNIT, 'StateDirectory')
        self.assertEqual(len(dirs), 1, 'exactly one StateDirectory= line in the worker unit')
        self.assertEqual(len(dirs[0].split()), 1, 'StateDirectory= names exactly one directory')
        from_unit = STATE_BASE + dirs[0]
        self.assertEqual(from_unit, tool.TRIVY_CACHE)
        self.assertEqual(from_unit, role_cache_root())

    def test_systemd_creates_it_root_owned_and_closed(self):
        self.assertEqual(service_settings(WORKER_UNIT, 'StateDirectoryMode'), ['0700'])
        # the owner of a StateDirectory= is the unit's User=/Group=: the role's protectedPath wants root at every level
        self.assertEqual(service_settings(WORKER_UNIT, 'User'), ['root'])
        self.assertEqual(service_settings(WORKER_UNIT, 'Group'), ['root'])
        self.assertEqual(service_settings(WORKER_UNIT, 'DynamicUser'), [])

    def test_the_cache_root_is_no_longer_an_optional_writable_path(self):
        # StateDirectory= is writable under ProtectSystem=strict by itself; a '-' entry would bring back "a host without it".
        tokens = [t for line in service_settings(WORKER_UNIT, 'ReadWritePaths') for t in line.split()]
        self.assertNotIn('-' + tool.TRIVY_CACHE, tokens)
        self.assertNotIn(tool.TRIVY_CACHE, tokens)
        self.assertEqual(service_settings(WORKER_UNIT, 'ProtectSystem'), ['strict'])

    def test_the_view_probe_carries_the_state_directory(self):
        # the rehearsal/selfcheck probe hands the unit's view settings to systemd-run: without StateDirectory= there, the cache
        # root is read-only inside the probe and view-check fails although the worker itself could write it.
        props = tool.namespace_properties(WORKER_UNIT, 'f' * 64)
        self.assertIn('--property=StateDirectory=' + tool.TRIVY_CACHE[len(STATE_BASE):], props)
        self.assertIn('--property=StateDirectoryMode=0700', props)


if __name__ == '__main__':
    unittest.main()
