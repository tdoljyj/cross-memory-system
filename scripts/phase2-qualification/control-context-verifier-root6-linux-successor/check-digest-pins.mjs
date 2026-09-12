// Every sha256 literal in this controller must be explained. Unexplained means refused.
//
// This replaces check-sibling-pins.mjs, which was fail-open: it recognised two Python syntax
// shapes and silently counted everything else as consistent. Round 16 showed what that costs.
// host-effect.mjs pins bridge.py's digest in a JS expression the regexes did not match, so when
// the previous round's repair changed bridge.py, that pin went stale and degraded into pointing
// at the PREDECESSOR controller's bridge.py -- and the gate printed "sibling pins consistent"
// on the same run. The gate missed the very damage it had just caused.
//
// Two changes follow from that.
//
// Fail closed. Every 64-hex literal in every controller file must resolve to something. A literal
// nobody can account for is an error, not silence.
//
// BUT THIS IS NOT THE AUTHORITATIVE CHECK, and round 17 is why. Seven ways of writing a digest
// walked past it, including R16-F1 rewritten as 'aaa'+'bbb'. That is not a missing regex; it is
// what textual analysis is. What matters is the value the code COMPARES AT RUNTIME, and source
// text is only evidence about that. selftest-runtime-pins.mjs asks the code instead, and catches
// the concatenation case this scan still cannot see. Both are required by
// build-linux-manifest.mjs: this one is cheap and runs first, that one decides.
//
// Repair by identity, not by syntax. The defect has the same signature all four times: a literal
// equals the digest of a PREDECESSOR controller's copy of a file that also exists here. That is
// recognisable without parsing how the pin is written, so repair matches on it directly and works
// for Python, JavaScript, or any shape added later.
//
//   node check-digest-pins.mjs           report only; non-zero exit if anything is unexplained
//   node check-digest-pins.mjs --write   repair to a fixed point, then report
//
// Pins are a chain -- parent600.py, fixed_host.py, bridge.py, host-effect.mjs -- so repairing one
// changes its digest and invalidates the pin above it. Repair iterates to a fixed point.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const QUAL = path.resolve(DIR, '..');
const APPLY = process.argv.includes('--write');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// Case-insensitive: R17 showed an uppercase digest walked straight past the lowercase class.
const HEX = /\b[a-fA-F0-9]{64}\b/g;

// Digests that are deliberately not the digest of any file. Each needs a reason; anything not
// listed here and not resolvable to a file fails the gate.
const DECLARED_NON_FILE = {
  ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b:
    'proposalSHA. The file it described was lost with the old host; the constant is cross-checked against approved.proposal_sha256 and appendix.proposal_sha256 from merged materials.',
  '64b2ba3ef6bfe2755b78e03b19d6a6b6ea5a0e3735c4b9328e9be2c4715dff07':
    'BASELINE_EVENTS_DIGEST. canonicalDigest over the first 44 execution_events, measured from the live store.',
  b27286d6fcb54e34a62d8738f49c1ecafe3210c9a321a703c3828e38497e434c:
    'failed_receipt_sha256 for ga_04377008. A receipt digest recorded in the control store, not a file.',
  cb5704c053850f1484f39f4396d638f2e603b7df48f6eb7045fea36b8f072654:
    'query_sha256. Digest of the fixed SQL text the trusted entry issues, not a file.',
  acaf2073c654be95a3beab820f1460de1e6e68caa267e9c75bdd3c891bd894b3:
    'inherited STATUS issuer-purpose digest.',
  b6d4782fcf79cf599f3ccc7e2c7b7434e41a26c6d4a28c6711eac0c9f469e146:
    'inherited GATE_AUTHORIZATION and GATE_RESULT issuer-purpose digest.',
  '1640995831b0c1f8ae616810e12eb7b97ee191e9f20b5c38eee32eb8bfac9d23':
    'qualification_ref.sha256 required of the STATUS issuer binding. A remote blob digest checked against the submitted body, not a local file.',
  '80cf8f471248ae76e5a637b5f94f20f4863a243c7011e5728de86cb5fc7cf5d2':
    'qualification_ref.sha256 required of the GATE_AUTHORIZATION and GATE_RESULT issuer bindings. Same shape.',
};
// Structural recognitions, each tied to the syntax that gives the literal its meaning, so a stray
// digest cannot borrow the exemption:
//   the fourteen gate-attempt digests, keyed by ga_id
const ATTEMPT_PIN = /"ga_[a-f0-9]{32}":'([a-f0-9]{64})'/g;
//   a sha256 that accompanies a GitHub blob URI is the digest of remote bytes, not a local file
const BLOBREF_PIN = /git\/blobs\/[a-f0-9]{40}'\s*,\s*sha256:\s*'([a-f0-9]{64})'/g;
const BLOBREF_PIN2 = /git\/blobs\/[a-f0-9]{40}"\s*,\s*"sha256":\s*"([a-f0-9]{64})"/g;

const controllerFiles = () => fs.readdirSync(DIR)
  .filter(f => /\.(py|mjs|js)$/.test(f))
  .filter(f => fs.statSync(path.join(DIR, f)).isFile());

// index: digest -> paths, over the whole qualification tree, plus the host files this controller's
// own manifest names, so a pinned interpreter or CLI resolves instead of reading as unexplained.
// Built by one function used everywhere. An earlier draft inlined it here and rebuilt a
// QUAL-only copy after each repair, which silently dropped the host entries: repairing one pin
// made the interpreter and CLI digests read as unexplained. A second index built differently
// from the first is the same mistake this whole gate exists to catch.
let index = new Map();
const buildIndex = () => {
  const ix = new Map();
  const add = p => { try { const h = sha(p); if (!ix.has(h)) ix.set(h, []); ix.get(h).push(p); } catch {} };
  // R18-F2: this used to seed the index from the manifest, which made the manifest able to explain
  // literals -- adding one absolute-path line laundered any digest into "accounted for". A gate
  // whose evidence the thing it guards can edit is not a gate. The host files whose digests
  // legitimately appear as literals in this controller are these four and no others, so they are
  // named here, in the gate, where the controller cannot reach them.
  for (const hostFile of ['/opt/node22/bin/node', '/usr/bin/docker', '/usr/local/bin/gh', '/usr/bin/python3.11'])
    if (fs.existsSync(hostFile)) add(hostFile);
  (function walk(d) {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p); }
      else add(p);
    }
  })(QUAL);
  return ix;
};
index = buildIndex();

// Named-target pins, used only by --write. Repair by identity handles the historic case where a
// literal still equals a predecessor's copy; it cannot handle the case this very tool creates,
// where a repair changes a file and the pin above it now matches nothing at all (R17). For that,
// the pin has to say which file it is for, so these read the target out of the syntax. Verification
// below never relies on them -- it stays fail-closed on every literal, however written.
const NAMED = [
  [/str\(BASE \/ '([^']+)'\)\s*,\s*\n?\s*'([a-f0-9]{64})'/g, 1, 2],
  [/\w+ = BASE \/ '([^']+)'\n\w+_SHA = '([a-f0-9]{64})'/g, 1, 2],
];
// The JS form binds the path to a variable and compares somewhere else entirely, so a single
// regex spanning both is a guess about how far apart they sit -- an earlier attempt used a
// 400-character window and missed by about two hundred. Resolve the variable first, then look for
// a comparison against it anywhere in the same file.
const namedJsPins = text => {
  const vars = new Map();
  for (const m of text.matchAll(/const (\w+)\s*=\s*fileURLToPath\(new URL\('\.\/([^']+)'/g)) vars.set(m[1], m[2]);
  const out = [];
  for (const [v, file] of vars)
    for (const m of text.matchAll(new RegExp('sha\\(fs\\.readFileSync\\(' + v + "\\)\\)\\s*!==\\s*'([a-f0-9]{64})'", 'g')))
      out.push([file, m[1]]);
  return out;
};

// ---- repair: a literal equal to a predecessor's copy of a file we also have is re-pinned here
let round = 0, repaired = 0;
if (APPLY) for (;;) {
  round++;
  let changed = 0;
  for (const f of controllerFiles()) {
    const p = path.join(DIR, f);
    let text = fs.readFileSync(p, 'utf8');
    const before = text;
    for (const lit of [...new Set(text.match(HEX) || [])]) {
      const owners = index.get(lit) || [];
      const elsewhere = owners.filter(o => path.dirname(o) !== DIR);
      for (const o of elsewhere) {
        const here = path.join(DIR, path.basename(o));
        if (!fs.existsSync(here)) continue;
        const actual = sha(here);
        if (actual === lit) continue;
        console.log(`  round ${round}  ${f} pins ${path.basename(o)}: ${lit.slice(0, 12)} (${path.basename(path.dirname(o))}) -> ${actual.slice(0, 12)}`);
        text = text.split(lit).join(actual);
        changed++;
        break;
      }
    }
    // second channel: the pin names its target, and that target's digest has moved
    const named = [...NAMED.flatMap(([re, ti, di]) => [...text.matchAll(re)].map(m => [m[ti], m[di]])),
                   ...namedJsPins(text)];
    for (const m of named.map(([t, d]) => ({1: t, 2: d}))) {
      const ti = 1, di = 2;
      const tp = path.join(DIR, m[ti]);
      if (!fs.existsSync(tp)) continue;
      const actual = sha(tp);
      if (actual === m[di]) continue;
      console.log(`  round ${round}  ${f} pins ${m[ti]}: ${m[di].slice(0, 12)} -> ${actual.slice(0, 12)} (named target)`);
      text = text.split(m[di]).join(actual);
      changed++;
    }
    if (text !== before) { fs.writeFileSync(p, text); index = buildIndex(); }
  }
  repaired += changed;
  if (!changed) break;
  if (round > 20) { console.error('DID NOT CONVERGE'); process.exit(1); }
}

// ---- verify, fail closed
const problems = [];

// A __pycache__ beside the controller's own modules is a live bypass of every byte check here.
// CPython loads the cached bytecode, and -B only stops it being WRITTEN, not read. Demonstrated:
// forging the .pyc header's source mtime and size lets tampered bytecode run while the .py stays
// byte-identical, so the manifest, the trusted entry's file check and this gate all pass. The
// stdlib caches are pinned in the manifest, which covers them; the controller's own are generated
// and pinning them would create one more chain to keep in sync. They are refused instead.
// R17-F2: covering only this directory was not enough. fixed_host.py and parent600.py load
// observe.py, validation.py, remote_evidence.py and fixed_skill_fixture.py from sibling
// directories by digest-then-exec, and a forged .pyc beside any of those runs while the .py it
// checked stays byte-identical -- demonstrated by the reviewer on the real tree. No python under
// this tree should execute from cache, so none of it may carry one. The stdlib caches are a
// different case: they are pinned in the manifest, so tampering with them is caught.
for (const d of (function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!e.isDirectory() || e.name === 'node_modules') continue;
    if (e.name === '__pycache__') acc.push(path.join(dir, e.name));
    else walk(path.join(dir, e.name), acc);
  }
  return acc;
})(QUAL))
  problems.push(`${path.relative(QUAL, d)} exists: bytecode there is loaded in preference to the .py and no byte check covers it. Remove it.`);

let accounted = 0;
for (const f of controllerFiles()) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const attempts = new Set([...text.matchAll(ATTEMPT_PIN), ...text.matchAll(BLOBREF_PIN), ...text.matchAll(BLOBREF_PIN2)].map(m => m[1]));
  for (const lit of [...new Set(text.match(HEX) || [])]) {
    const owners = index.get(lit) || [];
    const mine = owners.filter(o => path.dirname(o) === DIR);
    const stale = owners.filter(o => path.dirname(o) !== DIR && fs.existsSync(path.join(DIR, path.basename(o))));
    if (stale.length && !mine.length) {
      problems.push(`${f}: ${lit.slice(0, 12)} is ${path.basename(path.dirname(stale[0]))}/${path.basename(stale[0])}, not this controller's copy`);
    } else if (owners.length || attempts.has(lit) || DECLARED_NON_FILE[lit]) {
      accounted++;
    } else {
      problems.push(`${f}: ${lit.slice(0, 12)} matches no file and is not a declared non-file digest`);
    }
  }
}
if (APPLY && repaired) console.log(`repaired ${repaired} pin(s) over ${round} round(s)`);
if (problems.length) { for (const p of problems) console.log('  UNEXPLAINED  ' + p); console.log(`REFUSED: ${problems.length} digest literal(s) unexplained`); process.exit(1); }
console.log(`digest pins consistent (${accounted} literal(s) accounted for, 0 unexplained)`);
