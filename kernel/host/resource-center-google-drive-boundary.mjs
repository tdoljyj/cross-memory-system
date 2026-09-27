import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation, detectResourceCenterBoundaryViolations } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const fail = code => { throw new Error(code); };
const normalized = path => bindResourceCenterMutation({ destination_path: path }).destination_path;
function identity(file, id) {
  if (!file || file.id !== id || !/^[A-Za-z0-9_-]{1,160}$/.test(id ?? "") || file.trashed !== false ||
      typeof file.name !== "string" || !file.name || /[/\\]/.test(file.name) || [".",".."].includes(file.name) ||
      file.name.trim() !== file.name || typeof file.mimeType !== "string" || !/^[1-9]\d*$/.test(file.version ?? "")) fail("DRIVE_BOUNDARY_IDENTITY_INVALID");
  return file;
}

/** Read-only, deterministic enumeration of trusted registered boundaries.
 * No full-Drive search, model, file content, shortcut following or guessed
 * clean result on partial scans. Paths are only projections of pinned IDs.
 * This is detection at scan time, not a lock against external Drive writers.
 */
export function createGoogleDriveBoundaryScanner({ trusted_profile: trustedProfile,
  root_folder_id: rootId, root_parent_id: parentId, scan_roots: scanRoots,
  get_file: getFile, list_folder: listFolder,
} = {}) {
  const profile = structuredClone(trustedProfile), roots = structuredClone(scanRoots);
  const managed = normalized(profile?.managed_root), parent = managed?.slice(0,managed.lastIndexOf("/"));
  const maxDepth = profile?.boundary_scan_max_depth ?? 8, maxEntries = profile?.boundary_scan_max_entries ?? 10000;
  if (profile?.registration_status !== "registered" || !managed || managed !== profile.managed_root || !parent ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(rootId ?? "") || !/^[A-Za-z0-9_-]{1,160}$/.test(parentId ?? "") ||
      typeof getFile !== "function" || typeof listFolder !== "function" ||
      !Number.isInteger(maxDepth) || maxDepth<1 || maxDepth>32 || !Number.isInteger(maxEntries) || maxEntries<1 || maxEntries>10000 ||
      !Array.isArray(roots) || !roots.length || (profile.registered_external_roots ?? []).length) fail("DRIVE_BOUNDARY_PROFILE_UNQUALIFIED");
  const paths = [...new Set([parent,...(profile.boundary_scan_roots ?? [])])].sort();
  if (!isDeepStrictEqual(roots.map(r=>r.path).sort(), paths) || !roots.some(r=>r.path===parent && r.folder_id===parentId) ||
      roots.some(r=>r.path!==normalized(r.path) || !/^[A-Za-z0-9_-]{1,160}$/.test(r.folder_id ?? "")) ||
      new Set(roots.map(r=>r.folder_id)).size!==roots.length) fail("DRIVE_BOUNDARY_PROFILE_UNQUALIFIED");
  return async function scanBoundary() {
    const expectedRoot = identity(await getFile(rootId),rootId);
    if (expectedRoot.mimeType!==FOLDER || expectedRoot.name!==managed.split("/").at(-1) ||
      !isDeepStrictEqual(expectedRoot.parents,[parentId])) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
    let count=0, sawRoot=false;
    const observed=[], visited=new Set(), folders=[];
    async function walk(folderId,path,depth,expected) {
      if(visited.has(folderId)) fail("DRIVE_BOUNDARY_ALIAS_OR_CYCLE"); visited.add(folderId);
      const before=identity(await getFile(folderId),folderId);
      if(before.mimeType!==FOLDER) fail("DRIVE_BOUNDARY_FOLDER_INVALID");
      if(expected && !isDeepStrictEqual(before,expected)) fail("DRIVE_BOUNDARY_CHANGED");
      const children=await listFolder(folderId);
      if(!Array.isArray(children)) fail("DRIVE_BOUNDARY_ENUMERATION_INVALID");
      const names=new Set(), ids=new Set();
      for(const raw of children){
        if(++count>maxEntries) fail("DRIVE_BOUNDARY_ENTRY_LIMIT");
        const file=identity(raw,raw?.id);
        if(!isDeepStrictEqual(file.parents,[folderId]) || ids.has(file.id) || names.has(file.name)) fail("DRIVE_BOUNDARY_PATH_AMBIGUOUS");
        ids.add(file.id);names.add(file.name);
        const childPath=path+"/"+file.name;
        if(normalized(childPath)!==childPath) fail("DRIVE_BOUNDARY_PATH_AMBIGUOUS");
        if(file.id===rootId){
          if(childPath!==managed || !isDeepStrictEqual(file,expectedRoot)) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
          sawRoot=true;continue;
        }
        // Same name/path with another ID must not impersonate the managed root.
        if(childPath===managed) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
        observed.push({path:childPath});
        if(file.mimeType===SHORTCUT) fail("DRIVE_BOUNDARY_SHORTCUT_UNQUALIFIED");
        if(file.mimeType===FOLDER){
          if(depth>=maxDepth) fail("DRIVE_BOUNDARY_DEPTH_LIMIT");
          await walk(file.id,childPath,depth+1,file);
        }
      }
      folders.push({folderId,before});
    }
    for(const root of roots) await walk(root.folder_id,root.path,0);
    if(!sawRoot) fail("DRIVE_BOUNDARY_ROOT_NOT_LISTED");
    // Detect observed identity/version drift. Drive listing is not an atomic
    // namespace snapshot; provider qualification must retain that boundary.
    for(const {folderId,before} of folders) if(!isDeepStrictEqual(await getFile(folderId),before)) fail("DRIVE_BOUNDARY_CHANGED");
    if(!isDeepStrictEqual(await getFile(rootId),expectedRoot)) fail("DRIVE_BOUNDARY_ROOT_CHANGED");
    return detectResourceCenterBoundaryViolations({profile,observed_entries:observed});
  };
}
