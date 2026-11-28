import { check, HEX64, sha256 } from '../../src/canonical.mjs';

export const KIT_CONTRACT = 'clued.independent-ci.fleet-node-first-install-kit/1';
export const NODE_ENTRY = Object.freeze(Object.fromEntries(
  ['bootstrap.ps1', 'prereq-manifest.json'].map(name => [name, `tree/work/independent-ci-resident-v1/rollout/fleet/${name}`]),
));
export const sumsText = pairs => [...pairs].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  .map(([name, hash]) => `${hash}  ${name}\n`).join('');
export const deliveryAssetManifestName = version => `fleet-node-${version}.candidate.SHA256SUMS`;

export function localImagesOf(kit) {
  const local = Array.isArray(kit?.images?.local) ? kit.images.local : null;
  check(kit?.contract === KIT_CONTRACT && local && local.every(i => HEX64.test(i?.id ?? '') && i.asset === `role-image-${i.id}.tar.gz`),
    'FIRST_INSTALL_KIT_IMAGES_REFUSED');
  return [...new Set(local.map(i => i.id))].sort();
}

export function deliveryDigests(request, manifest, kit) {
  check(sha256(manifest) === request.deliveryAssetsSha256 && sha256(kit) === request.firstInstallKitSha256,
    'FLEET_DELIVERY_ASSET_MANIFEST_REFUSED');
  const tag = `fleet-node-${request.version}`;
  const kitName = `${tag}.first-install-kit.json`;
  const names = [`${tag}.tar`, `${tag}.release.json`, 'SHA256SUMS', kitName, `${tag}.first-install.SHA256SUMS`,
    ...Object.keys(NODE_ENTRY).map(suffix => `${tag}.${suffix}`),
    ...localImagesOf(JSON.parse(kit)).map(id => `role-image-${id}.tar.gz`)];
  const digests = new Map(manifest.toString('utf8').trimEnd().split('\n').map(line => [line.slice(66), line.slice(0, 64)]));
  check(digests.size === names.length && names.every(name => HEX64.test(digests.get(name) ?? '')) &&
    manifest.equals(Buffer.from(sumsText(digests))) && digests.get(`${tag}.tar`) === request.archive_sha256 &&
    digests.get(kitName) === request.firstInstallKitSha256, 'FLEET_DELIVERY_ASSET_MANIFEST_REFUSED');
  return digests;
}

export async function checkDeliveryAssets({ request, manifest, kit, assetSha256 }) {
  const kitName = `fleet-node-${request.version}.first-install-kit.json`;
  for (const [name, expected] of deliveryDigests(request, manifest, kit)) {
    const current = name === kitName ? sha256(kit) : await assetSha256(name);
    check(current === expected, 'FLEET_DELIVERY_RELEASE_ASSET_CHANGED', name);
  }
}
