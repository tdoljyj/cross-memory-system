import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";

// StorageNormalUse.v0.1 §3.1: an in-memory Drive seen through the real write-path
// metadata API. A `normal` credential (drive.readonly) lists every file, so the
// fake returns the Owner's own entries too, marked isAppAuthorized: false; Clued's
// entries (in `files`, no flag) are app-authorized. Like Drive, the field is
// returned only when `fields` names it. A `legacy` listing omits Owner entries.
export const LEGACY_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
export const NORMAL_SCOPE = LEGACY_SCOPE + " https://www.googleapis.com/auth/drive.readonly";

export function normalScopeDrive(files, ownerEntries = [], { scope = NORMAL_SCOPE } = {}) {
  const normal = scope === NORMAL_SCOPE;
  const all = () => [...files.values(), ...(normal ? ownerEntries.map((entry) => ({ ...entry, isAppAuthorized: false })) : [])];
  const project = (u, entry) => {
    const { isAppAuthorized = true, ...rest } = structuredClone(entry);
    return (u.searchParams.get("fields") ?? "").includes("isAppAuthorized") ? { ...rest, isAppAuthorized } : rest;
  };
  const fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") !== "GET") throw new Error("metadata fixture is read-only");
    const u = new URL(url), q = u.searchParams.get("q");
    if (q) {
      const parent = /'([^']+)' in parents/.exec(q)?.[1], name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
      return Response.json({ files: all().filter((f) => f.parents.includes(parent) && (name === undefined || f.name === name))
        .map((f) => project(u, f)), incompleteSearch: false });
    }
    const found = all().find((f) => f.id === decodeURIComponent(u.pathname.split("/").at(-1)));
    return found ? Response.json(project(u, found)) : new Response("", { status: 404 });
  };
  return createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "synthetic-normal-token", scope }), fetch });
}
