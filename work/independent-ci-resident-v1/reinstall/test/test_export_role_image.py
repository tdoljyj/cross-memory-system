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


def layer_tar(data):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        entry = tarfile.TarInfo('fixture.txt'); entry.size = len(data)
        archive.addfile(entry, io.BytesIO(data))
    return raw.getvalue()


def oci_archive(*, indexed=True, compatibility=True, compressed=False, bad_size=None, wrong_diff=False):
    """A real OCI descriptor graph, including containerd's outer export index.

    Its image ID is the target descriptor, never the synthetic export index.
    Layers exceed the old metadata buffer limit to exercise streaming hashes.
    """
    encode = lambda v: json.dumps(v, separators=(',', ':')).encode()
    entries = []
    def blob(data, media):
        digest = hashlib.sha256(data).hexdigest()
        entries.append(('blobs/sha256/' + digest, data))
        return {'mediaType': media, 'digest': 'sha256:' + digest, 'size': len(data)}
    raw_layer = layer_tar(b'layer-content' * 400000)
    layer = blob(gzip.compress(raw_layer, mtime=0) if compressed else raw_layer,
                 'application/vnd.oci.image.layer.v1.tar' + ('+gzip' if compressed else ''))
    config = blob(encode({'architecture': 'amd64', 'os': 'linux', 'rootfs': {'type': 'layers',
                         'diff_ids': ['sha256:' + ('0' * 64 if wrong_diff else hashlib.sha256(raw_layer).hexdigest())]}}),
                  'application/vnd.oci.image.config.v1+json')
    if bad_size == 'layer':
        layer['size'] += 1
    if bad_size == 'config':
        config['size'] += 1
    manifest = blob(encode({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                            'config': config, 'layers': [layer]}), 'application/vnd.oci.image.manifest.v1+json')
    if bad_size == 'manifest':
        manifest['size'] += 1
    target = blob(encode({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                         'manifests': [manifest]}), 'application/vnd.oci.image.index.v1+json') if indexed else manifest
    entries += [('oci-layout', encode({'imageLayoutVersion': '1.0.0'})),
                ('index.json', encode({'schemaVersion': 2, 'manifests': [target]}))]
    if compatibility:
        entries.append(('manifest.json', encode([{'Config': 'blobs/sha256/' + config['digest'][7:],
                                                 'RepoTags': None, 'Layers': ['blobs/sha256/' + layer['digest'][7:]]}])))
    return entries, target['digest'][7:], config['digest'][7:]


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

    def test_containerd_index_and_manifest_ids_are_not_config_ids(self):
        for indexed in (False, True):
            for compatibility in (False, True):
                with self.subTest(indexed=indexed, compatibility=compatibility):
                    entries, iid, config = oci_archive(indexed=indexed, compatibility=compatibility)
                    self.assertNotEqual(iid, config)
                    r = self.check(entries, iid)
                    self.assertTrue(r['ok'], r)
                    self.assertEqual(r['config'], 'blobs/sha256/' + config)

    def test_oci_descriptor_chain_rejects_tampered_or_missing_content(self):
        entries, iid, _ = oci_archive()
        for name, data in entries:
            if name.startswith('blobs/'):
                with self.subTest(member=name, change='changed'):
                    bad = [(n, d + b' ' if n == name else d) for n, d in entries]
                    self.assertFalse(self.check(bad, iid)['ok'])
                with self.subTest(member=name, change='missing'):
                    self.assertFalse(self.check([(n, d) for n, d in entries if n != name], iid)['ok'])
        self.assertFalse(self.check(entries, '0' * 64)['ok'])

    def test_the_archive_is_held_to_the_image_id_by_its_own_config(self):
        layer = layer_tar(b'layer' * 14000)   # hashed, never retained as JSON
        layer_id = hashlib.sha256(layer).hexdigest()
        config = json.dumps({'architecture': 'amd64', 'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + layer_id]}}).encode()
        iid = hashlib.sha256(config).hexdigest()
        classic = [(iid + '.json', config), ('abc/layer.tar', layer), ('manifest.json', json.dumps([{'Config': iid + '.json', 'RepoTags': None, 'Layers': ['abc/layer.tar']}]).encode())]
        r = self.check(classic, iid)
        self.assertEqual((r['ok'], r['config'], r['entries']), (True, iid + '.json', 3))
        oci = [('blobs/sha256/' + iid, config), ('blobs/sha256/' + layer_id, layer), ('manifest.json', json.dumps([{'Config': 'blobs/sha256/' + iid, 'Layers': ['blobs/sha256/' + layer_id]}]).encode())]
        self.assertTrue(self.check(oci, iid)['ok'])
        # another config under the image's name, another image, no manifest, two images, a truncated archive: refused by name
        self.assertEqual(self.check([(iid + '.json', config + b' '), classic[2]], iid)['code'], 'CONFIG_NOT_THE_IMAGE_ID')
        self.assertEqual(self.check(classic, '3' * 64)['code'], 'CONFIG_NOT_THE_IMAGE_ID')
        self.assertEqual(self.check(classic[:2], iid)['code'], 'MANIFEST_MISSING')
        two = json.dumps([{'Config': iid + '.json'}, {'Config': iid + '.json'}]).encode()
        self.assertEqual(self.check(classic[:2] + [('manifest.json', two)], iid)['code'], 'MANIFEST_NOT_ONE_IMAGE')
        self.assertEqual(self.check(classic, iid, truncate=True)['code'], 'TAR_TRUNCATED')
        self.assertEqual(self.check([(n, d + b'!' if n == 'abc/layer.tar' else d) for n, d in classic], iid)['code'], 'LAYER_DIFF_ID_MISMATCH')
        self.assertEqual(self.check([classic[0], classic[2]], iid)['code'], 'LAYER_MISSING')

    def test_oci_compatibility_manifest_cannot_redirect_the_verified_image(self):
        entries, iid, _ = oci_archive()
        compatibility = json.loads(entries[-1][1]); compatibility[0]['Layers'] = []
        self.assertEqual(self.check(entries[:-1] + [('manifest.json', json.dumps(compatibility).encode())], iid)['code'], 'DOCKER_OCI_MANIFEST_MISMATCH')

    def test_gzip_layers_and_classic_config_id_in_an_oci_layout(self):
        entries, iid, config = oci_archive(compressed=True)
        self.assertTrue(self.check(entries, iid)['ok'])
        self.assertTrue(self.check(entries, config)['ok'])
        # All blob hashes and descriptor sizes match, but the config lies about
        # the uncompressed layer. Neither target-ID nor config-ID may accept it.
        entries, iid, config = oci_archive(compressed=True, wrong_diff=True)
        for expected_id in (iid, config):
            self.assertEqual(self.check(entries, expected_id)['code'], 'LAYER_DIFF_ID_MISMATCH')

    def test_descriptor_size_is_checked_even_when_blob_hashes_match(self):
        entries, iid, _ = oci_archive()
        index = json.loads(dict(entries)['index.json']); index['manifests'][0]['size'] += 1
        bad = [(n, json.dumps(index).encode() if n == 'index.json' else d) for n, d in entries]
        self.assertEqual(self.check(bad, iid)['code'], 'OCI_DESCRIPTOR_HASH_OR_SIZE_MISMATCH')
        for at in ('manifest', 'config', 'layer'):
            with self.subTest(at=at):
                entries, iid, _ = oci_archive(bad_size=at)
                self.assertEqual(self.check(entries, iid)['code'], 'OCI_DESCRIPTOR_HASH_OR_SIZE_MISMATCH')

    def test_duplicate_path_traversal_links_and_incomplete_tar_are_refused(self):
        entries, iid, _ = oci_archive()
        self.assertEqual(self.check(entries + [entries[0]], iid)['code'], 'TAR_DUPLICATE_MEMBER')
        self.assertEqual(self.check(entries + [('../outside', b'x')], iid)['code'], 'TAR_PATH_REFUSED')
        self.assertEqual(self.check(entries + [('./index.json', b'{}')], iid)['code'], 'TAR_PATH_REFUSED')
        self.assertFalse(self.check(entries, iid, truncate=True)['ok'])
        # A valid tar checksum does not make a hardlink/symlink an image blob.
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, data in entries:
                info = tarfile.TarInfo(name); info.size = len(data); archive.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo('link'); info.type = tarfile.SYMTYPE; info.linkname = 'index.json'; archive.addfile(info)
        with tempfile.TemporaryDirectory(prefix='rimg-link-') as tmp:
            path = Path(tmp) / 'image.tar.gz'; path.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            self.assertEqual(self.ps('check', str(path), iid)['code'], 'TAR_MEMBER_TYPE_REFUSED')

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
