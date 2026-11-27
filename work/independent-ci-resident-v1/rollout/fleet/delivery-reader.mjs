// Candidate capabilities come from the exact archive already verified by seal.
import { createHash } from 'node:crypto';
import { RESIDENT } from './facts.mjs';
import { TOOL_PATH } from './ports.mjs';
import { readTar } from './tar.mjs';
import { deliveryBound } from './delivery-preflight.mjs';
import { fleetEvidencePayload, freshDeliveryTime, sourceRefsDigest } from '../../src/fleet-delivery-evidence.mjs';

const hex = /^[0-9a-f]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const reinstallEntries = [
  'rollout/fleet/bootstrap.ps1', 'rollout/fleet/install.mjs', 'reinstall/launcher/generate.py',
  'reinstall/launcher/template.ps1', 'reinstall/launcher/continue.py', 'reinstall/launcher/continue-install.ps1',
  'reinstall/tools/file-locks.ps1', 'reinstall/linux/prep.py', 'windows/install-resident.ps1',
  'windows/verify-resident.ps1', 'windows/uninstall-resident.ps1',
].map(name => 'tree/' + RESIDENT + '/' + name);

export function deliveryRequirements(bytes, request) {
  const entries = new Map(readTar(bytes).map(entry => [entry.path, entry.data]));
  const manifest = JSON.parse(entries.get('universal-manifest.json'));
  const supervisor = entries.get('tree/' + RESIDENT + '/windows/CompanionSupervisor.cs');
  const tool = entries.get('tree/' + TOOL_PATH);
  return { standardReinstall: reinstallEntries.every(name => entries.get(name)?.length > 0),
    supervisorSourceSha256: supervisor?.length ? digest(supervisor) : null,
    linuxToolSha256: tool?.length ? digest(tool) : null,
    upgraderSha256: manifest.facts?.upgraderManifestSha256 ?? null,
    sourceRefsSha256: sourceRefsDigest(request.fleetRefs) };
}

const triAnd = (...values) => values.includes(false) ? false : values.every(value => value === true) ? true : null;
const sameHash = (installed, candidate) => hex.test(installed ?? '') && hex.test(candidate ?? '') ? installed === candidate : null;

// Each invocation is confined to one pair of independently read snapshots.
// No network answer is shared across open and attach, or across candidates.
export function deliveryProjectionReaders({ read, requirements, clock }) {
  let pair;
  let reads = 0;
  return {
    async readFleetRegistry(candidate, options) {
      pair ??= await read(candidate, options);
      const view = reads++ === 0 ? pair?.first : pair?.last;
      return deliveryBound(view?.candidate, candidate) ? view : null;
    },
    async readNodeEvidence(candidate, row) {
      const e = row.evidence;
      if (!fleetEvidencePayload(e) || e.currentHeartbeat !== true ||
          e.windowsSourceSha256 !== row.reportedSourceSha256 || !freshDeliveryTime(e.brokerObservedAt, clock()) ||
          !freshDeliveryTime(e.linuxObservedAt, clock()) || !freshDeliveryTime(e.observedAt, clock())) return null;
      const checks = {
        currentPointer: true, installReceipt: true, linuxFacts: e.linuxReady,
        ciConnection: e.connectionCarry, host: row.serviceRunning && e.linuxReady,
        roleAndPause: row.reportedState === 'NORMAL', operations: e.operations,
        sourceAgreement: triAnd(e.windowsSourceSha256 === e.linuxSourceSha256, e.linuxConsistent),
        frozenChannel: triAnd(sameHash(e.upgraderSha256, requirements.upgraderSha256), sameHash(e.linuxToolSha256, requirements.linuxToolSha256)),
        acceptanceRefs: sameHash(e.sourceRefsSha256, requirements.sourceRefsSha256),
        supervisor: sameHash(e.supervisorSourceSha256, requirements.supervisorSourceSha256),
        launcher: requirements.standardReinstall, acl: e.acl, connectionCarry: e.connectionCarry,
        processClearance: e.processClearance, continuation: requirements.standardReinstall && e.operations,
      };
      return { candidate, nodeId: e.nodeId, node: row.name, bindingGeneration: e.bindingGeneration,
        registrationVersion: e.registrationVersion, generation: e.packageGeneration, receiptSha256: e.installReceiptSha256,
        observedAt: new Date(Math.min(...[e.observedAt, e.brokerObservedAt, e.linuxObservedAt].map(Date.parse))).toISOString(),
        evidenceSha256: e.evidenceSha256, checks };
    },
  };
}
