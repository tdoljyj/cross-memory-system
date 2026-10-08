// Storage step 3 (StorageFineGrainedConcurrency §4.2): the postconditions of a
// create, rename/file move, replace, trash and untrash whose provider identity
// names its ancestors walk the chain from the root to the folder by the
// registered Drive IDs instead of by name. Each folder must still carry its
// name, sit under the expected parent alone and not be trashed. A create pins
// the Drive version of the folders matched by version, as before; no folder
// matched by a digest has its version pinned. A sibling
// change inside a folder therefore never fails the verification, while a
// renamed, moved or trashed ancestor does.

const FOLDER = "application/vnd.google-apps.folder";
const fail = (code) => { throw new Error(code); };

/** The ancestors of provider_before from the root to folderPath, in order, or
 * null for a legacy identity (no ancestors). A missing or inconsistent link
 * fails with DRIVE_POSTCONDITION_REQUEST_MISMATCH. */
export function ancestorChain(before, { root, root_folder_id: rootId, root_parent_id: rootParentId }, folderPath) {
  if (!Array.isArray(before?.ancestors)) return null;
  if (folderPath !== root && !folderPath?.startsWith(`${root}/`)) fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
  const byPath = new Map(before.ancestors.map(entry => [entry?.path, entry]));
  const parts = folderPath === root ? [] : folderPath.slice(root.length + 1).split("/");
  const chain = [];
  for (let index = 0; index <= parts.length; index++) {
    const path = index === 0 ? root : `${root}/${parts.slice(0, index).join("/")}`;
    const entry = byPath.get(path);
    const parent = index === 0 ? rootParentId : chain[index - 1].id;
    if (!entry || typeof entry.id !== "string" || !entry.id || entry.parent_id !== parent || (index === 0 && entry.id !== rootId) ||
      !["access", "sharing", "version"].includes(entry.match) ||
      (entry.match === "version" && (typeof entry.value !== "string" || !/^\d+$/.test(entry.value)))) {
      fail("DRIVE_POSTCONDITION_REQUEST_MISMATCH");
    }
    chain.push(Object.freeze({ id: entry.id, parent_id: parent, name: index === 0 ? root.slice(root.lastIndexOf("/") + 1) : parts[index - 1],
      version: entry.match === "version" ? entry.value : null }));
  }
  return Object.freeze(chain);
}

/** Reads every folder of the chain by its Drive ID; returns the last one.
 * pin_versions (create only) also requires each version-matched folder to be
 * at the version the identity saw. */
export async function walkAncestorChain(chain, getFile, { pin_versions: pinVersions = false } = {}) {
  let node = null;
  for (const link of chain) {
    node = await getFile(link.id);
    if (!node || node.id !== link.id || node.name !== link.name || node.trashed !== false || node.mimeType !== FOLDER ||
      !Array.isArray(node.parents) || node.parents.length !== 1 || node.parents[0] !== link.parent_id ||
      typeof node.version !== "string" || !/^[1-9]\d*$/.test(node.version) ||
      (pinVersions && link.version !== null && node.version !== link.version)) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
  }
  return node;
}
