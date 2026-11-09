// Generation 12 (resident DESIGN 56.2): the queue watch rides on the stage-11 role probe. role-probe-run/2 names one PR; the probe's
// one holders read then says ROLE_PROBE_HELD_WATCHED_HEAD when the single live slot holder is bound to exactly that PR. Nothing
// else about the holders leaves the entry, and a run without a watch is /1 byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/proof.mjs';
import { ROLE_PROBE_RUN_CONTRACT, ROLE_PROBE_RUN_CONTRACT_WATCH, makeRoleProbeRun, roleProbeFact, roleProbeRunId, validateRoleProbeRun } from '../src/resident-v2/role-probe-run.mjs';
import { parseRoleProbe } from '../src/independent-control-checks-v2/merge-slot-native.mjs';
import { probeRole } from '../src/resident-v2/role-probe-entry.mjs';
import { main as invokeMain } from '../src/resident-v2/invoke-stage.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const H64 = c => c.repeat(64);
const BASE_RUN = { repo: REPO, runId: '0123456789abcdef-0123456789ab', sourceManifestSha256: H64('a'), nodeProfileSha256: H64('b'), createdAt: '2026-11-05T08:00:00.000Z' };
const row = pr => ({ claim_id: randomUUID(), task_id: randomUUID(), bound_pr: `${REPO}#${pr}`, bound_prs: [`${REPO}#${pr}`], merge_slot_until: '2026-11-05T09:00:00Z', merge_slot_ci: {} });
const ok = holders => ({ status: 'ok', repository: REPO, holders });

test('role-probe-run: /1 unchanged without a watch, /2 with watchPr; the PR is part of the id; a bad PR is refused', () => {
  const plain = makeRoleProbeRun(BASE_RUN);
  assert.equal(plain.contract, ROLE_PROBE_RUN_CONTRACT);
  assert.deepEqual(Object.keys(plain).sort(), ['contract', 'createdAt', 'id', 'nodeProfileSha256', 'repo', 'runId', 'sourceManifestSha256']);
  assert.deepEqual(makeRoleProbeRun({ ...BASE_RUN, watchPr: null }), plain);
  const watched = makeRoleProbeRun({ ...BASE_RUN, watchPr: 884 });
  assert.equal(watched.contract, ROLE_PROBE_RUN_CONTRACT_WATCH);
  assert.equal(watched.watchPr, 884);
  assert.notEqual(watched.id, plain.id);
  assert.notEqual(makeRoleProbeRun({ ...BASE_RUN, watchPr: 885 }).id, watched.id);
  assert.throws(() => validateRoleProbeRun({ ...watched, watchPr: 885 }), { code: 'ROLE_PROBE_RUN_REFUSED' }, 'the id binds the PR');
  for (const bad of [0, -3, 1.5, '884', 10_000_000_000]) {
    const v = { ...watched, watchPr: bad }; v.id = roleProbeRunId(v);
    assert.throws(() => validateRoleProbeRun(v), { code: 'ROLE_PROBE_RUN_REFUSED' }, String(bad));
  }
  assert.throws(() => validateRoleProbeRun({ ...plain, watchPr: 884 }), { code: 'ROLE_PROBE_RUN_REFUSED' }, '/1 has no watchPr');
  const noWatch = { ...watched }; delete noWatch.watchPr;
  assert.throws(() => validateRoleProbeRun(noWatch), { code: 'ROLE_PROBE_RUN_REFUSED' }, '/2 needs it');
});

test('parseRoleProbe with a watch: only exactly one holder bound to that PR is the watched head', () => {
  assert.equal(parseRoleProbe(200, ok([row(884)]), REPO, 884).code, 'ROLE_PROBE_HELD_WATCHED_HEAD');
  assert.equal(parseRoleProbe(200, ok([row(884)]), REPO, null).code, 'ROLE_PROBE_HELD', 'no watch: plain held');
  assert.equal(parseRoleProbe(200, ok([row(885)]), REPO, 884).code, 'ROLE_PROBE_HELD');
  assert.equal(parseRoleProbe(200, ok([]), REPO, 884).code, 'ROLE_PROBE_HELD');
  assert.equal(parseRoleProbe(200, ok([row(884), row(885)]), REPO, 884).code, 'ROLE_PROBE_HELD', 'two holders: not a single head');
  assert.equal(parseRoleProbe(200, ok([{ ...row(884), bound_pr: 'other/repo#884' }]), REPO, 884).code, 'ROLE_PROBE_HELD_WATCHED_HEAD', 'legacy scalar cannot override the validated PR projection');
  assert.equal(parseRoleProbe(200, ok([{ ...row(884), bound_prs: ['other/repo#884'] }]), REPO, 884).code, 'ROLE_PROBE_UNCERTAIN', 'foreign repository projection refused');
  assert.equal(parseRoleProbe(200, ok([{ ...row(884), bound_prs: undefined }]), REPO, 884).code, 'ROLE_PROBE_UNCERTAIN', 'old API is unknown');
  assert.equal(parseRoleProbe(200, { status: 'ok', holders: [], reason: 'admission_binding_required' }, REPO, 884).code, 'ROLE_PROBE_NOT_HELD');
  assert.equal(parseRoleProbe(502, { message: 'bad gateway' }, REPO, 884).code, 'ROLE_PROBE_UNCERTAIN');
  assert.deepEqual(roleProbeFact('ROLE_PROBE_HELD_WATCHED_HEAD'), { result: 'held', code: 'ROLE_PROBE_HELD_WATCHED_HEAD' });
});

// The entry over a real holders reply; tokens and paths are faked as in github-read-retry.test.mjs.
function entryRecord(token) {
  return { config: { repository: REPO, scope: `project:${randomUUID()}`, supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_test' },
    accepted: { node: { controllerSid: 'S-1-5-21-1' }, ciTokenPinSha256: digest('clued.independent-ci.ci-binding-pin/1\0' + token) } };
}
const token = 'clued_bnd_testtoken';
const reply = body => new Response(JSON.stringify(body), { status: 200 });

test('the entry: a watch asks the same one holders read and answers the watched head; without one the answer is unchanged', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, input: JSON.parse(init.body).p_input }); return reply(ok([row(884)])); };
  const base = { record: entryRecord(token), live: () => {}, tokenReader: async () => token, protect: async () => {}, fetchImpl, readRetry: { sleep: async () => {} } };
  assert.equal((await probeRole({ ...base, watchPr: 884 })).reason, 'ROLE_PROBE_HELD_WATCHED_HEAD');
  assert.equal((await probeRole(base)).reason, 'ROLE_PROBE_HELD');
  assert.equal((await probeRole({ ...base, watchPr: 'x' })).reason, 'ROLE_PROBE_HELD', 'an invalid watch is no watch');
  assert.equal(sent.length, 3);
  assert.ok(sent.every(s => s.url.endsWith('/rpc/clued_work_merge_slot_holders_v1') && !Object.hasOwn(s.input, 'pr_ref')), 'the PR is never sent to Native');
});

test('network cut: a watch whose holders read never answers is uncertain, never the watched head', async () => {
  const cut = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) }); };
  const r = await probeRole({ record: entryRecord(token), live: () => {}, watchPr: 884, tokenReader: async () => token, protect: async () => {}, fetchImpl: cut,
    readRetry: { sleep: async () => {} } });
  assert.equal(r.reason, 'ROLE_PROBE_UNCERTAIN');
  assert.equal(r.sideEffects, 0);
});

test('invoke-stage: --watch-pr must be the last pair and a PR number', async () => {
  const lines = [];
  const output = { write: s => lines.push(JSON.parse(s)) };
  const key = H64('c'), id = `${key.slice(0, 16)}-0123456789ab`;
  for (const extra of [['--watch-pr'], ['--watch-pr', '0'], ['--watch-pr', 'x'], ['--watch-pr', '12345678901'], ['--other', '5']]) {
    assert.equal(await invokeMain(['--role-probe', key, '--probe-id', id, '--node-profile-sha256', H64('d'), ...extra], output), 2, extra.join(' '));
    assert.deepEqual(lines.at(-1), { state: 'REFUSED', failure_code: 'STAGE_PACKAGE_REFUSED' });
  }
});

test('the session-0 helper (C#) accepts the same /2 job and derives the same id; /1 unchanged', { skip: process.platform !== 'win32' }, () => {
  const dir = fileURLToPath(new URL('../src/resident-v2/windows/', import.meta.url));
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  for (const job of [makeRoleProbeRun({ ...BASE_RUN, createdAt: new Date().toISOString(), watchPr: 884 }), makeRoleProbeRun({ ...BASE_RUN, createdAt: new Date().toISOString() })]) {
    const command = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(path.join(dir, 'NodeProfileV2.cs'))},${quote(path.join(dir, 'FormalPublicBoundaryV2.cs'))} -ReferencedAssemblies System.Web.Extensions; `
      + `$j=New-Object 'System.Collections.Generic.Dictionary[string,object]'; $v=ConvertFrom-Json ${quote(JSON.stringify(job))}; foreach($p in $v.PSObject.Properties){$j.Add($p.Name,$p.Value)}; `
      + `$x=[FormalPublicBoundaryV2]::ValidateRoleProbeRun($j,${quote(job.sourceManifestSha256)},${quote(job.runId)},${quote(job.nodeProfileSha256)}); [FormalPublicBoundaryV2]::RoleProbeRunId($j)`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), job.id, job.contract);
  }
});
