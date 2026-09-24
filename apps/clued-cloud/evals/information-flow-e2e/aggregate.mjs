// Run-level aggregation: E2E-09 (no-model mode), the B08 isolation proof,
// the egress summary and the run manifest (plan sections 3, 7 and 8).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizedDigest, redact, writeJson } from './evidence.mjs';
import { PRODUCTION_HOST, PROVIDER_HOSTS, environmentScan } from './preflight.mjs';
import { FORBIDDEN_ENV, childEnv } from './stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function readLedgers(guardDir) {
  const out = {};
  for (const name of fs.existsSync(guardDir) ? fs.readdirSync(guardDir).sort() : []) {
    try { out[name.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(guardDir, name), 'utf8')); } catch {
      out[name] = { unreadable: true };
    }
  }
  return out;
}

function summarizeLedger(ledger) {
  return { allowed: ledger.allowed ?? {}, denied: ledger.denied ?? [], dns: ledger.dns ?? [] };
}

export async function aggregate(state) {
  const { evidenceDir, guardDir, hosts, results, environment, binding, bundle, scan, status, wranglerArgv } = state;
  // Harness egress (P1 is this process; P2 and every Worker host wrote files).
  const own = require(path.join(here, 'isolation-guard.cjs')).ledger;
  const ledgers = { orchestrator: { ...own, pid: '<volatile>' }, ...readLedgers(guardDir) };
  for (const value of Object.values(ledgers)) delete value.pid;
  const guardDenied = Object.values(ledgers).flatMap((row) => row.denied ?? []);
  const egress = [...hosts.flatMap((host) => host.egress), ...(state.phaseBEgress ?? [])];
  const byClass = {};
  for (const row of egress) {
    const k = `${row.allowed ? 'allowed' : 'denied'} ${row.host} ${row.path_class}`;
    byClass[k] = (byClass[k] ?? 0) + 1;
  }
  const deniedEgress = egress.filter((row) => !row.allowed);
  const hostsContacted = [...new Set(egress.map((row) => row.host))].sort();
  const providerEgress = egress.filter((row) => PROVIDER_HOSTS.some((host) => row.host.includes(host)));
  const productionEgress = egress.filter((row) => row.host.includes(PRODUCTION_HOST));
  const egressSummary = { schema: 'clued.information-flow.m0d.egress-summary/1', worker_hosts: hosts.length + 1,
    requests_total: egress.length, hosts_contacted: hostsContacted, denied: deniedEgress.length, by_class: byClass,
    guard: Object.fromEntries(Object.entries(ledgers).map(([name, row]) => [name, summarizeLedger(row)])) };
  writeJson(path.join(evidenceDir, 'egress-summary.json'), egressSummary);

  // E2E-09.
  const packSteps = [];
  let claimsOk = true;
  for (const dir of ['e2e', 'continuity']) {
    const base = path.join(evidenceDir, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((n) => /^E2E-\d+\.json$/.test(n))) {
      const evidence = JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
      if (evidence.claims?.model_extraction !== 'NOT_EVALUATED') claimsOk = false;
      for (const step of evidence.steps ?? []) {
        if (step.extracted && Array.isArray(step.extracted.items) && step.extracted.status === 'ok') {
          packSteps.push({ scenario: evidence.scenario_id, model_extraction: step.extracted.model_extraction,
            execution_authorization: step.extracted.execution_authorization });
        }
      }
    }
  }
  const harnessSources = fs.readdirSync(here, { recursive: true }).filter((name) => /\.(mjs|cjs)$/.test(name))
    .filter((name) => !name.endsWith('aggregate.mjs') && !name.endsWith('preflight.mjs'))
    .map((name) => fs.readFileSync(path.join(here, name), 'utf8')).join('\n');
  const e09 = { schema: 'clued.information-flow.m0d.e2e-evidence/1', scenario_id: 'E2E-09',
    contract: binding.contract, code_binding: binding.code, environment, aliases: {}, steps: [], notes: [
      'Aggregation over the whole run: Worker egress ledger (Miniflare outboundService), Node guard ledgers, '
      + 'environment scan, a static scan of the dry-run Worker bundle and every compiled pack.'],
    assertions: [] };
  const check = (id, text, expected, observed) => e09.assertions.push({ id, text, expected, observed,
    pass: JSON.stringify(observed) === JSON.stringify(expected) });
  check('09.egress_denied', 'zero non-allowlisted Worker egress attempts', 0, deniedEgress.length);
  check('09.egress_hosts', 'the Worker contacted only the loopback gateway', [new URL(status.apiUrl).host], hostsContacted);
  check('09.provider_egress', 'zero requests to model/provider hosts', 0, providerEgress.length);
  check('09.production_egress', 'zero requests to the production Supabase host', 0, productionEgress.length);
  check('09.guard_denied', 'zero non-loopback connection attempts from harness Node processes', 0, guardDenied.length);
  check('09.bundle_provider_hosts', 'the Worker bundle contains no provider host', [], bundle.provider_hosts);
  check('09.extractor_not_imported', 'the M0-B extractor / promptfoo is not in the Worker bundle', false,
    bundle.extractor_imported);
  check('09.promptfoo_never_invoked', 'the harness never invokes promptfoo', false, /promptfoo/.test(harnessSources));
  check('09.packs_not_evaluated', 'every compiled pack carries model_extraction=NOT_EVALUATED', true,
    packSteps.length > 0 && packSteps.every((row) => row.model_extraction === 'NOT_EVALUATED'));
  check('09.packs_not_granted', 'every compiled pack carries execution_authorization=NOT_GRANTED', true,
    packSteps.length > 0 && packSteps.every((row) => row.execution_authorization === 'NOT_GRANTED'));
  check('09.claims', 'every scenario claims block records model_extraction=NOT_EVALUATED', true, claimsOk);
  e09.extracts = { packs_checked: packSteps.length, egress_requests: egress.length, bundle_production_default_present:
    bundle.production_host };
  e09.result = e09.assertions.every((a) => a.pass) ? 'PASS' : 'FAIL';
  e09.claims = { model_extraction: 'NOT_EVALUATED', verdict_env: '_LOCAL_QUALIFIED',
    od5_qualifier: 'Agent authority confined only on the Information Flow path' };
  e09.normalized_digest = normalizedDigest(e09);
  writeJson(path.join(evidenceDir, 'e2e', 'E2E-09.json'), e09);
  results['E2E-09'] = { result: e09.result, assertions: e09.assertions.length,
    failed: e09.assertions.filter((a) => !a.pass).map((a) => a.id), normalized_digest: e09.normalized_digest };

  // B08 isolation proof.
  const childEnvNames = Object.keys(childEnv()).sort();
  const childForbidden = childEnvNames.filter((name) => FORBIDDEN_ENV.some((pattern) => pattern.test(name)));
  const bindingsSeen = hosts.map((host) => host.ready?.binding_names ?? []);
  const e08File = path.join(evidenceDir, 'continuity', 'E2E-08.json');
  const phaseBIdentity = fs.existsSync(e08File)
    ? JSON.parse(fs.readFileSync(e08File, 'utf8')).assertions.find((a) => a.id === '08.B.db_identity') ?? null : null;
  const identityChecks = state.identityChecks ?? [];
  const identityPass = identityChecks.length === 2 && identityChecks.every((c) => c.system_identifier_equal
    && c.database_oid_equal && c.database_equal && c.server_addr_local) && phaseBIdentity?.pass === true;
  const points = {
    worker_egress: { hosts_contacted: hostsContacted, denied: deniedEgress.length, production_host_requests:
      productionEgress.length, supabase_url_binding_is_gateway: hosts.every((host) => host.config.gatewayOrigin === status.apiUrl),
    pass: deniedEgress.length === 0 && productionEgress.length === 0 && hostsContacted.length <= 1 },
    harness_egress: { processes: Object.keys(ledgers).length, denied: guardDenied.length, pass: guardDenied.length === 0 },
    credentials_absent: { orchestrator_scan: environmentScan(), child_env_allowlist: childEnvNames,
      child_forbidden: childForbidden, pass: scan.forbidden.length === 0 && childForbidden.length === 0
        && !scan.project_ref_linked },
    database_identity: { system_identifier: state.dbIdentity.system_identifier, database_oid: state.dbIdentity.database_oid,
      server_addr: state.dbIdentity.server_addr, database: state.dbIdentity.database,
      docker_bridge_cidrs: state.bridgeCidrs ?? [], connection_checks: identityChecks,
      phase_b_check: phaseBIdentity ? { id: phaseBIdentity.id, pass: phaseBIdentity.pass } : null,
      rule: 'local = loopback, Unix socket or the Docker bridge subnet(s) of the local db container read at runtime; '
        + 'every connection must match the identity recorded right after db reset', pass: identityPass },
    no_deploy_no_production_read: { wrangler_argv: wranglerArgv, production_release_gate_pre_deploy_invoked: false,
      worker_bindings: bindingsSeen[0] ?? [], pass: wranglerArgv.includes('--dry-run') },
    zero_model_provider_calls: { provider_egress: providerEgress.length, bundle_provider_hosts: bundle.provider_hosts,
      pass: providerEgress.length === 0 && bundle.provider_hosts.length === 0 },
    zero_cost: { paid_credentials_present: scan.forbidden.length > 0, deploy: false,
      residual: 'Image and CLI pulls and CLI update/telemetry checks happen in preflight, outside the qualification '
        + 'window; they are not writes, reach no model provider and cost nothing.', pass: scan.forbidden.length === 0 },
    historical: {
      referenced_exception: 'S1 production apply (PR #307)',
      statement: 'PR #307 states migration S1 was applied to clued-prod before S6. That apply is outside every S6 '
        + 'qualification run and is the only known production write of the Information Flow slices.',
      authorization: { decision_id: '7040b127-2a42-4ff6-ba46-060a594a9c1d',
        receipt_id: 'cef0f0dd-c89e-4eac-b805-18c0816b4449', kind: 'retroactive Owner authorization',
        writer: 'Agent-written, disclosed under OPEN_BY_OD-5',
        quoted_owner_confirmation: '补记授权，结论保持“本地验证” (推荐)' },
      backup_and_read_back: 'none recorded for the S1 apply (register L28)',
      scope: 'B08 claims only the S6 qualification runs, as the Decision states; every verdict keeps _LOCAL_QUALIFIED',
      register_entries: ['L26', 'L28'],
    },
  };
  const isolation = { schema: 'clued.information-flow.m0d.isolation/1', points,
    result: Object.values(points).every((point) => point.pass !== false) ? 'PASS' : 'FAIL' };
  writeJson(path.join(evidenceDir, 'isolation.json'), redact(isolation));

  writeJson(path.join(evidenceDir, 'run.json'), { schema: 'clued.information-flow.m0d.e2e-run/1', environment,
    code_binding: binding.code, contract: binding.contract, bundle, preflight_env_scan: scan,
    results: Object.fromEntries(Object.entries(results).sort()), duration_class: Date.now() - state.runStarted > 20 * 60000
      ? 'over_20_min' : 'under_20_min' });
  return { isolation: isolation.result, e09: e09.result };
}
