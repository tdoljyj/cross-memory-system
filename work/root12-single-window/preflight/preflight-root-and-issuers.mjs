// 补齐离线预检：控制器外层函数里"根 + 签发方资格 + 根引用"那一段（context.mjs 200-216）。
// 这一段正是第 11 代与第 12 代先后栽跟头的地方，而它原先不在预检覆盖内——
// 因为它在外层函数里，且原实现要连 GitHub。这里按同样的规则在本地逐条复算。
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const V = 'file:///C:/Users/17531/.dsh/projects/cross-memory-system/scripts/phase2-qualification/control-context-verifier-root10-single-window/';
const ctx = await import(V + 'context.mjs');
const {canonicalDigest} = await import(V + 'root10-single-window.mjs');
const REPO = 'C:/Users/17531/.dsh/projects/cross-memory-system/';
const CTRL = REPO + 'scripts/phase2-qualification/control-context-verifier-root10-single-window/';
const G = process.argv[2] || '12';
const OUT = REPO + 'work/root' + G + '-single-window/';
const LIVE = 'C:/Users/17531/root10-snapshot-20260916/gen' + G + '-live/';
const sha = b => crypto.createHash('sha256').update(b, 'utf8').digest('hex');
const same = (a, b) => JSON.stringify(ctx.parseExact ? a : a) === JSON.stringify(b);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const psql = t => execFileSync('docker', ['run', '--rm', 'postgres:17', 'psql', '-h', '172.17.0.6',
  '-U', 'postgres', '-d', 'clued', '-X', '-q', '-A', '-t', '-c', t],
  {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: {...process.env, MSYS_NO_PATHCONV: '1'}}).trim();

const execution = JSON.parse(psql('select clued_control.read_execution()'));
const attempt = execution.attempts.find(a => a.ga_id === execution.current.active_ga_id);
if (!attempt) throw Error('复制品上没有活动 GA');
const ga = JSON.parse(attempt.ga_raw);
const rootEvents = execution.root.events;
const registration = rootEvents.filter(e => e.request.kind === 'GENERATION_REGISTERED').at(-1);
const root = registration.request.body;          // 已签根对象
const contract = JSON.parse(fs.readFileSync(CTRL + 'Root10ControllerContract.candidate.json', 'utf8'));
const acc = JSON.parse(fs.readFileSync(OUT + 'RuntimeAcceptance.root' + G + '.json', 'utf8'));
const series = acc.accepted_subject;
const generation = contract.generation_id, rootID = contract.root_id;
const audience = 'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw';
const limits = {seconds: contract.caps.seconds, evidenceBytes: contract.caps.evidence_bytes,
  allocations: contract.caps.allocations};

const results = [];
const T = (name, fn) => {
  try { const v = fn(); results.push([v ? 'PASS' : 'FAIL', name, v ? '' : 'condition false']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

T('COMPLETE_ROOT_HISTORY', () => Array.isArray(rootEvents) && rootEvents.length === execution.root.sequence
  && rootEvents.every((e, i) => e.root_id === rootID && e.sequence === i + 1));
T('CURRENT_ROOT_EVENT', () => registration.request.generation_id === generation);
T('EXACT_ROOT_HISTORY_PREFIX', () => root.control_trust_root_generation === generation
  && root.history.prefix_sequence === registration.sequence - 1
  && root.history.prefix_digest === canonicalDigest(rootEvents.slice(0, registration.sequence - 1)));
T('EXACT_ROOT_SIGNING_PAYLOAD', () => {
  const p = {...root}; delete p.signature_binding;
  return root.signature_binding.signed_object_sha256 === canonicalDigest(p);
});
T('ACTUAL_CURRENT_ROOT_REF', () => ga.authority_source_ref.uri === 'urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:' + rootID
  && ga.authority_source_ref.sha256 === canonicalDigest(root));
for (const purpose of ['STATUS', 'GATE_AUTHORIZATION', 'GATE_RESULT']) {
  const issuers = root.issuer_bindings.filter(i => i.purpose === purpose);
  T('SEPARATE_ROOT_ISSUER_PURPOSE:' + purpose, () => issuers.length === 1 && issuers[0].subject_id === 'tdoljyj'
    && issuers[0].signing_service === 'web-flow' && issuers[0].audience === audience);
  const expected = contract.issuer_qualification_refs[purpose];
  T('EXACT_ROOT10_PURPOSE_ALGORITHM_METADATA_REF:' + purpose, () => eq(issuers[0].qualification_ref, expected)
    && eq(series.root10_single_window.issuer_qualification_refs[purpose], expected));
  T('EXACT_ROOT10_PURPOSE_QUALIFICATION:' + purpose, () => {
    const file = OUT + 'IssuerQualification.' + purpose + '.root' + G + '.json';
    const raw = fs.readFileSync(file, 'utf8');
    if (sha(raw) !== expected.sha256) throw Error('本地文件摘要与合同引用不符');
    const m = JSON.parse(raw);
    return m.control_trust_root_generation === generation && m.root_set_id === rootID
      && m.subject_id === 'tdoljyj' && m.signing_service === 'web-flow' && m.accepted_audience === audience
      && m.accepted_scope?.new_gate_authorizations_max === 1
      && m.accepted_scope?.cumulative_controlled_execution_seconds === limits.seconds
      && m.accepted_scope?.cumulative_evidence_bytes === limits.evidenceBytes
      && m.accepted_scope?.series_allocations_max === limits.allocations
      && m.accepted_scope?.no_refund === true && m.accepted_scope?.no_automatic_retry === true
      && m.accepted_issuer_purposes?.length === 1 && m.accepted_issuer_purposes[0].purpose === purpose
      && m.accepted_issuer_purposes[0].accepted === true && m.accepted_issuer_purposes[0].audience === audience
      && ctx.time(m.not_before) <= Date.now() && Date.now() < ctx.time(m.expires_at);
  });
  if (purpose === 'GATE_AUTHORIZATION')
    T('ACTUAL_GA_ISSUER_QUALIFICATION_REF', () => eq(ga.issuer_ref, issuers[0].qualification_ref));
}
let failed = 0;
for (const [s, n, m] of results) { if (s === 'FAIL') failed++; console.log(`${s}  ${n}${m ? '  -- ' + m : ''}`); }
console.log(`\n${results.length - failed}/${results.length} pass`);
