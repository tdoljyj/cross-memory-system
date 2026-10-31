import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation, detectResourceCenterBoundaryViolations } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
// Folder IDs per batched call; the provider transport splits each call further.
const BATCH_IDS = 256;
const fail = code => { throw new Error(code); };
// Listings carry isAppAuthorized for the island rule (StorageNormalUse §3.1); a
// direct read may not. Identity/version comparisons ignore only that field.
// Identity of a listed or read folder: the fields a path projection depends
// on. Listings carry isAppAuthorized for the island rule (StorageNormalUse
// §3.1) and a direct read may not; a folder's Drive version moves whenever
// anything inside it changes, which is not a boundary change (Decision
// 24422a98: as in Drive, a version is not a sharing or identity signal).
const identityOf = file => {
  if (!file || typeof file !== "object") return file;
  const { isAppAuthorized: _, version: __, ...rest } = file;
  return rest;
};
const sameListed = (a, b) => isDeepStrictEqual(identityOf(a), identityOf(b));
const normalized = path =>bindResourceCenterMutation({ destination_path: path }).destination_path;
function identity(file, id) {
  if (!file || file.id !== id || !/^[A-Za-z0-9_-]{1,160}$/.test(id ?? "") || file.trashed !== false ||
      typeof file.name !== "string" || !file.name || /[/\\]/.test(file.name) || [".",".."].includes(file.name) ||
      file.name.trim() !== file.name || typeof file.mimeType !== "string" || !/^[1-9]\d*$/.test(file.version ?? "")) fail("DRIVE_BOUNDARY_IDENTITY_INVALID");
  return file;
}

/** Read-only, deterministic enumeration of trusted registered boundaries.
 * No full-Drive search, model, file content or shortcut following. Paths are
 * only projections of pinned IDs. This is detection at scan time, not a lock
 * against external Drive writers. Every listed entry, whoever created it, goes
 * through the structural checks (ambiguity, root impersonation). Each observed
 * entry carries the listing's isAppAuthorized value to the island rule only.
 * registered_sibling_roots (server-trusted Drive folder IDs of the same
 * owner's other active managed roots under the same parent, Decision
 * b18eff80) are skipped as a whole: a folder listed directly in the managed
 * root's parent with one of those exact IDs is another registered root, not
 * an island, and is not descended. A name match without the ID never counts.
 *
 * Everything this scan lists lies outside the managed root (the root itself is
 * never descended). As in Drive, where access is decided on the item and its
 * ancestors, unrelated content there never fails a write (Decision 24422a98):
 * - folders are visited level by level from the managed root's parent, so the
 *   parent and sibling namespace (where an island matters most) always comes
 *   first;
 * - a folder deeper than boundary_scan_max_depth, or reached after
 *   boundary_scan_max_entries entries, is still observed by its own name but
 *   not descended, and once the bound is passed no further level is listed;
 *   the result lists them in its non-enumerable `partial`;
 * - a shortcut is an ordinary observed entry and is never followed;
 * - a folder's Drive version is not compared, only its identity.
 */
export function createGoogleDriveBoundaryScanner({ trusted_profile: trustedProfile,
  root_folder_id: rootId, root_parent_id: parentId, scan_roots: scanRoots,
  registered_sibling_roots: siblingRootIds,
  get_file: getFile, list_folder: listFolder, get_files: getFiles, list_folders: listFolders,
} = {}) {
  const profile = structuredClone(trustedProfile), roots = structuredClone(scanRoots);
  const siblings = siblingRootIds === undefined ? [] : Array.isArray(siblingRootIds) ? [...siblingRootIds] : null;
  if (!siblings || siblings.length > 64 || new Set(siblings).size !== siblings.length ||
      siblings.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || id === rootId || id === parentId))
    fail("DRIVE_BOUNDARY_PROFILE_UNQUALIFIED");
  const siblingRoots = new Set(siblings);
  // Only a folder listed directly in the managed root's parent can be another
  // registered root; anywhere else the same ID is an ordinary entry.
  const isSiblingRoot = (folderId, file) => folderId === parentId && file.mimeType === FOLDER && siblingRoots.has(file.id);
  const managed = normalized(profile?.managed_root), parent = managed?.slice(0,managed.lastIndexOf("/"));
  const maxDepth = profile?.boundary_scan_max_depth ?? 8, maxEntries = profile?.boundary_scan_max_entries ?? 10000;
  if (profile?.registration_status !== "registered" || !managed || managed !== profile.managed_root || !parent ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(rootId ?? "") || !/^[A-Za-z0-9_-]{1,160}$/.test(parentId ?? "") ||
      typeof getFile !== "function" || typeof listFolder !== "function" ||
      !Number.isInteger(maxDepth) || maxDepth<1 || maxDepth>32 || !Number.isInteger(maxEntries) || maxEntries<1 || maxEntries>10000 ||
      (getFiles === undefined) !== (listFolders === undefined) ||
      (getFiles !== undefined && (typeof getFiles !== "function" || typeof listFolders !== "function")) ||
      !Array.isArray(roots) || !roots.length || (profile.registered_external_roots ?? []).length) fail("DRIVE_BOUNDARY_PROFILE_UNQUALIFIED");
  const paths = [...new Set([parent,...(profile.boundary_scan_roots ?? [])])].sort();
  if (!isDeepStrictEqual(roots.map(r=>r.path).sort(), paths) || !roots.some(r=>r.path===parent && r.folder_id===parentId) ||
      roots.some(r=>r.path!==normalized(r.path) || !/^[A-Za-z0-9_-]{1,160}$/.test(r.folder_id ?? "")) ||
      new Set(roots.map(r=>r.folder_id)).size!==roots.length) fail("DRIVE_BOUNDARY_PROFILE_UNQUALIFIED");
  // The single-item functions run through the same level-by-level scan, one
  // request per folder; batched functions cover many folders per request.
  const getMany = getFiles ?? (async ids => { const out = []; for (const id of ids) out.push(await getFile(id)); return out; });
  const listMany = listFolders ?? (async ids => { const out = []; for (const id of ids) out.push(await listFolder(id)); return out; });
  const chunked = async (fn, values) => {
    const result = [];
    for (let i = 0; i < values.length; i += BATCH_IDS) {
      const part = values.slice(i, i + BATCH_IDS), got = await fn(part);
      if (!Array.isArray(got) || got.length !== part.length) fail("DRIVE_BOUNDARY_ENUMERATION_INVALID");
      result.push(...got);
    }
    return result;
  };
  const readFiles = ids => chunked(getMany, ids);
  return async function scanBoundary() {
    const expectedRoot = identity((await readFiles([rootId]))[0],rootId);
    if (expectedRoot.mimeType!==FOLDER || expectedRoot.name!==managed.split("/").at(-1) ||
      !isDeepStrictEqual(expectedRoot.parents,[parentId])) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
    let count=0, sawRoot=false, level=[];
    const observed=[], visited=new Set(), folders=[], partial=[];
    const enqueue=(next,folderId,path,depth,expected)=>{
      if(visited.has(folderId)) fail("DRIVE_BOUNDARY_ALIAS_OR_CYCLE"); visited.add(folderId);
      next.push({folderId,path,depth,expected});
    };
    for(const root of roots) enqueue(level,root.folder_id,root.path,0);
    while(level.length){
      // Past the entry bound a whole queued level is left undescended, so an
      // unrelated large Drive never makes the scan (and so every write) slow.
      if(count>maxEntries){ for(const n of level) partial.push({path:n.path,reason:"entries"}); break; }
      const befores=await readFiles(level.map(n=>n.folderId));
      level.forEach((n,i)=>{
        const before=identity(befores[i],n.folderId);
        if(before.mimeType!==FOLDER) fail("DRIVE_BOUNDARY_FOLDER_INVALID");
        if(n.expected && !sameListed(before,n.expected)) fail("DRIVE_BOUNDARY_CHANGED");
        n.before=before;
      });
      const listings=await chunked(listMany,level.map(n=>n.folderId)), next=[];
      level.forEach(({folderId,path,depth,before},i)=>{
        const children=listings[i];
        if(!Array.isArray(children)) fail("DRIVE_BOUNDARY_ENUMERATION_INVALID");
        const names=new Set(), ids=new Set();
        for(const raw of children){
          count++;
          const file=identity(raw,raw?.id);
          if(!isDeepStrictEqual(file.parents,[folderId]) || ids.has(file.id) || names.has(file.name)) fail("DRIVE_BOUNDARY_PATH_AMBIGUOUS");
          ids.add(file.id);names.add(file.name);
          const childPath=path+"/"+file.name;
          if(normalized(childPath)!==childPath) fail("DRIVE_BOUNDARY_PATH_AMBIGUOUS");
          if(file.id===rootId){
            if(childPath!==managed || !sameListed(file,expectedRoot)) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
            sawRoot=true;continue;
          }
          // Same name/path with another ID must not impersonate the managed root.
          if(childPath===managed) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
          if(isSiblingRoot(folderId,file)) continue;
          observed.push({path:childPath,is_app_authorized:raw.isAppAuthorized});
          if(file.mimeType===FOLDER){
            if(depth>=maxDepth) partial.push({path:childPath,reason:"depth"});
            else if(count>maxEntries) partial.push({path:childPath,reason:"entries"});
            else enqueue(next,file.id,childPath,depth+1,file);
          }
        }
        folders.push({folderId,before});
      });
      level=next;
    }
    if(!sawRoot) fail("DRIVE_BOUNDARY_ROOT_NOT_LISTED");
    // Detect observed identity drift. Drive listing is not an atomic namespace
    // snapshot; provider qualification must retain that boundary.
    const after=await readFiles(folders.map(f=>f.folderId));
    folders.forEach(({before},i)=>{ if(!sameListed(after[i],before)) fail("DRIVE_BOUNDARY_CHANGED"); });
    if(!sameListed((await readFiles([rootId]))[0],expectedRoot)) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
    const findings=detectResourceCenterBoundaryViolations({profile,observed_entries:observed});
    Object.defineProperty(findings,"partial",{value:Object.freeze(partial.map(p=>Object.freeze(p))),enumerable:false});
    return findings;
  };
}
