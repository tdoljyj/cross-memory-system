import { isDeepStrictEqual } from "node:util";
import { bindResourceCenterMutation } from "../policy/resource-center-mutation-policy.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const normalized = path => bindResourceCenterMutation({destination_path:path}).destination_path;
const deny = code => { throw new Error(`DRIVE_QUALIFICATION_${code}`); };
function identity(file) {
  if (!file || !id(file.id) || typeof file.name !== "string" || !file.name ||
      file.name.trim() !== file.name || /[/\\]/.test(file.name) || [".",".."].includes(file.name) ||
      typeof file.mimeType !== "string" || file.trashed !== false ||
      !/^[1-9][0-9]{0,39}$/.test(file.version ?? "") || !Array.isArray(file.parents) ||
      file.parents.some(parent => !id(parent))) deny("IDENTITY_INVALID");
  return file;
}

/** Private composition primitive, NOT an authority or public API.
 * The server must derive this entire layout from a current Canonical snapshot,
 * authenticate Owner + fixed issuer, pin its credential and recheck all CAS and
 * revocation predicates after this read. This function issues no qualification,
 * grant, admission or receipt. Its editable output alone cannot enable a writer.
 * Exact-ID authorization is checked independently for every registered directory;
 * root permission is never treated as inherited drive.file application access.
 */
export function createGoogleDriveDirectoryProbe({trusted_layout: raw, get_file: getFile,
  list_folder: listFolder, clock = Date.now, timeout_ms: timeoutMs = 60000} = {}) {
  const layout = structuredClone(raw), directories = layout?.directories;
  const root = layout?.managed_root;
  if (layout?.contract !== "clued.storage-directory-layout/1" || typeof root !== "string" ||
      normalized(root) !== root || !root.includes("/") ||
      !id(layout.root_folder_id) || !id(layout.root_parent_id) || layout.root_folder_id === layout.root_parent_id ||
      !Array.isArray(layout.allowed_root_children) || !layout.allowed_root_children.length ||
      layout.allowed_root_children.length > 32 ||
      new Set(layout.allowed_root_children).size !== layout.allowed_root_children.length ||
      layout.allowed_root_children.some(name => typeof name !== "string" || !name || name.length > 160 ||
        name.trim() !== name || /[/\\]/.test(name) || [".","..","00_从这里开始"].includes(name)) ||
      !Array.isArray(directories) || !directories.length || directories.length > 1024 ||
      typeof getFile !== "function" || typeof listFolder !== "function" || typeof clock !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) deny("LAYOUT_INVALID");
  const byPath = new Map(), ids = new Set([layout.root_parent_id]);
  for (const entry of directories) {
    if (!entry || Object.keys(entry).sort().join(",") !== "path,provider_file_id" ||
        typeof entry.path !== "string" || normalized(entry.path) !== entry.path || !id(entry.provider_file_id) ||
        byPath.has(entry.path) || ids.has(entry.provider_file_id)) deny("LAYOUT_INVALID");
    if (entry.path !== root && (!entry.path.startsWith(root + "/") ||
        !layout.allowed_root_children.includes(entry.path.slice(root.length + 1).split("/")[0]))) deny("LAYOUT_INVALID");
    if (entry.path.split("/").length - root.split("/").length > 32) deny("LAYOUT_INVALID");
    byPath.set(entry.path, entry); ids.add(entry.provider_file_id);
  }
  if (byPath.get(root)?.provider_file_id !== layout.root_folder_id ||
      layout.allowed_root_children.some(name => !byPath.has(root + "/" + name))) deny("LAYOUT_INVALID");
  const ordered = [...byPath.values()].sort((a,b) => a.path.length-b.path.length || a.path.localeCompare(b.path));
  for (const entry of ordered) {
    if (entry.path !== root && !byPath.has(entry.path.slice(0,entry.path.lastIndexOf("/")))) deny("LAYOUT_INVALID");
  }
  return async function probe() {
    const started = clock();
    if (!Number.isFinite(started)) deny("CLOCK_INVALID");
    const controller = new AbortController();
    const expired = new Error("DRIVE_QUALIFICATION_OBSERVATION_EXPIRED");
    const timer = setTimeout(() => controller.abort(expired), timeoutMs);
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = () => reject(expired); });
    controller.signal.addEventListener("abort", rejectAborted, {once:true});
    const checkTime = () => {
      const now = clock();
      controller.signal.throwIfAborted();
      if (!Number.isFinite(now) || now < started || now-started >= timeoutMs) deny("OBSERVATION_EXPIRED");
      return now;
    };
    const read = async (operation, argument) => {
      checkTime();
      // Host metadata callbacks must propagate this signal to every GET/page.
      // The race also bounds a stuck callback; it is not a substitute for abort.
      const value = await Promise.race([operation(argument, {signal:controller.signal}), aborted]);
      checkTime();
      return structuredClone(value);
    };
    try {
    const before = new Map(), observed = [];
    const parent = identity(await read(getFile,layout.root_parent_id));
    if (parent.id !== layout.root_parent_id || parent.mimeType !== FOLDER) deny("PARENT_INVALID");
    before.set(parent.id, parent);
    for (const entry of ordered) {
      const file = identity(await read(getFile,entry.provider_file_id));
      const parentId = entry.path === root ? layout.root_parent_id : byPath.get(entry.path.slice(0,entry.path.lastIndexOf("/"))).provider_file_id;
      if (file.id !== entry.provider_file_id || file.name !== entry.path.split("/").at(-1) ||
          file.mimeType !== FOLDER || !isDeepStrictEqual(file.parents,[parentId])) deny("DIRECTORY_CHANGED");
      if (file.isAppAuthorized !== true) deny("DIRECTORY_NOT_APP_AUTHORIZED");
      if (file.capabilities?.canAddChildren !== true) deny("DIRECTORY_NOT_WRITABLE");
      before.set(file.id,file);
      observed.push({path:entry.path,provider_file_id:file.id,provider_file_version:file.version,parent_id:parentId});
    }
    let count = 0;
    for (const [folderId] of before) {
      const children = await read(listFolder,folderId);
      if (!Array.isArray(children)) deny("ENUMERATION_INVALID");
      const names = new Set(), listedIds = new Set();
      for (const value of children) {
        if (++count > 10000) deny("ENTRY_LIMIT");
        const file = identity(value);
        if (!isDeepStrictEqual(file.parents,[folderId]) || names.has(file.name) || listedIds.has(file.id)) deny("PATH_AMBIGUOUS");
        names.add(file.name); listedIds.add(file.id);
        if (file.mimeType === SHORTCUT) deny("SHORTCUT_UNQUALIFIED");
        if (before.has(file.id) && !isDeepStrictEqual(before.get(file.id),file)) deny("DIRECTORY_CHANGED");
      }
      for (const file of observed) if (file.parent_id === folderId && !listedIds.has(file.provider_file_id)) deny("DIRECTORY_NOT_LISTED");
    }
    // Detect observed metadata drift, not an atomic provider namespace snapshot.
    for (const [fileId,file] of before) if (!isDeepStrictEqual(await read(getFile,fileId),file)) deny("DIRECTORY_CHANGED");
    const finished = checkTime();
    return {contract:"clued.storage-directory-observation/1",status:"metadata_observed",
      execution_permitted:false,observed_at_ms:finished,directories:observed};
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort",rejectAborted);
      controller.abort(expired);
    }
  };
}
