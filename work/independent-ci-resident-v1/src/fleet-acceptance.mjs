export const ACCEPTANCE_CONTRACT = 'clued.independent-ci.fleet-node-acceptance/1';
export const REQUEST_CONTRACT = 'clued.independent-ci.fleet-node-acceptance-request/1';
export const REQUEST_FLEET_REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef',
  'publisherQualificationRef', 'ownerPackageAcceptanceRef', 'formalRoles']);

// seal and the nodes serialize the same object in this order from the same accepted request.
export function acceptanceOf(request, { decision, receipt, acceptedAt }) {
  const f = request.fleetRefs;
  const a = { contract: ACCEPTANCE_CONTRACT, version: request.version, archive_sha256: request.archive_sha256, commit: request.commit,
    repository: request.repository, ciSourceManifestSha256: request.ciSourceManifestSha256, cluedDecision: decision, acceptedAt,
    fleetRefs: { sourceAcceptanceRef: f.sourceAcceptanceRef, hostQualificationRef: f.hostQualificationRef, ownerAuthorizationRef: f.ownerAuthorizationRef,
      publisherQualificationRef: f.publisherQualificationRef, ownerPackageAcceptanceRef: f.ownerPackageAcceptanceRef, installationReceiptRef: receipt,
      ownerDecisionRef: decision, ownerReceiptRef: receipt, formalRoles: f.formalRoles },
    firstInstallKitSha256: request.firstInstallKitSha256 };
  if (request.ciSourceManifestSha256 === undefined) delete a.ciSourceManifestSha256;
  return a;
}

export const acceptanceBytes = a => Buffer.from(JSON.stringify(a, null, 2) + '\n');
