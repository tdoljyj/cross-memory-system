import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configureTemporaryStorage } from "../../../.github/actions/ci-temporary-storage/setup.mjs";
import { checkApplicationWorkflows, temporaryStorageFindings } from "../../../.github/actions/ci-temporary-storage/check-workflows.mjs";

const cli = fileURLToPath(new URL("../../../.github/actions/ci-temporary-storage/setup.mjs", import.meta.url));

function fixture(run) {
  const base = mkdtempSync(path.join(os.tmpdir(), "ci-temp-storage-test-"));
  const root = path.join(base, "job-temp");
  const envFile = path.join(base, "github-env");
  mkdirSync(root);
  writeFileSync(envFile, "EXISTING=preserved\n");
  try { return run({ base, root, envFile }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test("sets all temporary variables, preserves existing environment and leaves no probe", () => fixture(({ root, envFile }) => {
  const values = configureTemporaryStorage({ RUNNER_TEMP: root, GITHUB_ENV: envFile });
  assert.deepEqual(values, { TMPDIR: root, TMP: root, TEMP: root });
  assert.equal(readFileSync(envFile, "utf8"), `EXISTING=preserved\nTMPDIR=${root}\nTMP=${root}\nTEMP=${root}\n`);
  assert.deepEqual(readdirSync(root), []);
}));

test("native dependency extraction and subprocesses inherit the job temporary root", () => fixture(({ root, envFile }) => {
  const values = configureTemporaryStorage({ RUNNER_TEMP: root, GITHUB_ENV: envFile });
  const childEnv = { ...process.env, ...values };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const p=fs.mkdtempSync(path.join(os.tmpdir(),'onnxruntime-node-pkgs_'));fs.writeFileSync(path.join(p,'native-unpack'),Buffer.alloc(1048576));process.stdout.write(p);"], { env: childEnv, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(path.dirname(child.stdout), root);
  assert.ok(existsSync(path.join(child.stdout, "native-unpack")));
}));

test("promptfoo state is optional and belongs to the same job", () => fixture(({ root, envFile }) => {
  const values = configureTemporaryStorage({ RUNNER_TEMP: root, GITHUB_ENV: envFile, CI_TEMP_ISOLATE_PROMPTFOO: "true" });
  assert.equal(values.PROMPTFOO_CONFIG_DIR, path.join(root, "clued-promptfoo"));
  assert.throws(() => configureTemporaryStorage({ RUNNER_TEMP: root, GITHUB_ENV: envFile, CI_TEMP_ISOLATE_PROMPTFOO: "maybe" }), /true or false/);
}));

test("missing, relative, injected, shared-root and nonexistent paths fail without environment writes", () => fixture(({ root, envFile, base }) => {
  for (const candidate of [undefined, "relative-temp", root + "\nBAD=value", path.parse(root).root, os.homedir(), path.join(base, "missing")]) {
    assert.throws(() => configureTemporaryStorage({ RUNNER_TEMP: candidate, GITHUB_ENV: envFile }));
    assert.equal(readFileSync(envFile, "utf8"), "EXISTING=preserved\n");
  }
  assert.throws(() => configureTemporaryStorage({ RUNNER_TEMP: root, GITHUB_ENV: "relative-env" }));
}));

test("directory symlinks are rejected without touching their destination", () => fixture(({ root, envFile, base }) => {
  const alias = path.join(base, "alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => configureTemporaryStorage({ RUNNER_TEMP: alias, GITHUB_ENV: envFile }), /symlink/);
  assert.deepEqual(readdirSync(root), []);
}));

test("CLI failure does not silently fall back to the operating-system temporary directory", () => fixture(({ envFile }) => {
  const child = spawnSync(process.execPath, [cli], { env: { ...process.env, RUNNER_TEMP: "relative", GITHUB_ENV: envFile }, encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /refused/);
  assert.equal(readFileSync(envFile, "utf8"), "EXISTING=preserved\n");
}));

test("coverage rejects absent, late or partial setup and shared promptfoo state", () => {
  const install = { run: "npm ci" };
  const setup = { uses: "./.github/actions/ci-temporary-storage" };
  const job = (steps, env) => ({ jobs: { app: { steps, env } } });
  assert.equal(temporaryStorageFindings(job([setup, install]), "clued-g4-database.yml").length, 0);
  assert.equal(temporaryStorageFindings(job([install, setup]), "clued-g4-database.yml").length, 1);
  assert.equal(temporaryStorageFindings(job([{ ...setup, if: "false" }, install]), "clued-g4-database.yml").length, 1);
  assert.equal(temporaryStorageFindings(job([{ ...setup, if: false }, install]), "clued-g4-database.yml").length, 1);
  assert.equal(temporaryStorageFindings(job([{ ...setup, if: "github.event_name == 'push'" }, { ...install, if: "github.event_name == 'push'" }]), "clued-g4-database.yml").length, 0);
  assert.equal(temporaryStorageFindings(job([{ ...setup, if: "github.event_name == 'push'" }, { ...install, if: "github.event_name == 'push'" }, install]), "clued-g4-database.yml").length, 1);
  assert.equal(temporaryStorageFindings(job([{ run: "npx --yes some-package" }]), "clued-g4-database.yml").length, 1);
  assert.equal(temporaryStorageFindings(job([setup, { ...install, env: { TMPDIR: "/tmp" } }]), "clued-g4-database.yml").length, 1);
  assert.equal(temporaryStorageFindings(job([{ run: "echo TMPDIR=$RUNNER_TEMP >> $GITHUB_ENV" }, install]), "clued-g4-database.yml").length, 1);
  assert.ok(temporaryStorageFindings(job([setup, install], { PROMPTFOO_CONFIG_DIR: "/tmp/promptfoo" }), "public-mcp-behavior.yml").length > 0);
  assert.equal(temporaryStorageFindings(job([{ ...setup, with: { "isolate-promptfoo": "true" } }, install]), "public-mcp-behavior.yml").length, 0);
});

test("the real eight application workflows configure temporary storage before every consumer", () => {
  const workflows = fileURLToPath(new URL("../../../.github/workflows", import.meta.url));
  assert.deepEqual(checkApplicationWorkflows(workflows), []);
});
