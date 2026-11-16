// The one-time switch of a runner host to the loader: idempotent, keeps .prev, checks itself, puts .prev back on a failed check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { HOOK_DIRS, install } from "./install-hook-loader.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LOADER = path.join(HERE, "clued-runner-hook-loader.mjs");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const OLD_HOOK = "// the hook as installed before the loader\nexport const HOOK_VERSION = \"old\";\n";

function host() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-hook-host-"));
  fs.writeFileSync(path.join(dir, "clued-runner-job-started.mjs"), OLD_HOOK);
  fs.writeFileSync(path.join(dir, "clued-runner-job-started.sh"), "#!/bin/sh\n# wrapper, untouched\n");
  return dir;
}
const read = (dir, name = "clued-runner-job-started.mjs") => fs.readFileSync(path.join(dir, name), "utf8");

test("install: keeps .prev, puts the loader in place, checks itself; running it again does nothing", () => {
  const dir = host();
  try {
    const expected = sha256(fs.readFileSync(LOADER));
    assert.deepEqual(install({ dir, loaderFile: LOADER, expected }), { status: "INSTALLED", sha256: expected, prevSha256: sha256(OLD_HOOK) });
    assert.equal(read(dir), fs.readFileSync(LOADER, "utf8"));
    assert.equal(read(dir, "clued-runner-job-started.mjs.prev"), OLD_HOOK);
    assert.equal(read(dir, "clued-runner-job-started.sh"), "#!/bin/sh\n# wrapper, untouched\n");
    assert.deepEqual(install({ dir, loaderFile: LOADER, expected }), { status: "ALREADY", sha256: expected });
    assert.equal(read(dir, "clued-runner-job-started.mjs.prev"), OLD_HOOK, ".prev is still the hook before the loader");
    // Rollback (no restart): .prev is back.
    assert.equal(install({ dir, rollback: true }).status, "ROLLED_BACK");
    assert.equal(read(dir), OLD_HOOK);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install: other bytes than expected, or no hook on this host, touch nothing", () => {
  const dir = host();
  try {
    assert.equal(install({ dir, loaderFile: LOADER, expected: "0".repeat(64) }).status, "REFUSED");
    assert.equal(install({ dir, loaderFile: LOADER, expected: "not-a-sha" }).status, "REFUSED");
    assert.equal(read(dir), OLD_HOOK);
    assert.equal(fs.existsSync(path.join(dir, "clued-runner-job-started.mjs.prev")), false);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clued-hook-empty-"));
    assert.equal(install({ dir: empty, loaderFile: LOADER, expected: sha256(fs.readFileSync(LOADER)) }).status, "REFUSED");
    assert.deepEqual(fs.readdirSync(empty), []);
    fs.rmSync(empty, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install: a file that does not import as the loader fails the self-check and the earlier hook is put back", () => {
  const dir = host();
  try {
    const bad = path.join(dir, "bad-loader.mjs");
    fs.writeFileSync(bad, "export const LOADER_VERSION = \"1.0.0\";\nthis is not javascript\n");
    const outcome = install({ dir, loaderFile: bad, expected: sha256(fs.readFileSync(bad)) });
    assert.equal(outcome.status, "ROLLED_BACK");
    assert.match(outcome.why, /does not import as the loader/);
    assert.equal(read(dir), OLD_HOOK);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("command: one JSON line, also written to --result for an elevated run; the folder comes from the platform", () => {
  assert.deepEqual(HOOK_DIRS, { linux: "/opt/clued-runner-hook", win32: "C:\\ProgramData\\CluedRunnerHook" });
  const dir = host();
  try {
    const result = path.join(dir, "result.json");
    const expected = sha256(fs.readFileSync(LOADER));
    const child = spawnSync(process.execPath, [path.join(HERE, "install-hook-loader.mjs"), "--dir", dir, "--loader", LOADER, "--sha256", expected,
      "--result", result], { encoding: "utf8", timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, "INSTALLED");
    assert.equal(JSON.parse(fs.readFileSync(result, "utf8")).status, "INSTALLED");
    const again = spawnSync(process.execPath, [path.join(HERE, "install-hook-loader.mjs"), "--dir", dir, "--loader", LOADER, "--sha256", "0".repeat(64)],
      { encoding: "utf8", timeout: 60_000 });
    assert.equal(again.status, 1);
    assert.equal(JSON.parse(again.stdout).status, "REFUSED");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
