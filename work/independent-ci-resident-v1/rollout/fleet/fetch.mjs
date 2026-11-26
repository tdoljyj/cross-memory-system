// Fetch one universal node package onto a node, over a network that drops connections (the node side of `upgrade.mjs fetch`).
// Zero imports from the package, so this one file also runs before any package is unpacked.
//
// The three release assets fleet-node-<v>.tar, fleet-node-<v>.acceptance.json and SHA256SUMS come from the GitHub Release API
// (resumable: a `.part` file continued with `Range: bytes=<have>-`, backoff between attempts, one total deadline), or from a second
// source, a directory holding the same file names (--from). No source is trusted: the tar is accepted only when its sha256 equals
// the acceptance's archive_sha256 and its SHA256SUMS line. A tar that does not match is deleted, never unpacked.
// The token comes from `gh auth token` inside this process only: never printed, written, or put in a child's environment, and
// sent to the API host only (never to the redirect target).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_REPO = 'tdoljyj/cross-memory-system';
export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
const IDLE_MS = 30000;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`), { code, detail }); };
const check = (ok, code, detail) => { if (!ok) fail(code, detail); };
const fatal = (code, detail) => { throw Object.assign(new Error(code), { code, detail, fatal: true }); };

export function ghToken(timeout) {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL' });
  const t = String(r.stdout ?? '').trim();
  check(r.status === 0 && t, 'FETCH_NO_GH_LOGIN', 'gh auth token gave nothing: log in with gh, or give --from');
  return t;
}

// One GET, redirects not followed: { status, headers, res }. An idle connection (no byte for IDLE_MS) is aborted.
function get(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'user-agent': 'fleet-node-fetch', ...headers }, signal }, res => resolve({ status: res.statusCode, headers: res.headers, res }));
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('idle timeout')));
    req.on('error', reject);
  });
}
const readAll = async res => { const c = []; for await (const b of res) c.push(b); return Buffer.concat(c); };
export const sha256File = file => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  fsSync.createReadStream(file).on('data', b => h.update(b)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

// The companion's anonymous lane. GitHub's direct asset links don't require a release listing or a credential.
// Resolve redirects anew on every try so a partial download never depends on a cached, expired signed URL.
export async function fetchFleetReleaseAsset({ repository, version, name, file, maxBytes, deadline,
  releaseBase = 'https://github.com', now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  check(REPO.test(repository) && VERSION.test(version) && /^[A-Za-z0-9._+-]+$/.test(name), 'FETCH_ASSET_REFUSED');
  const release = new URL(`/${repository}/releases/download/fleet-node-${encodeURIComponent(version)}/${encodeURIComponent(name)}`, releaseBase);
  const part = `${file}.part`;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) fatal('FETCH_DEADLINE');
    try {
      let have = (await fs.stat(part).catch(() => ({ size: 0 }))).size;
      if (have > maxBytes) { await fs.rm(part, { force: true }); have = 0; }
      const signal = AbortSignal.timeout(remaining);
      let url = release;
      let response;
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await get(url, have > 0 ? { range: `bytes=${have}-` } : {}, signal);
        if (response.status < 300 || response.status >= 400 || !response.headers.location) break;
        response.res.resume();
        url = new URL(response.headers.location, url);
        if (url.protocol !== release.protocol || url.username || url.password || redirects === 5) fatal('FETCH_REDIRECT_REFUSED');
      }
      const { status, headers, res } = response;
      if (status === 404) { res.resume(); return false; }
      const length = Number(headers['content-length']);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] ?? '');
      if (status === 416 || (status === 206 && (!range || Number(range[1]) !== have || Number(range[2]) + 1 !== Number(range[3])))) {
        res.resume(); await fs.rm(part, { force: true }); throw new Error('FETCH_RANGE_REFUSED');
      }
      if (status !== 200 && status !== 206) { res.resume(); throw new Error(`FETCH_HTTP_${status}`); }
      const start = status === 206 ? have : 0;
      const total = status === 206 ? Number(range[3]) : length;
      if (total > maxBytes) { res.destroy(); fatal('FETCH_ASSET_TOO_LARGE'); }
      let received = start;
      const bound = new Transform({ transform(chunk, _, callback) {
        received += chunk.length;
        callback(received > maxBytes ? Object.assign(new Error('FETCH_ASSET_TOO_LARGE'), { fatal: true }) : null, chunk);
      } });
      await pipeline(res, bound, fsSync.createWriteStream(part, { flags: status === 206 ? 'a' : 'w' }));
      if (Number.isFinite(total) && received !== total) throw new Error('FETCH_SHORT_BODY');
      await fs.rename(part, file);
      return true;
    } catch (error) {
      if (error.fatal) throw error;
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      if (now() + delay >= deadline) fail('FETCH_DEADLINE', { name, last: String(error.message).slice(0, 100) });
      await sleep(delay);
    }
  }
}

export async function fetchPackage({ version, dir, repo = DEFAULT_REPO, from = null, apiBase = 'https://api.github.com', getToken = ghToken,
  deadlineMs = DEFAULT_DEADLINE_MS, deadline, expectedArchiveSha256, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, backoffMs = n => Math.min(30000, 1000 * 2 ** n) }) {
  check(VERSION.test(version ?? ''), 'USAGE', 'version');
  check(REPO.test(repo), 'USAGE', 'repo');
  check(typeof dir === 'string' && dir, 'USAGE', 'dir');
  const tag = `fleet-node-${version}`;
  const name = { tar: `${tag}.tar`, acceptance: `${tag}.acceptance.json`, sums: 'SHA256SUMS' };
  const stop = Math.min(now() + deadlineMs, deadline ?? Infinity);
  const remaining = () => {
    const left = stop - now();
    if (!(left > 0)) fatal('FETCH_DEADLINE');
    return left;
  };
  const signal = () => AbortSignal.timeout(remaining());
  await fs.mkdir(dir, { recursive: true });
  const out = n => path.join(dir, n);
  let token = null, assets = null;
  const log = { attempts: 0, resumed: 0, source: null };

  const retrying = async (what, fn) => {
    for (let n = 0; ; n++) {
      try { return await fn(); } catch (e) {
        if (e?.fatal) throw e;
        const wait = backoffMs(n);
        if (now() + wait >= stop) fail('FETCH_DEADLINE', { what, last: String(e?.message ?? e).slice(0, 200) });
        await sleep(wait);
      }
    }
  };
  const apiGet = (p, accept) => { token ??= getToken(remaining()); return get(`${apiBase}${p}`, { authorization: `Bearer ${token}`, accept }, signal()); };
  const listAssets = () => retrying('release', async () => {
    const r = await apiGet(`/repos/${repo}/releases/tags/${tag}`, 'application/vnd.github+json');
    const body = await readAll(r.res);
    if (r.status === 404) fatal('FETCH_NO_SUCH_RELEASE', tag);
    if (r.status === 401 || r.status === 403) fatal('FETCH_API_REFUSED', r.status);
    if (r.status !== 200) throw new Error(`release lookup ${r.status}`);
    return new Map(JSON.parse(body.toString('utf8')).assets.map(a => [a.name, a]));
  });
  // One attempt: resolve the asset's download URL (fresh each time: it expires), continue the `.part` file at its length.
  const attempt = async (asset, part) => {
    log.attempts++;
    const api = await apiGet(`/repos/${repo}/releases/assets/${asset.id}`, 'application/octet-stream');
    api.res.resume();
    if (!(api.status >= 300 && api.status < 400 && api.headers.location)) throw new Error(`asset lookup ${api.status}`);
    const target = new URL(api.headers.location, apiBase).href;
    let have = (await fs.stat(part).catch(() => ({ size: 0 }))).size;
    if (have > asset.size) { await fs.rm(part, { force: true }); have = 0; }
    if (have === asset.size) return;
    const r = await get(target, have > 0 ? { range: `bytes=${have}-` } : {}, signal());
    let flags = 'a';
    if (r.status === 206) {
      const m = /^bytes (\d+)-/.exec(r.headers['content-range'] ?? '');
      if (!m || Number(m[1]) !== have) { r.res.resume(); await fs.rm(part, { force: true }); throw new Error('content-range does not continue the part file'); }
      log.resumed++;
    } else if (r.status === 200) {
      flags = 'w';
    } else {
      r.res.resume();
      if (r.status === 416) await fs.rm(part, { force: true });
      throw new Error(`download ${r.status}`);
    }
    const w = fsSync.createWriteStream(part, { flags });
    try {
      for await (const b of r.res) if (!w.write(b)) await new Promise(res => w.once('drain', res));
    } finally { await new Promise(res => w.end(res)); }   // whatever arrived before a drop stays: the next attempt continues there
    const size = (await fs.stat(part)).size;
    if (size !== asset.size) throw new Error(`short body ${size}/${asset.size}`);
  };
  const fromRelease = async n => {
    assets ??= await listAssets();
    const asset = assets.get(n);
    if (!asset) fatal('FETCH_ASSET_MISSING', n);
    const part = out(`${n}.part`);
    await retrying(n, () => attempt(asset, part));
    await fs.rename(part, out(n));
  };
  const fromDir = async n => {
    if (!from) return false;
    const src = path.join(from, n);
    if (!(await fs.stat(src).catch(() => null))) return false;
    await fs.copyFile(src, out(`${n}.part`));
    await fs.rename(out(`${n}.part`), out(n));
    return true;
  };
  // the small files: the second source when it has them, else the release
  const small = async n => { if (!(await fromDir(n))) await fromRelease(n); return fs.readFile(out(n)); };

  const acc = JSON.parse((await small(name.acceptance)).toString('utf8').replace(/^\uFEFF/, ''));
  check(HEX64.test(acc?.archive_sha256 ?? '') && acc.version === version, 'FETCH_ACCEPTANCE_NOT_THIS_VERSION', { version: acc?.version ?? null });
  check(expectedArchiveSha256 === undefined || acc.archive_sha256 === expectedArchiveSha256, 'FETCH_SUMS_NOT_THE_ACCEPTANCE',
    { expected: expectedArchiveSha256, acceptance: acc.archive_sha256 });
  const sums = (await small(name.sums)).toString('utf8').split(/\r?\n/).map(l => /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(l)).filter(Boolean);
  const listed = sums.find(m => m[2] === name.tar)?.[1]?.toLowerCase();
  check(listed === acc.archive_sha256, 'FETCH_SUMS_NOT_THE_ACCEPTANCE', { sums: listed ?? null, acceptance: acc.archive_sha256 });

  // the tar: an earlier run's file, the second source, then the release (one clean restart if a resume ended wrong); only the hash decides
  const tarOk = async src => { const ok = (await sha256File(out(name.tar)).catch(() => null)) === acc.archive_sha256; if (ok) log.source = src; return ok; };
  let ok = await tarOk('already-here');
  if (!ok && await fromDir(name.tar)) ok = await tarOk('from');
  for (let i = 0; !ok && i < 2; i++) {
    await fs.rm(out(name.tar), { force: true });
    await fromRelease(name.tar);
    ok = await tarOk('release');
  }
  if (!ok) await fs.rm(out(name.tar), { force: true });
  check(ok, 'FETCH_ARCHIVE_SHA_MISMATCH', { expected: acc.archive_sha256 });
  return { version, artifact: out(name.tar), artifactSha256: acc.archive_sha256, acceptance: out(name.acceptance), attempts: log.attempts, resumed: log.resumed, source: log.source };
}
