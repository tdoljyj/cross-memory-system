// Proves the cross-pin block in verify-manifest-against-host.mjs can actually fail.
//
// That block exists because its predecessor could not. A single hardcoded check on gh.exe looked
// the entry up by a Windows path the Linux manifest does not contain, reported NOT_IN_MANIFEST, fed
// into no verdict, and sat next to the words ALL_ENTRIES_VERIFIED. Replacing it with a
// source-derived table is worth nothing unless the table is shown to fire, so each failure mode is
// produced here and both the verdict and the exit code are required to change.
//
// Everything happens in a throwaway repository-shaped copy under the system temp directory. The
// real tree is never written to. No database, no docker, no budget, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CTRL = 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor';
const MANIFEST = CTRL + '/ControllerSourceManifest.candidate.json';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

let failures = 0;
const fail = m => { console.error('  FAILED  ' + m); failures++; };
const ok = m => console.log('  ok       ' + m);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-crosspin-'));
process.on('exit', () => fs.rmSync(sandbox, {recursive: true, force: true}));
fs.mkdirSync(path.join(sandbox, 'scripts'), {recursive: true});
fs.mkdirSync(path.join(sandbox, 'work'), {recursive: true});
fs.cpSync(path.join(REPO, 'scripts/phase2-qualification'), path.join(sandbox, 'scripts/phase2-qualification'),
  {recursive: true, filter: s => !s.includes('node_modules')});
fs.cpSync(HERE, path.join(sandbox, 'work/twentieth-forward'), {recursive: true});
fs.mkdirSync(path.join(sandbox, 'apps'), {recursive: true});
fs.symlinkSync(path.join(REPO, 'apps/clued-cloud'), path.join(sandbox, 'apps/clued-cloud'));

const abs = p => path.join(sandbox, p);
const run = () => {
  const r = spawnSync(process.execPath,
    [abs('work/twentieth-forward/verify-manifest-against-host.mjs'), abs(MANIFEST), '--map', '/=/'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* left null; callers report the stderr */ }
  return {report, code: r.status, stderr: (r.stderr || '').trim()};
};

// The sandbox manifest must describe the sandbox's own sources, or every case below would fail for
// the wrong reason -- ordinary drift rather than the cross-pin check. REPOSITORY_SOURCE entries are
// re-measured; RUNTIME_DEPENDENCY entries are absolute and still name the real files, so a drifted
// binary is still caught.
const remeasure = () => {
  const m = JSON.parse(fs.readFileSync(abs(MANIFEST), 'utf8'));
  for (const e of m.files) {
    if (e.role !== 'REPOSITORY_SOURCE') continue;
    const b = fs.readFileSync(abs(e.path));
    e.bytes = b.length;
    e.sha256 = sha(b);
  }
  fs.writeFileSync(abs(MANIFEST), JSON.stringify(m, null, 2) + '\n');
};

// A mutation is applied, the verifier is run, the tree is restored, and the result must be a
// cross-pin failure of the named kind -- not merely "some failure", which a broken script would
// also produce.
const restorePoints = [];
const patch = (rel, fn) => {
  const p = abs(rel);
  restorePoints.push([p, fs.readFileSync(p)]);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};
const undo = () => { while (restorePoints.length) { const [p, b] = restorePoints.pop(); fs.writeFileSync(p, b); } };

function expectFailure(label, expectedStatus, mutate) {
  remeasure();
  const before = run();
  if (before.report?.verdict !== 'ALL_ENTRIES_VERIFIED')
    return fail(`${label}: the unmutated sandbox does not verify (${before.report?.verdict ?? before.stderr.slice(0, 120)}), so this case proves nothing`);
  mutate();
  remeasure();
  const after = run();
  undo();
  if (!after.report) return fail(`${label}: verifier produced no report -- ${after.stderr.slice(0, 160)}`);
  const got = (after.report.cross_pins?.entries ?? []).map(e => e.status);
  if (after.report.verdict !== 'CROSS_PIN_FAILURE')
    return fail(`${label}: verdict stayed ${after.report.verdict}; statuses were ${JSON.stringify(got)}`);
  if (after.code !== 1) return fail(`${label}: verdict is CROSS_PIN_FAILURE but the exit code is ${after.code}`);
  if (!got.includes(expectedStatus))
    return fail(`${label}: failed, but not as ${expectedStatus} -- got ${JSON.stringify(got)}`);
  ok(`${label} -> ${expectedStatus}, verdict CROSS_PIN_FAILURE, exit 1`);
}

// 1. A pin whose digest no longer agrees with the manifest. This is the condition the block is for.
expectFailure('gh pin digest changed in trusted-github.mjs', 'DIGEST_DISAGREES',
  () => patch(CTRL + '/trusted-github.mjs', t => t.replace("const expectedGh='f687dc93", "const expectedGh='f687dc94")));

// 2. The construct the block matches on is gone. This is the gh failure itself, reproduced: the
//    check must refuse rather than report a neutral status.
expectFailure('docker pin construct removed from parent600.py', 'PIN_NOT_LOCATED_IN_SOURCE',
  () => patch(CTRL + '/parent600.py', t => t.replace(/^DOCKER_SHA = '[a-f0-9]{64}'$/m, "DOCKER_SHA_RENAMED = 'x'")));

// 3. The binary the controller pins is not described by the manifest at all.
expectFailure('node dropped from the manifest', 'BINARY_NOT_IN_MANIFEST', () => {
  const p = abs(MANIFEST);
  restorePoints.push([p, fs.readFileSync(p)]);
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.files = m.files.filter(e => e.path !== '/opt/node22/bin/node');
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
});

// 4. Two pins where there should be one. Ambiguity is not a pass either: with two, which one the
//    controller enforces is no longer decidable by reading, so the block must refuse rather than
//    pick. The first attempt at this case inserted "const expectedGhDecoy=" and the run still
//    verified -- correctly, since that is not a second occurrence of the pattern. Written as a
//    genuine duplicate it fails as it should. (It is not valid JS; the block reads text, and text
//    is what is under test.)
expectFailure('a second gh pin added to trusted-github.mjs', 'PIN_NOT_LOCATED_IN_SOURCE',
  () => patch(CTRL + '/trusted-github.mjs',
    t => t.replace("const expectedGh='", "const expectedGh='f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618';\nconst expectedGh='")));

// 5. The final state must be the clean one, or the cases above restored badly and everything after
//    this file in a sweep would be measuring a corrupted tree.
remeasure();
const final = run();
if (final.report?.verdict === 'ALL_ENTRIES_VERIFIED' && final.report.cross_pins.failures === 0
    && final.report.cross_pins.declared === final.report.cross_pins.entries.length)
  ok(`restored sandbox verifies again (${final.report.cross_pins.declared} cross-pins, 0 failures)`);
else fail('the sandbox does not verify after the mutations were undone: ' + JSON.stringify(final.report?.cross_pins ?? final.stderr.slice(0, 160)));

if (failures) { console.log(`cross-pin self-test FAILED (${failures} failed)`); process.exitCode = 1; }
else console.log('cross-pin self-test passed (every declared failure mode was produced and changed the verdict)');
