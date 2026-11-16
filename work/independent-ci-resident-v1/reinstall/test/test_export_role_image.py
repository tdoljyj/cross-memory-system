"""reinstall/tools/export-role-image.ps1 (the fleet's one-time export of the local role image, run by the agent on DESK with one UAC):
its pure functions in Windows PowerShell 5.1 on archives made here (classic and OCI docker save layouts, a changed config, a truncated
archive, no manifest), the root script's text (read-only towards docker), and that its machinery is the launcher's own (the template
generate.py pins, root-run by the companion registrar). Nothing is elevated, no docker, no WSL, nothing outside a temporary directory."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools' / 'export-role-image.ps1'
POWERSHELL = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
DRIVER = r'''
param([string]$Tool, [string]$Mode, [string]$A, [string]$B)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. $Tool -PureFunctionsOnly
if ($Mode -ceq 'check') { Test-RoleImageArchive $A $B | ConvertTo-Json -Compress }
else { try { [ordered]@{ text = (Get-RoleImageExportScript $A $B) } | ConvertTo-Json -Compress } catch { [ordered]@{ error = $_.Exception.Message } | ConvertTo-Json -Compress } }
'''


def tar_gz(entries, truncate=False):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as t:
        for name, data in entries:
            info = tarfile.TarInfo(name); info.size = len(data); t.addfile(info, io.BytesIO(data))
    b = raw.getvalue()
    if truncate:
        b = b[:len(b) // 2]
    return gzip.compress(b, mtime=0)


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class ExportRoleImage(unittest.TestCase):
    def ps(self, mode, a, b):
        with tempfile.TemporaryDirectory(prefix='rimg-') as d:
            (Path(d) / 'driver.ps1').write_text(DRIVER, encoding='utf-8')
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(Path(d) / 'driver.ps1'), str(TOOL), mode, a, b],
                               capture_output=True, text=True, encoding='utf-8', timeout=120)
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)

    def check(self, entries, image_id, **kw):
        with tempfile.TemporaryDirectory(prefix='rimg-a-') as d:
            f = Path(d) / 'role-image.tar.gz'; f.write_bytes(tar_gz(entries, **kw))
            return self.ps('check', str(f), image_id)

    def test_the_archive_is_held_to_the_image_id_by_its_own_config(self):
        config = json.dumps({'architecture': 'amd64', 'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + '1' * 64]}}).encode()
        iid = hashlib.sha256(config).hexdigest()
        layer = os.urandom(70000)   # skipped, never read into memory
        classic = [(iid + '.json', config), ('abc/layer.tar', layer), ('manifest.json', json.dumps([{'Config': iid + '.json', 'RepoTags': None, 'Layers': ['abc/layer.tar']}]).encode())]
        r = self.check(classic, iid)
        self.assertEqual((r['ok'], r['config'], r['entries']), (True, iid + '.json', 3))
        oci = [('blobs/sha256/' + iid, config), ('blobs/sha256/' + '2' * 64, layer), ('manifest.json', json.dumps([{'Config': 'blobs/sha256/' + iid, 'Layers': ['blobs/sha256/' + '2' * 64]}]).encode())]
        self.assertTrue(self.check(oci, iid)['ok'])
        # another config under the image's name, another image, no manifest, two images, a truncated archive: refused by name
        self.assertEqual(self.check([(iid + '.json', config + b' '), classic[2]], iid)['code'], 'CONFIG_NOT_THE_IMAGE_ID')
        self.assertEqual(self.check(classic, '3' * 64)['code'], 'CONFIG_NOT_THE_IMAGE_ID')
        self.assertEqual(self.check(classic[:2], iid)['code'], 'MANIFEST_MISSING')
        two = json.dumps([{'Config': iid + '.json'}, {'Config': iid + '.json'}]).encode()
        self.assertEqual(self.check(classic[:2] + [('manifest.json', two)], iid)['code'], 'MANIFEST_NOT_ONE_IMAGE')
        self.assertEqual(self.check(classic, iid, truncate=True)['code'], 'TAR_TRUNCATED')

    def test_the_root_step_is_read_only_towards_docker_and_writes_only_into_its_out_directory(self):
        iid = 'a' * 64
        t = self.ps('script', iid, '/mnt/c/ProgramData/CluedIndependentCI/reinstall-linux-out-' + 'b' * 32)['text']
        self.assertIn('docker image inspect --format', t)
        self.assertIn('docker save "sha256:$ID" | gzip -n > "$F"', t)
        self.assertIn('F="$O/role-image-$ID.tar.gz"', t)
        for word in ('docker rm', 'docker rmi', 'docker load', 'docker pull', 'docker run', 'docker tag', 'docker image rm', 'docker system', 'rm -', 'systemctl'):
            self.assertNotIn(word, t, word)
        self.assertIn('{"status":"ROLE_IMAGE_SAVED"', t.replace('\\"', '"'))
        for bad in (('A' * 64, '/mnt/c/x'), (iid, '/tmp/x'), (iid, '/mnt/c/x y')):
            self.assertEqual(self.ps('script', *bad)['error'], 'EXPORT_SCRIPT_INPUT_REFUSED', bad)

    def test_its_machinery_is_the_launchers_own(self):
        text = TOOL.read_text(encoding='utf-8')
        # the template generate.py pins, its functions by name; the registrar root-run through Invoke-FleetLinuxScript; the registrar built
        # by companion-headless.ps1's own function from sources held to the universal manifest's pins
        self.assertIn("(?m)^TEMPLATE_SHA = '([0-9a-f]{64})'", text)
        for name in ('Invoke-FleetLinuxScript', 'Set-FleetLinuxDirectories', 'New-FleetRunDirectory', 'Remove-FleetRegistrar', 'New-CompanionBuildFromPackage'):
            self.assertIn(name, text, name)
        self.assertIn('$FleetCompanionAccount = $true', text)
        self.assertIn('Test-RoleImageArchive $dst $ImageId', text)
        template = (ROOT / 'launcher' / 'template.ps1').read_text(encoding='utf-8')
        self.assertIn("('root-run ' + $ResidentRoot + ' ' + $run.script", template)


if __name__ == '__main__':
    unittest.main()
