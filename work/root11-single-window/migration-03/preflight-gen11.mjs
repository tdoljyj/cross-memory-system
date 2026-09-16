// 离线预检：拿复制品的真实状态 + 本地的验收/资格/Status，跑控制器自己的检查器。
// 不连 GitHub、不起容器，目的是在签 GA 之前把所有不匹配一次性找出来，而不是一条一条撞。
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const V = 'file:///C:/Users/17531/.dsh/projects/cross-memory-system/scripts/phase2-qualification/control-context-verifier-root10-single-window/';
const ctx = await import(V + 'context.mjs');
const REPO = 'C:/Users/17531/.dsh/projects/cross-memory-system/';
const LIVE = 'C:/Users/17531/root10-snapshot-20260916/gen11-live/';
const sha = b => crypto.createHash('sha256').update(b, 'utf8').digest('hex');

const psql = text => execFileSync('docker', ['run', '--rm', 'postgres:17', 'psql', '-h', '172.17.0.6',
  '-U', 'postgres', '-d', 'clued', '-X', '-q', '-A', '-t', '-c', text],
  {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: {...process.env, MSYS_NO_PATHCONV: '1'}}).trim();

const execution = JSON.parse(psql('select clued_control.read_execution()'));
const current = execution.current;
const attempt = execution.attempts.find(a => a.ga_id === current.active_ga_id);
if (!attempt) throw Error('复制品上没有活动 GA，先跑一次 reserve_gate');

const runtimeAcceptanceRaw = fs.readFileSync(REPO + 'work/root11-single-window/RuntimeAcceptance.root11.json', 'utf8');
const qualificationRaw = fs.readFileSync(REPO + 'work/root11-single-window/ControllerQualification.root11.json', 'utf8');
const runtimeAcceptance = JSON.parse(runtimeAcceptanceRaw);
const qualification = JSON.parse(qualificationRaw);
const statusRaw = fs.readFileSync(LIVE + 'Root11SignedStatus.v2.json', 'utf8');

const observation = {project: 'uscrdifznmlvczcekqpw', row: {observed_at: new Date().toISOString(), execution},
  query_sha256: sha('select clock_timestamp() as observed_at, clued_control.read_execution() as execution')};

const results = [];
const run = (name, fn) => {
  try { fn(); results.push(['PASS', name, '']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

run('checkCurrentSemantics(CREATE)', () => ctx.checkCurrentSemantics({
  gaRaw: attempt.ga_raw, operation: 'CREATE', observation, runtimeAcceptance, qualification,
  now: Date.now(), admissionPhase: 'PREFLIGHT',
}));
run('checkGAShape', () => ctx.checkGAShape(attempt.ga_raw));
run('checkCumulativeBudget', () => ctx.checkCumulativeBudget(current, execution.binding));
run('parseStoredStatus', () => ctx.parseStoredStatus(statusRaw));

// 状态清单那一段（context.mjs 231-251）控制器放在外层函数里，这里按同样的规则逐条手验。
const ga = JSON.parse(attempt.ga_raw);
const root = execution.root;
const sm = JSON.parse(statusRaw);
const smPayload = {...sm}; delete smPayload.signature_binding;
const ordered = v => Array.isArray(v) ? v.map(ordered)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
const canonicalDigest = v => sha(JSON.stringify(ordered(v)) + '\n');
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const subject = runtimeAcceptance.accepted_subject;
const binding = execution.binding;

const manual = [
  ['EXACT_STATUS_BYTES', () => sha(statusRaw) === ga.status_manifest_ref.sha256],
  ['EXACT_STATUS_ISSUER_REF', () => same(sm.issuer_ref,
    root.events.at(-1).request.body.issuer_bindings.find(i => i.purpose === 'STATUS').qualification_ref)],
  ['ORIGINAL_TYPED_STATUS_URI', () => ga.status_manifest_ref.uri === 'control://status-manifests/' + sm.status_manifest_id],
  ['ACTUAL_STORED_STATUS_READ_REQUIRED', () => {
    const s = (execution.control_objects ?? []).filter(x => x.object_type === 'StatusManifest' && x.uri === ga.status_manifest_ref.uri);
    return s.length === 1 && s[0].raw === statusRaw && s[0].sha256 === sha(statusRaw);
  }],
  ['EXACT_SIGNED_STATUS_SCHEMA_PURPOSE', () => sm.schema_digest === subject.control_schema_refs.StatusManifest.sha256
    && sm.issuer_purpose === 'STATUS' && sm.control_trust_root_generation === root.generation_id],
  ['STATUS_CURRENT_INPUTS', () => ctx.time(sm.as_of) <= Date.now() && Date.now() < ctx.time(sm.expires_at)
    && Array.isArray(sm.source_digests) && sm.source_digests.length > 0],
  ['STATUS_EXACT_CURRENT_OBSERVATION_BINDING', () => same(sm.observations, {
    root_set_id: root.root_set_id, root_generation: root.generation_id,
    profile_digest: binding.profile_sha256, gate_digest: binding.gate_sha256,
    controller_digest: binding.controller_sha256, scope_digest: binding.scope_sha256,
    runner_generation: ga.runner_generation, credential_generation: ga.credential_generation,
    session_generation: ga.session_generation, stage_receipt_refs: ga.stage_receipt_refs,
  }) && [binding.profile_sha256, binding.gate_sha256, binding.controller_sha256, binding.scope_sha256]
    .every(h => sm.source_digests.includes(h))],
  ['STATUS_EXACT_SOURCE_REFS', () => [...ga.stage_receipt_refs, ga.scope_ref, ga.controller_qualification_ref,
    ga.authority_source_ref].every(r => sm.source_refs.some(x => same(x, r)))],
  ['EXACT_SIGNED_STATUS_PAYLOAD_DIGEST', () => canonicalDigest(smPayload)
    === subject.late_bound_fields.status_manifest_ref.signed_payload_sha256],
];
for (const [name, fn] of manual) {
  try { results.push([fn() ? 'PASS' : 'FAIL', name, fn() ? '' : 'condition false']); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

let failed = 0;
for (const [s, n, m] of results) { if (s === 'FAIL') failed++; console.log(`${s}  ${n}${m ? '  -- ' + m : ''}`); }
console.log(`\n${results.length - failed}/${results.length} pass`);
