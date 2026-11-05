// Run after both Workers are deployed and the live commit is attested
// (StorageNormalUse.v0.1 §4.5, Owner decision 7210e5a5). Asks production's
// main Worker to send its fixed built-in check PDF through the PDF_EXTRACTOR
// service binding to clued-storage-pdf (the extractor parses its fixed check
// PDF outside the user PDF slot), and requires the expected text back and the
// extractor's own marker to name exactly the repository's contract and version. A
// missing binding, an extractor of another version or a failed round trip
// blocks the release.
import { readFile, writeFile } from 'node:fs/promises';

export const PRODUCTION_ORIGIN = 'https://kooyumi.pixelgrav.com';
export const CHECK_PATH = '/v1/storage/pdf-extractor/check';
/** 8 attempts 10 s apart: longer than the route's 60 s per-isolate cache of an OK result. */
export const ATTEMPTS = 8;
const commonSource = new URL('../worker/storage-read-pdf-common.ts', import.meta.url);

/** The extractor contract and version the repository's main Worker requires. */
export function expectedExtractorOf(source) {
  const contract = /export const PDF_EXTRACTOR_CONTRACT = "([^"]+)";/.exec(source ?? '')?.[1];
  const version = /export const PDF_EXTRACTOR_VERSION = (\d+);/.exec(source ?? '')?.[1];
  return contract && version ? { contract, version: Number(version) } : null;
}

export function verifyPdfExtractorCheck({ expected, status, body, notBefore }) {
  const errors = [];
  // A fresh round trip: not an answer the route replayed from before this
  // verification started (5 s allowance for clock skew).
  if (typeof notBefore === 'number' && body?.status === 'ok' && body?.cached !== false &&
      !(Date.parse(body?.checked_at ?? '') >= notBefore - 5_000)) errors.push('pdf_extractor_check_not_fresh');
  if (!expected) errors.push('repository_extractor_contract_missing');
  if (status !== 200) errors.push(`pdf_extractor_check_http_${status}`);
  if (body?.contract !== 'clued.storage-pdf-extractor-check/1') errors.push('pdf_extractor_check_contract_invalid');
  if (body?.status !== 'ok') errors.push(`pdf_extractor_check_${typeof body?.code === 'string' && /^[a-z_]{1,64}$/.test(body.code) ? body.code : 'failed'}`);
  if (expected && (body?.extractor?.contract !== expected.contract || body?.extractor?.version !== expected.version)) {
    errors.push('pdf_extractor_version_mismatch');
  }
  return errors;
}

async function check(commit) {
  const response = await fetch(`${PRODUCTION_ORIGIN}${CHECK_PATH}?release=${commit}`, {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' },
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

async function main() {
  const commit = process.env.GITHUB_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('source_commit_missing');
  const expected = expectedExtractorOf(await readFile(commonSource, 'utf8'));
  // A freshly deployed version can take a few seconds to serve everywhere, and
  // a main Worker isolate serves its last check result again for up to 60 s
  // (failures for 5 s), so the attempts span more than that window.
  let errors = [], last;
  const notBefore = Date.now();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    last = await check(commit).catch(() => ({ status: 0, body: null }));
    errors = verifyPdfExtractorCheck({ expected, notBefore, ...last });
    if (!errors.length) break;
    if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, 10_000));
  }
  if (errors.length) throw new Error(`pdf_extractor_blocked:${errors.join(',')}`);
  const result = { status: 'passed', source_commit: commit, extractor: expected, check: last.body, checked_at: new Date().toISOString() };
  const evidenceIndex = process.argv.indexOf('--evidence-out');
  if (evidenceIndex >= 0) {
    const path = process.argv[evidenceIndex + 1];
    if (!path) throw new Error('evidence_path_required');
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'pdf_extractor_unexpected_error'}\n`);
    process.exitCode = 1;
  });
}
