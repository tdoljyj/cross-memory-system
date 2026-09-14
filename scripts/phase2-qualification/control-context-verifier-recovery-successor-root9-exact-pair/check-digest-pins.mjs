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
import {execFileSync} from 'node:child_process';
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
  '50583449ba31202aa5a7cbb908ff82e556baf95bc6a8734c5b8e58890d6d8819':
    'Exact failed GateAuthorization raw sha256 for the sole Root9 pre-dispatch recovery subject.',
  'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a':
    'Accepted predecessor controller manifest sha256, pinned to the failed GateAuthorization.',
  '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a':
    'Exact immutable BUDGET_RESERVED event 102 raw sha256; inheritance never creates another budget event.',
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
  '3cb175ca0d3720773c9561840aa1e12bf3c04f2dd864d8bdde6d3e1690bf03b4':
    'qualification_ref.sha256 required of the STATUS issuer binding. A remote blob digest checked against the submitted body, not a local file.',
  '209712fb1bd80b4dfb5678a62390b57b9ed875eff6137f708bb7c4f08797aac8':
    'qualification_ref.sha256 required of the GATE_AUTHORIZATION and GATE_RESULT issuer bindings. Same shape.',
  '2bbd9352b79da288b1a161f32cf59fc946e4cd68167b608fbd3d994617df65e9':
    'Root9 STATUS issuer-purpose qualification blob digest. The Owner-signed Root9 must pin these exact remote bytes.',
  '751afdf957b8055ea28d5fbc9ae7bcea2b384c0b005bc53263244cf1612d1004':
    'Root9 GATE_AUTHORIZATION issuer-purpose qualification blob digest. It is generation-specific and not inherited from Root8.',
  'ffafc9eb63a2148176dca0e66d5a22bf07ee9f0a5462c966d42a79d247f0088c':
    'Root9 GATE_RESULT issuer-purpose qualification blob digest. It is separately bound from GATE_AUTHORIZATION.',
};
// Structural recognitions, each tied to the syntax that gives the literal its meaning, so a stray
// digest cannot borrow the exemption:
//   the fourteen gate-attempt digests, keyed by ga_id
const ATTEMPT_PIN = /"ga_[a-f0-9]{32}":'([a-f0-9]{64})'/g;
//   a sha256 that accompanies a GitHub blob URI is the digest of remote bytes, not a local file
const BLOBREF_PIN = /git\/blobs\/[a-f0-9]{40}'\s*,\s*sha256:\s*'([a-f0-9]{64})'/g;
const BLOBREF_PIN2 = /git\/blobs\/[a-f0-9]{40}"\s*,\s*"sha256":\s*"([a-f0-9]{64})"/g;

// Files OUTSIDE the controller directory that a literal in this controller may legitimately
// resolve to. Each is the target of a pin whose path is written in the controller's own source
// (load()/load_exact()/CHILD_PATH), except the last, which is the evidence-sink definition whose
// digest context.mjs requires of a submitted material. Adding an entry here is a source change
// that appears in a diff and needs a reason; dropping a file into the tree is not. That asymmetry
// is the whole point -- a loop is dangerous in proportion to how well it hides.
const TREE_EVIDENCE = [
  'docker-engineering-observation/observe.py',                  // fixed_host.py load()
  'docker-engineering-observation/validation.py',               // parent600.py load_exact()
  'qualification-runtime/remote_evidence.py',                   // parent600.py load_exact()
  'control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py', // parent600.py CHILD_SHA
  'RuntimeMaterialPreparation/ordinary-bounded-successor/EvidenceSinkDefinition.json',       // context.mjs previous_evidence_sink_ref
  // FIXED_BATCH_EXECUTOR_BYTES, restored in read-source-blobs-linux.mjs (R22-F4): the modules
  // whose judgement decides what a valid blob is, re-hashed at the point of use.
  'control-context-verifier-original-input-capacity-successor/ref-plan.mjs',
  'control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs',
];
if (TREE_EVIDENCE.length !== 7) throw new Error('TREE_EVIDENCE length changed; widen the evidence base deliberately, not by accident');

// The controller's own sources, named here rather than discovered. Discovery left a smaller
// version of R19-F2 open inside the controller directory itself: a launder.py dropped in beside
// the real files entered the evidence base and washed any digest clean. That file would at least
// have shown up in the manifest (the build enumerates this directory in full) and so in the
// controller digest, which makes it far less hideable than the notes.txt case -- but it costs one
// list to remove, so it is removed rather than written down as a residual.
//
// An undeclared .py/.mjs/.js in this directory is now REFUSED outright, not merely excluded: a new
// controller source is a thing to notice, and silently ignoring it would leave the gate reporting
// success over a tree it did not fully account for.
// R17-N5, open since round 17: controllerFiles() is non-recursive and covers only this directory,
// so a module the controller imports from elsewhere is never scanned for literals at all. The
// self-test's census counts these; the gate has to check them too, or the two disagree about what
// "the controller" is. Listed rather than discovered, same rule as everything else here.
const CROSS_DIRECTORY_SOURCES = [];
if (CROSS_DIRECTORY_SOURCES.length !== 0) throw new Error('CROSS_DIRECTORY_SOURCES length changed; declare deliberately');
// Why only signing.mjs, when the controller also loads observe.py, validation.py,
// remote_evidence.py and fixed_skill_fixture.py across directories: those four are FROZEN
// dependencies. This controller pins their bytes and several predecessors pin the same bytes, so
// they cannot be edited by anyone; what this controller guarantees about them is that they have
// not changed, not what their own digests mean. Scanning them here was tried and produced fifteen
// refusals whose subjects are that module's business -- docker image layer digests inside
// validation.py, the Skill file digests inside fixed_skill_fixture.py -- none of which this gate
// is in a position to adjudicate. Their literal counts ARE checked, by the census in
// selftest-runtime-pins.mjs, which counts without claiming to explain. signing.mjs is different:
// it is live code this controller imports, in the same domain as its own sources, and it is what
// rounds 18 and 20 named as the blind spot. It carries no digest literal today; the point is that
// if one appears, it will be seen.

const CONTROLLER_SOURCES = [
  'bridge.py', 'build-linux-manifest.mjs', 'check-digest-pins.mjs', 'cli.mjs', 'context.mjs',
  'dynamic-signing.mjs',
  'fixed_host.py', 'grr.mjs', 'historical-component-observations.mjs', 'host-effect.mjs',
  'original-inputs-blob.mjs', 'parent600.py', 'read-source-blobs-linux.mjs',
  'request-denials.mjs', 'result-terminal.mjs',
  'root-window-validation.mjs', 'selftest-runtime-pins.mjs', 'source-publication.mjs',
  'tool-entry.functions.js', 'trusted-github.mjs',
];
if (CONTROLLER_SOURCES.length !== 20) throw new Error('CONTROLLER_SOURCES length changed; declare a new source deliberately, not by accident');
// R20-F3. Round 20 ran this gate on a host with no gh installed and got
// "UNEXPLAINED trusted-github.mjs: f687dc937534 matches no file", exit 1 -- correct fail-closed
// behaviour, but indistinguishable from a real controller defect, and since build-linux-manifest
// starts by running this gate, the manifest could not be rebuilt there at all. The reviewer's
// objection was not the refusal, it was that nothing said which binaries a host must have, so
// "environment missing a component" and "controller broken" had no way to be told apart.
//
// They are told apart now: a missing host binary is named as such, with the provisioning document
// to consult, instead of surfacing as an unexplained digest.
const HOST_BINARIES = ['/opt/node22/bin/node', '/usr/bin/docker', '/usr/local/bin/gh', '/usr/bin/python3.11'];
const missingHostBinaries = [];

// R20-N6. Round 20 rechecked nine of my measured claims; eight held and one -- "expectedGh
// matches /usr/local/bin/gh" -- was false in THEIR container, which has no gh installed. The claim
// was true where I ran it. That is the problem: a measurement recorded without saying which host
// it was taken on is not a record. Every run now stamps the four pinned binaries it can see.
const hostStamp = () => HOST_BINARIES.map(p => {
  try { return path.basename(p) + '=' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch { return path.basename(p) + '=ABSENT'; }
}).join(' ');


const controllerFiles = () => {
  const onDisk = fs.readdirSync(DIR)
    .filter(f => /\.(py|mjs|js)$/.test(f))
    .filter(f => fs.statSync(path.join(DIR, f)).isFile())
    .sort();
  const declared = new Set(CONTROLLER_SOURCES);
  const undeclared = onDisk.filter(f => !declared.has(f));
  const missing = CONTROLLER_SOURCES.filter(f => !onDisk.includes(f));
  if (undeclared.length || missing.length) {
    for (const f of undeclared) console.error('  UNDECLARED   ' + f + ': present in the controller directory but not in CONTROLLER_SOURCES');
    for (const f of missing) console.error('  MISSING      ' + f + ': declared in CONTROLLER_SOURCES but not on disk');
    console.error('REFUSED: the controller directory does not match its declared source set');
    process.exit(1);
  }
  return onDisk;
};

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
  for (const hostFile of HOST_BINARIES) {
    if (fs.existsSync(hostFile)) add(hostFile);
    else missingHostBinaries.push(hostFile);
  }
  // R19-F2: this used to walk the whole qualification tree -- 973 files, all of them editable by
  // the thing being guarded. Dropping the manifest from the evidence base (R18-F2) did not close
  // the loop, it only closed one instance of it: a 34-byte notes.txt dropped into
  // docker-engineering-observation/ and an expectedGh pinned to its digest made the gate print
  // "45 literal(s) accounted for, 0 unexplained" and exit 0. That file was invisible to every other
  // defence -- the manifest's repository enumeration reads the controller directory one level deep
  // so it never listed it, and the trusted entry only checks what the manifest lists -- and visible
  // to this gate alone. An ideal laundering vehicle.
  //
  // The evidence base is now closed and written down here, where the controller cannot reach it:
  // the four host binaries above, the controller's own directory, and the five tree files that
  // literals in this controller legitimately resolve to. A digest that matches none of them is
  // unexplained however many files exist elsewhere in the tree.
  for (const f of controllerFiles()) add(path.join(DIR, f));
  for (const rel of TREE_EVIDENCE) add(path.join(QUAL, rel));
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

// A port copies a directory and edits it. Whatever it forgets to edit still names the PREDECESSOR,
// and the reference keeps working -- the predecessor's files are still there -- so nothing fails
// until the controller runs. source-publication.mjs's manifestPath was exactly that: copied
// verbatim, pointing at window11's manifest, fatal at the first line of verifySourcePublication,
// and invisible for four rounds because both its uses sit on the GitHub-API path the self-test
// lists as uncovered.
//
// So every mention of another controller's directory must be declared here with a reason. The two
// below are historical facts -- the recorded entry point of a call that actually happened -- and
// are asserted in pairs by the code that cites them; they are not paths this controller resolves.
// Each entry says why the reference is legitimate. The test applied to every import was: does this
// directory hold a file of the same name? Six of the seven imports below have no local namesake,
// so they are shared implementations rather than paths a port forgot to update. The seventh does
// have one, and imports the predecessor's under the alias decodePriorBlob -- decoding the OLD blob
// format is the point, so that is deliberate too.
//
// This table is itself a hand-maintained list, the seventh in this controller, and like the others
// it can go stale. What it cannot do is go stale SILENTLY: a reference that is not declared here
// refuses, so drift shows up as a refusal rather than as a controller that runs against the wrong
// predecessor.
const FOREIGN_CONTROLLER_REFERENCES = {
  // Recorded history: the entry point of a call that actually happened. Asserted in pairs by the
  // code citing it; not a path this controller resolves.
  'request-denials.mjs': ['control-context-verifier-root5-final-successor/context.mjs#checkCurrentSemantics'],
  'original-inputs-blob.mjs': [
    'control-context-verifier-root5-final-successor/context.mjs#checkCurrentSemantics',
    'control-context-verifier-ordinary-bounded-acyclic-successor/context.mjs#checkCurrentSemantics',
    // Imported as decodePriorBlob: this controller handles the current format and still has to
    // decode the previous one. A local namesake exists, and that is the point of the alias.
    'control-context-verifier-evidence-blob-successor/original-inputs-blob.mjs',
  ],
  // Deliberate: the manifest is built by remapping the predecessor's entries onto this directory,
  // so the old directory has to be named.
  'build-linux-manifest.mjs': ['scripts/phase2-qualification/control-context-verifier-root6-linux-successor'],
  // Shared implementations. None has a namesake in this directory.
  'context.mjs': [
    'control-context-verifier-runtime180/dispatch-evidence.mjs',
    'control-context-verifier-runtime600/late-bound-policy.mjs',
  ],
  'result-terminal.mjs': ['control-context-verifier-runtime600/write-targets.mjs'],
  // R21-F3: source-publication.mjs now imports this controller's own Linux reader; the two
  // references left here are the pure-logic modules that reader reuses.
  // source-publication.mjs still imports ref-plan.mjs directly for planSourceBatches.
  'source-publication.mjs': ['control-context-verifier-original-input-capacity-successor/ref-plan.mjs'],
  'read-source-blobs-linux.mjs': [
    'control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs',
    'control-context-verifier-original-input-capacity-successor/ref-plan.mjs',
  ],
  // The frozen Skill fixture, already in TREE_EVIDENCE.
  'parent600.py': ['control-context-verifier-public-runtime-env-diagnostic-successor'],
  // The self-test's census names every module in the computed load set, which is the point of it:
  // round 21 found the load set had been hand-enumerated as five modules when 34 are statically
  // reachable from cli.mjs, and fourteen digest literals in the reachable set were counted by
  // nobody. Naming them here is not a port leaving a stale path behind -- it is a table of what
  // the controller actually loads, and the census fails if the computed set stops matching it.
  'selftest-runtime-pins.mjs': [
    'control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py',
    'control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs',
    'control-context-verifier-runtime600/context.mjs',
    'control-context-verifier-runtime600/host-effect.mjs',
    'control-context-verifier-runtime600/result-terminal.mjs',
    'control-context-verifier-runtime600/trusted-github.mjs',
    'control-context-verifier-runtime600/write-targets.mjs',
    'control-context-verifier-recovery-successor-root9-exact-pair',
  ],
  // This file is handled below rather than listed: the declarations it holds necessarily quote
  // every reference in the table, so its allowed set IS the union. That is not an exemption -- a
  // reference appearing here that no entry declares still refuses.
};
{
  const FOREIGN = /control-context-verifier-[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._#-]+)*/g;
  const selfDir = path.basename(DIR);
  for (const f of controllerFiles()) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const declared = f === path.basename(fileURLToPath(import.meta.url))
      ? Object.values(FOREIGN_CONTROLLER_REFERENCES).flat()
      : FOREIGN_CONTROLLER_REFERENCES[f] || [];
    for (const hit of new Set(text.match(FOREIGN) || [])) {
      if (hit.includes(selfDir)) continue;
      if (declared.some(d => d.includes(hit) || hit.includes(d))) continue;
      problems.push(`${f}: names another controller, "${hit}", with no declared reason. A port that forgets to update a path leaves it pointing at the predecessor, where it still resolves and still runs -- and fails only when the controller does.`);
    }
  }
}

// HostProvisioning.json was written last round to close R20-F3 -- nothing said which binaries a
// host must have, so a refusal could not be attributed. It was then read by nothing at all: its
// name appeared only inside two console.log strings. Measured: setting docker's digest to 0*64,
// its version to 1.0.0 and adding an invented binary left the gate at exit 0.
//
// That is the SEVENTH instance of a verification that cannot fail, and the second in a row to be
// born inside the remedy for an earlier one -- the sixth was the denominator written to fix the
// fifth. A document that records requirements and is checked by nothing does not record anything;
// it only looks as though it does. So the gate reads it now, and the document has to agree with
// the host it claims to describe.
{
  const provPath = path.join(DIR, 'HostProvisioning.json');
  if (!fs.existsSync(provPath)) problems.push('HostProvisioning.json: missing. The gate names it when a host binary is absent, so it has to exist.');
  else {
    let prov = null;
    try { prov = JSON.parse(fs.readFileSync(provPath, 'utf8')); }
    catch (e) { problems.push('HostProvisioning.json: not parseable -- ' + e.message); }
    if (prov) {
      const declared = (prov.required_binaries || []).map(x => x.path).sort();
      if (String(declared) !== String([...HOST_BINARIES].sort()))
        problems.push(`HostProvisioning.json: declares [${declared}] as the required binaries, the gate pins [${[...HOST_BINARIES].sort()}]. The document and the gate must name the same set.`);
      const groups = [[prov.required_binaries, 'required_binaries'],
                      [prov.shell_tools_pinned_by_manifest_only, 'shell_tools_pinned_by_manifest_only']];
      const pinned = new Set(HOST_BINARIES);
      for (const [list, label] of groups) for (const e of list || []) {
        if (!fs.existsSync(e.path)) {
          // Only a path the GATE pins counts as the host missing something. A path only the
          // document names and that does not exist is the document being wrong, and the set
          // mismatch above already says so -- reporting it as HOST INCOMPLETE would blame the
          // host for a fabricated entry.
          if (pinned.has(e.path)) missingHostBinaries.push(e.path);
          else problems.push(`HostProvisioning.json ${label}: ${e.path} does not exist on this host and is not a binary the gate pins.`);
          continue;
        }
        const bytes = fs.readFileSync(e.path);
        if (sha(e.path) !== e.sha256 || bytes.length !== e.bytes)
          problems.push(`HostProvisioning.json ${label}: ${e.path} records ${String(e.sha256).slice(0, 12)}/${e.bytes}B, this host has ${sha(e.path).slice(0, 12)}/${bytes.length}B. Re-measure the document, or explain the host.`);
      }
    }
  }
}

// R21-F5. Counting literals is the wrong instrument and this is where it ended.
//
// Per-file counts refuse a plain addition, a plain removal, and a cancellation across two files --
// all three measured. They do not refuse the one attack they were written for. Round 20 hid
// arm_watchdog's PYTHON_SHA as adjacent string fragments holding the predecessor's Windows digest;
// round 21 did the same and added ONE COMMENT LINE in the same file quoting a digest the gate can
// explain. Net count unchanged, gate green, exit 0, and the controller dies at the first step of
// START. The comment in this file said per-file counts "shrink the cancellation to a pair inside
// the same file", which reads as though the bar were raised. The bar is one comment line.
//
// So the pins are checked by POSITION, not by population. Every runtime byte check in this
// controller has a definite syntactic shape; each is required to match exactly once, and the digest
// it captures must equal what is actually on disk at the target it names. A pin rewritten as
// concatenation no longer matches its shape and is refused, however many literals are added
// elsewhere in the file. Where the shape carries the target path, the path is read from the source
// rather than repeated here, so a port that forgets to update one is caught by the same check.
const RUNTIME_PINS = [
  {file: 'bridge.py', label: 'HOST_SHA -> fixed_host.py', binds: ['HOST_SHA'],
   re: /^HOST_SHA = '([a-f0-9]{64})'$/m, target: () => path.join(DIR, 'fixed_host.py')},
  {file: 'fixed_host.py', label: "load('accepted_fixed_parent') -> parent600.py", binds: ['parent'],
   re: /load\('accepted_fixed_parent', str\(BASE \/ '([^']+)'\),\s*\n\s*'([a-f0-9]{64})'\)/, pathGroup: 1, shaGroup: 2,
   target: p => path.join(DIR, p)},
  {file: 'fixed_host.py', label: "load('accepted_observation') -> observe.py", binds: ['observation'],
   re: /load\('accepted_observation', '([^']+)',\s*\n\s*'([a-f0-9]{64})'\)/, pathGroup: 1, shaGroup: 2,
   target: p => path.join(QUAL, p)},
  {file: 'fixed_host.py', label: 'PYTHON_SHA -> the interpreter', binds: ['PYTHON', 'PYTHON_SHA'],
   re: /^PYTHON = Path\('([^']+)'\)\n^PYTHON_SHA = '([a-f0-9]{64})'$/m, pathGroup: 1, shaGroup: 2,
   target: p => p},
  {file: 'parent600.py', label: "load_exact('accepted_observation_validation') -> validation.py", binds: ['v'],
   re: /load_exact\('accepted_observation_validation', '([^']+)',\s*\n\s*'([a-f0-9]{64})'\)/, pathGroup: 1, shaGroup: 2,
   target: p => path.join(QUAL, p)},
  {file: 'parent600.py', label: "load_exact('accepted_auxiliary_evidence') -> remote_evidence.py", binds: ['remote'],
   re: /load_exact\('accepted_auxiliary_evidence', '([^']+)',\s*\n\s*'([a-f0-9]{64})'\)/, pathGroup: 1, shaGroup: 2,
   target: p => path.join(QUAL, p)},
  {file: 'parent600.py', label: 'CHILD_SHA -> fixed_skill_fixture.py', binds: ['CHILD_SHA', 'CHILD_PATH'],
   re: /^CHILD_SHA = '([a-f0-9]{64})'\n^CHILD_PATH = Path\(__file__\)\.resolve\(\)\.parent\.parent \/ '([^']+)' \/ '([^']+)'$/m,
   shaGroup: 1, target: (_, m) => path.join(QUAL, m[2], m[3])},
  {file: 'parent600.py', label: 'DOCKER_SHA -> the docker binary', binds: ['DOCKER', 'DOCKER_SHA'],
   re: /^DOCKER = '([^']+)'\n(?:.*\n)*?^DOCKER_SHA = '([a-f0-9]{64})'$/m, pathGroup: 1, shaGroup: 2,
   target: p => p},
  {file: 'host-effect.mjs', label: 'invokeFixedHost -> the interpreter', binds: ['python'],
   re: /const python='([^']+)';(?:[\s\S]*?)sha\(fs\.readFileSync\(python\)\)!=='([a-f0-9]{64})'/, pathGroup: 1, shaGroup: 2,
   target: p => p},
  {file: 'host-effect.mjs', label: 'invokeFixedHost -> bridge.py', binds: ['bridge'],
   re: /const bridge=fileURLToPath\(new URL\('\.\/([^']+)'(?:[\s\S]*?)sha\(fs\.readFileSync\(bridge\)\)!=='([a-f0-9]{64})'/, pathGroup: 1, shaGroup: 2,
   target: p => path.join(DIR, p)},
  {file: 'read-source-blobs-linux.mjs', label: 'PLAN_SHA -> ref-plan.mjs', binds: ['PLAN', 'PLAN_SHA'],
   re: /^const PLAN = fileURLToPath\(new URL\('([^']+)', import\.meta\.url\)\);\nconst PLAN_SHA = '([a-f0-9]{64})';$/m,
   pathGroup: 1, shaGroup: 2, target: rel => path.join(DIR, rel)},
  {file: 'read-source-blobs-linux.mjs', label: 'VALIDATOR_SHA -> read-source-blobs.mjs', binds: ['VALIDATOR', 'VALIDATOR_SHA'],
   re: /^const VALIDATOR = fileURLToPath\(new URL\('([^']+)', import\.meta\.url\)\);\nconst VALIDATOR_SHA = '([a-f0-9]{64})';$/m,
   pathGroup: 1, shaGroup: 2, target: rel => path.join(DIR, rel)},
  {file: 'read-source-blobs-linux.mjs', label: 'ghSHA -> the gh binary', binds: ['gh', 'ghSHA'],
   re: /^const gh = '([^']+)';\nconst ghSHA = '([a-f0-9]{64})';$/m, pathGroup: 1, shaGroup: 2,
   target: p => p},
  {file: 'trusted-github.mjs', label: 'expectedGh -> the gh binary', binds: ['gh', 'expectedGh'],
   re: /const gh='([^']+)';\nconst expectedGh='([a-f0-9]{64})';/, pathGroup: 1, shaGroup: 2,
   target: p => p},
  {file: 'tool-entry.functions.js', label: 'entry -> the interpreter',
   re: /sha256sum (\/[^ "|]*python[0-9.]*) \|[\s\S]{0,80}?= "([a-f0-9]{64})"/, pathGroup: 1, shaGroup: 2,
   target: p => p},
  {file: 'tool-entry.functions.js', label: 'entry -> node',
   re: /sha256sum (\/[^ "|]*node) \|[\s\S]{0,80}?= "([a-f0-9]{64})"/, pathGroup: 1, shaGroup: 2,
   target: p => p},
  // Not a file: the digest of the SQL text this entry sends. Self-checking, so it is verified
  // against the query rather than against a path.
  {file: 'tool-entry.functions.js', label: 'query_sha256 -> the SQL text', binds: ['query', 'query_sha256'],
   re: /query='([^']+)';\nconst query_sha256='([a-f0-9]{64})';/, shaGroup: 2,
   digestOf: m => crypto.createHash('sha256').update(m[1]).digest('hex')},
];
if (RUNTIME_PINS.length !== 17) throw new Error('RUNTIME_PINS length changed; declare a pin deliberately, not by accident');
{
  for (const pin of RUNTIME_PINS) {
    const abs = path.join(DIR, pin.file);
    if (!fs.existsSync(abs)) { problems.push(`${pin.file}: declared to hold the pin "${pin.label}" and is not on disk`); continue; }
    const text = fs.readFileSync(abs, 'utf8');
    const all = [...text.matchAll(new RegExp(pin.re.source, pin.re.flags.includes('g') ? pin.re.flags : pin.re.flags + 'g'))];
    if (all.length !== 1) {
      problems.push(`${pin.file}: the pin "${pin.label}" matches its declared shape ${all.length} time(s), expected exactly 1. A pin rewritten -- as concatenated fragments, say -- stops matching while it keeps running, and no count of literals will notice.`);
      continue;
    }
    const m = all[0];

    // R22-F1, the eighth instance, and inside the remedy for the seventh exactly as predicted.
    // Matching a shape once says the TEXT is there; it does not say the text is the binding the
    // code uses. Round 22 appended a second `PYTHON_SHA = (...)` with its digest split into
    // fragments: the declared shape still matched exactly once and still verified, no literal count
    // moved, --write closed the chain around it, and Python took the SECOND value. The same in
    // JavaScript with a function-scope `const gh` shadowing a module-level pin anchored at column
    // zero. Both fail-open, both green.
    //
    // So each pin now declares the names it binds, and each name must be bound exactly once in the
    // file. This file's own header already said what the property is -- "what matters is the value
    // the code COMPARES AT RUNTIME, and source text is only evidence about that" -- and a shape
    // match is weaker evidence than it looks.
    //
    // Python is parsed rather than matched: ast gives module-level assignment targets, so a
    // shadow inside a function is correctly not counted while a second module-level assignment is.
    // JavaScript is counted textually -- every declaration and every plain assignment of the name,
    // at any depth -- which is stricter than scope analysis and refuses the shadow the reviewer
    // used. Where a pin binds no name (the entry script's shell lines) there is nothing to count,
    // and those two say so by declaring no binds.
    for (const name of pin.binds ?? []) {
      let bindings;
      if (pin.file.endsWith('.py')) {
        const script = 'import ast,sys\n'
          + 'tree=ast.parse(open(sys.argv[1]).read())\n'
          + 'n=sum(1 for st in tree.body if isinstance(st,ast.Assign) '
          + 'for t in st.targets if isinstance(t,ast.Name) and t.id==sys.argv[2])\n'
          + 'print(n)';
        try {
          bindings = Number(execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', script, abs, name],
            {encoding: 'utf8'}).trim());
        } catch (e) {
          problems.push(`${pin.file}: could not parse to count bindings of ${name} -- ${String(e.message).slice(0, 80)}`);
          continue;
        }
      } else {
        const decl = [...text.matchAll(new RegExp('\\b(?:const|let|var)\\s+' + name + '\\s*=(?!=)', 'g'))].length;
        const plain = [...text.matchAll(new RegExp('(?<![\\w.$])' + name + '\\s*=(?!=)', 'g'))].length;
        bindings = Math.max(decl, plain);
      }
      if (bindings !== 1)
        problems.push(`${pin.file}: the pin "${pin.label}" binds ${name} ${bindings} time(s), expected exactly 1. A second binding of the same name runs INSTEAD of the pinned one while the declared shape still matches once -- which is how a pin passes by shape and fails in fact.`);
    }

    const declared = m[pin.shaGroup ?? 1];
    const expected = pin.digestOf ? pin.digestOf(m)
      : (() => { const t = pin.target(pin.pathGroup ? m[pin.pathGroup] : undefined, m); return fs.existsSync(t) ? sha(t) : null; })();
    if (expected === null) {
      const t = pin.target(pin.pathGroup ? m[pin.pathGroup] : undefined, m);
      if (HOST_BINARIES.includes(t)) missingHostBinaries.push(t);
      else problems.push(`${pin.file}: the pin "${pin.label}" names ${t}, which is not on this host`);
    } else if (declared !== expected) {
      problems.push(`${pin.file}: the pin "${pin.label}" declares ${declared.slice(0, 12)} but its target measures ${expected.slice(0, 12)}`);
    }
  }
}

let accounted = 0;
const perFile = {};
const scanTargets = [
  ...controllerFiles().map(f => [f, path.join(DIR, f)]),
  ...CROSS_DIRECTORY_SOURCES.map(rel => [path.posix.basename(rel), path.join(QUAL, rel)]),
];
for (const [f, abs] of scanTargets) {
  if (!fs.existsSync(abs)) { problems.push(`${f}: declared as a source but not on disk`); continue; }
  const text = fs.readFileSync(abs, 'utf8');
  perFile[f] = 0;
  const attempts = new Set([...text.matchAll(ATTEMPT_PIN), ...text.matchAll(BLOBREF_PIN), ...text.matchAll(BLOBREF_PIN2)].map(m => m[1]));
  for (const lit of [...new Set(text.match(HEX) || [])]) {
    const owners = index.get(lit) || [];
    const mine = owners.filter(o => path.dirname(o) === DIR);
    const stale = owners.filter(o => path.dirname(o) !== DIR && fs.existsSync(path.join(DIR, path.basename(o))));
    if (stale.length && !mine.length) {
      problems.push(`${f}: ${lit.slice(0, 12)} is ${path.basename(path.dirname(stale[0]))}/${path.basename(stale[0])}, not this controller's copy`);
    } else if (owners.length || attempts.has(lit) || DECLARED_NON_FILE[lit]) {
      accounted++; perFile[f]++;
    } else {
      problems.push(`${f}: ${lit.slice(0, 12)} matches no file and is not a declared non-file digest`);
    }
  }
}
// R17-N1, asked for since round 16 and not done until now: the count is compared against an
// expected value. Without it the gate is blind in the one direction that matters most -- a literal
// DISAPPEARING. Round 20 demonstrated the exploit: write arm_watchdog's PYTHON_SHA as two adjacent
// string literals holding the predecessor's Windows digest, and /[a-f0-9]{64}/ no longer matches
// it, so the pin drops out of the count, the gate's output is byte-identical to a clean run, and
// the controller dies at the first step of START. Fewer literals than expected now refuses, and
// so does more -- a new pin has to be declared here as well as in the self-test's census.
// Per FILE, not one total. A single total cancels: removing a pin from one file while adding one
// to another leaves the sum unchanged, and that is not hypothetical -- it is what happened the
// first time this was tested, and the run passed. Per-file counts shrink the cancellation to a
// pair inside the same file, which is stated below rather than claimed away.
const EXPECTED_PER_FILE = {
  'bridge.py': 1, 'check-digest-pins.mjs': 14, 'context.mjs': 27, 'fixed_host.py': 3,
  'host-effect.mjs': 2, 'parent600.py': 4, 'read-source-blobs-linux.mjs': 3, 'result-terminal.mjs': 1,
  'tool-entry.functions.js': 3, 'trusted-github.mjs': 1,
  // Cross-directory live code, newly scanned (R17-N5). Zero today; declared so it cannot appear
  // unnoticed.
  'signing.mjs': 0,
};
if (!problems.length) {
  for (const f of new Set([...Object.keys(EXPECTED_PER_FILE), ...Object.keys(perFile).filter(k => perFile[k])])) {
    const want = EXPECTED_PER_FILE[f], got = perFile[f] ?? 0;
    if (want === undefined)
      problems.push(`${f}: ${got} digest literal(s) and no expected count. A new pin must be declared here and in selftest-runtime-pins' census.`);
    else if (got < want)
      problems.push(`${f}: ${want - got} digest literal(s) have GONE MISSING (${got} found, ${want} expected). A pin written as concatenated string fragments reads as absent here while still running -- round 20 did exactly that to arm_watchdog's PYTHON_SHA and both gates stayed green. Find it before changing this number.`);
    else if (got > want)
      problems.push(`${f}: ${got - want} digest literal(s) more than expected (${got} found, ${want} expected). Declare the new pin here and in the census.`);
  }
}

if (APPLY && repaired) console.log(`repaired ${repaired} pin(s) over ${round} round(s)`);
if (problems.length) {
  for (const p of problems) console.log('  UNEXPLAINED  ' + p);
  if (missingHostBinaries.length) {
    console.log('');
    console.log('  HOST INCOMPLETE  this host is missing ' + missingHostBinaries.join(', ') + '.');
    console.log('  Some or all of the refusals above are that, not a controller defect: a pin whose');
    console.log('  binary is absent can match nothing. Required binaries and their digests are in');
    console.log('  HostProvisioning.json beside this file. Install them, then run this again --- if');
    console.log('  refusals remain, they are real.');
  }
  console.log(`  host        ${hostStamp()}`);
  console.log(`REFUSED: ${problems.length} digest literal(s) unexplained`);
  process.exit(1);
}
if (missingHostBinaries.length) {
  console.log('  HOST INCOMPLETE  missing ' + missingHostBinaries.join(', ') + ' --- see HostProvisioning.json');
  console.log('REFUSED: the gate cannot vouch for pins whose binaries are not on this host');
  process.exit(1);
}
console.log(`  host        ${hostStamp()}`);
console.log(`digest pins consistent (${accounted} literal(s) accounted for, 0 unexplained)`);
