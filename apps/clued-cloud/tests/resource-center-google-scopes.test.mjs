import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import * as kernel from "../../../kernel/host/resource-center-google-scopes.mjs";

// StorageNormalUse.v0.1 §2.2: one scope module per runtime, equal exports,
// exact-set profiles, and no scope URL literal anywhere else.
const output = path.join(await mkdtemp(path.join(os.tmpdir(), "clued-google-scopes-")), "scopes.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-google-scopes.ts", import.meta.url))], outfile: output,
  bundle: true, platform: "node", format: "esm" });
const worker = await import(pathToFileURL(output));

const FILE = "https://www.googleapis.com/auth/drive.file";
const META_RO = "https://www.googleapis.com/auth/drive.metadata.readonly";
const RO = "https://www.googleapis.com/auth/drive.readonly";
const META = "https://www.googleapis.com/auth/drive.metadata";
const DRIVE = "https://www.googleapis.com/auth/drive";

test("Worker and kernel scope modules export the same values item by item", () => {
  assert.deepEqual(Object.keys(worker).sort(), Object.keys(kernel).sort());
  for (const [name, value] of Object.entries(kernel)) {
    if (typeof value === "function") continue;
    assert.deepEqual(worker[name], value, name);
  }
  assert.deepEqual([...kernel.STORAGE_GOOGLE_SCOPE_SETS.legacy], [FILE, META_RO]);
  assert.deepEqual([...kernel.STORAGE_GOOGLE_SCOPE_SETS.normal], [FILE, META_RO, RO]);
  assert.deepEqual([...kernel.STORAGE_SCOPE_PROFILES], ["legacy", "normal"]);
  for (const module of [worker, kernel]) {
    assert.equal(module.scopeString("legacy"), `${FILE} ${META_RO}`);
    assert.equal(module.scopeString("normal"), `${FILE} ${META_RO} ${RO}`);
    assert.throws(() => module.scopeString("full"), TypeError);
    assert.ok(Object.isFrozen(module.STORAGE_GOOGLE_SCOPE_SETS) && Object.isFrozen(module.STORAGE_GOOGLE_SCOPE_SETS.normal));
  }
});

test("scopeProfile matrix: exact sets only, after dedupe and sort", () => {
  const cases = [
    [`${FILE} ${META_RO}`, "legacy"],
    [`${META_RO} ${FILE}`, "legacy"],
    [`${META_RO} ${FILE} ${FILE}  ${META_RO}`, "legacy"],
    [` ${FILE}\t${META_RO}\n`, "legacy"],
    [`${FILE} ${META_RO} ${RO}`, "normal"],
    [`${RO} ${FILE} ${META_RO} ${RO}`, "normal"],
    // partial
    [FILE, null], [META_RO, null], [RO, null], [`${FILE} ${RO}`, null], [`${META_RO} ${RO}`, null],
    // containing drive or drive.metadata
    [`${FILE} ${META_RO} ${DRIVE}`, null], [`${FILE} ${META_RO} ${RO} ${DRIVE}`, null], [DRIVE, null],
    [`${FILE} ${META_RO} ${META}`, null], [`${FILE} ${META} ${RO}`, null],
    // unknown
    [`${FILE} ${META_RO} openid`, null], [`${FILE} ${META_RO}.evil`, null], [`${FILE} ${META_RO} ${RO}x`, null],
    ["drive.file drive.metadata.readonly", null],
    // not a scope string
    ["", null], ["   ", null], [undefined, null], [null, null], [[FILE, META_RO], null], [42, null],
    [`${FILE} ${META_RO} ` + "x".repeat(5000), null],
  ];
  for (const module of [worker, kernel]) {
    for (const [value, profile] of cases) assert.equal(module.scopeProfile(value), profile, JSON.stringify(value));
    assert.deepEqual(module.normalizeScopes(`${META_RO} ${FILE} ${FILE}`), [FILE, META_RO]);
    assert.equal(module.isStorageScopeProfile("normal"), true);
    assert.equal(module.isStorageScopeProfile("full"), false);
  }
});

test("namespace visibility scopes are shared, and none of drive or drive.metadata alone is a profile", () => {
  assert.deepEqual([...kernel.NAMESPACE_READ_SCOPES], [DRIVE, META, META_RO, RO]);
  for (const scope of kernel.NAMESPACE_READ_SCOPES) assert.equal(kernel.scopeProfile(scope), null);
});

test("CI drift: scope URL literals appear only in the scope modules, the pilot credential, tests and prose", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const allowed = new Set(["apps/clued-cloud/worker/storage-google-scopes.ts", "kernel/host/resource-center-google-scopes.mjs",
    // Local pilot Host credential (StorageNormalUse §2.2 item 5 "本机试点凭据文件").
    "kernel/host/resource-center-google-drive-credential.mjs"]);
  const permitted = file => allowed.has(file) || file.startsWith("apps/clued-cloud/tests/") ||
    (/^(development|docs)\//.test(file) && file.endsWith(".md"));
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter(file => file && /\.(?:[cm]?[jt]sx?|json|sql|py|ps1|sh|toml|ya?ml|html)$/.test(file));
  assert.ok(files.includes("apps/clued-cloud/worker/storage-google-oauth.ts"), "the scan sees Worker sources");
  const offenders = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(path.join(root, file), "utf8"); } catch { continue; }
    if (text.includes("googleapis.com/auth/") && !permitted(file)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
