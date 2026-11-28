import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { insist } from './release-admission.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const manifest = 'work/independent-ci-resident-v1/rollout/fleet/release-migrations.json';
const sqlDir = 'apps/clued-cloud/supabase/migrations';
const version = /^[0-9]{14}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const procedure = (name, result, conditions = 'true', returnsSet = false) => `exists (select 1 from pg_proc p
    where p.oid = to_regprocedure('clued_private.${name}') and p.prokind = 'f' and p.proretset = ${returnsSet}
      and p.prorettype = '${result}'::regtype and (${conditions})
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
        where grantee = 0 and privilege_type = 'EXECUTE')
      and not exists (select 1 from pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role', 'clued_worker_gateway')
          and has_function_privilege(r.oid, p.oid, 'EXECUTE')))`;
const relation = (name, columns) => `exists (select 1 from pg_class c
    where c.oid = to_regclass('clued_private.${name}') and c.relkind = 'r'
      and not exists (select 1 from (values ${Object.entries(columns).map(([column, type]) => `('${column}', '${type}'::regtype)`).join(',')})
        expected(name, type) where not exists (select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = expected.name and a.atttypid = expected.type and not a.attisdropped)))`;
const acceptanceGuard = `if clued_private.fleet_package_generation_v1(v_parts[2])>=25 then
    if p_input->'delivery'->'candidate'->>'repository' is distinct from v_parts[1]
        or p_input->'delivery'->'candidate'->>'version' is distinct from v_parts[2]
        or p_input->'delivery'->'candidate'->>'archiveSha256' is distinct from v_parts[3]
        or p_input->'delivery'->'candidate'->>'requestSha256' is distinct from v_parts[4] then
      raise exception 'fleet_delivery_subject_invalid' using errcode='22023'; end if;
    perform clued_private.fleet_delivery_require_snapshot_v1(p_input->'delivery'->'candidate',p_input->'delivery'->>'snapshotToken');
  end if;
  v_req:=clued_private.owner_grant_door_request_v1(v_anchor,'fleet.accept',array[v_resource]);`;
// The release door's owner is the migration login by contract. Inspect its
// privileges through the attestation connection without loading its credential.
const callerCanExecute = `exists (select 1 from pg_proc door join pg_roles r on r.oid = door.proowner
    where door.oid = to_regprocedure('clued_private.release_door_v1(jsonb)') and r.rolcanlogin
      and has_schema_privilege(r.oid, p.pronamespace, 'USAGE') and has_function_privilege(r.oid, p.oid, 'EXECUTE'))`;
const bodyContains = code => `strpos(p.prosrc, $probe$${code}$probe$) > 0`;
const pendingStates = "n.state in ('pending','active','draining')";
const probes = {
  train: `${relation('ci_train_batches_v2', { batch_id: 'text', state: 'text', test_sha: 'text', tree_sha: 'text', receipt_id: 'uuid' })}
    and ${procedure('ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)', 'jsonb')}`,
  landing: `${relation('ci_train_landing_receipts_v2', { receipt_id: 'uuid', repository: 'text', effect_id: 'text', intent: 'jsonb', result: 'jsonb' })}
    and ${relation('ci_train_member_receipts_v2', { receipt_id: 'uuid', landing_receipt_id: 'uuid', pr_number: 'bigint', result: 'jsonb' })}
    and ${procedure('ci_train_record_landing_v2(public.clued_agent_bindings,text,text,jsonb,jsonb)', 'uuid')}`,
  delivery: `${relation('fleet_accepted_v1', { sealed_at: 'timestamptz', acceptance_sha256: 'text', grant_id: 'uuid', receipt_id: 'uuid',
    accepted_at: 'timestamptz', version: 'text', repository: 'text', archive_sha256: 'text', request_sha256: 'text' })}
    and ${procedure('fleet_delivery_registry_v1(jsonb)', 'jsonb', `p.provolatile = 's' and ${callerCanExecute}`)}
    and ${procedure('fleet_delivery_seal_v1(jsonb)', 'jsonb', callerCanExecute)}
    and ${procedure('fleet_delivery_require_snapshot_v1(jsonb,text)', 'void', `p.provolatile = 's'
      and ${bodyContains('declare fresh jsonb:=clued_private.fleet_delivery_registry_v1(c);')}
      and ${bodyContains("if token is null or token is distinct from fresh->>'snapshotToken' then")}`)}
    and ${procedure('fleet_accept_door_v1(jsonb)', 'jsonb', `p.prosecdef
      and ${bodyContains("k not in ('action','resources','run_id','run_attempt','delivery')")}
      and ${bodyContains(acceptanceGuard)}`)}`,
  pendingDelivery: `${procedure('fleet_node_target_v1(uuid,uuid)', 'jsonb', `p.provolatile = 's'
      and (${bodyContains("n.revoked_at is null and " + pendingStates)}
        or ${bodyContains("from clued_private.fleet_delivery_recipient_rows_v1(p_owner) n")})
      and ${bodyContains("'acceptance_sha256',a.acceptance_sha256")}`)}
    and exists (select 1 from pg_proc p
      where p.oid = to_regprocedure('public.clued_ci_connection_renew_v1(jsonb)')
        and ${bodyContains("case when k='ci' and " + pendingStates)}
        and ${bodyContains("'fleet_target',clued_private.fleet_node_target_v1(u,n.node_id)")})`,
  deliveryRecipients: procedure('fleet_delivery_registry_v1(jsonb)', 'jsonb', `p.provolatile = 's' and ${callerCanExecute}
    and ${bodyContains('jsonb_build_array(identity.user_id,identity.anchor_binding_id,c,recipients)')}`),
  deliveryPeerRecipients: `${procedure('fleet_delivery_recipient_rows_v1(uuid)', 'record', `p.provolatile = 's' and not p.prosecdef
      and not exists (select 1 from pg_proc caller
        where caller.oid in (to_regprocedure('clued_private.fleet_delivery_registry_v1(jsonb)'),
          to_regprocedure('clued_private.fleet_node_target_v1(uuid,uuid)'))
          and not has_function_privilege(caller.proowner, p.oid, 'EXECUTE'))`, true)}
    and ${procedure('fleet_delivery_registry_v1(jsonb)', 'jsonb', `p.provolatile = 's' and ${callerCanExecute}
      and ${bodyContains('from clued_private.fleet_delivery_recipient_rows_v1(identity.user_id) n')}`)}
    and ${procedure('fleet_node_target_v1(uuid,uuid)', 'jsonb', `p.provolatile = 's'
      and ${bodyContains("from clued_private.fleet_delivery_recipient_rows_v1(p_owner) n")}
      and ${bodyContains("n.registration->'recipientExclusion'='null'::jsonb")}`)}`,
  previousInterfaceGate: `${relation('fleet_accepted_v1', { previous_interface_evidence: 'jsonb' })}
    and (case when to_regtype('clued_private.fleet_accepted_v1') is not null then
      ${procedure('fleet_require_previous_interface_v1(jsonb,clued_private.fleet_accepted_v1)', 'jsonb',
    `p.provolatile = 's' and ${callerCanExecute}
      and ${bodyContains("proof jsonb:=p_input->'previousInterfaceEvidence';")}
      and ${bodyContains("proof->'candidate' is distinct from p_input->'candidate'")}
      and ${bodyContains("proof->>'migrationsSha256' is distinct from p_input->>'migrationsSha256'")}
      and ${bodyContains('order by version desc limit 1;')}
      and ${bodyContains("raise exception 'fleet_previous_interface_predecessor_changed'")}`)} else false end)
    and ${procedure('fleet_delivery_seal_v1(jsonb)', 'jsonb', `${callerCanExecute}
      and ${bodyContains('proof:=clued_private.fleet_require_previous_interface_v1(p_input,a);')}
      and ${bodyContains('previous_interface_evidence=proof')}`)}`,
  sealedSourceRule: `${relation('fleet_accepted_v1', { source_sha256: 'text', source_commit: 'text' })}
    and ${relation('fleet_maintenance_v1', { operation_id: 'uuid', binding_generation: 'bigint',
      reinstall_pause_until: 'timestamptz', reinstall_pause_receipt_id: 'uuid', reinstall_resume_receipt_id: 'uuid' })}
    and ${procedure('fleet_delivery_seal_v1(jsonb)', 'jsonb', `${callerCanExecute}
      and ${bodyContains("clued_private.fleet_backfill_previous_v1(a,p_input->>'previousRequest')")}
      and ${bodyContains("source_commit=candidate->>'commit'")}`)}
    and ${procedure('fleet_maintenance_request_v1(uuid,uuid,jsonb)', 'jsonb', "p.provolatile = 'v'")}
    and ${procedure('fleet_reinstall_window_tick_v1(uuid,uuid,timestamptz)', 'void', "p.provolatile = 'v'")}`,
  reinstallWindowPartialReady: procedure('fleet_reinstall_window_tick_v1(uuid,uuid,timestamptz)', 'void', `p.provolatile = 'v'
    and ${bodyContains('if cardinality(ready_nodes) <> jsonb_array_length(peers)')}
    and ${bodyContains('and (t >= w.reinstall_pause_until) is not true')}`),
};

export function releaseRequirements(commit, read = file => execFileSync('git', ['show', `${commit}:${file}`], {
  cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 << 20,
})) {
  insist(/^[0-9a-f]{40}$/.test(commit), 'FLEET_RELEASE_SUBJECT_REFUSED');
  const entries = JSON.parse(read(manifest).toString('utf8'));
  insist(Array.isArray(entries) && entries.length > 0 && entries.length <= 64, 'FLEET_MIGRATION_REQUIREMENTS_REFUSED');
  const files = new Set(), names = new Set(), versions = new Set(), seenProbes = new Set();
  const requirements = entries.map(({ file, requires, probe }) => {
    const match = /^([0-9]{14})_([a-z0-9_]+)\.sql$/.exec(file);
    insist(match && !files.has(file) && !names.has(match[2]) && !versions.has(match[1]) && Object.hasOwn(probes, probe) && !seenProbes.has(probe) &&
      Array.isArray(requires) && new Set(requires).size === requires.length && requires.every(dep => files.has(dep)),
    'FLEET_MIGRATION_REQUIREMENTS_REFUSED', file);
    const bytes = read(`${sqlDir}/${file}`);
    const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    insist(sql.endsWith('\n') && !/[\x00-\x02\r]|^\\\.$/m.test(sql), 'FLEET_MIGRATION_FILE_REFUSED', file);
    files.add(file);
    names.add(match[2]);
    versions.add(match[1]);
    seenProbes.add(probe);
    return { file, version: match[1], name: match[2], digest: sha256(bytes), requires, probe };
  });
  insist(Object.keys(probes).every(probe => seenProbes.has(probe)), 'FLEET_MIGRATION_REQUIREMENTS_REFUSED');
  return requirements;
}

export function missingMigrations(requirements, snapshot) {
  insist(snapshot?.base === true && Array.isArray(snapshot.applied) && snapshot.interfaces &&
    snapshot.applied.length <= requirements.length, 'FLEET_MIGRATION_SNAPSHOT_REFUSED');
  const byName = new Map(requirements.map(row => [row.name, row]));
  const applied = new Map(), seenVersions = new Set();
  for (const row of snapshot.applied) {
    const expected = byName.get(row?.name);
    insist(expected && !applied.has(row.name) && typeof row.version === 'string' && version.test(row.version) && !seenVersions.has(row.version) &&
      row.digest === expected.digest, 'FLEET_MIGRATION_LEDGER_CONFLICT', row?.name);
    applied.set(row.name, row.version);
    seenVersions.add(row.version);
  }
  const installed = new Map();
  return requirements.flatMap(row => {
    const observed = applied.get(row.name);
    insist(snapshot.interfaces[row.probe] === Boolean(observed), 'FLEET_MIGRATION_INTERFACE_MISMATCH', row.file);
    if (observed) insist(row.requires.every(dep => installed.get(dep) && installed.get(dep) < observed), 'FLEET_MIGRATION_DEPENDENCY_MISMATCH', row.file);
    installed.set(row.file, observed);
    return observed ? [] : [row.file];
  });
}

export const requirementsDigest = requirements => sha256(JSON.stringify(requirements));
export const SNAPSHOT_LABEL = 'CLUED_FLEET_MIGRATIONS_V1';

export function readbackSql(requirements) {
  const quote = values => values.map(value => `'${value}'`).join(',');
  const names = quote(requirements.map(row => row.name));
  const versions = quote(requirements.map(row => row.version));
  const interfaces = requirements.map(({ probe }) => `'${probe}', (${probes[probe]})`).join(',\n');
  return `begin isolation level repeatable read read only;
select jsonb_build_object('base', ${procedure('release_door_v1(jsonb)', 'jsonb', `p.prosecdef and ${callerCanExecute}`)}
    and ${procedure('fleet_accept_door_v1(jsonb)', 'jsonb', `p.prosecdef and ${callerCanExecute}`)},
  'applied', coalesce((select jsonb_agg(jsonb_build_object('version', version, 'name', name,
    'digest', encode(sha256(convert_to(array_to_string(statements, ''), 'UTF8')), 'hex')) order by version)
    from supabase_migrations.schema_migrations where name in (${names}) or version in (${versions})), '[]'::jsonb),
  'interfaces', jsonb_build_object(${interfaces}));
commit;\n`;
}

function readProduction(requirements, rawUrl) {
  const ref = 'ccxsikzwxlolxqlosril';
  let url;
  try { url = new URL(rawUrl); } catch { insist(false, 'FLEET_MIGRATION_DATABASE_REFUSED'); }
  const direct = url.hostname === `db.${ref}.supabase.co` && (!url.port || url.port === '5432');
  const pool = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && ['5432', '6543'].includes(url.port) &&
    decodeURIComponent(url.username).split('.').at(-1) === ref;
  insist(['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/postgres' && (direct || pool) &&
    ![...url.searchParams.keys()].some(k => ['host', 'hostaddr', 'port', 'dbname', 'database', 'user', 'service', 'servicefile'].includes(k.toLowerCase())),
  'FLEET_MIGRATION_DATABASE_REFUSED');
  url.searchParams.delete('uselibpqcompat');
  url.searchParams.set('sslmode', 'verify-full');
  if (!url.searchParams.has('sslrootcert')) url.searchParams.set('sslrootcert', 'system');
  try {
    const reply = execFileSync('docker', ['run', '--rm', '-i', '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'DATABASE_URL',
      'postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929',
      'sh', '-c', 'exec psql "$DATABASE_URL" -X -q -tA -v ON_ERROR_STOP=1'], {
      env: { ...process.env, DATABASE_URL: url.href }, input: readbackSql(requirements), stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 90_000, maxBuffer: 64 << 10,
    });
    return JSON.parse(reply.toString('utf8'));
  } catch { insist(false, 'FLEET_MIGRATION_SNAPSHOT_UNREADABLE'); }
}

if (import.meta.main) {
  try {
    const env = process.env;
    const phase = process.argv[2];
    insist(['read', 'before-migrate', 'after-migrate'].includes(phase) && env.GITHUB_SHA === env.EXPECTED_RELEASE_SHA &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) && env.GITHUB_RUN_ATTEMPT === '1', 'FLEET_MIGRATION_RUN_REFUSED');
    const requirements = releaseRequirements(env.GITHUB_SHA);
    const snapshot = readProduction(requirements, env.CLUED_ATTESTATION_DATABASE_URL);
    const missing = missingMigrations(requirements, snapshot);
    if (phase === 'before-migrate') insist(missing.length > 0 && missing.join(',') === env.MIGRATIONS, 'FLEET_MIGRATION_PLAN_CHANGED', { missing });
    if (phase !== 'before-migrate') console.log(SNAPSHOT_LABEL, JSON.stringify({ commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
      requirementsSha256: requirementsDigest(requirements), snapshot }));
    if (phase === 'after-migrate') insist(missing.length === 0, 'FLEET_MIGRATION_INCOMPLETE', { missing });
  } catch (error) {
    console.error(error.code ?? 'FLEET_MIGRATION_READBACK_REFUSED', JSON.stringify(error.detail ?? null));
    process.exitCode = 1;
  }
}
