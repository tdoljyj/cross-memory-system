// Rolling in-place upgrade of every resident node to one Owner-accepted Source (DESIGN §42.3.3, Task 018da927). NON-elevated and
// read-only on every host; `plan` and `observe` write one new file each, never overwrite.
//
//   node rollout/rollout.mjs plan    --out <rollout.json> --decision <uuid> --package <node>=<dir> [--package <node>=<dir> ...]
//   node rollout/rollout.mjs observe --root <resident root> --out <observation.json>          (on each node, in the Owner's session)
//   node rollout/rollout.mjs next    --plan <rollout.json> --observation <file> [--observation <file> ...] [--now <ISO>] [--allow-active-upgrade]
//        [--handover-issued-at <ISO>] [--ack-op <opId> ...]   (an op the Owner has looked at: its outcome no longer blocks)
//
// `next` is a pure function of the plan, one fresh observation per node and the clock. It names the one next step: UPGRADE a node,
// WAIT, DONE or BLOCKED. The STANDBY nodes go first, one at a time (the same rule for any number of nodes, Decision d6eef30e); the
// holder goes last, in place, with ciPause: ci-admission is never handed to a node on another Source (the server refuses it,
// migration 20261114120000: ci_admission_target_source_not_accepted), and while the nodes run different Sources the train stands
// still anyway (TRAIN_SOURCE_MISMATCH). With no upgraded, healthy STANDBY the holder is upgraded only when the Owner chose to pause CI
// (--allow-active-upgrade). A hand-over the Owner wants (between nodes of one Source) is made before the rollout starts.
//
// Nothing here admits anything: the Owner's Grant on the KooYomi page (one per node and package, resource ci-resident:<node>/<sha>)
// admits each upgrade. This tool only says what is due.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HEX64, UUID, canonicalJson, check, sha256 } from '../src/canonical.mjs';
import { parseStatus } from '../src/status.mjs';
import { UPGRADE_STATUS_CONTRACT, parseGenerationCurrent } from '../src/upgrade-mailbox.mjs';

export const ROLLOUT_PLAN_CONTRACT = 'clued.independent-ci.rollout-plan/1';
export const OBSERVATION_CONTRACT = 'clued.independent-ci.rollout-observation/1';
export const NEXT_CONTRACT = 'clued.independent-ci.rollout-next/1';
export const OBSERVATION_FRESH_MS = 15 * 60_000;
export const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MODES = ['ACTIVE', 'STANDBY', 'UNCERTAIN'];
// upgrade\status.json op states that are still moving (src/upgrade-mailbox.mjs UPGRADE_OP_STATES minus the outcomes).
const OP_MOVING = ['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK'];
// Terminal outcomes after which the rollout does not ask for the same upgrade again: the Owner looks first (DESIGN §42.6). Only an
// outcome at or after the plan's createdAt counts (an older one belongs to an earlier rollout); ROLLBACK_FAILED always counts.
const OUTCOMES_ROLLED_BACK = ['ROLLED_BACK_PAUSED', 'ROLLBACK_FAILED'];
const OUTCOMES_REFUSED = ['REFUSED', 'GRANT_REJECTED', 'GRANT_EXPIRED', 'STALE', 'CANCELLED'];
export const HANDOVER_PENDING_MS = 15 * 60_000;
const iso = ms => new Date(ms).toISOString();
const isIso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- plan ----

// The node a package was built for: its record\acceptance.json (what request-upgrade.ps1 checks too).
function packageNode(manifest, bytesOf) {
  const entry = manifest.files.find(f => f.target === 'record\\acceptance.json');
  check(entry, 'ROLLOUT_PACKAGE_REFUSED', 'acceptance');
  const acc = JSON.parse(bytesOf(entry.path).toString('utf8'));
  check(NODE_NAME.test(acc?.node?.nodeName ?? ''), 'ROLLOUT_PACKAGE_REFUSED', 'node');
  return acc.node.nodeName;
}

// packages: [{ node, manifest, manifestBytes, bytesOf(path) -> Buffer }] (each read and verified once by the caller).
export function buildRolloutPlan({ decisionRef, packages, now = Date.now() }) {
  check(UUID.test(decisionRef ?? ''), 'ROLLOUT_DECISION_REQUIRED');
  check(Array.isArray(packages) && packages.length >= 1, 'ROLLOUT_PACKAGES_REQUIRED');
  const seen = new Set();
  const nodes = packages.map(p => {
    check(NODE_NAME.test(p.node ?? '') && !seen.has(p.node), 'ROLLOUT_NODE_TWICE_OR_INVALID', p.node);
    seen.add(p.node);
    check(packageNode(p.manifest, p.bytesOf) === p.node, 'ROLLOUT_PACKAGE_IS_FOR_ANOTHER_NODE', p.node);
    check(p.manifest.acceptance?.decisionRef === decisionRef, 'ROLLOUT_PACKAGE_NOT_THIS_ACCEPTANCE', p.node);
    const packageManifestSha256 = sha256(p.manifestBytes);
    return { node: p.node, packageManifestSha256, residentManifestSha256: p.manifest.residentManifestSha256, grantResource: `ci-resident:${p.node}/${packageManifestSha256}`,
      ciSourceManifestSha256: p.manifest.ciSourceManifestSha256, sourceManifestSha256: p.manifest.sourceManifestSha256 };
  });
  // One Source for every node: only the node profile and identity differ between their packages.
  for (const k of ['ciSourceManifestSha256', 'sourceManifestSha256']) check(new Set(nodes.map(n => n[k])).size === 1, 'ROLLOUT_NODES_DO_NOT_SHARE_ONE_SOURCE', k);
  const plan = { contract: ROLLOUT_PLAN_CONTRACT, decisionRef, createdAt: iso(now), ciSourceManifestSha256: nodes[0].ciSourceManifestSha256, sourceManifestSha256: nodes[0].sourceManifestSha256,
    nodes: nodes.map(({ node, packageManifestSha256, residentManifestSha256, grantResource }) => ({ node, packageManifestSha256, residentManifestSha256, grantResource }))
      .sort((a, b) => (a.node < b.node ? -1 : 1)) };
  const bytes = Buffer.from(canonicalJson(plan) + '\n', 'utf8');
  return { plan, bytes, rolloutSha256: sha256(bytes) };
}

export function validateRolloutPlan(v) {
  check(plain(v) && v.contract === ROLLOUT_PLAN_CONTRACT && UUID.test(v.decisionRef ?? '') && HEX64.test(v.ciSourceManifestSha256 ?? '') && HEX64.test(v.sourceManifestSha256 ?? '')
    && isIso(v.createdAt) && Object.keys(v).sort().join('|') === 'ciSourceManifestSha256|contract|createdAt|decisionRef|nodes|sourceManifestSha256', 'ROLLOUT_PLAN_REFUSED');
  check(Array.isArray(v.nodes) && v.nodes.length >= 1 && v.nodes.length <= 64, 'ROLLOUT_PLAN_REFUSED', 'nodes');
  for (const n of v.nodes) {
    check(plain(n) && Object.keys(n).sort().join('|') === 'grantResource|node|packageManifestSha256|residentManifestSha256' && NODE_NAME.test(n.node ?? '')
      && HEX64.test(n.packageManifestSha256 ?? '') && HEX64.test(n.residentManifestSha256 ?? '') && n.grantResource === `ci-resident:${n.node}/${n.packageManifestSha256}`,
    'ROLLOUT_PLAN_REFUSED', 'node');
  }
  check(v.nodes.every((n, i) => i === 0 || v.nodes[i - 1].node < n.node), 'ROLLOUT_PLAN_REFUSED', 'order');   // sorted, so also no duplicate
  return v;
}

// ---- observe (one node, its own files, read-only) ----

async function readOrNull(file, max) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > max) return { bytes: null, error: 'shape' };
    return { bytes: await fs.readFile(file), error: null };
  } catch (error) {
    return { bytes: null, error: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

export async function observe(root, clock = Date.now) {
  const unreadable = [];
  const status = await readOrNull(path.join(root, 'state', 'status.json'), 256 * 1024);
  let resident = null;
  if (status.bytes) {
    try {
      const s = parseStatus(status.bytes);
      resident = { writtenAt: iso(s.writtenAt), node: s.node ? s.node.name : null, mode: s.node ? s.node.mode : null, halt: s.halt ? s.halt.code : null, paused: s.paused,
        consistent: s.versions ? s.versions.consistent : null };
    } catch { unreadable.push('state/status.json'); }
  } else unreadable.push('state/status.json');
  const cur = await readOrNull(path.join(root, 'upgrade', 'current.json'), 8192);
  let generation = null;
  if (cur.bytes) {
    try { const c = parseGenerationCurrent(cur.bytes); generation = { generation: c.generation, packageManifestSha256: c.packageManifestSha256 }; } catch { unreadable.push('upgrade/current.json'); }
  } else unreadable.push('upgrade/current.json');
  const up = await readOrNull(path.join(root, 'upgrade', 'status.json'), 256 * 1024);
  let upgrade = null;
  if (up.bytes) {
    try {
      const v = JSON.parse(up.bytes.toString('utf8'));
      check(v?.contract === UPGRADE_STATUS_CONTRACT, 'UPGRADE_STATUS_REFUSED');
      const op = plain(v.op) && UUID.test(v.op.opId ?? '') && typeof v.op.state === 'string' ? { opId: v.op.opId, state: v.op.state, code: typeof v.op.code === 'string' ? v.op.code : null } : null;
      const recent = Array.isArray(v.recent) ? v.recent.filter(r => plain(r) && UUID.test(r.opId ?? '') && typeof r.outcome === 'string') : [];
      const last = recent.length ? recent[recent.length - 1] : null;
      upgrade = { op, last: last ? { opId: last.opId, outcome: last.outcome, code: typeof last.code === 'string' ? last.code : null, at: isIso(last.at) ? last.at : null } : null };
    } catch { unreadable.push('upgrade/status.json'); }
  } else if (up.error !== 'missing') unreadable.push('upgrade/status.json');
  else upgrade = { op: null, last: null };
  return { contract: OBSERVATION_CONTRACT, observedAt: iso(clock()), node: resident?.node ?? null, resident, generation, upgrade, unreadable };
}

export function validateObservation(v) {
  check(plain(v) && v.contract === OBSERVATION_CONTRACT && isIso(v.observedAt) && (v.node === null || NODE_NAME.test(v.node)), 'ROLLOUT_OBSERVATION_REFUSED');
  check(v.resident === null || !plain(v.resident) || v.resident.node === v.node, 'ROLLOUT_OBSERVATION_REFUSED', 'node');
  check(v.resident === null || (plain(v.resident) && isIso(v.resident.writtenAt) && (v.resident.mode === null || MODES.includes(v.resident.mode))
    && typeof v.resident.paused === 'boolean' && [true, false, null].includes(v.resident.consistent)), 'ROLLOUT_OBSERVATION_REFUSED', 'resident');
  check(v.generation === null || (plain(v.generation) && Number.isSafeInteger(v.generation.generation) && (v.generation.packageManifestSha256 === null || HEX64.test(v.generation.packageManifestSha256))),
    'ROLLOUT_OBSERVATION_REFUSED', 'generation');
  check(v.upgrade === null || (plain(v.upgrade) && (v.upgrade.op === null || plain(v.upgrade.op)) && (v.upgrade.last === null || plain(v.upgrade.last))), 'ROLLOUT_OBSERVATION_REFUSED', 'upgrade');
  return v;
}

// ---- next (pure) ----

// handoverIssuedAt: when the Owner's last hand-over was asked for (the role takes effect 5 minutes later, and the former holder writes
// STANDBY when it sees it): until HANDOVER_PENDING_MS after it, two ACTIVE nodes are a WAIT, not two holders.
export function nextStep(plan, observations, now, { allowActiveUpgrade = false, handoverIssuedAt = null, ackOps = [] } = {}) {
  check(Array.isArray(ackOps) && ackOps.every(id => UUID.test(id)), 'USAGE', 'ack-op');
  const issued = handoverIssuedAt === null ? NaN : Date.parse(handoverIssuedAt);
  const handoverPending = Number.isFinite(issued) && now - issued < HANDOVER_PENDING_MS;
  validateRolloutPlan(plan);
  const byNode = new Map();
  for (const o of observations) {
    validateObservation(o);
    check(o.node !== null, 'ROLLOUT_OBSERVATION_WITHOUT_NODE');
    check(!byNode.has(o.node), 'ROLLOUT_OBSERVATION_TWICE', o.node);
    byNode.set(o.node, o);
  }
  const out = (action, extra = {}) => ({ contract: NEXT_CONTRACT, action, ...extra, nodes: summary });
  const summary = plan.nodes.map(n => {
    const o = byNode.get(n.node) ?? null;
    return { node: n.node, observedAt: o?.observedAt ?? null, mode: o?.resident?.mode ?? null, atTarget: o?.generation?.packageManifestSha256 === n.packageManifestSha256,
      generation: o?.generation?.generation ?? null, op: o?.upgrade?.op?.state ?? null, last: o?.upgrade?.last?.outcome ?? null };
  });
  // Every observed node is in the plan, and every node of the plan has a fresh, complete observation (a holder left out of the plan
  // and not observed is caught at DONE: exactly one ACTIVE node among the plan's).
  for (const node of byNode.keys()) if (!plan.nodes.some(n => n.node === node)) return out('BLOCKED', { code: 'ROLLOUT_NODE_NOT_IN_PLAN', node });
  for (const n of plan.nodes) {
    const o = byNode.get(n.node);
    if (!o) return out('WAIT', { code: 'ROLLOUT_OBSERVATION_MISSING', node: n.node });
    if (o.resident === null || o.generation === null || o.upgrade === null) return out('WAIT', { code: 'ROLLOUT_OBSERVATION_INCOMPLETE', node: n.node, unreadable: o.unreadable ?? [] });
    const seen = Date.parse(o.observedAt);
    if (now - seen > OBSERVATION_FRESH_MS || seen - now > OBSERVATION_FRESH_MS) return out('WAIT', { code: 'ROLLOUT_OBSERVATION_STALE', node: n.node });
    // A resident that stopped writing its status is not observed, whatever the file says.
    if (seen - Date.parse(o.resident.writtenAt) > OBSERVATION_FRESH_MS) return out('BLOCKED', { code: 'ROLLOUT_RESIDENT_NOT_WRITING_STATUS', node: n.node });
  }
  const rows = plan.nodes.map(n => {
    const o = byNode.get(n.node);
    return { node: n.node, mode: o.resident.mode ?? 'UNCERTAIN', halt: o.resident.halt, paused: o.resident.paused, consistent: o.resident.consistent,
      atTarget: o.generation.packageManifestSha256 === n.packageManifestSha256, op: o.upgrade.op, last: o.upgrade.last };
  });
  for (const r of rows) if (r.halt) return out('BLOCKED', { code: 'ROLLOUT_NODE_HALTED', node: r.node, halt: r.halt });
  const since = Date.parse(plan.createdAt);
  for (const r of rows) {
    // an acknowledged op (the Owner looked; --ack-op) never blocks again: the only way past a ROLLBACK_FAILED the Owner recovered,
    // or an outcome without a readable time, both of which would otherwise block for good (the upgrader keeps its last outcome)
    if (!r.last || (r.op && OP_MOVING.includes(r.op.state)) || ackOps.includes(r.last.opId)) continue;
    const at = r.last.at === null ? NaN : Date.parse(r.last.at);
    if (r.last.outcome === 'ROLLBACK_FAILED') return out('BLOCKED', { code: 'ROLLOUT_NODE_ROLLED_BACK', node: r.node, outcome: r.last.outcome, upgradeCode: r.last.code, opId: r.last.opId });
    // an outcome without a readable time is taken as this rollout's (conservative)
    if (r.atTarget || (Number.isFinite(at) && at < since)) continue;
    if (OUTCOMES_ROLLED_BACK.includes(r.last.outcome)) return out('BLOCKED', { code: 'ROLLOUT_NODE_ROLLED_BACK', node: r.node, outcome: r.last.outcome, upgradeCode: r.last.code, opId: r.last.opId });
    if (OUTCOMES_REFUSED.includes(r.last.outcome)) return out('BLOCKED', { code: 'ROLLOUT_NODE_UPGRADE_REFUSED', node: r.node, outcome: r.last.outcome, upgradeCode: r.last.code, opId: r.last.opId });
  }
  const moving = rows.find(r => r.op && OP_MOVING.includes(r.op.state));
  if (moving) return out('WAIT', { code: 'ROLLOUT_UPGRADE_IN_PROGRESS', node: moving.node, state: moving.op.state, upgradeCode: moving.op.code });
  const active = rows.filter(r => r.mode === 'ACTIVE');
  // while a handover takes effect both nodes may say ACTIVE for a moment: wait; otherwise it is two holders
  if (active.length > 1) return handoverPending ? out('WAIT', { code: 'ROLLOUT_HANDOVER_PENDING', nodes: active.map(r => r.node) }) : out('BLOCKED', { code: 'ROLLOUT_TWO_ACTIVE', nodes: active.map(r => r.node) });
  const uncertain = rows.find(r => r.mode === 'UNCERTAIN');
  if (uncertain) return out('WAIT', { code: 'ROLLOUT_NODE_UNCERTAIN', node: uncertain.node });
  if (rows.every(r => r.atTarget)) {
    const skew = rows.find(r => r.consistent !== true);
    if (skew) return out('WAIT', { code: 'ROLLOUT_VERSIONS_NOT_CONSISTENT', node: skew.node, consistent: skew.consistent });
    const paused = rows.find(r => r.paused);
    if (paused) return out('BLOCKED', { code: 'ROLLOUT_NODE_PAUSED', node: paused.node });
    // DONE means the node that holds ci-admission is one of the plan's (a holder left out of the plan was never upgraded)
    return active.length === 1 ? out('DONE') : out('BLOCKED', { code: 'ROLLOUT_NO_ACTIVE_NODE_IN_PLAN' });
  }
  const standbys = rows.filter(r => r.mode === 'STANDBY');
  const due = standbys.filter(r => !r.atTarget);
  const ready = due.filter(r => !r.paused);
  const target = n => plan.nodes.find(p => p.node === n);
  const upgrade = (r, ciPause = false) => out('UPGRADE', { node: r.node, packageManifestSha256: target(r.node).packageManifestSha256, grantResource: target(r.node).grantResource, ciPause });
  if (ready.length) return upgrade(ready[0]);
  if (due.length) return out('BLOCKED', { code: 'ROLLOUT_STANDBY_PAUSED', node: due[0].node });
  // Every STANDBY is on the new package; only the holder is left. It is upgraded in place (ciPause): a hand-over to a node on another
  // Source is refused by the server, and the train already stands still while the Sources differ.
  const holder = active[0];
  const healthy = standbys.filter(r => r.atTarget && !r.paused && r.consistent === true);
  if (healthy.length) {
    if (holder.paused) return out('BLOCKED', { code: 'ROLLOUT_STANDBY_PAUSED', node: holder.node });
    return upgrade(holder, true);
  }
  if (standbys.length === 0) {
    if (!allowActiveUpgrade) return out('BLOCKED', { code: 'ROLLOUT_NO_STANDBY', node: holder.node });
    if (holder.paused) return out('BLOCKED', { code: 'ROLLOUT_STANDBY_PAUSED', node: holder.node });
    return upgrade(holder, true);
  }
  return out('BLOCKED', { code: 'ROLLOUT_NO_HEALTHY_UPGRADED_STANDBY', node: holder.node });
}

// ---- CLI ----

async function writeNew(file, bytes) { await fs.writeFile(file, bytes, { flag: 'wx' }); }

async function readPackageForPlan(node, dir) {
  // The upgrader's own reader: one read, every listed file hashed (the same check the node's ACCEPT makes).
  const { readPackageOnce } = await import('../upgrader/src/package.mjs');
  const manifestBytes = await fs.readFile(path.join(dir, 'package-manifest.json'));
  const pkg = await readPackageOnce(path.resolve(dir), sha256(manifestBytes));
  return { node, manifest: pkg.manifest, manifestBytes: pkg.manifestBytes, bytesOf: p => pkg.bytesByPath.get(p) };
}

export async function main(argv, { clock = Date.now, log = s => process.stdout.write(s + '\n') } = {}) {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { out: { type: 'string' }, decision: { type: 'string' }, package: { type: 'string', multiple: true },
    root: { type: 'string' }, plan: { type: 'string' }, observation: { type: 'string', multiple: true }, now: { type: 'string' }, 'allow-active-upgrade': { type: 'boolean' },
    'handover-issued-at': { type: 'string' }, 'ack-op': { type: 'string', multiple: true } } });
  if (cmd === 'plan') {
    check(values.out && values.package?.length, 'USAGE');
    const packages = [];
    for (const spec of values.package) {
      const i = spec.indexOf('=');
      check(i > 0, 'USAGE', spec);
      packages.push(await readPackageForPlan(spec.slice(0, i), spec.slice(i + 1)));
    }
    const r = buildRolloutPlan({ decisionRef: values.decision, packages, now: clock() });
    await writeNew(values.out, r.bytes);
    log(JSON.stringify({ status: 'ROLLOUT_PLAN_WRITTEN', plan: values.out, rolloutSha256: r.rolloutSha256, nodes: r.plan.nodes }));
    return 0;
  }
  if (cmd === 'observe') {
    check(values.root && values.out, 'USAGE');
    const o = await observe(values.root, clock);
    await writeNew(values.out, Buffer.from(canonicalJson(o) + '\n', 'utf8'));
    log(JSON.stringify({ status: 'ROLLOUT_OBSERVED', observation: values.out, node: o.node, unreadable: o.unreadable }));
    return 0;
  }
  if (cmd === 'next') {
    check(values.plan && values.observation?.length, 'USAGE');
    const planBytes = await fs.readFile(values.plan);
    const plan = validateRolloutPlan(JSON.parse(planBytes.toString('utf8')));
    const observations = [];
    for (const f of values.observation) observations.push(JSON.parse(await fs.readFile(f, 'utf8')));
    const now = values.now ? Date.parse(values.now) : clock();
    check(Number.isFinite(now), 'USAGE', 'now');
    log(JSON.stringify({ rolloutSha256: sha256(planBytes), ...nextStep(plan, observations, now, { allowActiveUpgrade: values['allow-active-upgrade'] === true,
      handoverIssuedAt: values['handover-issued-at'] ?? null, ackOps: values['ack-op'] ?? [] }) }));
    return 0;
  }
  check(false, 'USAGE', 'plan | observe | next');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stdout.write(JSON.stringify({ status: 'REFUSED', code: error?.code ?? 'ROLLOUT_FAILED', detail: error?.detail ?? String(error?.message ?? error).slice(0, 300) }) + '\n');
    process.exitCode = 1;
  });
}
