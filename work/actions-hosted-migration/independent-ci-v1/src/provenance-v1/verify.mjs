// Read-only verification of the provenance attestations of one commit (L4, optimisation plan bf57ff10).
//   node verify.mjs --sha <40-hex commit> --pubkey <ed25519 public key PEM> [--pubkey ...] [--keyid <id>] [--dir <receipts dir>]
//                   [--role <role>] [--repo <git checkout, to check the tree subject>] [--json]
// For every <sha>-*.dsse.json: DSSE signature with the given public key(s), in-toto Statement v1 / SLSA provenance v1 fields,
// the commit subject equal to <sha>, a tree subject (if present) equal to the checkout's tree. Exit 0 only when at least one
// file was found and every one verified. It writes nothing, signs nothing, contacts nothing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyDsse } from './dsse.mjs';
import { validateStatementV1 } from './statement.mjs';
import { listProvenance, MAX_PROVENANCE_BYTES, PROVENANCE_DIRECTORY, LINUX_PROVENANCE_DIR } from './store.mjs';
import { STATE_V2 } from '../resident-v2/layout.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const code = e => (typeof e?.code === 'string' && /^[a-z][a-z0-9_:.-]{0,100}$/.test(e.code) ? e.code : 'provenance_unverifiable');

// publicKeys: [{ keyId?: string, pem: string }]. treeOf(sha): optional async -> tree sha (e.g. from `git rev-parse`).
export async function verifyProvenanceForCommit({ dir, sha, publicKeys, role = null, treeOf = null }) {
  if (!SHA1.test(sha ?? '')) throw Object.assign(new Error('commit_sha_invalid'), { code: 'commit_sha_invalid' });
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) throw Object.assign(new Error('public_key_required'), { code: 'public_key_required' });
  const results = [];
  for (const file of await listProvenance(dir, sha)) {
    const entry = { file: path.basename(file), ok: false };
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size > MAX_PROVENANCE_BYTES) throw Object.assign(new Error('provenance_file_invalid'), { code: 'provenance_file_invalid' });
      const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
      let body = null, lastError = null;
      for (const k of publicKeys) {
        try { body = verifyDsse({ envelope, publicKey: k.pem, keyId: k.keyId ?? null }); break; } catch (e) { lastError = e; }
      }
      if (!body) throw lastError ?? Object.assign(new Error('dsse_signature_invalid'), { code: 'dsse_signature_invalid' });
      if (envelope.payloadType !== 'application/vnd.in-toto+json') throw Object.assign(new Error('dsse_payload_type'), { code: 'dsse_payload_type' });
      const statement = JSON.parse(body.toString('utf8'));
      validateStatementV1(statement);
      const commit = statement.subject.find(s => s.digest.gitCommit === sha);
      if (!commit) throw Object.assign(new Error('provenance_subject_mismatch'), { code: 'provenance_subject_mismatch' });
      const tree = statement.subject.find(s => s.digest.gitTree);
      if (tree && treeOf) {
        if ((await treeOf(sha)) !== tree.digest.gitTree) throw Object.assign(new Error('provenance_tree_mismatch'), { code: 'provenance_tree_mismatch' });
        entry.treeChecked = true;
      }
      const ep = statement.predicate.buildDefinition.externalParameters;
      Object.assign(entry, { role: ep.role, jobId: ep.jobId, attempt: ep.attempt, conclusion: JSON.parse(Buffer.from(statement.predicate.runDetails.byproducts.find(b => b.name === 'check-result').content, 'base64')).conclusion,
        builder: statement.predicate.runDetails.builder.id });
      if (role !== null && ep.role !== role) { entry.skipped = true; entry.ok = true; } else entry.ok = true;
    } catch (e) { entry.error = code(e); }
    results.push(entry);
  }
  const considered = results.filter(r => !r.skipped);
  return { sha, found: results.length, verified: considered.filter(r => r.ok).length, ok: considered.length > 0 && considered.every(r => r.ok), results };
}

export function parseArgs(argv) {
  const o = { pubkey: [], keyid: null, dir: null, role: null, repo: null, sha: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (['--sha', '--dir', '--role', '--repo', '--keyid'].includes(a) && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else if (a === '--pubkey' && i + 1 < argv.length) o.pubkey.push(argv[++i]);
    else throw Object.assign(new Error('usage'), { code: 'usage' });
  }
  return o;
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  let o;
  try { o = parseArgs(argv); } catch { out.write('usage: verify.mjs --sha <commit> --pubkey <pem> [--pubkey <pem>] [--keyid <id>] [--dir <dir>] [--role <role>] [--repo <checkout>] [--json]\n'); return 2; }
  if (!SHA1.test(o.sha ?? '') || o.pubkey.length === 0) { out.write('usage: --sha (40 hex) and at least one --pubkey are required\n'); return 2; }
  const dir = o.dir ?? (process.platform === 'win32' ? `${STATE_V2.receipts}\\${PROVENANCE_DIRECTORY}` : LINUX_PROVENANCE_DIR);
  const publicKeys = [];
  for (const f of o.pubkey) publicKeys.push({ keyId: o.keyid, pem: await fs.readFile(f, 'utf8') });
  const treeOf = o.repo ? async sha => (await promisify(execFile)('git', ['-C', o.repo, 'rev-parse', '--verify', `${sha}^{tree}`], { windowsHide: true, timeout: 15000 })).stdout.trim() : null;
  let report;
  try { report = await verifyProvenanceForCommit({ dir, sha: o.sha, publicKeys, role: o.role, treeOf }); }
  catch (e) { out.write(`refused: ${code(e)}\n`); return 2; }
  if (o.json) out.write(JSON.stringify(report) + '\n');
  else {
    out.write(`commit ${report.sha}: ${report.verified}/${report.found} attestation(s) verified\n`);
    for (const r of report.results) out.write(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.file}${r.role ? ` role=${r.role} conclusion=${r.conclusion}` : ''}${r.error ? ` error=${r.error}` : ''}${r.skipped ? ' (other role)' : ''}\n`);
    if (report.found === 0) out.write('  no attestation found for this commit\n');
  }
  return report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
