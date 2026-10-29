// Stage R entry of Source v2 (free-minutes design S17/S19), run by the one generic helper as clued-control:
//   node relay-entry-v2.mjs --run --stage <nonce> --config-sha256 <sha>
// The stage package's jobs are the relay candidates the resident wrote into 20-plan-intent (a non-empty
// ordered subset of the registry's relayable roles; derive-batch.mjs --relay-roles). For each candidate the
// hosted relay stage (stage.mjs) observes the GitHub-hosted run, verifies its GitHub-signed OIDC token,
// attests E1-E8 and, only for ATTESTED_SUCCESS, lets the v2 scanner publisher re-attest, take the fresh
// Native admission (E9, the sticky batch claim) and K(head, role) in the SAME effect journal the local v2
// scanner publisher uses (state\v2\effects-scan, E10), publish under App 5368905 and read back.
// The outcome record carries the per-role plan rows (relay-plan.mjs) for the resident's 25-plan.
// Nothing here executes PR content; the only network reads are api.github.com (the installed checks port)
// and the fixed GitHub OIDC JWKS URL, whose cache lives in state\relay\jwks\.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { EffectJournal } from '../effect-journal.mjs';
import { readBatchClaim } from '../batch-claim-v2.mjs';
import { createRecoverableCheckPublisherV2, createPublicationRecoveryAuditWriter } from '../../runtime/one-shot-v2.mjs';
import { runEntry, controllerPrincipal, controllerPorts, publicationControllerGithub, observationLog } from '../resident-v2/entry-runtime.mjs';
import { STATE_V2, STATE_RELAY_JWKS } from '../resident-v2/layout.mjs';
import { validateRegistry, OCI_DIGEST, RELAY_AUDIENCE } from './registry.mjs';
import { createGitHubOidcVerifier, createJwksFileCache, createJwksPort } from './oidc.mjs';
import { createHostedRelayObserver } from './observe.mjs';
import { createHostedRelayStage, createHostedRelayVerifier } from './stage.mjs';
import { entryResultOf } from './relay-plan.mjs';

const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const REGISTRY_URL = new URL('./registry.json', import.meta.url);
const REGISTRY_PATH = 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json';
const fail = code => { throw Object.assign(new Error(code), { code }); };

// The installed production registry, read once and checked against the held Source pin (the record pins
// every Source byte; a registry that is not the accepted one is refused before any read).
export function installedRegistry(held) {
  const bytes = fs.readFileSync(fileURLToPath(REGISTRY_URL));
  if (held.sourceHashes.get(REGISTRY_PATH) !== createHash('sha256').update(bytes).digest('hex')) fail('RELAY_REGISTRY_NOT_ACCEPTED');
  return validateRegistry(JSON.parse(bytes.toString('utf8')), { domain: 'production' });
}

// The installed local roles' own pins of hosted-job inputs, from the installed Source manifest (the record):
// trivy's checks bundle digest (formalTrivy.checksPin.digest). Anything else yields no pin, so the role stays local.
export function installedInputPins(manifest) {
  const digest = manifest?.roles?.trivy?.formalTrivy?.checksPin?.digest;
  return Object.freeze(typeof digest === 'string' && OCI_DIGEST.test(digest) ? { trivy: Object.freeze({ checksDigest: digest }) } : {});
}

// The relay stage subject: the batch content of the candidate jobs plus the sticky batch claim generation
// stage 1 recorded (the relay publication must observe that same generation again, A-strict).
export function relaySubject(jobs, batchClaim) {
  const j = jobs[0];
  return { repo: j.repo, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, claimId: batchClaim.claimId, fence: batchClaim.fence, epoch: batchClaim.epoch,
    sourceManifestSha256: j.sourceManifestSha256 };
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  return runEntry({ argv, entryRole: 'relay-publisher', moduleUrl: import.meta.url, output, successStatuses: ['RELAY_COMPLETE'],
    body: async ({ args, inputs, held, live, sourceRoot }) => {
      const jobs = inputs.jobs, { config, accepted } = inputs.record;
      const registry = installedRegistry(held);
      const batchClaim = await readBatchClaim(STATE_V2.batchClaims, jobs[0]);
      const { appKey, nativeToken } = await controllerPrincipal(inputs.record);
      const log = observationLog(STATE_V2.effectsScan, jobs[0].id);
      const ports = controllerPorts({ record: inputs.record, appKey, nativeToken, policyText: held.policyText, sourceRoot, live, log });
      const { admission, fetchImpl } = ports;
      const journal = await EffectJournal.open(STATE_V2.effectsScan);
      const github = publicationControllerGithub({ ports, jobs, journal, args, record: inputs.record });
      const oidc = createGitHubOidcVerifier({ audience: RELAY_AUDIENCE, jwksPort: createJwksPort({ fetchImpl }), cache: createJwksFileCache(STATE_RELAY_JWKS) });
      const verifier = createHostedRelayVerifier({ registry, observer: createHostedRelayObserver({ github, registry }), oidc });
      // K(head, role) and the relay's own effect keys live in the local v2 scanner publisher's journal, so the two
      // paths exclude each other for one role on one head across batches, bases and attempts (K has neither the
      // base nor the attempt since PR-A review MAJOR 2; the v1 one-shot never takes K).
      const recoveryContext = { nonce: args.nonce, stage: inputs.plan.stage, entryRole: inputs.plan.entryRole, batchKey: inputs.plan.batchKey,
        configSha256: args.configSha256, sourceManifestSha256: inputs.plan.sourceManifestSha256, acceptanceSha256: inputs.plan.acceptanceSha256, entrySha256: inputs.plan.entrySha256 };
      const publisher = createRecoverableCheckPublisherV2({ recoveryContext, auditWriter: createPublicationRecoveryAuditWriter({ context: recoveryContext }), authorityOptions: { config, accepted, github, fetchImpl, nativeToken },
        readCurrentBatchClaim: j => readBatchClaim(STATE_V2.batchClaims, j), live, log, publisherOptions: { nativeAdmission: admission,
        github, journal, signers: inputs.record.signers, configuredChecks: config.checks, readChangedPaths: subject => github.readChangedPaths(subject), batchClaim,
        protectedDeployment: { enabled: true, domain: 'production', repository: config.repository, ciPrincipalBindingId: config.ciPrincipalBindingId, ...Object.fromEntries(REFS.map(r => [r, accepted[r]])) },
        domain: 'production', hostedVerifier: verifier } });
      const stage = createHostedRelayStage({ registry, verifier, publisher, localInputPins: installedInputPins(inputs.record.manifest) });
      const result = await stage.run({ subject: relaySubject(jobs, batchClaim), attempt: jobs[0].attempt, roles: jobs.map(j => j.role) });
      log('hosted_relay_stage_result', { jobId: jobs[0].id, resultSha256: result.resultSha256, status: result.status, code: result.code });
      return entryResultOf(result);
    } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
