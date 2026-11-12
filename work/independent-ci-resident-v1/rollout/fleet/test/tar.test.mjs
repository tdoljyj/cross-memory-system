// tar.mjs: deterministic ustar written, read back strictly; links, directories, climbing or absolute paths, bad checksums and
// trailing data are refused; Python's tarfile reads what it writes (when Python is there).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractTar, readTar, safeTarPath, writeTar } from '../tar.mjs';

const LONG = `tree/work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/${'x'.repeat(60)}/caf\u00e9-\u4e2d.mjs`;
const entries = () => [{ path: 'b.txt', data: Buffer.from('b\n') }, { path: 'a/z.bin', data: Buffer.alloc(513, 7) }, { path: LONG, data: Buffer.from('long\n') },
  { path: 'empty', data: Buffer.alloc(0) }];

// Rewrites one header field of the first entry and fixes its checksum (so only the field is wrong).
function forge(buf, at, text) {
  const b = Buffer.from(buf);
  b.fill(0, at, at + text.length + 1); b.write(text, at, 'latin1');
  b.fill(0x20, 148, 156);
  let sum = 0; for (let k = 0; k < 512; k++) sum += b[k];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}

test('tar: the same entries in any order give the same bytes; read back exactly; fixed metadata', () => {
  const a = writeTar(entries()), b = writeTar(entries().reverse());
  assert.ok(a.equals(b));
  const back = readTar(a);
  assert.deepEqual(back.map(e => e.path), ['a/z.bin', 'b.txt', 'empty', LONG]);
  for (const e of entries()) assert.ok(back.find(x => x.path === e.path).data.equals(e.data), e.path);
  assert.equal(a.toString('ascii', 100, 107), '0000644');
  assert.equal(a.toString('ascii', 136, 147), '00000000000');
  assert.equal(a.length % 512, 0);
});

test('tar: refuses links, directories, pax headers, climbing/absolute/Windows-alias paths, bad checksums, trailing data, a name twice', () => {
  const one = writeTar([{ path: 'ok.txt', data: Buffer.from('x') }]);
  assert.throws(() => readTar(forge(one, 156, '2')), { code: 'TAR_ENTRY_TYPE_REFUSED' });
  assert.throws(() => readTar(forge(one, 156, '1')), { code: 'TAR_ENTRY_TYPE_REFUSED' });
  assert.throws(() => readTar(forge(one, 156, '5')), { code: 'TAR_ENTRY_TYPE_REFUSED' });
  assert.throws(() => readTar(forge(one, 156, 'x')), { code: 'TAR_ENTRY_TYPE_REFUSED' });
  assert.throws(() => readTar(forge(one, 157, 'target')), { code: 'TAR_ENTRY_TYPE_REFUSED' });
  for (const bad of ['../evil.txt', '/abs.txt', 'a/../../b', 'c:/x', 'a\\b', 'dir/NUL', 'dir/con.txt', 'trail.', 'a//b', './a']) {
    assert.equal(safeTarPath(bad), false, bad);
    assert.throws(() => readTar(forge(one, 0, bad)), { code: 'TAR_PATH_REFUSED' }, bad);
    assert.throws(() => writeTar([{ path: bad, data: Buffer.alloc(1) }]), { code: 'TAR_PATH_REFUSED' }, bad);
  }
  const bad = Buffer.from(one); bad[0] ^= 1;
  assert.throws(() => readTar(bad), { code: 'TAR_CHECKSUM_MISMATCH' });
  assert.throws(() => readTar(Buffer.concat([one, Buffer.from('junk')])), { code: 'TAR_TRAILING_DATA' });
  assert.throws(() => readTar(one.subarray(0, 600)), { code: 'TAR_TRUNCATED' });
  assert.throws(() => writeTar([{ path: 'A.txt', data: Buffer.alloc(1) }, { path: 'a.txt', data: Buffer.alloc(1) }]), { code: 'TAR_PATH_TWICE' });
  const twice = Buffer.concat([writeTar([{ path: 'a.txt', data: Buffer.alloc(1) }]).subarray(0, 1024), writeTar([{ path: 'A.TXT', data: Buffer.alloc(1) }])]);
  assert.throws(() => readTar(twice), { code: 'TAR_PATH_TWICE' });
});

test('tar: extraction is create-only under a new directory; Python tarfile reads the same entries', async t => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fleettar'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  const buf = writeTar(entries());
  await extractTar(readTar(buf), path.join(d, 'x'));
  assert.equal(await fs.readFile(path.join(d, 'x', ...LONG.split('/')), 'utf8'), 'long\n');
  await assert.rejects(extractTar(readTar(buf), path.join(d, 'x')), { code: 'EEXIST' });
  await fs.writeFile(path.join(d, 'a.tar'), buf);
  const r = spawnSync('python', ['-I', '-c', 'import sys,tarfile,json; t=tarfile.open(sys.argv[1]); print(json.dumps([[m.name,m.size,m.mode,m.mtime,m.type.decode()] for m in t.getmembers()]))', path.join(d, 'a.tar')]);
  if (r.status === null || r.error) return t.skip('no Python here');
  assert.deepEqual(JSON.parse(r.stdout), [['a/z.bin', 513, 0o644, 0, '0'], ['b.txt', 2, 0o644, 0, '0'], ['empty', 0, 0o644, 0, '0'], [LONG, 5, 0o644, 0, '0']]);
});
