// The companion forwards a fixed projection of the local observations. It never
// opens the CI token, the protected connection record or a mutable install plan.
import path from 'node:path';
import { canonicalJson, HEX64, sha256, UUID } from './canonical.mjs';
import { readBounded } from './store.mjs';

const WINDOW = 15 * 60_000;
const fields = ['linuxReady', 'linuxConsistent', 'acl', 'connectionCarry', 'operations', 'processClearance'];
const hashes = ['installReceiptSha256', 'windowsSourceSha256', 'linuxSourceSha256', 'brokerEvidenceSha256', 'linuxFactsSha256'];
const optionalHashes = ['upgraderSha256', 'linuxToolSha256', 'supervisorSourceSha256', 'sourceRefsSha256'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = value => Number.isSafeInteger(value) && value >= 1 && value < 10 ** 15;
export const freshDeliveryTime = (time, now) => typeof time === 'string' && time.length <= 40
  && Date.parse(time) <= now && now - Date.parse(time) <= WINDOW;
const hex = value => typeof value === 'string' && HEX64.test(value);
const time = value => typeof value === 'string' && /^[0-9T:.Z+-]{20,40}$/.test(value) && Number.isFinite(Date.parse(value));

export function fleetEvidencePayload(value) {
  if (!plain(value) || value.schemaVersion !== 1 || !UUID.test(value.nodeId ?? '') ||
      !int(value.bindingGeneration) || !int(value.installGeneration) ||
      !(value.packageGeneration === null || int(value.packageGeneration)) ||
      !hashes.every(key => hex(value[key])) || !time(value.brokerObservedAt) || !time(value.linuxObservedAt)) return null;
  return {
    schemaVersion: 1, nodeId: value.nodeId, bindingGeneration: value.bindingGeneration,
    packageGeneration: value.packageGeneration, installGeneration: value.installGeneration,
    brokerObservedAt: value.brokerObservedAt, linuxObservedAt: value.linuxObservedAt,
    ...Object.fromEntries(hashes.map(key => [key, value[key]])),
    ...Object.fromEntries(optionalHashes.map(key => [key, hex(value[key]) ? value[key] : null])),
    ...Object.fromEntries(fields.map(key => [key, typeof value[key] === 'boolean' ? value[key] : null])),
  };
}

export function sourceRefsOf(acceptance, manifest) {
  const formalRoles = Object.fromEntries(['gitleaks', 'trivy', 'contract-placement'].map(role =>
    [role, Object.fromEntries(Object.entries(manifest.roles[role]).filter(([key]) => key !== 'sourceFiles' && key !== 'controllerRelay'))]));
  return { sourceAcceptanceRef: acceptance.sourceAcceptanceRef, hostQualificationRef: acceptance.hostQualificationRef, formalRoles };
}
export const sourceRefsDigest = ({ sourceAcceptanceRef, hostQualificationRef, formalRoles }) =>
  sha256(canonicalJson({ sourceAcceptanceRef, hostQualificationRef, formalRoles }));

export function fleetInstallIdentity(bytes, currentBytes) {
  const parse = value => JSON.parse(Buffer.from(value).toString('utf8').replace(/^\uFEFF/, ''));
  const receipt = parse(bytes), current = parse(currentBytes);
  if (!hex(current?.packageManifestSha256) || current.packageManifestSha256 !== receipt.packageManifestSha256 ||
      current.installReceiptSha256 !== sha256(bytes)) return null;
  return { receipt, current, bytes };
}

export async function readFleetDeliveryEvidence({ root, status, now }) {
  const read = name => readBounded(path.join(root, name), 262144, 'FLEET_DELIVERY_EVIDENCE_REFUSED');
  try {
    const broker = JSON.parse(await read('broker/renew-ci.json')).delivery;
    if (!broker || !freshDeliveryTime(broker.observedAt, now)) return null;
    const identity = fleetInstallIdentity(await read('install/install-receipt.json'), await read('upgrade/current.json'));
    if (!identity) return null;
    const { receipt, current } = identity;
    const versions = status?.versions;
    if (broker.installReceiptSha256 !== current.installReceiptSha256 || broker.installGeneration !== current.generation ||
        broker.windowsSourceSha256 !== current.ciSourceManifestSha256 || versions?.localInstallGeneration !== current.generation ||
        versions?.windows?.ciSourceManifestSha256 !== current.ciSourceManifestSha256) return null;

    const linuxBytes = await read('upgrade/mailbox/responses/version-facts.json');
    const linux = JSON.parse(linuxBytes);
    if (linux.contract !== 'clued.independent-ci.linux-version-facts/1' || !freshDeliveryTime(linux.observedAt, now) ||
        Date.parse(linux.observedAt) !== Date.parse(versions.linux?.observedAt) || linux.ciSourceManifestSha256 !== versions.linux?.ciSourceManifestSha256 ||
        linux.generation !== versions.linux?.localInstallGeneration) return null;
    const packageView = versions.installedPackage;
    const packageGeneration = packageView?.status === 'verified' && packageView.ciSourceManifestSha256 === broker.windowsSourceSha256
      ? packageView.packageGeneration : null;

    let sourceRefsSha256;
    try {
      const bytes = await read('record/source-manifest.json'), accepted = await read('record/acceptance.json');
      if (sha256(bytes) === current.ciSourceManifestSha256 && sha256(accepted) === receipt.acceptanceSha256) {
        sourceRefsSha256 = sourceRefsDigest(sourceRefsOf(JSON.parse(accepted), JSON.parse(bytes)));
      }
    } catch { /* Optional upgrade evidence remains unknown. */ }

    return fleetEvidencePayload({ ...broker, brokerObservedAt: broker.observedAt, packageGeneration,
      brokerEvidenceSha256: sha256(canonicalJson(broker)), linuxFactsSha256: sha256(linuxBytes),
      linuxSourceSha256: linux.ciSourceManifestSha256, linuxObservedAt: linux.observedAt,
      linuxConsistent: versions.consistent,
      linuxReady: linux.staged === null && linux.pinsOk === true && linux.liveMatchesCurrent !== false,
      upgraderSha256: receipt.upgrader?.manifestSha256, linuxToolSha256: linux.upgradeToolSha256, sourceRefsSha256 });
  } catch {
    return null;
  }
}
