// The landing port of push mode (resident ADR 0018). Protocol 1 uses the REST
// methods below. Protocol 2 adds fixed-name atomic ref updates and marker commits:
//   fastForwardMain(S)        PATCH /git/refs/heads/main {sha: S, force: false}    (GitHub only fast-forwards; 422 otherwise)
//   pointRef(ref, sha)        PATCH (or POST when missing) one of the train's own refs heads/clued-train/staging[.tmp], force true
//   mergeIntoTmp(head, msg)   POST /merges {base: clued-train/staging.tmp, head}   (the cumulative merge of a batch)
// Every other ref, a deletion, a force on main, a PR merge: refused before anything is sent (LANDING_REF_REFUSED). Its token is
// minted from the same private-key provider as the checks port (github.mjs: the protected control-service principal's App key;
// no new secret) but asks only for contents write (plus workflows write, so a tested change of .github/workflows can land: ADR 0018 §8
// item 1). The reply's permission set and repository must be exactly that, or no token is used. This token reads back only the
// fixed v2 refs. Rules, checks, pull requests and commits are read through the corresponding read ports.
import { createSign } from 'node:crypto';
import { MAIN_REF, STAGING_REF, STAGING_TMP_REF, STAGING_TMP_BRANCH, GENERATION_REF, ABSENT_OID } from './train-landing.mjs';

export const LANDING_PERMISSIONS = Object.freeze({ contents: 'write', workflows: 'write' });
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const oid = value => typeof value === 'string' && SHA.test(value) && value !== ABSENT_OID;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = v => Number.isSafeInteger(v) && v > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
// The two Apps the checks port refuses (clued-admission and the hosted relay App): never the landing identity either.
const FORBIDDEN_APPS = Object.freeze([5365273, 5164952]);

function jwt(appId, key, now) {
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: String(appId) })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

export function createLandingPort({ repository, repositoryId, appId, installationId, privateKeyProvider, fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 15_000 } = {}) {
  if (!REPO.test(repository ?? '') || ![repositoryId, appId, installationId].every(positive) || FORBIDDEN_APPS.includes(appId)
    || typeof privateKeyProvider !== 'function' || typeof fetchImpl !== 'function' || typeof clock !== 'function') fail('invalid_landing_configuration');
  const root = `https://api.github.com/repos/${repository}`;
  let token = null;
  async function send(url, method, bearer, body) {
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${bearer}`, 'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      const connect = ['connect', 'getaddrinfo'].includes(e?.cause?.syscall) || e?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      return { status: null, body: null, notSent: connect };
    }
    let parsed = null;
    try { const text = await response.text(); parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, notSent: false };
  }
  async function credential() {
    if (token && Date.parse(token.expires_at) > clock() + 60_000) return token.token;
    let appJwt;
    try { appJwt = jwt(appId, await privateKeyProvider(), clock()); } catch { fail('github_credential_unavailable'); }
    const app = await send('https://api.github.com/app', 'GET', appJwt);
    if (app.status !== 200 || app.body?.id !== appId) fail('unexpected_app_identity');
    const minted = await send(`https://api.github.com/app/installations/${installationId}/access_tokens`, 'POST', appJwt,
      { repository_ids: [repositoryId], permissions: LANDING_PERMISSIONS });
    const p = minted.body?.permissions, allowed = { ...LANDING_PERMISSIONS, metadata: 'read' };
    if (minted.status !== 201 || typeof minted.body?.token !== 'string' || !Number.isFinite(Date.parse(minted.body.expires_at))
      || Date.parse(minted.body.expires_at) <= clock() || Date.parse(minted.body.expires_at) > clock() + 3_660_000
      || !p || Object.entries(p).some(([k, v]) => allowed[k] !== v) || !Object.keys(LANDING_PERMISSIONS).every(k => p[k] === LANDING_PERMISSIONS[k])
      || !Array.isArray(minted.body.repositories) || minted.body.repositories.length !== 1 || minted.body.repositories[0].id !== repositoryId
      || minted.body.repositories[0].full_name !== repository) fail('unexpected_installation_token_scope');
    token = minted.body;
    return token.token;
  }
  const refOk = ref => ref === STAGING_REF || ref === STAGING_TMP_REF;
  const update = (name, beforeOid, afterOid, force = false) => ({ name: `refs/${name}`, beforeOid, afterOid, force });
  const tmpRef = (batchId, generation) => {
    if (typeof batchId !== 'string' || !HASH.test(batchId) || !positive(generation)) fail('LANDING_REF_REFUSED');
    return `heads/clued-train/tmp/${batchId}/${generation}`;
  };
  function requireV2() {
    if (appId !== 5368905) fail('LANDING_REF_REFUSED');
  }
  async function atomic(effectId, refUpdates) {
    requireV2();
    if (typeof effectId !== 'string' || !HASH.test(effectId)
      || refUpdates.some(r => !(oid(r.beforeOid) || r.beforeOid === ABSENT_OID) || !oid(r.afterOid) || r.beforeOid === r.afterOid))
      fail('LANDING_REF_REFUSED');
    const bearer = await credential();
    const repositoryId = token.repositories[0].node_id;
    if (typeof repositoryId !== 'string' || !/^[A-Za-z0-9_+=/-]+$/.test(repositoryId)) fail('unexpected_installation_token_scope');
    const r = await send('https://api.github.com/graphql', 'POST', bearer, {
      query: 'mutation TrainUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
      variables: { input: { repositoryId, clientMutationId: effectId, refUpdates } },
    });
    return { acknowledged: r.status === 200 && !r.body?.errors && r.body?.data?.updateRefs?.clientMutationId === effectId };
  }
  async function mergeInto(ref, head, message) {
    if (!oid(head) || typeof message !== 'string' || message.length > 1000) fail('LANDING_REF_REFUSED');
    const bearer = await credential();
    const r = await send(`${root}/merges`, 'POST', bearer, { base: ref, head, commit_message: message });
    if (r.status === 201 && oid(r.body?.sha)) return { status: 201, sha: r.body.sha };
    if (r.status === 204 || r.status === 409) return { status: r.status, sha: null };
    fail('LANDING_MERGE_UNCONFIRMED');
  }
  return Object.freeze({
    appId,
    async readTrainRefs() {
      requireV2();
      const bearer = await credential();
      const [owner, name] = repository.split('/');
      const { status, body } = await send('https://api.github.com/graphql', 'POST', bearer, {
        query: `query TrainRefs($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            id
            main: ref(qualifiedName: "refs/${MAIN_REF}") { target { oid } }
            generation: ref(qualifiedName: "refs/${GENERATION_REF}") { target { oid } }
            staging: ref(qualifiedName: "refs/${STAGING_REF}") { target { oid } }
          }
        }`,
        variables: { owner, name },
      });
      const repo = body?.data?.repository;
      if (status !== 200 || body?.errors || typeof repo?.id !== 'string' || repo.id !== token.repositories[0].node_id
        || !oid(repo.main?.target?.oid) || !(repo.generation === null || oid(repo.generation?.target?.oid))
        || !(repo.staging === null || oid(repo.staging?.target?.oid))) fail('LANDING_REF_UNCONFIRMED');
      return { mainSha: repo.main.target.oid, generationRefOid: repo.generation?.target.oid ?? ABSENT_OID, stagingSha: repo.staging?.target.oid ?? ABSENT_OID };
    },
    async createGenerationMarker({ parentOid, treeOid, effectId, transition, createdAt }) {
      requireV2();
      if (!oid(parentOid) || !oid(treeOid) || typeof effectId !== 'string' || !HASH.test(effectId)
        || !['activate', 'stage', 'land', 'invalidate'].includes(transition)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(createdAt ?? '') || !Number.isFinite(Date.parse(createdAt))) fail('LANDING_REF_REFUSED');
      const bearer = await credential();
      const identity = { name: 'BeamingFace Merge Train', email: 'beamingface-merge-train@users.noreply.github.com', date: createdAt };
      const r = await send(`${root}/git/commits`, 'POST', bearer, {
        author: identity, committer: identity, message: `clued-train/2 ${transition} ${effectId}`, tree: treeOid, parents: [parentOid],
      });
      if (r.status !== 201 || !oid(r.body?.sha) || r.body?.tree?.sha !== treeOid
        || r.body?.parents?.length !== 1 || r.body.parents[0]?.sha !== parentOid) fail('LANDING_REF_UNCONFIRMED');
      return r.body.sha;
    },
    async activateGeneration({ beforeOid, afterOid, effectId }) {
      return atomic(effectId, [update(GENERATION_REF, beforeOid, afterOid)]);
    },
    async invalidateGeneration({ beforeOid, afterOid, effectId }) {
      if (!oid(beforeOid)) fail('LANDING_REF_REFUSED');
      return atomic(effectId, [update(GENERATION_REF, beforeOid, afterOid)]);
    },
    async landIntent({ baseSha, testSha, generationRefOid, landedRefOid, effectId }) {
      if (!oid(baseSha) || !oid(generationRefOid)) fail('LANDING_REF_REFUSED');
      return atomic(effectId, [update(MAIN_REF, baseSha, testSha), update(GENERATION_REF, generationRefOid, landedRefOid)]);
    },
    async stageIntent({ testSha, stagingBeforeOid, generationRefOid, stagedRefOid, effectId }) {
      if (!oid(generationRefOid)) fail('LANDING_REF_REFUSED');
      return atomic(effectId, [update(STAGING_REF, stagingBeforeOid, testSha, true), update(GENERATION_REF, generationRefOid, stagedRefOid)]);
    },
    async prepareBatchTmp({ batchId, generation, baseSha }) {
      return atomic(batchId, [update(tmpRef(batchId, generation), ABSENT_OID, baseSha)]);
    },
    async mergeIntoBatchTmp({ batchId, generation, headSha, message }) {
      requireV2();
      return mergeInto(tmpRef(batchId, generation).slice('heads/'.length), headSha, message);
    },
    // -> { status, sha, notSent }: 200 with the new tip; 422 not a fast-forward (or refused by a rule); anything else as GitHub said.
    async fastForwardMain(sha) {
      if (!SHA.test(sha ?? '')) fail('LANDING_REF_REFUSED');
      const bearer = await credential();
      const r = await send(`${root}/git/refs/${MAIN_REF}`, 'PATCH', bearer, { sha, force: false });
      return { status: r.status, sha: r.body?.object?.sha ?? null, notSent: r.notSent };
    },
    async pointRef(ref, sha) {
      if (!refOk(ref) || !SHA.test(sha ?? '')) fail('LANDING_REF_REFUSED');
      const bearer = await credential();
      let r = await send(`${root}/git/refs/${ref}`, 'PATCH', bearer, { sha, force: true });
      if (r.status === 404 || r.status === 422) {
        const created = await send(`${root}/git/refs`, 'POST', bearer, { ref: `refs/${ref}`, sha });
        if (created.status === 201) r = { status: 200, body: created.body };
        else if (r.status === 422) r = created;
      }
      if (r.status !== 200 || r.body?.object?.sha !== sha) fail('LANDING_REF_UNCONFIRMED');
      return { sha };
    },
    // -> { status: 201, sha } a merge commit; 204 nothing to merge (the head is already in the base); 409 a conflict.
    async mergeIntoTmp(head, message) {
      return mergeInto(STAGING_TMP_BRANCH, head, message);
    },
  });
}
