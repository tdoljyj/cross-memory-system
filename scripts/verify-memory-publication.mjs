import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const POINTER_PATH = "artifacts/clued-two-level-snapshots/current.json";
const MANIFEST_PATH = "memory/manifest.json";

function fail(code) {
  throw new Error(code);
}

function git(repo, args, encoding = "utf8") {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail("MEMORY_PUBLICATION_GIT_ERROR");
  return result.stdout;
}

function show(repo, revision, file) {
  return git(repo, ["show", `${revision}:${file}`], null);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const repo = values.get("--repo");
  const base = values.get("--base");
  const candidate = values.get("--candidate");
  if (!repo || !SHA.test(base ?? "") || !SHA.test(candidate ?? "")) fail("MEMORY_PUBLICATION_ARGUMENT_INVALID");
  return { base, candidate, repo };
}

function treeMap(repo, revision, prefix) {
  const output = git(repo, ["ls-tree", "-r", "-z", revision, "--", prefix], null);
  const entries = new Map();
  for (const record of output.toString("binary").split("\0").filter(Boolean)) {
    const bytes = Buffer.from(record, "binary");
    const tab = bytes.indexOf(9);
    const header = bytes.subarray(0, tab).toString("ascii").split(" ");
    const file = bytes.subarray(tab + 1).toString("utf8");
    if (header[1] !== "blob") fail("MEMORY_PUBLICATION_NON_BLOB");
    entries.set(file.slice(prefix.length + 1), header[2]);
  }
  return entries;
}

export function requireAtomicPublication(changedFiles, basePointer, candidatePointer) {
  const memoryChanged = changedFiles.some((file) => file === "memory" || file.startsWith("memory/"));
  if (!memoryChanged) return "NOT_APPLICABLE";
  if (!changedFiles.includes(MANIFEST_PATH) || !changedFiles.includes(POINTER_PATH)) {
    fail("DIRECT_MEMORY_EDIT_WITHOUT_POINTER_AND_MANIFEST");
  }
  if (candidatePointer.previous_snapshot_version !== basePointer.snapshot_version) {
    fail("SNAPSHOT_PREDECESSOR_MISMATCH");
  }
  if (candidatePointer.snapshot_version === basePointer.snapshot_version) {
    fail("SNAPSHOT_VERSION_NOT_ADVANCED");
  }
  const root = `artifacts/clued-two-level-snapshots/${candidatePointer.bundle_path}`;
  if (!changedFiles.some((file) => file.startsWith(`${root}/`))) fail("PUBLISHED_BUNDLE_NOT_CHANGED");
  return root;
}

function main() {
  const { base, candidate, repo } = parseArgs(process.argv.slice(2));
  const changed = git(repo, ["diff", "--name-only", "-z", base, candidate], null)
    .toString("utf8").split("\0").filter(Boolean);
  const basePointer = JSON.parse(show(repo, base, POINTER_PATH).toString("utf8"));
  const candidatePointerBytes = show(repo, candidate, POINTER_PATH);
  const candidatePointer = JSON.parse(candidatePointerBytes.toString("utf8"));
  if (!/^published\/snap_[0-9a-f]+\/memory$/.test(candidatePointer.bundle_path)) {
    fail("SNAPSHOT_BUNDLE_PATH_INVALID");
  }
  const bundleRoot = requireAtomicPublication(changed, basePointer, candidatePointer);
  if (bundleRoot === "NOT_APPLICABLE") {
    console.log(JSON.stringify({ result: "PASS", status: "NOT_APPLICABLE" }));
    return;
  }
  const manifestBytes = show(repo, candidate, MANIFEST_PATH);
  const manifestHash = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  if (candidatePointer.manifest_sha256 !== manifestHash) fail("SNAPSHOT_MANIFEST_DIGEST_MISMATCH");
  const memory = treeMap(repo, candidate, "memory");
  const published = treeMap(repo, candidate, bundleRoot);
  if (JSON.stringify([...memory]) !== JSON.stringify([...published])) fail("SNAPSHOT_BUNDLE_BYTE_MISMATCH");
  console.log(JSON.stringify({
    bundle_root: bundleRoot,
    candidate,
    changed_file_count: changed.length,
    manifest_sha256: manifestHash,
    result: "PASS",
    status: "ATOMIC_SNAPSHOT_PUBLICATION",
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MEMORY_PUBLICATION_UNKNOWN_ERROR");
    process.exitCode = 1;
  }
}
