// realize-nw02-subject.mjs -- substitutes the five sentinels in the NW-02 continuation subject
// and prints the resulting subject_sha256, which the three downstream documents and the SQL all
// pin. Run after NW02AdjudicationsRound1.md settles what each sentinel resolves to.
//
//   node realize-nw02-subject.mjs [--write]
//
// Why a script rather than an edit: the subject is canonical JSON (sorted keys, compact
// separators, trailing LF) and its digest is the whole point of the document. A hand edit that
// perturbs a separator changes subject_sha256 silently, and every downstream digest with it.
// Each sentinel is asserted to occur exactly once before substitution, and the result is
// re-canonicalised and required to be byte-identical to the substituted text -- so a substitution
// that produced non-canonical bytes refuses instead of shipping.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..', '..', '..');
const SUBJECT = path.join(HERE, 'ContinuationRegistrationSubject.canonical.json');
const WRITE = process.argv.includes('--write');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const rel = p => path.relative(REPO, p).replaceAll('\\', '/');

// Repo-relative paths whose digests are computed here rather than pasted, so a stale digest is
// impossible: the file is read and hashed at substitution time.
const VERIFICATION = path.join(HERE, '..', 'OwnerApprovalVerification.json');
// NW02-R1 (independent acceptance, REFUSED the previous choice): the proposal is the PR 164 body,
// captured verbatim from the API alongside OwnerApprovalVerification.json. The earlier choice --
// the window12 work plan -- was refused because its Owner-actions section, the only
// document-specific ground cited for it, had itself been measured defective by NW02-F1 in this
// same directory (three actions listed, four owed). The PR body states those obligations
// correctly and carries the NW-01 proposal structure section for section.
const PROPOSAL = path.join(HERE, '..', 'OwnerApprovalProposalPR164.md');

for (const f of [SUBJECT, VERIFICATION, PROPOSAL]) {
  if (!fs.existsSync(f)) throw new Error('MISSING_INPUT: ' + rel(f));
}

// The merge verification string. Mirrors NW-01's approval.verification form exactly
// ("verified:true;reason:valid"). The VALUES come from the captured evidence file rather than
// from this script's own belief -- if that file ever says something else, this refuses.
const verification = JSON.parse(fs.readFileSync(VERIFICATION, 'utf8'));
const v = verification?.merge?.verification ?? {};
if (v.verified !== true || v.reason !== 'valid') {
  throw new Error('EVIDENCE_DOES_NOT_ATTEST_A_VERIFIED_MERGE: verified=' + v.verified + ' reason=' + v.reason);
}
if (verification?.merge?.sha !== 'f92cd46e42e20e1fa305c573964e0597230c0b65') {
  throw new Error('EVIDENCE_IS_FOR_A_DIFFERENT_MERGE: ' + verification?.merge?.sha);
}
const verificationString = 'verified:' + v.verified + ';reason:' + v.reason;

const SUBS = [
  ['__PENDING_M3_MERGE_VERIFICATION_STRING__', verificationString],
  ['__PENDING_M3_OWNER_APPROVAL_VERIFICATION_PATH__', rel(VERIFICATION)],
  ['__PENDING_M3_OWNER_APPROVAL_VERIFICATION_SHA256__', sha256(fs.readFileSync(VERIFICATION))],
  // Superseded adjudication, kept for the record: open point 3 first chose the plan document on a
  // same-merge argument. Independent acceptance refused it (NW02-R1) -- same-merge does not
  // discriminate among 48 files, and the one specific ground was self-refuted. Now the captured
  // proposal itself.
  ['__PENDING_M3_PROPOSAL_PATH__', rel(PROPOSAL)],
  ['__PENDING_M3_PROPOSAL_SHA256__', sha256(fs.readFileSync(PROPOSAL))],
];

let text = fs.readFileSync(SUBJECT, 'utf8');
const before = sha256(Buffer.from(text, 'utf8'));
const count = (h, n) => h.split(n).length - 1;
let ok = true;
for (const [sentinel, value] of SUBS) {
  const n = count(text, sentinel);
  if (n !== 1) { console.error('  WRONG   ' + sentinel + ' x' + n + ', expected 1'); ok = false; continue; }
  console.log('  ok      ' + sentinel + '\n            -> ' + value);
  text = text.split(sentinel).join(value);
}
if (!ok) throw new Error('SENTINEL_CENSUS_DRIFT');

const stray = text.match(/__PENDING_[A-Z0-9_]*__/g);
if (stray) throw new Error('SENTINEL_SURVIVED: ' + [...new Set(stray)].join(', '));

// Canonical form must survive substitution, or the digest below is of malformed bytes.
const recanon = JSON.stringify(JSON.parse(text), Object.keys(JSON.parse(text)).sort() && null, 0);
const canonical = (() => {
  const sortDeep = x => Array.isArray(x) ? x.map(sortDeep)
    : (x && typeof x === 'object')
      ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortDeep(x[k])]))
      : x;
  return JSON.stringify(sortDeep(JSON.parse(text)), null, 0) + '\n';
})();
if (canonical !== text) throw new Error('NOT_CANONICAL_AFTER_SUBSTITUTION: re-canonicalising differs from the substituted bytes');
void recanon;

const after = sha256(Buffer.from(text, 'utf8'));
if (after === before) throw new Error('NO_CHANGE: substitution produced identical bytes');

if (WRITE) {
  fs.writeFileSync(SUBJECT, text);
  console.log('\nwrote ' + rel(SUBJECT));
} else {
  console.log('\ndry run only; re-run with --write.');
}
console.log('  subject_sha256 = ' + after);
console.log('\nThis digest is accepted_binding.subject_sha256, and it is pinned by the three');
console.log('downstream documents and by the NW-02 SQL. Regenerate all of them from this value:');
console.log('  node build-nw02-sql.mjs   (after the three documents are reissued)');
