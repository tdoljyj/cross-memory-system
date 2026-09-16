#!/usr/bin/env node
// Root10 runtime-clock dispatch driver. It is the trusted caller the controller expects: it
// supplies a fresh control-store observation and it commits, as separate transactions, the
// intent/dispatch/result rows the controller asks for. It decides nothing. Every admission,
// window and byte check lives behind the trusted entry; this program cannot grant authority,
// and every refusal it can raise is its own input handling, never a verdict.
//
// This is the Linux successor of the tool-origin entry in
// scripts/phase2-qualification/control-context-verifier-root10-single-window/tool-entry.functions.js,
// which drove the same handshake through a harness that could call an MCP SQL tool from inside
// the program. Here the SQL goes through psql, because the controller requires the observation
// to be at most 15 seconds old and a 3 MB snapshot cannot make a human-mediated round trip in
// that window.
//
//   CLUED_CONTROL_DB_PASSWORD='<the database password, verbatim>' \
//   node drive-root10-runtime-clock-dispatch.mjs --check-connection
//
//   CLUED_CONTROL_DB_PASSWORD='<...>' \
//   node drive-root10-runtime-clock-dispatch.mjs --template TEMPLATE.json --operation CREATE
//
// --check-connection is a read-only reachability probe: it appends nothing and changes nothing.
// --dry-run stops after building the material and prints what it would send.
//
// STOP is deliberately not an operation here. The entry has no dispatch handshake for it:
// prepareTrustedToolMaterial returns a stop-authority object with no intent, no dispatch key and
// no finishDispatch, and invokeFixedHost refuses STOP outright. The container is stopped by the
// host's own watchdog at its deadline, and STOP_SENT/STOPPED are recorded out of band.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import readline from 'node:readline';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueAfter = name => {const i = args.indexOf(name); return i < 0 ? null : args[i + 1];};
const need = (v, m) => {if (!v) throw Error(m);};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const hex64 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

const PROJECT = 'uscrdifznmlvczcekqpw';
const ROOT = 'ctr_414bd3c724264a83894b0c55cf2ab878';
// The exact text the trusted entry issues. Its digest is what the controller compares against,
// so it is issued verbatim; only psql's output framing is ours.
const QUERY = 'select clock_timestamp() as observed_at, clued_control.read_execution() as execution';
const QUERY_SHA256 = sha(QUERY);
const UNIT = '\x1f';
const ENTRY = path.resolve(import.meta.dirname, 'entry-root12.sh');
const RUNTIME_SECONDS = 600;

const probeOnly = flag('--check-connection');
const operation = valueAfter('--operation');
need(probeOnly || ['CREATE', 'START', 'GRR'].includes(operation), 'FIXED_OPERATION_REQUIRED');
// CREATE mints the host window; START must replay it byte for byte. bridge.py compares the
// START material against the dict persisted at CREATE and refuses any difference, so the window
// is written once and read back rather than re-cut -- the accepted limitation recorded in the
// activation README, not something this driver may quietly work around.
const windowPath = valueAfter('--window-file') ?? path.resolve(import.meta.dirname, '.host-window.json');
const templatePath = valueAfter('--template');
need(probeOnly || (templatePath && fs.existsSync(templatePath)), 'MATERIAL_TEMPLATE_REQUIRED');

// Two ways to reach the control store. CLUED_CONTROL_DB_PASSWORD takes the password verbatim
// and is the one to prefer: a generated Postgres password routinely contains characters that a
// URL must percent-encode, and an unencoded one truncates the URL silently -- the failure then
// looks exactly like a wrong password. It also keeps the password out of the process argument
// list, where a connection string would be readable by anything that can run `ps`.
// CLUED_CONTROL_DATABASE_URL is still honoured for a URL someone has already built.
const DEFAULTS = {PGHOST: 'db.uscrdifznmlvczcekqpw.supabase.co', PGPORT: '5432', PGUSER: 'postgres', PGDATABASE: 'postgres', PGSSLMODE: 'require'};
const url = process.env.CLUED_CONTROL_DATABASE_URL ?? null;
const password = process.env.CLUED_CONTROL_DB_PASSWORD ?? null;
need(url || password, 'CLUED_CONTROL_DB_PASSWORD_OR_DATABASE_URL_REQUIRED');
need(!url || /^postgres(ql)?:\/\//.test(url), 'EXACT_POSTGRES_URL_REQUIRED');
const connection = url ? {} : {
  ...DEFAULTS, PGPASSWORD: password,
  ...Object.fromEntries(['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSSLMODE']
    .filter(k => process.env['CLUED_CONTROL_DB_' + k.slice(2)])
    .map(k => [k, process.env['CLUED_CONTROL_DB_' + k.slice(2)]])),
};

// psql, not a driver library: nothing here may depend on a package the controller's runtime
// dependency manifest does not pin.
function sql(text, {columns = 1} = {}) {
  const out = execFileSync('/usr/bin/psql', [...(url ? [url] : []), '-X', '-q', '-A', '-t', '-F', UNIT, '-v', 'ON_ERROR_STOP=1', '-c', text],
    {encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: {...process.env, ...connection}});
  const lines = out.split('\n').filter(l => l.length > 0);
  need(lines.length === 1, 'EXACT_SINGLE_SQL_ROW_REQUIRED');
  const fields = lines[0].split(UNIT);
  need(fields.length === columns, 'EXACT_SQL_COLUMN_COUNT_REQUIRED');
  return fields;
}

function observe() {
  const [observed_at, execution] = sql(QUERY, {columns: 2});
  const row = {observed_at, execution: JSON.parse(execution)};
  need(row.execution?.binding?.root_id === ROOT && row.execution.current?.root_id === ROOT, 'EXACT_EXECUTION_BINDING');
  return {project: PROJECT, query_sha256: QUERY_SHA256, row};
}

const quote = x => "'" + String(x).replaceAll("'", "''") + "'";
// The same two query builders the tool-origin entry uses, so the committed rows the controller
// re-reads are shaped exactly as it expects.
function recordQuery(intent) {
  need(intent && /^ga_[A-Za-z0-9_.-]+$/.test(intent.gaId ?? '') && /^intent_[a-f0-9]{64}$/.test(intent.key ?? '')
    && ['CREATE', 'START'].includes(intent.body?.operation) && typeof intent.body.raw === 'string'
    && intent.body.raw.length <= 131072 && hex64(intent.body.sha256), 'FIXED_INTENT_QUERY_INPUT');
  return 'select clued_control.record_effect_intent(' + quote(intent.gaId) + ',' + quote(intent.key) + ',' + quote(JSON.stringify(intent.body)) + '::jsonb) as recorded';
}
function dispatchQuery(intent, sequence, key) {
  recordQuery(intent);
  need(Number.isSafeInteger(sequence) && sequence >= 1 && /^clued_[a-f0-9]{64}$/.test(key ?? ''), 'FIXED_DISPATCH_QUERY_INPUT');
  return 'select clued_control.dispatch_recorded_intent(' + quote(intent.gaId) + ',' + quote(intent.body.operation + '_SENT') + ',' + quote(key) + ',' + sequence + ',' + quote(intent.body.sha256) + ') as dispatched';
}
// psql -A -t returns the value without its column name, so the alias the query already names
// is restated here to rebuild the single-row object the controller reads.
function call(text, column) {
  const [value] = sql(text);
  need(text.endsWith(' as ' + column), 'EXACT_SQL_COLUMN_ALIAS_REQUIRED');
  return {project: PROJECT, query: text, row: {[column]: JSON.parse(value)}};
}

// A read-only reachability probe, so the credential and the network route can be confirmed
// before anything touches the attempt. It appends nothing and changes nothing.
if (probeOnly) {
  const [now, seq, phase, ctrl] = sql(
    "select clock_timestamp() as now, (select c.sequence from clued_control.execution_current c where c.root_id='" + ROOT + "') as seq,"
    + " (select a.phase from clued_control.gate_attempts a where a.root_id='" + ROOT + "' and a.ga_id=(select c.active_ga_id from clued_control.execution_current c where c.root_id='" + ROOT + "')) as phase,"
    + " (select b.controller_sha256 from clued_control.effective_execution_binding() b) as controller", {columns: 4});
  process.stdout.write(JSON.stringify({state: 'CONTROL_STORE_REACHABLE', authority_effect: 'NONE',
    observed_at: now, current_sequence: Number(seq), attempt_phase: phase, controller_sha256: ctrl}, null, 2) + '\n');
  process.exit(0);
}

// --- Build the live half of the material ------------------------------------
const material = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
// GRR 的物料比模板多三项：grr_raw（Owner 签名的收据）、oracle_assessments、
// result_executor_applicability。模板只承载 CREATE/START 用得到的部分，故由外部文件补齐。
const extrasPath = valueAfter('--grr-extras');
if (operation === 'GRR') {
  need(extrasPath && fs.existsSync(extrasPath), 'GRR_EXTRAS_REQUIRED');
  Object.assign(material, JSON.parse(fs.readFileSync(extrasPath, 'utf8')));
}
const observation = observe();
const execution = observation.row.execution;

const attempts = execution.attempts.filter(a => a.ga_id === execution.current.active_ga_id);
need(attempts.length === 1, 'ONE_EXACT_GA_ATTEMPT');
const attempt = attempts[0];
const ga = JSON.parse(attempt.ga_raw);

// 第 11 代不带修正案：没有激活事件可读，授权窗口就是 GA 自己的 600 秒。
need(!execution.events.some(e => e.request?.ga_id === attempt.ga_id
  && ['SCOPE_AMENDMENT_ACTIVATED', 'RUNTIME_CLOCK_AMENDMENT_ACTIVATED', 'TEMPORAL_CONTINUATION_ACTIVATED'].includes(e.request.operation)),
  'NO_AMENDMENT_EVENT_FOR_THIS_GA');

// Status29 is a live control object, not another Git payload authority: its complete signed
// bytes come from the control store, and the digest it was signed against is the ORIGINAL
// runtime acceptance -- which the superseded temporal event records as its old binding, so it
// is read from history rather than restated as a literal here.
const stored = (execution.control_objects ?? []).filter(x => x.object_type === 'StatusManifest' && x.uri === ga.status_manifest_ref.uri);
need(stored.length === 1 && sha(stored[0].raw) === ga.status_manifest_ref.sha256, 'ACTUAL_STORED_STATUS_READ_REQUIRED');
// Status 绑定的是当前生效的运行时验收，直接从绑定读，不必绕历史事件。
const boundAcceptance = execution.binding.runtime_acceptance_sha256;
need(hex64(boundAcceptance), 'BOUND_RUNTIME_ACCEPTANCE_DIGEST_REQUIRED');

// Preparation is not runtime: the window is cut for THIS dispatch, never inherited, and the
// 600 authorized seconds bound only the container's life.
const iso = ms => new Date(ms).toISOString();
let hostWindow;
if (operation === 'CREATE') {
  const preparedAt = Date.now();
  // 无修正案时容器的寿命就是 GA 自己的窗口：fixed_host 的 effective_window 在 temporal 为
  // None 时直接返回 (issued_at, deadline, expires_at)。主机窗口因此到 GA 的 deadline 为止，
  // 而不是从现在起再数 600 秒——那样必然越过 GA 的截止时刻。
  hostWindow = {prepared_utc: iso(preparedAt), deadline_utc: ga.deadline};
  // Exclusive create: a second CREATE cannot silently re-cut the window a START would replay.
  fs.writeFileSync(windowPath, JSON.stringify(hostWindow) + '\n', {flag: 'wx'});
} else {
  hostWindow = JSON.parse(fs.readFileSync(windowPath, 'utf8'));
  need(Object.keys(hostWindow).sort().join(',') === 'deadline_utc,prepared_utc', 'EXACT_RECORDED_HOST_WINDOW');
}
need(Date.parse(hostWindow.deadline_utc) === Date.parse(ga.deadline), 'HOST_WINDOW_IS_THE_GA_WINDOW');
need(Date.parse(hostWindow.prepared_utc) >= Date.parse(ga.issued_at), 'HOST_WINDOW_BEFORE_GA');
need(Date.parse(hostWindow.prepared_utc) < Date.parse(hostWindow.deadline_utc), 'HOST_WINDOW_ALREADY_CLOSED');
// The host refuses START inside its own stop reserve (30s) plus the start budget (6s). Failing
// here names the real reason instead of surfacing it as an opaque host refusal.
if (operation === 'START') need(Date.parse(hostWindow.deadline_utc) - Date.now() > 36000, 'RECORDED_HOST_WINDOW_TOO_LATE_TO_START');

material.operation = operation;
material.ga_raw = attempt.ga_raw;
material.observation = observation;
material.host_window = hostWindow;
material.status_manifest.raw = stored[0].raw;
material.status_manifest.store_ref = ga.status_manifest_ref;
material.status_manifest.source_binding_sha256 = boundAcceptance;

const summary = {
  state: 'ROOT11_SINGLE_WINDOW_DISPATCH_MATERIAL_READY', authority_effect: 'NONE', qualified: false,
  operation, attempt_phase: attempt.phase, container_id: attempt.container_id,
  current_sequence: execution.current.sequence, charged_seconds: execution.current.charged_seconds,
  observed_at: observation.row.observed_at, host_window: hostWindow, host_window_file: windowPath,
  controller_sha256: execution.binding.controller_sha256,
};
if (flag('--dry-run')) {process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); process.exit(0);}
process.stderr.write(JSON.stringify(summary) + '\n');

// --- Drive the trusted entry ------------------------------------------------
need(fs.existsSync(ENTRY), 'TRUSTED_ENTRY_SCRIPT_REQUIRED');
const child = spawn('/usr/bin/dash', [ENTRY], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {PATH: '/usr/bin:/bin', EXPECTED_CONTROLLER_SHA256: execution.binding.controller_sha256, GH_TOKEN: process.env.GH_TOKEN ?? null},
});
const lines = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
const inbox = [];
let waiter = null;
lines.on('line', line => {
  let value;
  try {value = JSON.parse(line);} catch {return;}
  if (waiter) {const w = waiter; waiter = null; w(value);} else inbox.push(value);
});
const nextMessage = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => {waiter = resolve;});
const send = value => child.stdin.write(JSON.stringify(value) + '\n');

const journal = [];
function record(step, value) {journal.push({step, ...value}); process.stderr.write(JSON.stringify({step, ...value}) + '\n');}

send(material);
for (;;) {
  const message = await nextMessage();
  if (message.state === 'NEED_COMMITTED_DISPATCH') {
    need(message.project === PROJECT, 'FIXED_NODE_PROJECT_REQUIRED');
    // Two separately committed tool calls. Any failure leaves the live slot UNKNOWN; this
    // driver never retries one, because a second dispatch on a recorded intent is exactly what
    // the control store exists to refuse.
    const rec = call(recordQuery(message.intent), 'recorded');
    need(rec.row.recorded?.status === 'RECORDED' && rec.row.recorded.phase === 'INTENT_RECORDED', 'NO_DISPATCH_ON_OLD_OR_UNKNOWN_INTENT');
    const dispatch = call(dispatchQuery(message.intent, rec.row.recorded.sequence, message.dispatch_key), 'dispatched');
    record('committed_dispatch', {intent_sequence: rec.row.recorded.sequence, dispatched: dispatch.row.dispatched?.status ?? null});
    // 入口把单行 stdin 限制在 4 MiB，而 execution_transition 在两个响应里都回了整个
    // 3.3 MB 的 read_execution() 上下文。checkDispatchEvidence 只读 dispatch 那一份的
    // current_context，record 那份只按 status/phase/sequence 检查，所以把没人读的那份丢掉
    // 而不是截断。
    delete rec.row.recorded.current_context;
    send({challenge: message.challenge, record: rec, dispatch});
    continue;
  }
  if (message.state === 'NEED_FRESH_RESULT_CONTEXT') {
    need(message.project === PROJECT, 'FIXED_RESULT_NODE_PROJECT_REQUIRED');
    send({challenge: message.challenge, observation: observe()});
    continue;
  }
  if (message.state === 'ACTUAL_HOST_EFFECT_REQUIRES_REMOTE_RESULT') {
    const request = message.event_request;
    need(['CREATED', 'RUNNING'].includes(request?.operation) && JSON.stringify(request).length <= 262144, 'EXACT_FIXED_HOST_EVENT_REQUIRED');
    const recorded = call("select clued_control.execution_transition(" + quote(JSON.stringify(request)) + "::jsonb) as recorded", 'recorded');
    need(recorded.row.recorded?.status === 'RECORDED' && recorded.row.recorded.phase === request.operation, 'REMOTE_RESULT_UNKNOWN_PRESERVE_ACTUAL_OBSERVATION');
    record('host_effect_recorded', {operation: message.operation, container_id: message.container_id, phase: recorded.row.recorded.phase, sequence: recorded.row.recorded.sequence});
    break;
  }
  if (message.state === 'EXACT_RESULT_REQUIRES_TERMINAL_CAS') {
    const request = message.request;
    need(typeof request?.raw === 'string' && request.raw.length <= 131072 && hex64(request.sha256) && hex64(request.decision_sha256), 'EXACT_SIGNED_RESULT_CAS_REQUIRED');
    const committed = call('select clued_control.commit_gate_result(' + quote(request.raw) + ',' + quote(request.sha256) + ',' + quote(request.decision_sha256) + ') as committed', 'committed');
    need(committed.row.committed?.status === 'COMMITTED' && committed.row.committed.receipt_sha256 === request.sha256 && committed.row.committed.result === message.result, 'RESULT_COMMIT_UNKNOWN_NO_RETRY');
    const readback = observe().row.execution;
    const final = readback.attempts.filter(a => a.ga_id === message.ga_id);
    need(final.length === 1 && final[0].receipt_raw === request.raw && final[0].receipt_sha256 === request.sha256
      && final[0].receipt_id === message.receipt_id && final[0].phase === message.result && readback.current.active_ga_id === null, 'EXACT_RESULT_READBACK_REQUIRED');
    record('result_committed', {result: message.result, receipt_id: message.receipt_id});
    break;
  }
  if (['BLOCKED', 'UNKNOWN'].includes(message.state)) {record('ended', message); break;}
  record('message', message);
}
child.stdin.end();
process.stdout.write(JSON.stringify({state: 'ROOT10_RUNTIME_CLOCK_DISPATCH_STEP_COMPLETE', operation, journal, authority_effect: 'NONE', qualified: false}, null, 2) + '\n');
