'use strict';

// Fixed DEVELOPMENT request preparation and passive result retention only.
// The original M1 capture is held directly by the Root Host. Shape checking
// cannot authenticate its provenance or qualify an issuer. There is no run,
// issuance, serialized ISSUED input, tool callback, CLI or offline fallback.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const SCHEMA = 'clued.fixed-development-request-authorization-payload/1';
const SHA = /^[0-9a-f]{64}$/;
const MAX_SAVED = 1048576;
const need = (ok, code) => { if (!ok) throw new Error('DEVELOPMENT_REQUEST_HOST_' + code); };
const stable = value => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  need(typeof value !== 'number' || Number.isFinite(value), 'NONFINITE');
  const text = JSON.stringify(value); need(text !== undefined, 'JSON_VALUE'); return text;
};
const clone = value => JSON.parse(stable(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const objectDigest = value => digest(Buffer.from(stable(value), 'utf8'));
const sourceHashes = source => Object.fromEntries(source.files.map(row => [row.path,row.sha256]));
const frozen = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
};
function utc(value) {
  const m = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  need(m, 'UTC_WINDOW'); const n = Date.parse(value);
  need(Number.isFinite(n) && new Date(n).toISOString() ===
    m[1] + '.' + (m[2] || '').padEnd(3, '0').slice(0, 3) + 'Z', 'UTC_WINDOW'); return n;
}
function windowCheck(window, current = false) {
  const start = utc(window?.not_before), stop = utc(window?.stop_at);
  need(stop > start && stop - start <= 86400000, 'WINDOW_LIMIT');
  if (current) need(Date.now() >= start && Date.now() < stop, 'WINDOW_NOT_CURRENT');
}
function pin(row) {
  need(row && typeof row.path === 'string' && row.path.length > 0
    && Number.isSafeInteger(row.bytes) && row.bytes > 0 && SHA.test(row.sha256), 'FILE_PIN');
}
function validatePayload(p) {
  need(p && Object.keys(p).sort().join(',') ===
    'budget,device,fixed_startup,input,model,namespace,permissions,profile_id,purpose_id,schema,scope,source,task_id,window', 'PAYLOAD_FIELDS');
  need(p.schema === SCHEMA && p.scope === SCOPE && p.task_id === TASK && p.purpose_id === 'development'
    && typeof p.profile_id === 'string' && /^DEV-[A-Za-z0-9._-]{1,120}$/.test(p.profile_id), 'EXACT_DEVELOPMENT');
  need(stable(p.permissions) === stable({model_call:true,namespace_install:true,profile_install:true,
    training:false,production:false,qualification:false,paid:false,downloads:false,private_data:false,
    authorization_platform:false,backup:false,sql:false,deployment:false}), 'PERMISSIONS');
  const b = p.budget;
  need(b?.attempts === 1 && b.model_calls === 1 && b.concurrency === 1 && b.training_steps === 0
    && b.paid_cost === 0 && b.downloads === 0 && b.model_external_network_bytes === 0, 'SINGLE_NONLEARNING_BUDGET');
  need(b.control_total_seconds === 240, 'CONTROL_TOTAL_BUDGET');
  for (const [name, ceiling] of Object.entries({input_tokens:4096,output_tokens:512,total_tokens:4608,
    context_tokens:8192,stdout_bytes:131072,stderr_bytes:131072,observation_bytes:65536,
    wall_seconds:120,max_output_storage_bytes:MAX_SAVED,other_result_profile_ledger_and_receipts_max_bytes:262144}))
    need(Number.isSafeInteger(b[name]) && b[name] > 0 && b[name] <= ceiling, 'BUDGET_' + name.toUpperCase());
  need(b.output_tokens < b.total_tokens && b.input_tokens + b.output_tokens <= b.total_tokens, 'TOKEN_TOTAL');
  const encoded = [b.stdout_bytes,b.stderr_bytes,b.observation_bytes]
    .reduce((n, size) => n + 4 * Math.ceil(size / 3), 0);
  need(encoded + b.observation_bytes + b.other_result_profile_ledger_and_receipts_max_bytes
    <= b.max_output_storage_bytes, 'SAVED_STORAGE_BOUND');
  need(p.device?.cpu_threads === 2 && p.device.gpu_layers === 0 && p.device.substitution_allowed === false,
    'EXACT_DEVICE');
  need(/^[0-9a-f]{40}$/.test(p.source?.head) && Array.isArray(p.source.files) && p.source.files.length > 0,
    'SOURCE'); p.source.files.forEach(pin);
  need(new Set(p.source.files.map(row => row.path)).size === p.source.files.length, 'SOURCE_DUPLICATE');
  pin({path:p.model?.absolute_path,bytes:p.model?.bytes,sha256:p.model?.sha256});
  pin(p.input?.prompt); pin(p.input?.schema);
  need(p.input?.root_count === 1 && p.input.gold === false && p.input.holdout === false, 'DEVELOPMENT_INPUT');
  const f = p.fixed_startup, plan = f?.execution_plan_without_runtime_monotonic_deadline;
  need(f && plan && !Object.hasOwn(plan, 'deadline_monotonic')
    && objectDigest(plan) === f.execution_plan_sha256 && objectDigest(f.startup) === f.startup_sha256,
    'FIXED_PLAN_OR_STARTUP_DIGEST');
  for (const name of ['input_tokens','output_tokens','total_tokens','stdout_bytes','stderr_bytes','observation_bytes','wall_seconds'])
    need(plan.budget?.[name] === b[name], 'PLAN_BUDGET');
  need(plan.model?.path === p.model.absolute_path && plan.model.sha256 === p.model.sha256
    && plan.model.bytes === p.model.bytes && stable(plan.prompt) === stable(p.input.prompt)
    && stable(plan.output_schema) === stable(p.input.schema), 'PLAN_ASSETS');
  need(typeof p.namespace?.root === 'string' && p.namespace.reuse_old_m1_ledger === false
    && p.namespace.ledger_child === 'ledger' && p.namespace.output_child === 'outputs'
    && p.namespace.physical_same_principal_isolation_claimed === false
    && f.output_name === 'runtime-observation.jsonl' && p.namespace.observation_name === f.output_name
    && path.resolve(f.ledger_directory) === path.resolve(p.namespace.root,p.namespace.ledger_child)
    && path.resolve(f.output_directory) === path.resolve(p.namespace.root,p.namespace.output_child)
    && path.resolve(plan.observation_path) === path.resolve(f.output_directory,f.output_name)
    && f.startup.environment?.TEMP === path.join(p.namespace.root,'tmp')
    && f.startup.environment?.TMP === path.join(p.namespace.root,'tmp'), 'FIXED_NAMESPACE');
  windowCheck(p.window);
}
function makeDevelopmentRequestPayload(draft, window) {
  // This is the whole hash domain. Later approval/receipt/profile/output fields
  // and the digest itself are absent; adding them to a packet is non-circular.
  const p = clone({schema:SCHEMA,scope:SCOPE,task_id:draft.task_id,profile_id:draft.proposed_profile_id,
    purpose_id:draft.purpose,source:draft.source,model:draft.model,input:draft.input,device:draft.device,
    budget:draft.budget,namespace:draft.planned_namespace,fixed_startup:draft.fixed_startup_preparation,
    permissions:{model_call:true,namespace_install:true,profile_install:true,training:false,production:false,
      qualification:false,paid:false,downloads:false,private_data:false,authorization_platform:false,
      backup:false,sql:false,deployment:false},window});
  validatePayload(p);
  const bytes = Buffer.from(stable(p),'utf8');
  need(bytes.length <= 131072, 'REQUEST_SIZE');
  return Object.freeze({payload:frozen(p),requestBytes:bytes,requestSha256:digest(bytes),
    hashDomain:SCHEMA + ': exact canonical UTF-8 payload bytes, no trailing newline'});
}
function parseRequest(bytes, expected) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 131072 && SHA.test(expected), 'REQUEST_BYTES');
  need(digest(bytes) === expected, 'REQUEST_DIGEST');
  const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes), p = JSON.parse(text);
  need(stable(p) === text, 'REQUEST_CANONICAL'); validatePayload(p); return p;
}
function originalCapture(value) {
  need(value && !value.isError, 'ORIGINAL_CAPTURE');
  const c = value.structuredContent || JSON.parse((value.content || []).find(row => row.type === 'text')?.text || 'null');
  const r = c?.supplemental?.record;
  need(c?.status === 'committed' && typeof c.receipt_id === 'string' && c.receipt_id.length > 0
    && Array.isArray(c.event_ids) && c.event_ids.length > 0
    && r?.record_type === 'decision' && r.authority === 'user_explicit' && r.lifecycle_status === 'active'
    && r.canonical_scope === SCOPE && r.receipt_id === c.receipt_id && SHA.test(r.content_hash)
    && typeof r.id === 'string' && Number.isSafeInteger(r.version) && r.version > 0, 'EXACT_OWNER_CAPTURE');
  return {capture:c,record:r};
}
function prepareFixedDevelopmentOwnerBinding({requestBytes,expectedRequestSha256,ownerCapture,sessionRef,livePins}) {
  const p = parseRequest(requestBytes,expectedRequestSha256), {capture,record} = originalCapture(ownerCapture);
  // Preserve the real M1 supplemental Record shape; a serialized legacy
  // top-level rationale is not an alternative approval carrier.
  const rationale = record.type_fields?.rationale;
  need(rationale && typeof rationale === 'object' && !Array.isArray(rationale), 'OWNER_RATIONALE_CARRIER');
  const a = rationale.model_development_experiment_approval;
  need(a?.kind === 'EXACT_BOUNDED_DEVELOPMENT_EXPERIMENT' && a.task_id === TASK && a.purpose_id === 'development'
    && a.profile_id === p.profile_id && a.request_sha256 === expectedRequestSha256 && a.max_attempts === 1
    && a.training_allowed === false && a.production_allowed === false && a.qualification_allowed === false,
    'EXACT_OWNER_EXPERIMENT');
  need(stable(a.budget) === stable(p.budget) && stable(a.window) === stable(p.window)
    && stable(a.permissions) === stable(p.permissions) && stable(a.source_sha256) === stable(sourceHashes(p.source))
    && a.execution_plan_sha256 === p.fixed_startup.execution_plan_sha256
    && a.startup_sha256 === p.fixed_startup.startup_sha256, 'OWNER_REQUEST_PINS');
  windowCheck(p.window,true);
  need(typeof sessionRef === 'string' && sessionRef.length > 0 && typeof livePins?.claim_id === 'string'
    && livePins.claim_id.length > 0 && Number.isSafeInteger(livePins.claim_fence) && livePins.claim_fence > 0
    && Number.isSafeInteger(livePins.task_version) && livePins.task_version > 0
    && typeof livePins.task_query === 'string' && livePins.task_query.length > 0
    && livePins.holder_session_ref === sessionRef, 'ROOT_LIVE_PINS');
  const manifest = {schema:'clued.fixed-development-profile-preparation/1',readiness:'PREPARED_NOT_ISSUED',
    task_id:TASK,profile_id:p.profile_id,purpose_id:'development',request_sha256:expectedRequestSha256,
    approval_record_id:record.id,approval_version:record.version,approval_receipt_id:capture.receipt_id,
    approval_content_hash:record.content_hash,session_ref:sessionRef,live_pins:clone(livePins),
    execution_plan_sha256:p.fixed_startup.execution_plan_sha256,startup_sha256:p.fixed_startup.startup_sha256,
    source_sha256:sourceHashes(p.source),window:clone(p.window),budget:clone(p.budget),max_attempts:1,
    authority_effect:'NONE',permission_issued:false,
    required_before_execution:'Actual admitted fixed Host and original issuer binding; this preparation is not an issued Profile'};
  const candidateHash = objectDigest(manifest);
  const identity = {task_id:TASK,profile_id:p.profile_id,profile_sha256:candidateHash,
    request_sha256:expectedRequestSha256,approval_record_id:record.id,approval_version:record.version,
    approval_receipt_id:capture.receipt_id,ledger_directory:p.fixed_startup.ledger_directory};
  return frozen({readiness:'PREPARED_NOT_ISSUED',authority_effect:'NONE',permission_issued:false,
    candidate_manifest:manifest,candidate_manifest_sha256:candidateHash,candidate_identity:identity,
    candidate_binding:{identity,execution_plan_sha256:manifest.execution_plan_sha256},
    candidate_bootstrap:{schema:'clued.fixed-development-child-bootstrap/1',identity,
      plan:clone(p.fixed_startup.execution_plan_without_runtime_monotonic_deadline),
      live_pins:{task_version:livePins.task_version,claim_id:livePins.claim_id,claim_fence:livePins.claim_fence},
      output_directory:p.fixed_startup.output_directory,output_name:p.fixed_startup.output_name,
      remaining_seconds:p.budget.wall_seconds}});
}

function base64Capture(value, cap) {
  need(value && Object.keys(value).sort().join(',') === 'data,encoding' && value.encoding === 'base64'
    && typeof value.data === 'string' && value.data.length <= 4 * Math.ceil(cap / 3), 'ENCODED_CAPTURE');
  const bytes = Buffer.from(value.data,'base64');
  need(bytes.length <= cap && bytes.toString('base64') === value.data, 'CAPTURE_SIZE_OR_ENCODING'); return bytes;
}
function deadlineOperations(deadlineMonotonic) {
  // Root captures this one same-process performance.now() cutoff before the
  // whole operation. A caller-supplied clock value does not supply permission.
  need(typeof deadlineMonotonic === 'number' && Number.isFinite(deadlineMonotonic)
    && deadlineMonotonic > performance.now() && deadlineMonotonic <= performance.now() + 240000,
    'SAVE_SHARED_DEADLINE');
  const active = () => need(performance.now() < deadlineMonotonic, 'SAVE_DEADLINE');
  async function within(operation, lateCleanup) {
    active(); let timer, late = false, value;
    const pending = Promise.resolve().then(() => { active(); return operation(); });
    pending.then(result => {
      if (late && lateCleanup) Promise.resolve().then(() => lateCleanup(result)).catch(() => {});
    }, () => {});
    try {
      value = await Promise.race([pending,new Promise((_,reject) => {
        timer = setTimeout(() => reject(new Error('DEVELOPMENT_REQUEST_HOST_SAVE_DEADLINE')),
          Math.max(1,deadlineMonotonic-performance.now()));
      })]);
      active(); return value;
    } catch (error) {
      late = true;
      if (value !== undefined && lateCleanup) Promise.resolve().then(() => lateCleanup(value)).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  }
  return {active,within};
}
async function retainedTree(root, known, within) {
  const files = new Map(), directories = new Map();
  async function visit(directory, depth) {
    const st = await within(() => fs.lstat(directory));
    need(st.isDirectory() && !st.isSymbolicLink() && depth <= 1, 'SAVE_DIRECTORY');
    directories.set(directory,[st.dev,st.ino]);
    const entries = await within(() => fs.readdir(directory)); need(entries.length <= 16, 'SAVE_FILE_COUNT');
    for (const name of entries) {
      const full = path.join(directory,name), stat = await within(() => fs.lstat(full));
      need(!stat.isSymbolicLink(), 'SAVE_LINK');
      if (stat.isDirectory()) { need(known.directories.has(full),'SAVE_UNDECLARED_DIRECTORY'); await visit(full,depth+1); }
      else { need(stat.isFile() && stat.nlink === 1 && known.files.has(full),'SAVE_UNDECLARED_FILE');
        files.set(full,{bytes:stat.size,dev:stat.dev,ino:stat.ino}); }
    }
  }
  await visit(root,0); return {files,directories};
}
async function saveFixedDevelopmentResult({requestBytes,expectedRequestSha256,terminalResult,deadlineMonotonic}) {
  // Caller must separately verify the actual Windows private namespace/ACL
  // before and after saving. Metadata checks below do not qualify that Host.
  // Only this single encoded terminal and a small fixed metadata record are
  // created. No raw capture, observation copy, tool log or ledger reset exists.
  const {active,within} = deadlineOperations(deadlineMonotonic);
  const p = parseRequest(requestBytes,expectedRequestSha256), f = p.fixed_startup, b = p.budget;
  const root = path.resolve(p.namespace.root), ledger = path.resolve(f.ledger_directory), out = path.resolve(f.output_directory);
  need(path.isAbsolute(p.namespace.root) && !p.namespace.root.startsWith('\\\\')
    && path.resolve(p.namespace.root) === path.normalize(p.namespace.root).replace(/[\\/]+$/,''), 'SAVE_CANONICAL_ROOT');
  const obsPath = path.join(out,f.output_name), terminalPath = path.join(out,'terminal-result.json');
  const metadataPath = path.join(out,'result-metadata.json');
  const profilePath = path.join(root,'profile-manifest.json');
  const spentPath = path.join(ledger,digest(Buffer.from(p.profile_id)) + '.spent.json');
  const known = {directories:new Set([ledger,out,path.join(root,'tmp')]),files:new Set([spentPath,obsPath,terminalPath,metadataPath,
    ...['profile-manifest.json','approval-receipt.json','request-binding.json'].map(name => path.join(root,name))])};
  const before = await retainedTree(root,known,within);
  need(before.files.has(spentPath) && before.files.has(obsPath) && before.files.has(profilePath)
    && !before.files.has(terminalPath) && !before.files.has(metadataPath), 'SAVE_SPENT_OBSERVATION_OR_REPLAY');
  const t = clone(terminalResult), reservation = t.budget_reservation;
  need(t.authority_effect === 'NONE' && t.model_output_validated === false && t.usage === null
    && t.owned_cleanup_verified === true && reservation?.status === 'SPENT_BEFORE_MODEL_LOAD'
    && path.resolve(reservation.path || '') === spentPath && SHA.test(reservation.sha256)
    && Number.isSafeInteger(reservation.bytes) && reservation.bytes > 0, 'TERMINAL_NOT_OWNED_SPENT_RESULT');
  const beforeTotal = [...before.files.values()].reduce((n,row) => n + row.bytes,0);
  need(beforeTotal <= b.max_output_storage_bytes && before.files.get(spentPath).bytes
    <= b.other_result_profile_ledger_and_receipts_max_bytes, 'EXISTING_STORAGE_LIMIT');
  const spentBytes = await within(() => fs.readFile(spentPath)), spent = JSON.parse(spentBytes.toString('utf8'));
  need(spentBytes.length === reservation.bytes && digest(spentBytes) === reservation.sha256
    && spent.status === 'SPENT_BEFORE_MODEL_LOAD' && spent.max_attempts === 1 && spent.retries_allowed === false
    && spent.task_id === TASK && spent.profile_id === p.profile_id && spent.request_sha256 === expectedRequestSha256
    && spent.plan_sha256 === f.execution_plan_sha256 && SHA.test(spent.profile_sha256), 'EXISTING_SPENT_BINDING');
  need(before.files.get(profilePath).bytes <= b.other_result_profile_ledger_and_receipts_max_bytes, 'PROFILE_FILE_LIMIT');
  const profileBytes = await within(() => fs.readFile(profilePath));
  need(digest(profileBytes) === spent.profile_sha256, 'PROFILE_CONTENT_PIN');
  const stdout = base64Capture(t.stdout_raw,b.stdout_bytes), stderr = base64Capture(t.stderr_raw,b.stderr_bytes);
  const observation = base64Capture(t.observation_capture?.raw,b.observation_bytes);
  need(t.capture?.stdout?.retained_bytes === stdout.length && t.capture?.stderr?.retained_bytes === stderr.length
    && t.observation_capture.retained_bytes === observation.length
    && t.observation_capture.sha256 === digest(observation), 'TERMINAL_CAPTURE_FACTS');
  const obsInfo = before.files.get(obsPath);
  need(obsInfo.bytes <= b.observation_bytes, 'OBSERVATION_FILE_LIMIT');
  const existingObservation = await within(() => fs.readFile(obsPath));
  need(existingObservation.equals(observation), 'OBSERVATION_IDENTITY');
  const terminalBytes = Buffer.from(stable(t) + '\n','utf8');
  const metadata = {schema:'clued.fixed-development-result-retention/1',profile_id:p.profile_id,
    profile_sha256:spent.profile_sha256,request_sha256:expectedRequestSha256,
    terminal_sha256:digest(terminalBytes),observation_sha256:digest(existingObservation),
    authority_effect:'NONE',model_output_validated:false,recorded_at:new Date().toISOString()};
  const metadataBytes = Buffer.from(stable(metadata) + '\n','utf8');
  const retained = beforeTotal;
  const encodedLength = t.stdout_raw.data.length + t.stderr_raw.data.length + t.observation_capture.raw.data.length;
  const other = retained - obsInfo.bytes + terminalBytes.length - encodedLength + metadataBytes.length;
  need(other <= b.other_result_profile_ledger_and_receipts_max_bytes
    && retained + terminalBytes.length + metadataBytes.length <= b.max_output_storage_bytes, 'SAVE_BUDGET');
  async function checkDirectories() {
    for (const [directory,identity] of before.directories) {
      const st = await within(() => fs.lstat(directory));
      need(st.isDirectory() && !st.isSymbolicLink() && st.dev === identity[0] && st.ino === identity[1], 'SAVE_DIRECTORY_CHANGED');
    }
  }
  async function createOnly(target, bytes) {
    await checkDirectories();
    const handle = await within(() => fs.open(target,'wx',0o600), lateHandle => lateHandle.close());
    // A failed or partial file remains. No unlink, overwrite or retry-to-unused.
    try { const st = await within(() => handle.stat()); need(st.isFile() && st.nlink === 1,'SAVE_CREATED_FILE');
      await within(() => handle.writeFile(bytes)); await within(() => handle.sync()); await checkDirectories(); }
    finally {
      // Resource cleanup is attempted even after expiry. Already-started OS
      // work may complete late; the operation stays failed/uncertain and never
      // begins another write, removes a partial file or resets the spent ledger.
      const closing = handle.close(); closing.catch(() => {});
      await within(() => closing);
    }
  }
  await createOnly(terminalPath,terminalBytes); await createOnly(metadataPath,metadataBytes);
  const after = await retainedTree(root,known,within);
  await checkDirectories();
  need([...after.files.values()].reduce((n,row) => n + row.bytes,0) <= b.max_output_storage_bytes, 'SAVE_FINAL_BUDGET');
  for (const [file,row] of before.files) {
    const next = after.files.get(file);
    need(next && next.dev === row.dev && next.ino === row.ino && next.bytes === row.bytes, 'SAVE_EXISTING_FILE_CHANGED');
  }
  need((await within(() => fs.readFile(spentPath))).equals(spentBytes)
    && (await within(() => fs.readFile(obsPath))).equals(existingObservation)
    && (await within(() => fs.readFile(profilePath))).equals(profileBytes), 'SAVE_EXISTING_CONTENT_CHANGED');
  active();
  return frozen({authority_effect:'NONE',model_output_validated:false,terminal_path:terminalPath,
    metadata_path:metadataPath,observation_path:obsPath,terminal_sha256:metadata.terminal_sha256,
    total_saved_bytes:[...after.files.values()].reduce((n,row) => n + row.bytes,0),attempt_remains_spent:true});
}

module.exports = Object.freeze({makeDevelopmentRequestPayload,prepareFixedDevelopmentOwnerBinding,
  saveFixedDevelopmentResult,SCHEMA});
