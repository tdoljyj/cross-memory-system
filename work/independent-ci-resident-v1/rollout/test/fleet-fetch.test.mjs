// fetch.mjs against a local fake of the GitHub Release API (never the network, never gh): a tar that is cut off halfway is continued
// with Range until its sha256 is the acceptance's; a wrong body is refused and deleted; the second source (--from) needs no API and no
// token; the token goes to the API host only. The fake token is a literal that exists only in this file's process.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { fetchPackage, TRANSPORT, transportAssetNames } from '../fleet/fetch.mjs';
import { stageTransport } from '../fleet/transport-assets.mjs';
import { readTar } from '../fleet/tar.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const VERSION = '2026.11.15-1', TAG = `fleet-node-${VERSION}`, FAKE_TOKEN = 'fake-token-for-test';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fetch-'));
const fast = { backoffMs: () => 1 };

function release(tarBytes, version = VERSION) {
  const tag = `fleet-node-${version}`;
  const acceptance = Buffer.from(JSON.stringify({ version, archive_sha256: sha(tarBytes) }));
  const sums = Buffer.from(`${sha(tarBytes)}  ${tag}.tar\n`);
  return { [`${tag}.tar`]: tarBytes, [`${tag}.acceptance.json`]: acceptance, SHA256SUMS: sums };
}

// cutAfter: the first N tar responses are cut after that many bytes (the connection is destroyed, as the field failures were).
async function fakeApi(files, { served = files, cutAfter = 0, cuts = 0, honorRange = true, version = VERSION } = {}) {
  const names = Object.keys(files);
  const seen = { authToBlob: 0, ranges: [], tarRequests: 0, apiAuth: [], bytes: 0, downloads: [] };
  let cutsLeft = cuts;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === `/repos/o/r/releases/tags/fleet-node-${version}`) {
      seen.apiAuth.push(req.headers.authorization);
      return res.end(JSON.stringify({ assets: names.map((n, i) => ({ id: i + 1, name: n, size: files[n].length })) }));
    }
    const m = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (m) { seen.apiAuth.push(req.headers.authorization); res.writeHead(302, { location: `/blob/${names[m[1] - 1]}` }); return res.end(); }
    const b = /^\/blob\/(.+)$/.exec(url.pathname);
    if (b) {
      if (req.headers.authorization) seen.authToBlob++;
      const body = served[b[1]];
      seen.downloads.push(b[1]);
      let start = 0;
      const r = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (b[1].endsWith('.tar')) { seen.tarRequests++; seen.ranges.push(req.headers.range ?? null); }
      if (r && honorRange) { start = Number(r[1]); res.writeHead(206, { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, 'content-length': body.length - start }); } else res.writeHead(200, { 'content-length': body.length });
      if (b[1].endsWith('.tar') && cutsLeft > 0) { cutsLeft--; seen.bytes += cutAfter; res.write(body.subarray(start, start + cutAfter)); return setTimeout(() => res.destroy(), 20); }
      seen.bytes += body.length - start;
      return res.end(body.subarray(start));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}
const base = { version: VERSION, repo: 'o/r', getToken: () => FAKE_TOKEN, ...fast };

test('a tar cut off twice is continued with Range and ends with the accepted sha256', async () => {
  const tar = randomBytes(3 * 1024 * 1024), files = release(tar), api = await fakeApi(files, { cutAfter: 700000, cuts: 2 });
  const dir = await tmp();
  try {
    const r = await fetchPackage({ ...base, dir, apiBase: api.base });
    assert.equal(sha(await fs.readFile(r.artifact)), sha(tar));
    assert.equal(r.artifactSha256, sha(tar));
    assert.equal(r.source, 'release');
    assert.equal(r.resumed, 2);
    const [first, ...later] = api.seen.ranges, at = r => Number(/^bytes=(\d+)-$/.exec(r)?.[1]);   // how much arrived before each cut is the network's
    assert.equal(first, null);
    assert.ok(later.length === 2 && at(later[0]) > 0 && at(later[1]) > at(later[0]), api.seen.ranges.join(' '));
    assert.equal(api.seen.authToBlob, 0, 'the token goes to the API host, not to the download host');
    assert.ok(api.seen.apiAuth.every(a => a === `Bearer ${FAKE_TOKEN}`));
    assert.deepEqual((await fs.readdir(dir)).sort(), ['SHA256SUMS', `${TAG}.acceptance.json`, `${TAG}.tar`]);
    assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN));
  } finally { await api.close(); }
});

test('a server that ignores Range restarts from byte 0 and still ends at the accepted sha256', async () => {
  const tar = randomBytes(1024 * 1024), api = await fakeApi(release(tar), { cutAfter: 300000, cuts: 1, honorRange: false });
  try {
    const r = await fetchPackage({ ...base, dir: await tmp(), apiBase: api.base });
    assert.equal(sha(await fs.readFile(r.artifact)), sha(tar));
  } finally { await api.close(); }
});

test('a tar whose bytes are not the accepted ones is refused and deleted', async () => {
  const tar = randomBytes(500000), bad = Buffer.from(tar); bad[1000] ^= 1;
  const api = await fakeApi(release(tar), { served: { ...release(tar), [`${TAG}.tar`]: bad } });
  const dir = await tmp();
  try {
    await assert.rejects(fetchPackage({ ...base, dir, apiBase: api.base }), e => e.code === 'FETCH_ARCHIVE_SHA_MISMATCH');
    assert.ok(!(await fs.readdir(dir)).includes(`${TAG}.tar`));
  } finally { await api.close(); }
});

test('SHA256SUMS that disagrees with the acceptance is refused before any tar is fetched', async () => {
  const tar = randomBytes(1000), files = release(tar);
  files.SHA256SUMS = Buffer.from(`${sha(Buffer.from('x'))}  ${TAG}.tar\n`);
  const api = await fakeApi(files);
  try {
    await assert.rejects(fetchPackage({ ...base, dir: await tmp(), apiBase: api.base }), e => e.code === 'FETCH_SUMS_NOT_THE_ACCEPTANCE');
    assert.equal(api.seen.tarRequests, 0);
  } finally { await api.close(); }
});

test('the second source (--from) works with no API and no token; a wrong tar there is not used', async () => {
  const tar = randomBytes(200000), files = release(tar), from = await tmp();
  for (const [n, b] of Object.entries(files)) await fs.writeFile(path.join(from, n), b);
  const noNetwork = { ...base, apiBase: 'http://127.0.0.1:1', getToken: () => { throw new Error('token must not be read'); } };
  const r = await fetchPackage({ ...noNetwork, dir: await tmp(), from });
  assert.equal(r.source, 'from');
  assert.equal(sha(await fs.readFile(r.artifact)), sha(tar));
  await fs.writeFile(path.join(from, `${TAG}.tar`), randomBytes(200000));
  await assert.rejects(fetchPackage({ ...noNetwork, dir: await tmp(), from, deadlineMs: 50 }), e => e.code === 'FETCH_NO_GH_LOGIN' || e.code === 'FETCH_DEADLINE' || /token must not/.test(e.message));
});

test('an unreachable network ends at the deadline with FETCH_DEADLINE, not a hang', async () => {
  const r = fetchPackage({ ...base, dir: await tmp(), apiBase: 'http://127.0.0.1:1', deadlineMs: 200, backoffMs: () => 50 });
  await assert.rejects(r, e => e.code === 'FETCH_DEADLINE');
});

test('a second run in the same directory keeps the verified tar and downloads nothing', async () => {
  const tar = randomBytes(100000), api = await fakeApi(release(tar)), dir = await tmp();
  try {
    await fetchPackage({ ...base, dir, apiBase: api.base });
    const before = api.seen.tarRequests;
    const r = await fetchPackage({ ...base, dir, apiBase: api.base });
    assert.equal(r.source, 'already-here');
    assert.equal(api.seen.tarRequests, before);
  } finally { await api.close(); }
});

const transportVersion = 'g000025';
// Opt-in real Release bytes. The suite runner preserves TEMP and filters out
// arbitrary environment variables. Ordinary CI uses the generated fixtures.
const real = await fs.readFile(path.join(os.tmpdir(), 'fleet-transport-fixtures.json'), 'utf8')
  .then(JSON.parse, error => { if (error.code === 'ENOENT') return {}; throw error; });
const { g000025: real25, g000024: real24, g000023: real23 } = real;

async function transportRelease(t, tar, version, previous) {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = release(tar, version);
  const assets = await stageTransport({ repository: base.repo, version, archiveSha256: sha(tar), archive: tar, stage: dir,
    previous: previous && { ...previous, sha256: sha(previous.bytes) } });
  for (const { name, file } of assets) files[name] = await fs.readFile(file);
  return files;
}

async function measureFetch(t, { tar, previous, budget, source, assetDir, legacyFetch, version = transportVersion }) {
  const dir = await tmp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (previous) await fs.writeFile(path.join(dir, `fleet-node-${previous.version}.tar`), previous.bytes);
  const files = await transportRelease(t, tar, version, previous);
  if (assetDir) {
    for (const name of [`fleet-node-${version}.acceptance.json`, 'SHA256SUMS']) files[name] = await fs.readFile(path.join(assetDir, name));
  }
  const api = await fakeApi(files, { version });
  t.after(api.close);
  const options = { ...base, version, dir, apiBase: api.base };
  const result = await fetchPackage(options);
  assert.equal(sha(await fs.readFile(result.artifact)), sha(tar));
  assert.equal(result.source, source);
  t.diagnostic(`${version}: ${api.seen.bytes} bytes via ${result.source}`);
  assert.ok(api.seen.bytes <= budget, `${api.seen.bytes} > ${budget} bytes`);
  if (legacyFetch) {
    await fs.rm(result.artifact);
    const before = api.seen.bytes;
    const downloads = api.seen.downloads.length;
    const old = await legacyFetch(options);
    const bytes = api.seen.bytes - before;
    assert.equal(old.source, 'release');
    assert.equal(sha(await fs.readFile(old.artifact)), sha(tar));
    assert.deepEqual(api.seen.downloads.slice(downloads).sort(), ['SHA256SUMS', `fleet-node-${version}.acceptance.json`, `fleet-node-${version}.tar`]);
    assert.ok(bytes > budget, `legacy budget unexpectedly passed: ${bytes} <= ${budget}`);
    t.diagnostic(`${version}: ${bytes} bytes via legacy ${old.source}`);
  }
}

async function officialTar(dir, version) {
  const name = `fleet-node-${version}.tar`;
  const [tar, sums, accepted] = await Promise.all([fs.readFile(path.join(dir, name)), fs.readFile(path.join(dir, 'SHA256SUMS'), 'utf8'),
    fs.readFile(path.join(dir, `fleet-node-${version}.acceptance.json`), 'utf8')]);
  const { archive_sha256, version: acceptedVersion } = JSON.parse(accepted);
  assert.equal(acceptedVersion, version);
  assert.equal(sha(tar), archive_sha256);
  assert.ok(sums.split(/\r?\n/).includes(`${archive_sha256}  ${name}`));
  return tar;
}

async function legacyReader(tar) {
  const file = readTar(tar).find(({ path: name }) => name === 'tree/work/independent-ci-resident-v1/rollout/fleet/fetch.mjs');
  assert.ok(file, 'actual old standalone fetch.mjs');
  return (await import(`data:text/javascript;base64,${file.data.toString('base64')}`)).fetchPackage;
}

test('cold fetch transfers at most 75 MB and returns the accepted tar', async t => {
  const tar = real25 ? await officialTar(real25, transportVersion) : Buffer.alloc(82_736_640, 42);
  await measureFetch(t, { tar, budget: 75_000_000, source: 'release-gzip', assetDir: real25,
    legacyFetch: real24 ? await legacyReader(await officialTar(real24, 'g000024')) : null });
});

test('warm fetch transfers at most 8 MB from the exact previous generation', async t => {
  const actual = real24 && real25;
  const previous = { version: 'g000024', bytes: actual ? await officialTar(real24, 'g000024') : randomBytes(8_500_000) };
  const tar = actual ? await officialTar(real25, transportVersion) : Buffer.concat([previous.bytes, Buffer.from('next generation')]);
  await measureFetch(t, { tar, previous, budget: 8_000_000, source: 'release-delta', assetDir: actual ? real25 : null,
    legacyFetch: actual ? await legacyReader(previous.bytes) : null });
});

test('第 23→24 代实包的暖取和第 23 代旧读者兼容', { skip: !real23 || !real24 }, async t => {
  const previous = { version: 'g000023', bytes: await officialTar(real23, 'g000023') };
  await measureFetch(t, { version: 'g000024', tar: await officialTar(real24, 'g000024'), previous, budget: 8_000_000,
    source: 'release-delta', assetDir: real24, legacyFetch: await legacyReader(previous.bytes) });
});

test('损坏、超界解压和错代压缩表示都回到正式 tar，坏正式 tar 留不下候选', async t => {
  const tar = Buffer.alloc(256_000, 7);
  const version = transportVersion, tarName = `fleet-node-${version}.tar`;
  const { meta, payload } = transportAssetNames(version, 'gzip');
  const fixture = await transportRelease(t, tar, version);
  for (const fault of ['corrupt', 'output-limit', 'wrong-version', 'wrong-object', 'no-valid-tar']) {
    const files = { ...fixture };
    const info = JSON.parse(files[meta]);
    if (fault === 'output-limit') {
      files[payload] = gzipSync(Buffer.alloc(tar.length + 1, 7));
      Object.assign(info, { bytes: files[payload].length, sha256: sha(files[payload]) });
    } else if (fault === 'wrong-version') info.version = 'g000024';
    else if (fault === 'wrong-object') info.archive_sha256 = 'a'.repeat(64);
    else files[payload] = randomBytes(files[payload].length);
    files[meta] = Buffer.from(JSON.stringify(info));
    if (fault === 'no-valid-tar') files[tarName] = Buffer.alloc(tar.length, 9);
    const api = await fakeApi(files, { version });
    t.after(api.close);
    const dir = await tmp();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const result = fetchPackage({ ...base, version, dir, apiBase: api.base });
    if (fault === 'no-valid-tar') {
      await assert.rejects(result, { code: 'FETCH_ARCHIVE_SHA_MISMATCH' });
      assert.equal(api.seen.tarRequests, 2);
      await assert.rejects(fs.stat(path.join(dir, tarName)), { code: 'ENOENT' });
    } else {
      assert.equal((await result).source, 'release');
      assert.equal(sha(await fs.readFile(path.join(dir, tarName))), sha(tar));
      assert.equal(api.seen.tarRequests, 1);
    }
    assert.equal(api.seen.downloads.includes(payload), !fault.startsWith('wrong-'), fault);
    assert.ok(!(await fs.readdir(dir)).some(name => name.startsWith('.fleet-transport-')), fault);
  }
});

test('旧代缺失、损坏、跳代及坏增量均只回落一次到完整压缩资产', async t => {
  const previous = { version: 'g000024', bytes: Buffer.concat([randomBytes(200_000), Buffer.alloc(300_000, 10)]) };
  const tar = Buffer.concat([previous.bytes, Buffer.from('updated')]);
  const version = transportVersion;
  const { meta, payload } = transportAssetNames(version, 'delta');
  const fixture = await transportRelease(t, tar, version, previous);
  for (const fault of ['missing', 'corrupt-base', 'skipped', 'wrong-base-version', 'bad-copy', 'patch-limit']) {
    const files = { ...fixture };
    const dir = await tmp();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    if (fault !== 'missing') {
      const label = fault === 'skipped' ? 'g000023' : previous.version;
      const bytes = fault === 'corrupt-base' ? Buffer.alloc(previous.bytes.length, 1) : previous.bytes;
      await fs.writeFile(path.join(dir, `fleet-node-${label}.tar`), bytes);
    }
    const info = JSON.parse(files[meta]);
    if (fault === 'wrong-base-version') info.base.version = 'g000023';
    if (fault === 'bad-copy' || fault === 'patch-limit') {
      const patch = fault === 'patch-limit' ? Buffer.alloc(TRANSPORT.patchMax + 1) : Buffer.alloc(8);
      patch.writeUInt32LE(previous.bytes.length, 0);
      patch.writeUInt32LE(1, 4);
      files[payload] = gzipSync(patch);
      Object.assign(info, { bytes: files[payload].length, sha256: sha(files[payload]) });
    }
    files[meta] = Buffer.from(JSON.stringify(info));
    const api = await fakeApi(files, { version });
    t.after(api.close);
    const result = await fetchPackage({ ...base, version, dir, apiBase: api.base });
    assert.equal(result.source, 'release-gzip', fault);
    assert.equal(sha(await fs.readFile(result.artifact)), sha(tar));
    assert.equal(api.seen.downloads.filter(name => name === transportAssetNames(version, 'gzip').payload).length, 1);
    assert.equal(api.seen.tarRequests, 0);
    assert.equal(api.seen.downloads.includes(payload), ['bad-copy', 'patch-limit'].includes(fault), fault);
  }
});
