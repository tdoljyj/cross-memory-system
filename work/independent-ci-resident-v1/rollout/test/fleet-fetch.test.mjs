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
import { fetchPackage } from '../fleet/fetch.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const VERSION = '2026.11.15-1', TAG = `fleet-node-${VERSION}`, FAKE_TOKEN = 'fake-token-for-test';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fetch-'));
const fast = { backoffMs: () => 1 };

function release(tarBytes) {
  const acceptance = Buffer.from(JSON.stringify({ version: VERSION, archive_sha256: sha(tarBytes) }));
  const sums = Buffer.from(`${sha(tarBytes)}  ${TAG}.tar\n`);
  return { [`${TAG}.tar`]: tarBytes, [`${TAG}.acceptance.json`]: acceptance, SHA256SUMS: sums };
}

// cutAfter: the first N tar responses are cut after that many bytes (the connection is destroyed, as the field failures were).
async function fakeApi(files, { served = files, cutAfter = 0, cuts = 0, honorRange = true } = {}) {
  const names = Object.keys(files);
  const seen = { authToBlob: 0, ranges: [], tarRequests: 0, apiAuth: [] };
  let cutsLeft = cuts;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === `/repos/o/r/releases/tags/${TAG}`) {
      seen.apiAuth.push(req.headers.authorization);
      return res.end(JSON.stringify({ assets: names.map((n, i) => ({ id: i + 1, name: n, size: files[n].length })) }));
    }
    const m = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (m) { seen.apiAuth.push(req.headers.authorization); res.writeHead(302, { location: `/blob/${names[m[1] - 1]}` }); return res.end(); }
    const b = /^\/blob\/(.+)$/.exec(url.pathname);
    if (b) {
      if (req.headers.authorization) seen.authToBlob++;
      const body = served[b[1]];
      let start = 0;
      const r = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (b[1].endsWith('.tar')) { seen.tarRequests++; seen.ranges.push(req.headers.range ?? null); }
      if (r && honorRange) { start = Number(r[1]); res.writeHead(206, { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, 'content-length': body.length - start }); } else res.writeHead(200, { 'content-length': body.length });
      if (b[1].endsWith('.tar') && cutsLeft > 0) { cutsLeft--; res.write(body.subarray(start, start + cutAfter)); return setTimeout(() => res.destroy(), 20); }
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
