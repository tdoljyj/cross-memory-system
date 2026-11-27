// The push-landing precheck (Fable 2026-11-21, push landing follow-up §3.3, §4, §5; resident ADR 0018 §8 item 7). Read-only: it
// answers GO or NO-GO with the evidence of every item, and never changes a ruleset, a branch, a check or a node. DESK runs it with
// the repository owner's gh identity (the ruleset bypass lists are only shown to an administrator), at the times of §5:
//
//   node rollout/landing-precheck.mjs --before --snapshot <file> [--root <resident root>] [--repo <owner/name>] [--only P1,P4]
//   node rollout/landing-precheck.mjs --after  --snapshot <file> [same options]
//
//   R1  the independent ruleset just created:     --before --only P4 (a subset: PARTIAL-PASS at best, no snapshot written)
//   R1+ stage 10's next round after it:           --before --only P3 (until bypass.independent reads never)
//   R2  right before the Owner is asked to save:  --before (all of P1-P5; writes the main ruleset's snapshot; GO only then ask)
//   R3  right after the Owner saved:              --after  (P1-P6 against that snapshot)
//
// Inputs, all read-only and none needing elevation: gh (GET only: the branch rules, the rulesets, the staging runs and S's check-runs,
// main's head), this node's state\status.json and record\source-manifest.json under --root, and this checkout (its source-closure.json
// files, its policy.mjs FLEET_TRAIN and its HEAD). The one file written is the --before snapshot (local, --snapshot). The stage-8
// receipts are not read (Fable 11-21 open points §5: their directory is denied without elevation).
// Items (§4):
//   P1  precondition one: every required check of the live rules push waits for on S (not pinned to App 5368905; review A/B) has a
//       completed success (of its pinned App, or any App when not pinned) on at least 2 of the newest 10 distinct S on clued-train/staging
//       (a), and at least 1 of those S is all green by push's own rule, externalChecksDecision (b); not consecutive.
//       On NO-GO every S with every check's conclusion, and for a check that did not succeed its title, summary and annotations
//       (the runner hook's refusal is written there).
//   P2  every node stage 10 last heard within 24 hours runs this node's Source, this node's Source record pins exactly this
//       checkout's Source closure files, and this checkout is origin's main; and (open points §3) this node's policy has the train on
//       and landing push, stage 10's newest round (within 60 minutes) read a landing route (--before: github-merge), and this
//       checkout's FLEET_TRAIN lands by push.
//   P3  stage 10's newest round in state\status.json (train.last.landing.bypass) reads this App's bypass state of the main and the
//       independent ruleset: --before both never (the App token can read the field); --after main always and independent never.
//       --before also (task 04f9b91b): what push still lacks that round (train.last.landing.missing) is nothing but what the save of C
//       adds (kooyumi-train-landed, the main ruleset's bypass); read with the App's own token, it covers rulesets of any shape.
//   P4  the independent ruleset, known by its shape (train-landing.mjs#guardRuleset): at least one active ruleset on the default branch
//       whose rules are exactly deletion and non_fast_forward, with no bypass actor, whose two rules main's branch rules carry; and
//       (task 04f9b91b) every other active ruleset on the default branch but the main one has exactly Integration 5368905 always on its
//       bypass list (a bypass list only an administrator can read, so here and not in the landing route).
//   P5  the main ruleset 24182890. --before: no bypass actor, no kooyumi-train-landed. --after: the bypass actors exactly Integration
//       5368905 always, the required checks the snapshot's plus kooyumi-train-landed pinned to 5368905, everything else as the snapshot.
//   P6  --after: stage 10's newest round after the snapshot reads the landing route push (nothing missing).
// Nothing here relaxes an item: a NO-GO goes back to Fable with this output (§3.3, §8 stop lines).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { FLEET_HEARTBEAT_WINDOW_MS, fleetSourceCheck, parseTrainLast, parseTrainNodes } from '../src/train.mjs';
import { externalChecksDecision, externalRequiredChecks, guardRuleset, runsOfRequired } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-landing.mjs';

export const LANDING_PRECHECK_CONTRACT = 'clued.independent-ci.landing-precheck/1';
export const SNAPSHOT_CONTRACT = 'clued.independent-ci.landing-precheck-snapshot/1';
export const MAIN_RULESET_ID = 24182890;
export const APP_ID = 5368905;
export const TRAIN_LANDED = 'kooyumi-train-landed';
export const STAGING_BRANCH = 'clued-train/staging';
export const S_WINDOW = 10;
export const ITEMS = Object.freeze(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
export const DEFAULT_REPO = 'tdoljyj/cross-memory-system';
export const DEFAULT_ROOT = 'C:\\ProgramData\\CluedIndependentCI\\resident';
const CLOSURE = 'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/source-closure.json';
const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n = 300) => (typeof s === 'string' ? s.slice(0, n) : null);
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : plain(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);
class ItemError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
const refuse = (code, detail) => { throw new ItemError(code, detail); };

// ---- P1 ----
// Independent review A/B (Fable 11-21 open points §9): the list is push's own (train-landing.mjs#externalRequiredChecks: every required
// check of the live rules not pinned to App 5368905; pinned to another App, that App's runs only; not pinned, any App's), and an S is all
// green only when push's own externalChecksDecision answers null for it (each check's newest run by id a completed success), from S's
// whole check list (a list GitHub did not give whole is never all green). Condition a stays "has had a success" (it proves the check
// can be produced on S).
const labelOf = (c, list) => (list.filter(x => x.context === c.context).length > 1 ? `${c.context}@${c.pin ?? 'any'}` : c.context);
export async function p1({ gh, repo, rules, now = Date.now() }) {
  const seen = new Set(), required = [];
  for (const c of externalRequiredChecks({ rules, appId: APP_ID })) { const k = `${c.context}\n${c.pin}`; if (!seen.has(k)) { seen.add(k); required.push(c); } }
  const named = required.map(c => ({ ...c, label: labelOf(c, required) })).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const names = named.map(c => c.label);
  if (!names.length) refuse('NO_EXTERNAL_REQUIRED_CHECKS');
  const runs = await gh.paged(`repos/${repo}/actions/runs?branch=${encodeURIComponent(STAGING_BRANCH)}&event=push`, 'workflow_runs', { max: 3 });
  const order = runs.filter(r => typeof r?.head_sha === 'string').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const shas = [...new Set(order.map(r => r.head_sha))].slice(0, S_WINDOW);
  const perS = [];
  for (const s of shas) {
    const inventory = await gh.paged(`repos/${repo}/commits/${s}/check-runs?filter=all`, 'check_runs', { whole: true });
    const checks = Array.isArray(inventory?.rows) ? inventory.rows : [];
    const decision = externalChecksDecision({ rules, inventory: { complete: inventory?.complete === true, checks }, commitSha: s, appId: APP_ID, now });
    const row = { testSha: s, allGreen: decision === null, ...(decision ? { decision } : {}), ...(inventory?.complete === true ? {} : { incomplete: true }), checks: {} };
    for (const c of named) {
      const mine = runsOfRequired(checks, c, s).sort((a, b) => b.id - a.id);
      const ok = mine.some(k => k.status === 'completed' && k.conclusion === 'success');
      const last = mine[0];
      const newest = !last ? 'absent' : last.status === 'completed' ? last.conclusion : last.status;
      row.checks[c.label] = ok && newest === 'success' ? { state: 'success' }
        : ok ? { state: 'success', newest, id: last.id, title: clip(last.output?.title), summary: clip(last.output?.summary) }
          : !last ? { state: 'absent' } : { state: newest, id: last.id, title: clip(last.output?.title), summary: clip(last.output?.summary) };
    }
    perS.push(row);
  }
  const successes = Object.fromEntries(names.map(n => [n, perS.filter(r => r.checks[n].state === 'success').length]));
  const a = names.filter(n => successes[n] < 2);
  const full = perS.filter(r => r.allGreen).map(r => r.testSha);
  const pass = a.length === 0 && full.length > 0;
  if (!pass) for (const r of perS) for (const n of names) {
    const c = r.checks[n];
    // review optional 3: best effort; one that cannot be read leaves that check's annotations null and every other detail
    if (c.id) try { c.annotations = (await gh.paged(`repos/${repo}/check-runs/${c.id}/annotations`, null, { max: 1 })).slice(0, 5).map(x => clip(x?.message)); }
    catch { c.annotations = null; }
  }
  return { pass, names, sCount: perS.length, successes, ...(a.length ? { fewerThanTwo: a } : {}), fullyGreen: full, ...(pass ? {} : { perS }) };
}

// ---- P2 ----
// Fable 11-21 open points §3: the stage file stage 10 reads is written from the node's installed policy (train.landing), which is not
// in the CI Source closure: one Source does not prove one policy. Read off the objects: this node's status (train.enabled on, train.landing
// push), stage 10's newest round within 60 minutes with landing.route (written only while push is in force; --before: github-merge, C not
// saved), and this checkout's FLEET_TRAIN (what a package from main writes on every node). Residual: a standby node's policy is not
// readable (the node view carries the Source hash only); it is inferred from one Source and main's FLEET_TRAIN.
export const ROUND_FRESH_MS = 60 * 60_000;
function policyFailures({ status, fleetTrain, mode, now }) {
  const last = parseTrainLast(status?.train?.last);
  const route = last?.landing?.route ?? null;
  return [
    ...(status?.train?.enabled !== 'on' ? ['NODE_TRAIN_NOT_ON'] : []),
    ...(status?.train?.landing !== 'push' ? ['NODE_LANDING_NOT_PUSH'] : []),
    ...(mode === 'before' && !(route === 'github-merge' && last && now - last.at <= ROUND_FRESH_MS && last.at <= now) ? ['STAGE10_ROUTE_NOT_READ'] : []),
    ...(fleetTrain?.landing !== 'push' ? ['CHECKOUT_FLEET_LANDING_NOT_PUSH'] : []),
  ];
}
export async function p2({ gh, repo, files, checkout, now, mode = 'before' }) {
  const head = await checkout.head();
  const main = (await gh.get(`repos/${repo}/branches/main`))?.commit?.sha;
  const bytes = await files.read(files.sourceManifest);
  const source = sha256(bytes);
  let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { refuse('SOURCE_MANIFEST_UNREADABLE'); }
  const closure = JSON.parse((await checkout.read(CLOSURE)).toString('utf8'));
  if (!Array.isArray(closure?.paths) || !closure.paths.length) refuse('SOURCE_CLOSURE_UNREADABLE');
  const pins = [];
  for (const p of [...closure.paths].sort()) pins.push({ path: p, sha256: sha256(await checkout.read(p)) });
  const roles = plain(manifest?.roles) ? Object.entries(manifest.roles) : [];
  const want = canon(pins);
  const differ = roles.filter(([, r]) => canon([...(r?.sourceFiles ?? [])].map(f => ({ path: f?.path, sha256: f?.sha256 })).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) !== want)
    .map(([role]) => role);
  const status = JSON.parse((await files.read(files.status)).toString('utf8'));
  const installed = status?.versions?.windows?.ciSourceManifestSha256 ?? null;
  const view = parseTrainNodes(status?.train?.nodes);
  const fleet = fleetSourceCheck({ view, target: source, now, onDuty: status?.node?.mode === 'ACTIVE', selfNames: [status?.node?.name] });
  // Review C (open points §9): a node heard within 24 hours that reports no Source is not proven on this one (fleetSourceCheck, shared
  // with the upgrade precheck and stage 10, skips it and stays as it is). Optional 1 (half): a view with dropped entries is not whole.
  const unreported = (view && Object.hasOwn(view, 'holderPackage') ? [] : view?.nodes ?? []).filter(n => n.sourceManifestSha256 === null && n.lastHeartbeatAt !== null
    && now - Date.parse(n.lastHeartbeatAt) <= FLEET_HEARTBEAT_WINDOW_MS).map(n => n.node);
  const failed = [
    ...(head !== main ? ['CHECKOUT_NOT_MAIN'] : []),
    ...(!roles.length || differ.length ? ['SOURCE_RECORD_NOT_THIS_CHECKOUT'] : []),
    ...(installed !== source ? ['SOURCE_RECORD_NOT_THIS_NODE'] : []),
    ...(fleet.status !== 'PASS' ? [`FLEET_${fleet.status}${fleet.reason ? `_${fleet.reason}` : ''}`] : []),
    ...(unreported.length ? ['FLEET_NODE_SOURCE_UNREPORTED'] : []),
    ...(view && !Object.hasOwn(view, 'holderPackage') && view.dropped > 0 ? ['FLEET_NODES_DROPPED'] : []),
    ...policyFailures({ status, fleetTrain: await checkout.fleetTrain(), mode, now }),
  ];
  return { pass: failed.length === 0, ...(failed.length ? { failed } : {}), checkoutHead: head, mainSha: main ?? null, ciSourceManifestSha256: source,
    installedCiSourceManifestSha256: installed, recordSourceSha: manifest?.sourceSha ?? null, ...(differ.length ? { rolesDiffer: differ } : {}), fleet, ...(unreported.length ? { sourceUnreported: unreported } : {}),
    policy: { trainEnabled: status?.train?.enabled ?? null, trainLanding: status?.train?.landing ?? null, lastAt: status?.train?.last?.at ?? null,
      lastRoute: status?.train?.last?.landing?.route ?? null } };
}

// ---- P3 ----
// What push lacks before the save of C, and only that (train-landing.mjs#landingRoute's names).
const SAVE_ADDS = Object.freeze(['train_landed_check_missing', 'main_app_cannot_bypass']);
// Fable 11-21 open points §5: from state\status.json, the round stage 10 last wrote (train.last.landing.bypass), never the receipts.
// --after: the state route push needs (main always, independent never); P6 judges the route itself.
export async function p3({ files, mode = 'before' }) {
  const status = JSON.parse((await files.read(files.status)).toString('utf8'));
  const last = parseTrainLast(status?.train?.last);
  const bypass = last?.landing?.bypass ?? null;
  const want = mode === 'after' ? 'always' : 'never';
  const missing = last?.landing?.missing ?? null;
  const lacks = mode === 'before' && Array.isArray(missing) ? missing.filter(m => !SAVE_ADDS.includes(m)) : [];
  const failed = [...(!bypass ? ['BYPASS_NOT_READ'] : [
    ...(bypass.main !== want ? [mode === 'after' ? 'BYPASS_MAIN_NOT_ALWAYS' : 'BYPASS_MAIN_NOT_NEVER'] : []),
    ...(bypass.independent !== 'never' ? ['BYPASS_INDEPENDENT_NOT_NEVER'] : []),
  ]), ...(mode === 'before' && !Array.isArray(missing) ? ['PUSH_LACKS_NOT_READ'] : lacks.length ? ['PUSH_LACKS_MORE_THAN_THE_SAVE'] : [])];
  return { pass: failed.length === 0, ...(failed.length ? { failed } : {}), at: last ? new Date(last.at).toISOString() : null, bypass,
    ...(mode === 'before' ? { missing } : {}), ...(lacks.length ? { lacks } : {}) };
}

// ---- P4 ----
const ruleTypes = rs => (Array.isArray(rs?.rules) ? rs.rules.map(r => r?.type).sort() : null);
const onDefault = rs => (rs?.conditions?.ref_name?.include ?? []).some(x => x === '~DEFAULT_BRANCH' || x === 'refs/heads/main' || x === '~ALL');
const THE_APP_ALWAYS = canon([{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' }]);
export async function p4({ gh, repo, rules }) {
  const list = await gh.paged(`repos/${repo}/rulesets?includes_parents=true`, null);
  // a disabled or evaluate-only ruleset GitHub does not enforce: it counts for nothing here
  const active = [];
  for (const r of list.filter(r => r?.target === 'branch' && r.id !== MAIN_RULESET_ID)) {
    const full = await gh.get(`repos/${repo}/rulesets/${r.id}`);
    if (onDefault(full) && full?.enforcement === 'active') active.push(full);
  }
  active.sort((a, b) => a.id - b.id);
  const guards = active.filter(rs => guardRuleset(ruleTypes(rs)));
  // every guard's own defects; the item passes when one guard has none
  const defects = rs => {
    const branch = new Set(rules.filter(r => r?.ruleset_id === rs.id).map(r => r.type));
    return [...(!Array.isArray(rs.bypass_actors) ? ['BYPASS_ACTORS_UNREADABLE'] : rs.bypass_actors.length ? ['BYPASS_ACTORS_NOT_EMPTY'] : []),
      ...(!branch.has('deletion') || !branch.has('non_fast_forward') ? ['MAIN_BRANCH_RULES_LACK_IT'] : [])];
  };
  const rs = guards.find(g => defects(g).length === 0) ?? guards[0] ?? null;
  const notTheApp = active.filter(o => !guards.includes(o)).filter(o => !Array.isArray(o.bypass_actors)
    || canon(o.bypass_actors.map(a => ({ actor_id: a?.actor_id ?? null, actor_type: a?.actor_type ?? null, bypass_mode: a?.bypass_mode ?? null }))) !== THE_APP_ALWAYS);
  const failed = [...(!rs ? ['NO_INDEPENDENT_RULESET'] : defects(rs)), ...notTheApp.map(o => `OTHER_RULESET_BYPASS_NOT_EXACTLY_THE_APP:${o.id}`)];
  return { pass: failed.length === 0, ...(failed.length ? { failed } : {}), id: rs?.id ?? null, name: rs?.name ?? null, enforcement: rs?.enforcement ?? null,
    rules: rs ? ruleTypes(rs) : null, bypassActors: rs?.bypass_actors ?? null, guards: guards.map(g => g.id),
    others: active.filter(o => !guards.includes(o)).map(o => ({ id: o.id, name: o.name ?? null, bypassActors: o.bypass_actors ?? null })) };
}

// ---- P5 ----
const requiredOf = rs => (rs?.rules ?? []).filter(r => r?.type === 'required_status_checks')
  .flatMap(r => r.parameters?.required_status_checks ?? []).map(c => ({ context: c.context, integration_id: c.integration_id ?? null }));
const keyOf = c => `${c.context}\n${c.integration_id}`;
// The main ruleset minus what P5 compares on its own (the bypass list, the required checks list) and GitHub's bookkeeping.
const restOf = rs => ({ name: rs.name, target: rs.target, enforcement: rs.enforcement, conditions: rs.conditions ?? null,
  rules: (rs.rules ?? []).map(r => {
    if (r?.type !== 'required_status_checks') return r;
    const { required_status_checks: _, ...parameters } = r.parameters ?? {};
    return { type: r.type, parameters };
  }) });
export async function p5({ gh, repo, mode, snapshot }) {
  const rs = await gh.get(`repos/${repo}/rulesets/${MAIN_RULESET_ID}`);
  if (!Array.isArray(rs?.bypass_actors)) return { pass: false, failed: ['BYPASS_ACTORS_UNREADABLE'] };
  const required = requiredOf(rs), landed = required.filter(c => c.context === TRAIN_LANDED);
  const actors = rs.bypass_actors.map(a => ({ actor_id: a?.actor_id ?? null, actor_type: a?.actor_type ?? null, bypass_mode: a?.bypass_mode ?? null }));
  if (mode === 'before') {
    const failed = [...(actors.length ? ['BYPASS_ACTORS_NOT_EMPTY'] : []), ...(landed.length ? ['TRAIN_LANDED_ALREADY_REQUIRED'] : [])];
    return { pass: failed.length === 0, ...(failed.length ? { failed } : {}), bypassActors: actors, required, snapshot: { required, rest: restOf(rs) } };
  }
  if (!snapshot) return { pass: false, failed: ['SNAPSHOT_MISSING'] };
  const before = new Set(snapshot.required.map(keyOf));
  const added = required.filter(c => !before.has(keyOf(c))), dropped = snapshot.required.filter(c => !required.some(r => keyOf(r) === keyOf(c)));
  const failed = [
    ...(canon(actors) !== canon([{ actor_id: APP_ID, actor_type: 'Integration', bypass_mode: 'always' }]) ? ['BYPASS_ACTORS_NOT_EXACTLY_THE_APP_ALWAYS'] : []),
    ...(canon(added) !== canon([{ context: TRAIN_LANDED, integration_id: APP_ID }]) || dropped.length ? ['REQUIRED_CHECKS_NOT_SNAPSHOT_PLUS_TRAIN_LANDED'] : []),
    ...(canon(restOf(rs)) !== canon(snapshot.rest) ? ['OTHER_RULES_CHANGED'] : []),
  ];
  return { pass: failed.length === 0, ...(failed.length ? { failed } : {}), bypassActors: actors, added, dropped };
}

// ---- P6 ----
export async function p6({ files, snapshot }) {
  const status = JSON.parse((await files.read(files.status)).toString('utf8'));
  const last = parseTrainLast(status?.train?.last);
  const after = !!snapshot && Number.isFinite(Date.parse(snapshot.readAt)) && last?.at > Date.parse(snapshot.readAt);
  const route = last?.landing?.route ?? null, error = last?.landing?.error ?? null;
  const failed = [...(!after ? ['NO_ROUND_AFTER_THE_SNAPSHOT'] : []), ...(route !== 'push' ? ['ROUTE_NOT_PUSH'] : [])];
  return { pass: failed.length === 0, ...(failed.length ? { failed } : {}), at: last ? new Date(last.at).toISOString() : null, route, ...(error ? { error } : {}) };
}

// The whole precheck. mode 'before' | 'after'; only: the items to decide (default all of the mode's). Ports: gh { get, paged } (GET
// only), files { read, status, sourceManifest, writeSnapshot, readSnapshot }, checkout { fleetTrain, head, read }.
export async function landingPrecheck({ mode, repo = DEFAULT_REPO, only = null, gh, files, checkout, clock = Date.now }) {
  if (!['before', 'after'].includes(mode)) refuse('USAGE');
  const items = (only ?? ITEMS).filter(i => ITEMS.includes(i) && (i !== 'P6' || mode === 'after'));
  const readAt = new Date(clock()).toISOString();
  const result = { contract: LANDING_PRECHECK_CONTRACT, mode, repo, readAt, items: {} };
  let rules = null, snapshot = null;
  const rulesOnce = async () => (rules ??= await gh.paged(`repos/${repo}/rules/branches/main`, null));
  if (mode === 'after') { try { snapshot = await files.readSnapshot(); } catch { snapshot = null; } }
  if (snapshot && snapshot.contract !== SNAPSHOT_CONTRACT) snapshot = null;
  const run = { P1: async () => p1({ gh, repo, rules: await rulesOnce(), now: clock() }), P2: () => p2({ gh, repo, files, checkout, now: clock(), mode }), P3: () => p3({ files, mode }),
    P4: async () => p4({ gh, repo, rules: await rulesOnce() }), P5: () => p5({ gh, repo, mode, snapshot }), P6: () => p6({ files, snapshot }) };
  for (const i of items) {
    try { result.items[i] = await run[i](); } catch (e) { result.items[i] = { pass: false, failed: [e instanceof ItemError ? e.code : 'READ_FAILED'], detail: clip(e?.detail ?? e?.message) }; }
  }
  const p5Snapshot = result.items.P5?.snapshot;
  if (p5Snapshot) delete result.items.P5.snapshot;
  // review optional 2: only the whole mode can be GO; a subset (--only) that passes is PARTIAL-PASS (exit 0 as before)
  result.verdict = !(items.length > 0 && items.every(i => result.items[i].pass === true)) ? 'NO-GO' : only === null ? 'GO' : 'PARTIAL-PASS';
  // The snapshot of the main ruleset is kept only from a full --before GO (R2): it is what --after compares with.
  if (mode === 'before' && only === null && result.verdict === 'GO' && p5Snapshot) {
    await files.writeSnapshot({ contract: SNAPSHOT_CONTRACT, readAt, ...p5Snapshot });
    result.snapshotWritten = true;
  }
  return result;
}

// ---- the real ports ----
const exec = promisify(execFile);
export function ghPort({ run = (args) => exec('gh', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }) } = {}) {
  // Every call is `gh api <route>` with no method and no field: a GET.
  const get = async route => JSON.parse((await run(['api', '-H', 'X-GitHub-Api-Version: 2022-11-28', route])).stdout);
  // whole: { rows, complete } (complete false when the last page read was full at the page limit: GitHub may have more).
  const paged = async (route, key, { max = 20, whole = false } = {}) => {
    const out = [];
    let complete = false;
    for (let page = 1; page <= max; page++) {
      const body = await get(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = key ? body?.[key] : body;
      if (!Array.isArray(rows)) refuse('GITHUB_REPLY_UNREADABLE', route);
      out.push(...rows);
      if (rows.length < 100) { complete = true; break; }
    }
    return whole ? { rows: out, complete } : out;
  };
  return { get, paged };
}
export function filePorts({ root, snapshot }) {
  return { read: f => fs.readFile(f),
    status: path.join(root, 'state', 'status.json'), sourceManifest: path.join(root, 'record', 'source-manifest.json'),
    readSnapshot: async () => JSON.parse(await fs.readFile(snapshot, 'utf8')),
    writeSnapshot: async v => fs.writeFile(snapshot, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' }) };
}
export function checkoutPort(dir = CHECKOUT) {
  return { fleetTrain: async () => (await import(pathToFileURL(path.join(dir, 'work', 'independent-ci-resident-v1', 'src', 'policy.mjs')).href)).FLEET_TRAIN,
    head: async () => (await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(),
    read: rel => fs.readFile(path.join(dir, ...rel.split('/'))) };
}

export async function main(argv, { log = s => process.stdout.write(s + '\n') } = {}) {
  const { values } = parseArgs({ args: argv, options: { before: { type: 'boolean' }, after: { type: 'boolean' }, snapshot: { type: 'string' },
    root: { type: 'string' }, repo: { type: 'string' }, only: { type: 'string' } } });
  const only = values.only ? values.only.split(',').map(s => s.trim().toUpperCase()) : null;
  // The snapshot is written by a full --before and read by --after; a subset of --before (R1) needs none.
  if (values.before === values.after || (!values.snapshot && !(values.before && only))) refuse('USAGE');
  const r = await landingPrecheck({ mode: values.before ? 'before' : 'after', repo: values.repo ?? DEFAULT_REPO, only, gh: ghPort(),
    files: filePorts({ root: values.root ?? DEFAULT_ROOT, snapshot: values.snapshot }), checkout: checkoutPort() });
  log(JSON.stringify(r));
  return r.verdict === 'GO' || r.verdict === 'PARTIAL-PASS' ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stdout.write(JSON.stringify({ contract: LANDING_PRECHECK_CONTRACT, verdict: 'NO-GO', code: error?.code ?? 'PRECHECK_FAILED', detail: clip(String(error?.message ?? error)) }) + '\n');
    process.exitCode = 1;
  });
}
