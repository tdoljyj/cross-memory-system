// The acceptance door (PLAN-accept-auto-seal-20261125 section 2 and 5; PLAN-accept-binding-20261125 section 3: who calls it; part A serves it,
// this is part B's client). The Owner accepts one universal node package by approving one fleet.accept Grant on the Clued confirm page;
// publish.mjs seal seals only on the door's "accepted". Its own small file on purpose: the frozen upgrader's grant-client.mjs is not
// imported (it ships inside the package and changes only with a package).
//
// Two ways out, neither holding a token:
//   openRequest  one `gh workflow run` of the release workflow's fleet-accept mode (RELEASE_WORKFLOW, on main): the workflow's database login
//                calls the private door function, which replays an accepted row, reuses a pending request or opens a new one. Asked
//                once by seal when the door knows no open request of this resource (none, expired; never on rejected, which is final).
//   readStatus   the anonymous read public.<ACCEPT_STATUS_RPC>(p_resource) with the repository's public Supabase address and publishable key
//                (PUBLIC_CONFIG_SOURCE, the one source the web app and scripts/ci read; never the environment, so no other host can answer).
// The resource: fleet-node:<owner>/<repo>/<version>/<tar sha256>/<acceptance-request file sha256> (the request's sha256 already binds tar,
// commit, Source, kit and fleetRefs). Every answer names the request it answers (request_sha256, and the resource when it lists
// `resources`); readAnswer refuses one that names another or none:
//   { status: 'none' }                                           no request of this resource yet
//   { status: 'none', conflict: 'fleet_accept_version_already_accepted' }   the version is accepted under another package or request:
//                                                                this one never will be (ACCEPT_DOOR_VERSION_ALREADY_ACCEPTED, no request)
//   { status: 'pending', request_id, confirm_path, expires_at }   not approved yet: the page the Owner opens, the request's expiry
//   { status: 'accepted', grant_id, receipt_id, accepted_at, nodes }    approved; the door's one row of the version, replayed on every read
//   { status: 'rejected' } | { status: 'expired' }                the Owner rejected it (final: the door never opens it again), or it ran out
// The Grant is never approved automatically and only on the page (the server's rule); nothing here can approve.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIRM_ORIGIN } from './install.mjs';
import { VERSION } from './universal.mjs';

export const ACCEPT_ACTION = 'fleet.accept';
// part A's anonymous read (PLAN-accept-binding-20261125 section 3, A item 4); the one place its name is written on this side
export const ACCEPT_STATUS_RPC = 'clued_fleet_accept_status_v1';
// the release workflow and its mode that open the request (part A adds the mode); its inputs, written here only
export const RELEASE_WORKFLOW = 'clued-cloud-production-release.yml';
export const OPEN_MODE = 'fleet-accept';
export const PUBLIC_CONFIG_SOURCE = 'apps/clued-cloud/app/supabase-public-config.ts';
export const CALL_TIMEOUT_MS = 30_000;
export const ANSWERS = Object.freeze(['none', 'pending', 'accepted', 'rejected', 'expired']);

const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`), { code, detail }); };
const check = (ok, code, detail) => { if (!ok) fail(code, detail); };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONFIRM_PATH = /^\/confirm\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const OPEN_RUN_ID = /^[1-9][0-9]{0,15}$/;
// this file lies at <checkout>/work/independent-ci-resident-v1/rollout/fleet/
const CHECKOUT = fileURLToPath(new URL('../../../../', import.meta.url));

// The one resource of a fleet.accept request (section 2.1).
export function acceptResourceOf({ repository, version, archiveSha256, requestSha256 }) {
  check(REPO.test(repository ?? '') && VERSION.test(version ?? '') && HEX64.test(archiveSha256 ?? '') && HEX64.test(requestSha256 ?? ''), 'ACCEPT_RESOURCE_REFUSED',
    { repository, version });
  return `fleet-node:${repository}/${version}/${archiveSha256}/${requestSha256}`;
}

// Open the request: one run of the release workflow's fleet-accept mode on main. `runGh(args)` is publish.mjs's gh (no token variable reaches
// it). The run is queued, not awaited: the request shows on the anonymous read once the workflow has called the door.
export function openRequest({ runGh, repository, version, requestSha256 }) {
  check(REPO.test(repository ?? '') && VERSION.test(version ?? '') && HEX64.test(requestSha256 ?? ''), 'ACCEPT_RESOURCE_REFUSED', { repository, version });
  const r = runGh(['workflow', 'run', RELEASE_WORKFLOW, '--repo', repository, '--ref', 'main', '-f', `mode=${OPEN_MODE}`,
    '-f', `fleet_version=${version}`, '-f', `fleet_request_sha256=${requestSha256}`]);
  check(r?.status === 0, 'ACCEPT_DOOR_OPEN_FAILED', { exit: r?.status ?? null, stderr: r?.stderr ?? null,
    note: 'dispatch was not confirmed; read the door before deciding whether to open the request again' });
  const url = /https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)\s*$/.exec(r.stdout ?? '');
  const runId = url?.[1] === repository && OPEN_RUN_ID.test(url[2]) ? url[2] : null;
  return { workflow: RELEASE_WORKFLOW, mode: OPEN_MODE, runId };
}

// Only an exact first-attempt result can authorize another dispatch. A
// missing run, an unreadable answer or a manual rerun keeps the outcome unknown.
export function openRunFailed({ runGh, repository, runId }) {
  check(REPO.test(repository) && OPEN_RUN_ID.test(runId), 'ACCEPT_DOOR_RUN_REFUSED');
  const result = runGh(['api', 'repos/' + repository + '/actions/runs/' + runId, '--hostname', 'github.com']);
  if (result?.status !== 0) return false;
  let run;
  try { run = JSON.parse(result.stdout); } catch { return false; }
  return String(run?.id) === runId && run.path === '.github/workflows/' + RELEASE_WORKFLOW &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.run_attempt === 1 &&
    run.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(run.conclusion);
}

// The repository's public Supabase address and publishable key, read from PUBLIC_CONFIG_SOURCE the way scripts/ci/clued-work-admission.mjs
// resolvePublicSupabaseConfig reads its default (not imported: this file ships in the package, scripts/ci does not). seal runs in a checkout.
export function publicConfigOf({ root = CHECKOUT, readFile = readFileSync } = {}) {
  let text = null;
  try { text = readFile(path.join(root, PUBLIC_CONFIG_SOURCE), 'utf8'); } catch { text = null; }
  const m = text === null ? null : /return \{ url: "(https:\/\/[^"]+)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(text);
  check(m, 'ACCEPT_DOOR_NOT_CONFIGURED', { source: PUBLIC_CONFIG_SOURCE, note: text === null ? 'seal runs in a checkout of the repository' : 'no recognizable public default' });
  return { url: m[1].replace(/\/$/, ''), key: m[2] };
}

// The anonymous read over HTTP: resource -> the door's answer as it came (readAnswer holds it to the contract). A transport failure (with
// its cause: ECONNREFUSED, ENOTFOUND, ...), a read not deployed (PGRST202), a 5xx or a body that is not a JSON object is
// ACCEPT_DOOR_UNAVAILABLE (reading again may help); a 4xx with the database's message is ACCEPT_DOOR_REFUSED (it will say the same again).
export function httpStatus({ supabaseUrl, publishableKey, fetchImpl = globalThis.fetch }) {
  check(/^https:\/\/[^\s/]+\/?$/.test(supabaseUrl ?? '') && typeof publishableKey === 'string' && publishableKey !== '', 'ACCEPT_DOOR_NOT_CONFIGURED');
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${ACCEPT_STATUS_RPC}`;
  return async (resource, { timeoutMs = CALL_TIMEOUT_MS } = {}) => {
    let response, text;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'clued-fleet-accept' },
        body: JSON.stringify({ p_resource: resource }),
        signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, timeoutMs)),
        redirect: 'error',
      });
      text = await response.text();
    } catch (e) {
      fail('ACCEPT_DOOR_UNAVAILABLE', { http: null, error: String(e?.name ?? 'Error'), cause: typeof e?.cause?.code === 'string' ? e.cause.code : null });
    }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const message = plain(body) ? String(body.message ?? body.error_code ?? body.code ?? '').slice(0, 200) : '';
    if (response.status === 200 && body !== null && typeof body === 'object') return body;
    if (response.status >= 400 && response.status < 500 && !(response.status === 404 && body?.code === 'PGRST202') && message !== '') {
      fail('ACCEPT_DOOR_REFUSED', { http: response.status, message });
    }
    return fail('ACCEPT_DOOR_UNAVAILABLE', { http: response.status, message: message || null });
  };
}

// The read seal uses: the repository's public configuration, nothing from the environment.
export function statusReader({ root, readFile, fetchImpl = globalThis.fetch } = {}) {
  const { url, key } = publicConfigOf({ ...(root ? { root } : {}), ...(readFile ? { readFile } : {}) });
  return httpStatus({ supabaseUrl: url, publishableKey: key, fetchImpl });
}

// An answer held to the contract and to the request it is read for ({ resource, requestSha256 }): { kind: 'none' | 'rejected' | 'expired' } |
// { kind: 'pending', confirmUrl, expiresAt } | { kind: 'accepted', grantId, receiptId, acceptedAt, acceptedAtMs }; acceptedAt to the second,
// UTC, ending in Z (whether it is past is seal's to judge: the door's clock is the server's). Anything else is ACCEPT_DOOR_ANSWER_REFUSED.
export function readAnswer(answer, { resource, requestSha256 }) {
  check(plain(answer) && ANSWERS.includes(answer.status), 'ACCEPT_DOOR_ANSWER_REFUSED', { status: plain(answer) ? answer.status ?? null : null });
  check(answer.request_sha256 === requestSha256, 'ACCEPT_DOOR_ANSWER_REFUSED',
    { status: answer.status, request_sha256: answer.request_sha256 ?? null, note: 'the answer names another request, or none' });
  check(answer.resources === undefined || (Array.isArray(answer.resources) && answer.resources.length === 1 && answer.resources[0] === resource), 'ACCEPT_DOOR_ANSWER_REFUSED',
    { status: answer.status, resources: answer.resources, note: 'the answer is of another resource' });
  // part A's fleet_accept_answer_v1: the version accepted under another package or request; the door refuses to open this one
  check(!(answer.status === 'none' && answer.conflict !== undefined), 'ACCEPT_DOOR_VERSION_ALREADY_ACCEPTED', { conflict: answer.conflict, note: 'this version is accepted under another package or request: publish another version' });
  if (answer.status === 'pending') {
    check(CONFIRM_PATH.test(answer.confirm_path ?? '') && TIME.test(answer.expires_at ?? '') && Number.isFinite(Date.parse(answer.expires_at)), 'ACCEPT_DOOR_ANSWER_REFUSED',
      { status: 'pending', confirm_path: answer.confirm_path ?? null, expires_at: answer.expires_at ?? null });
    return { kind: 'pending', confirmUrl: `${CONFIRM_ORIGIN}${answer.confirm_path}`, expiresAt: answer.expires_at };
  }
  if (answer.status !== 'accepted') return { kind: answer.status };
  check(UUID.test(answer.grant_id ?? '') && UUID.test(answer.receipt_id ?? '') && answer.grant_id !== answer.receipt_id, 'ACCEPT_DOOR_ANSWER_REFUSED',
    { status: 'accepted', note: 'grant_id and receipt_id: two different UUIDs' });
  const at = TIME.test(answer.accepted_at ?? '') ? Date.parse(answer.accepted_at) : NaN;
  check(Number.isFinite(at), 'ACCEPT_DOOR_ANSWER_REFUSED', { status: 'accepted', accepted_at: answer.accepted_at ?? null });
  const sealed = answer.sealed_acceptance_sha256;
  check(sealed == null || HEX64.test(sealed), 'ACCEPT_DOOR_ANSWER_REFUSED', { status: 'accepted', note: 'invalid sealed acceptance digest' });
  return { kind: 'accepted', grantId: answer.grant_id, receiptId: answer.receipt_id, acceptedAtMs: at,
    ...(sealed == null ? {} : { sealedAcceptanceSha256: sealed }),
    acceptedAt: new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z') };
}

// The registered nodes of an accepted version as the door reads them (part C's accept.mjs run: which nodes are not on the accepted Source
// yet): [{ node, ciSourceManifestSha256 (null: none reported), paused }]. Not accepted: FLEET_NOT_ACCEPTED; not of this shape: refused.
export async function readFleet({ resource, readStatus = statusReader(), timeoutMs }) {
  const requestSha256 = String(resource ?? '').split('/').pop();
  check(HEX64.test(requestSha256), 'ACCEPT_RESOURCE_REFUSED', { resource });
  const answer = await readStatus(resource, { timeoutMs });
  const a = readAnswer(answer, { resource, requestSha256 });
  check(a.kind === 'accepted', 'FLEET_NOT_ACCEPTED', { answer: a.kind });
  const nodes = answer.nodes;
  check(Array.isArray(nodes) && nodes.every(n => plain(n) && typeof n.name === 'string' && n.name !== '' && (n.source_sha256 === null || HEX64.test(n.source_sha256 ?? ''))
    && typeof n.paused === 'boolean' && (!Object.hasOwn(n, 'at_sealed_target') || typeof n.at_sealed_target === 'boolean')), 'ACCEPT_DOOR_ANSWER_REFUSED', { status: 'accepted', note: 'nodes: [{ name, source_sha256 (hex or null), paused }]' });
  return nodes.map(n => ({ node: n.name, ciSourceManifestSha256: n.source_sha256, paused: n.paused,
    ...(Object.hasOwn(n, 'at_sealed_target') ? { atSealedTarget: n.at_sealed_target } : {}) }));
}
