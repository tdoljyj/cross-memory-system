import { isDeepStrictEqual } from 'node:util';
import { googleDriveAccessDigest, googleDriveSharingDigest } from './resource-center-google-drive-sharing.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
const versionPattern = /^[1-9][0-9]{0,39}$/;
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const fail = code => { throw new Error(`STORAGE_EXTERNAL_${code}`); };
const nameValid = name => typeof name === 'string' && name.length > 0 && name.length <= 255 &&
  !/[\u0000-\u001f\u007f/\\]/u.test(name) && !['.', '..'].includes(name) && name.trim() === name;

/** GET-only observer. The server supplies the registry; observations confer no
 * write authority. The transaction must independently validate the same plan.
 * A bounded focus subtree is observed, including every registered descendant.
 * Other registered directories are locators for resolving a changed parent.
 * @param {{metadata?: {getFile: Function, listChildren: Function, listFolder: Function}, clock?: () => number, maxObjects?: number}} config
 */
export function createGoogleDriveExternalRegistrationObserver({ metadata, clock = Date.now, maxObjects = 256 } = {}) {
  if (!metadata || !['getFile', 'listChildren', 'listFolder'].every(k => typeof metadata[k] === 'function') ||
      !Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 1000) fail('CONFIG_INVALID');

  async function once(plan, signal) {
    if (!object(plan) || plan.contract !== 'clued.storage-external-registration-plan/1' ||
        !idPattern.test(plan.root_folder_id) || !idPattern.test(plan.root_parent_id) ||
        !idPattern.test(plan.focus_file_id) || typeof plan.managed_root !== 'string' ||
        !Array.isArray(plan.registry) || plan.registry.length < 1 || plan.registry.length > 5000) fail('PLAN_INVALID');
    const registry = new Map();
    for (const row of plan.registry) {
      if (!object(row) || !idPattern.test(row.provider_file_id) || registry.has(row.provider_file_id) ||
          typeof row.path !== 'string' || !['file', 'directory'].includes(row.target_kind) ||
          !['active', 'trashed', 'revoked'].includes(row.state)) fail('PLAN_INVALID');
      registry.set(row.provider_file_id, row);
    }
    const root = registry.get(plan.root_folder_id), focus = registry.get(plan.focus_file_id);
    if (!root || root.path !== plan.managed_root || root.state !== 'active' || root.target_kind !== 'directory' ||
        !focus || focus.state !== 'active' || focus.target_kind !== 'directory' ||
        focus.governance_class !== 'ordinary' || !focus.path.startsWith(plan.managed_root + '/')) fail('PLAN_INVALID');
    const selected = plan.registry.filter(row => row.state === 'active' &&
      (row.path === focus.path || row.path.slice(0, row.path.lastIndexOf('/')) === focus.path));
    const selectedIds = new Set(selected.map(row => row.provider_file_id));
    if (selected.some(row => row.governance_class !== 'ordinary') || selected.length > maxObjects) fail('SCOPE_UNAVAILABLE');
    const observed = new Map(), resolving = new Set(), namespace = new Map(), rawFiles = new Map();
    function getFile(id) {
      if (!rawFiles.has(id)) rawFiles.set(id, metadata.getFile(id, { signal }));
      return rawFiles.get(id);
    }
    async function unique(parent, name, expectedId) {
      const key = JSON.stringify([parent, name]);
      if (!namespace.has(key)) namespace.set(key, metadata.listChildren({ parent_id: parent, name }, { signal }));
      const entries = await namespace.get(key);
      if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.id !== expectedId) fail('NAME_AMBIGUOUS');
    }
    async function read(id, allowNew = false) {
      signal?.throwIfAborted();
      if (observed.has(id)) return observed.get(id);
      if (resolving.has(id)) fail('PARENT_CYCLE');
      if (observed.size + resolving.size >= maxObjects) fail('OBJECT_LIMIT');
      const registered = registry.get(id);
      if (registered && registered.state !== 'active' || !registered && !allowNew) fail('PARENT_UNREGISTERED');
      resolving.add(id);
      const raw = await getFile(id);
      if (!object(raw) || raw.id !== id || !nameValid(raw.name) || !versionPattern.test(raw.version) ||
          raw.trashed !== false || raw.explicitlyTrashed === true || raw.mimeType === SHORTCUT ||
          typeof raw.mimeType !== 'string' || !Array.isArray(raw.parents) || raw.parents.length !== 1 ||
          !idPattern.test(raw.parents[0])) fail('IDENTITY_INVALID');
      // Complete, private ownership is deliberate: a sharing/ownership change
      // needs its existing governance path, never an automatic new baseline.
      if (raw.ownedByMe !== true || raw.driveId != null || raw.shared !== false ||
          !Array.isArray(raw.permissions) || raw.permissions.length !== 1 ||
          raw.permissions[0].type !== 'user' || raw.permissions[0].role !== 'owner' ||
          raw.permissions[0].deleted === true || raw.permissions[0].pendingOwner === true ||
          raw.permissions[0].view != null || raw.inheritedPermissionsDisabled === true) fail('ACCESS_CHANGED');
      const kind = raw.mimeType === FOLDER ? 'directory' : 'file';
      const access = googleDriveAccessDigest(raw), sharing = googleDriveSharingDigest(raw);
      if (!access || !sharing || kind === 'directory' && raw.capabilities?.canListChildren !== true ||
          registered && registered.target_kind !== kind) fail('IDENTITY_INVALID');
      if (registered?.provider_access_digest && registered.provider_access_digest !== access ||
          registered?.provider_sharing_digest && registered.provider_sharing_digest !== sharing) fail('ACCESS_CHANGED');
      let path;
      if (id === plan.root_folder_id) {
        if (raw.parents[0] !== plan.root_parent_id || raw.name !== plan.managed_root.split('/').at(-1)) fail('ROOT_CHANGED');
        path = plan.managed_root;
      } else {
        // A registered item may have been moved into a newly created folder.
        // Resolve that exact parent chain now; each new link must terminate at
        // this focus directory and is adopted parent-first in the same batch.
        const parent = await read(raw.parents[0], true);
        if (parent.target_kind !== 'directory') fail('PARENT_INVALID');
        path = parent.path + '/' + raw.name;
        if (path.length > 1000) fail('PATH_INVALID');
        await unique(parent.provider_file_id, raw.name, id);
        if (registered && (registered.governance_class !== 'ordinary' ||
            registered.path.slice(plan.managed_root.length + 1).indexOf('/') < 0) && path !== registered.path) fail('GOVERNANCE_CHANGED');
        if (registered && !selectedIds.has(id) && path !== registered.path) fail('ANCESTOR_CHANGED');
        if (!registered && (parent.provider_file_id !== plan.focus_file_id && registry.has(parent.provider_file_id) ||
            parent.provider_file_id === plan.root_folder_id || parent.access_digest !== access)) fail('ADOPTION_DENIED');
      }
      const node = { provider_file_id: id, provider_file_version: raw.version, parent_id: raw.parents[0], name: raw.name,
        target_kind: kind, path, mime_type: raw.mimeType, access_digest: access, sharing_digest: sharing,
        content_identity: { size: raw.size ?? null, sha256: raw.sha256Checksum ?? null, md5: raw.md5Checksum ?? null,
          head_revision_id: raw.headRevisionId ?? null } };
      observed.set(id, node); resolving.delete(id); return node;
    }
    for (const row of selected) {
      if (row.target_kind !== 'directory') continue;
      const value = await read(row.provider_file_id);
      if (value.target_kind === 'directory' && value.path !== row.path) {
        for (const descendant of plan.registry) if (descendant.state === 'active' && descendant.path.startsWith(row.path + '/') && !selectedIds.has(descendant.provider_file_id)) {
          if (descendant.governance_class !== 'ordinary') fail('SCOPE_UNAVAILABLE');
          selected.push(descendant); selectedIds.add(descendant.provider_file_id);
          if (selected.length > maxObjects) fail('OBJECT_LIMIT');
        }
      }
    }
    // Bound independent file reads to six concurrent requests. Resolution and
    // validation remain sequential, avoiding shared-parent/cycle races.
    async function prime(ids) {
      if (new Set([...observed.keys(), ...ids]).size > maxObjects) fail('OBJECT_LIMIT');
      let next = 0;
      const results = await Promise.allSettled(Array.from({ length: Math.min(6, ids.length) }, async () => {
        while (next < ids.length) {
          const id = ids[next++], raw = await getFile(id);
          if (object(raw) && raw.id === id && raw.trashed === false && raw.explicitlyTrashed !== true && nameValid(raw.name) && Array.isArray(raw.parents) && raw.parents.length === 1 &&
              registry.get(raw.parents[0])?.state === 'active') await unique(raw.parents[0], raw.name, id);
        }
      }));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    const fileIds = selected.filter(row => row.target_kind === 'file').map(row => row.provider_file_id);
    await prime(fileIds);
    for (const id of fileIds) await read(id);
    const children = await metadata.listFolder(plan.focus_file_id, { signal });
    if (!Array.isArray(children) || children.length > maxObjects) fail('OBJECT_LIMIT');
    const newIds = [], seen = new Set(), names = new Set();
    for (const child of children) {
      if (!object(child) || !idPattern.test(child.id) || !nameValid(child.name) || seen.has(child.id) || names.has(child.name)) fail('NAME_AMBIGUOUS');
      seen.add(child.id); names.add(child.name);
      if (!registry.has(child.id)) newIds.push(child.id);
      // A revoked item must never be re-adopted, even after a new name.
    }
    await prime(newIds);
    for (const id of newIds) await read(id, true);
    return { nodes: [...observed.values()].sort((a, b) => a.provider_file_id < b.provider_file_id ? -1 : 1),
      selected_ids: selected.map(row => row.provider_file_id).sort(),
      new_ids: [...observed.keys()].filter(id => !registry.has(id)).sort() };
  }
  return Object.freeze({ async observe(plan, { signal } = {}) {
    const pinned = structuredClone(plan), started = clock();
    if (!Number.isFinite(started)) fail('CLOCK_INVALID');
    const first = await once(pinned, signal), second = await once(pinned, signal), finished = clock();
    if (!Number.isFinite(finished) || finished < started || finished - started > 120000) fail('OBSERVATION_EXPIRED');
    if (!isDeepStrictEqual(first, second)) fail('CHANGED_DURING_SCAN');
    return { contract: 'clued.storage-external-registration-observation/1', observed_at: new Date(finished).toISOString(),
      first_observation: first, second_observation: second };
  } });
}
