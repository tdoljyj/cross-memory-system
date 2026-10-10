import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configureTemporaryStorage } from "../../../.github/actions/ci-temporary-storage/setup.mjs";
import { checkApplicationWorkflows, checkRepositoryWorkflows, checkoutSources, PLATFORM_TEMP_ENVIRONMENT, repositoryTemporaryStorageFindings, sourceFingerprint, stepFingerprint, temporaryStorageFindings } from "../../../.github/actions/ci-temporary-storage/check-workflows.mjs";
import { createRequire } from "node:module";

const cli = fileURLToPath(new URL("../../../.github/actions/ci-temporary-storage/setup.mjs", import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = require("yaml");

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
  assert.deepEqual(values, {
    TMPDIR: root, TMP: root, TEMP: root,
    PYTHONPYCACHEPREFIX: path.join(root, "clued-pycache"),
    WRANGLER_LOG_PATH: path.join(root, "clued-wrangler-logs"),
  });
  assert.equal(readFileSync(envFile, "utf8"), "EXISTING=preserved\n" + Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
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

test("Python-only bootstrap implements the same environment contract without installing Node", () => fixture(({ base, root, envFile }) => {
  const python = process.platform === "win32" ? "python" : "python3";
  const script = fileURLToPath(new URL("../../../.github/actions/ci-temporary-storage/setup.py", import.meta.url));
  const env = { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: envFile, CI_TEMP_ISOLATE_PROMPTFOO: "true" };
  const child = spawnSync(python, [script], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const expected = configureTemporaryStorage({ RUNNER_TEMP: root, GITHUB_ENV: envFile, CI_TEMP_ISOLATE_PROMPTFOO: "true" });
  const section = Object.entries(expected).map(([key, value]) => `${key}=${value}\n`).join("");
  assert.equal(readFileSync(envFile, "utf8"), "EXISTING=preserved\n" + section + section);
  assert.deepEqual(readdirSync(root), []);
  writeFileSync(envFile, "EXISTING=preserved\n");
  for (const invalid of ["relative", root + "\nBAD=value", path.parse(root).root, os.homedir()]) {
    const refused = spawnSync(python, [script], { env: { ...env, RUNNER_TEMP: invalid }, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /refused/);
    assert.equal(readFileSync(envFile, "utf8"), "EXISTING=preserved\n");
  }
  const alias = path.join(base, "python-alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  const refused = spawnSync(python, [script], { env: { ...env, RUNNER_TEMP: alias }, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /symlink/);
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

test("repository coverage includes Python/control jobs and preserves the trusted checkout", () => {
  const checkout = { uses: "actions/checkout@pinned" };
  const setup = { uses: "./.github/actions/ci-temporary-storage" };
  const run = { run: "python3 -m unittest example" };
  const audit = { jobs: { control: { mode: "job-temp", action: setup.uses, checkout_sources: checkoutSources([checkout]), retained_artifacts: [], persistent_action_caches: [] } } };
  const check = (steps, job = {}) => repositoryTemporaryStorageFindings({ jobs: { control: { steps, ...job } } }, "control.yml", audit);
  assert.deepEqual(check([checkout, setup, run]), []);
  assert.ok(check([checkout, run]).length);
  assert.ok(check([setup, checkout, run]).length);
  assert.ok(check([checkout, { ...setup, if: false }, run]).length);
  assert.ok(check([checkout, { ...setup, if: "github.event_name == 'push'" }, run]).length);
  assert.deepEqual(check([checkout, { ...setup, if: "github.event_name == 'push'" }, { ...run, if: "github.event_name == 'push'" }]), []);
  assert.ok(check([checkout, setup, { run: "curl -o /tmp/shared-package url" }]).length);
  assert.ok(check([checkout, setup, { ...run, env: { temp: "/tmp" } }]).length);
  assert.ok(check([checkout, setup, run], { container: "python:3.12" }).length);
  assert.ok(check([checkout, setup, { uses: "vendor/unknown@commit" }, run]).length);
  const trustedCheckout = { ...checkout, with: { path: "trusted", ref: "main", repository: "owner/repo" } };
  const trustedAudit = { jobs: { control: { ...audit.jobs.control, action: "./trusted/.github/actions/ci-temporary-storage", checkout_sources: checkoutSources([trustedCheckout]) } } };
  const trusted = { jobs: { control: { steps: [trustedCheckout, { uses: trustedAudit.jobs.control.action }, run] } } };
  assert.deepEqual(repositoryTemporaryStorageFindings(trusted, "control.yml", trustedAudit), []);
  trusted.jobs.control.steps[1].uses = "./candidate/.github/actions/ci-temporary-storage";
  assert.ok(repositoryTemporaryStorageFindings(trusted, "control.yml", trustedAudit).length);
  trusted.jobs.control.steps[1].uses = trustedAudit.jobs.control.action;
  for (const changed of [{ ...trustedCheckout, if: false }, { ...trustedCheckout, with: { ...trustedCheckout.with, ref: "candidate" } },
    { ...trustedCheckout, with: { ...trustedCheckout.with, repository: "other/repo" } }]) {
    trusted.jobs.control.steps[0] = changed;
    assert.match(repositoryTemporaryStorageFindings(trusted, "control.yml", trustedAudit).join("\n"), /checkout/);
  }
  // Even a freshly classified conditional checkout must actually provide the bootstrap.
  const disabled = { ...checkout, if: false };
  const disabledAudit = { jobs: { control: { ...audit.jobs.control, checkout_sources: checkoutSources([disabled]) } } };
  assert.match(repositoryTemporaryStorageFindings({ jobs: { control: { steps: [disabled, setup, run] } } }, "control.yml", disabledAudit).join("\n"), /compatible checkout/);
  for (const uses of ["actions/setup-node@pinned", "actions/upload-artifact@pinned"]) {
    const official = { uses, with: { path: "evidence" }, env: { TMPDIR: "/tmp/shared" } };
    assert.match(check([checkout, setup, official, run]).join("\n"), /overridden temporary/);
    official.env = { WRANGLER_LOG_SANITIZE: false };
    assert.match(check([checkout, setup, official, run]).join("\n"), /sanitization/);
  }
  assert.match(check([checkout, setup, run], { env: { TEMP: "shared" } }).join("\n"), /overridden job temporary/);
});

test("no-checkout production control binds every runtime step without loading repository code", () => {
  const run = { run: "npx --yes example-command", env: { ...PLATFORM_TEMP_ENVIRONMENT } };
  const audit = { jobs: { control: { mode: "step-env", retained_artifacts: [], persistent_action_caches: [] } } };
  const check = (steps) => repositoryTemporaryStorageFindings({ jobs: { control: { steps } } }, "control.yml", audit);
  assert.deepEqual(check([run, { ...run, if: "always()" }]), []);
  assert.match(check([{ uses: "actions/checkout@pinned" }, run]).join("\n"), /no-checkout control/);
  assert.ok(check([run, { ...run, env: { TMPDIR: "${{ runner.temp }}" } }]).length);
  assert.ok(check([run, { ...run, env: { ...run.env, WRANGLER_LOG_PATH: "/tmp/logs" } }]).length);
  assert.ok(check([run, { uses: "actions/upload-artifact@v4", with: { path: "evidence.json" } }]).length);
});

test("route-only review is invalidated by changed behavior and cannot exempt another job", () => {
  const steps = [{ run: "echo route observed" }];
  const audit = { jobs: { "linux-route": { mode: "no-temp-writes", step_sha256: stepFingerprint(steps) } } };
  assert.deepEqual(repositoryTemporaryStorageFindings({ jobs: { "linux-route": { steps } } }, "clued-ci-runner-heartbeat.yml", audit), []);
  assert.ok(repositoryTemporaryStorageFindings({ jobs: { "linux-route": { steps: [{ run: "mkdir /tmp/other" }] } } }, "clued-ci-runner-heartbeat.yml", audit).length);
  assert.ok(repositoryTemporaryStorageFindings({ jobs: { "linux-route": { steps } } }, "new.yml", audit).length);
});

test("repository discovery rejects new workflows, jobs, composite actions and stale review entries", () => fixture(({ base }) => {
  const workflows = path.join(base, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  mkdirSync(path.join(base, ".github", "actions"), { recursive: true });
  const source = "jobs:\n  control:\n    steps:\n      - run: python check.py\n        env:\n" + Object.entries(PLATFORM_TEMP_ENVIRONMENT).map(([key, value]) => `          ${key}: ${value}\n`).join("");
  writeFileSync(path.join(workflows, "control.yml"), source);
  const catalog = { schema: "clued.ci-temporary-storage-coverage/1", workflows: { "control.yml": { jobs: { control: { mode: "step-env", retained_artifacts: [], persistent_action_caches: [] } } } }, local_actions: {} };
  assert.deepEqual(checkRepositoryWorkflows(workflows, catalog), []);
  writeFileSync(path.join(workflows, "new.yaml"), source);
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /no reviewed/);
  rmSync(path.join(workflows, "new.yaml"));
  writeFileSync(path.join(workflows, "control.yml"), source + "  unexpected:\n    steps: []\n");
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /new job/);
  writeFileSync(path.join(workflows, "control.yml"), source);
  mkdirSync(path.join(base, ".github", "actions", "new"));
  writeFileSync(path.join(base, ".github", "actions", "new", "action.yml"), "runs:\n  using: composite\n  steps: []\n");
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /no temporary lifecycle/);
  const action = ".github/actions/new/action.yml", producer = ".github/actions/new/start.py";
  writeFileSync(path.join(base, producer), "print('fixture')\n");
  catalog.local_actions[action] = { producer_sources: [producer], source_sha256: {
    [action]: sourceFingerprint(readFileSync(path.join(base, action), "utf8")),
    [producer]: sourceFingerprint(readFileSync(path.join(base, producer), "utf8")),
  } };
  assert.deepEqual(checkRepositoryWorkflows(workflows, catalog), []);
  writeFileSync(path.join(base, producer), "print('changed')\n");
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /producer source changed/);
  writeFileSync(path.join(base, action), "runs:\n  using: node24\n  main: changed.js\n");
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /local action or producer source changed/);
  rmSync(path.join(base, action));
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /reviewed local action no longer exists/);
  catalog.workflows["removed.yml"] = { jobs: {} };
  assert.match(checkRepositoryWorkflows(workflows, catalog).join("\n"), /no longer exists/);
}));

test("every repository workflow and job has a valid temporary-data lifecycle", () => {
  const workflows = fileURLToPath(new URL("../../../.github/workflows", import.meta.url));
  assert.deepEqual(checkRepositoryWorkflows(workflows), []);
});

test("production plaintext backup uses job scratch and retains only its encrypted artifact", () => {
  const source = readFileSync(new URL("../../../.github/workflows/clued-cloud-production-release.yml", import.meta.url), "utf8");
  const step = parse(source).jobs.release.steps.find(s => s.name === "Create and verify encrypted pre-migration backup");
  assert.match(step.run, /mktemp -d "\$RUNNER_TEMP\//);
  assert.match(step.run, /trap cleanup_plaintext EXIT/);
  assert.match(step.run, /trap 'exit 143' TERM/);
  assert.match(step.run, /dump_path="\$backup_tmp\//);
  assert.match(step.run, /verified_path="\$backup_tmp\//);
  assert.match(step.run, /encrypted_path="\$evidence_dir\/clued-production-pre-migration\.dump\.enc"/);
  assert.match(step.run, /-v "\$backup_tmp:\/backup"/);
});

function mockCommand(bin, name, source) {
  const file = path.join(bin, name);
  writeFileSync(file, "#!/bin/bash\nset -euo pipefail\n" + source + "\n");
  chmodSync(file, 0o700);
}

test("backup failure cleans plaintext while successful encrypted evidence is retained (mocked tools)", { skip: process.platform !== "linux" }, () => fixture(({ base, root }) => {
  const source = parse(readFileSync(new URL("../../../.github/workflows/clued-cloud-production-release.yml", import.meta.url), "utf8"));
  const script = source.jobs.release.steps.find(s => s.name === "Create and verify encrypted pre-migration backup").run;
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  mockCommand(bin, "node", "printf '%s' 'postgresql://fixture:fixture@invalid.test/db'");
  mockCommand(bin, "docker", 'while [ "$#" -gt 0 ]; do if [ "$1" = -v ]; then shift; backup="${1%:/backup}"; fi; shift; done\nprintf "fixture-only backup data\\n" > "$backup/clued-production-pre-migration.dump"');
  mockCommand(bin, "openssl", 'decrypt=false; input=""; output=""; while [ "$#" -gt 0 ]; do case "$1" in -d) decrypt=true;; -in) shift; input="$1";; -out) shift; output="$1";; esac; shift; done\nif [ "$MOCK_FAILURE" = encrypt ] && [ "$decrypt" = false ]; then exit 42; fi\ncp -- "$input" "$output"\nif [ "$MOCK_FAILURE" = verify ] && [ "$decrypt" = true ]; then printf corruption >> "$output"; fi');
  for (const failure of ["none", "encrypt", "verify"]) {
    const cwd = path.join(base, "backup-" + failure);
    mkdirSync(cwd);
    const child = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: {
      ...process.env, PATH: bin + ":/usr/bin:/bin", RUNNER_TEMP: root,
      CLUED_ATTESTATION_DATABASE_URL: "postgresql://fixture:fixture@invalid.test/db", CLUED_PRODUCTION_BACKUP_KEY: "fixture-only-key",
      GITHUB_SHA: "fixture-source", MOCK_FAILURE: failure,
    } });
    assert.equal(child.status === 0, failure === "none", child.stderr);
    assert.deepEqual(readdirSync(root), [], failure + ": plaintext scratch survived");
    const evidence = path.join(cwd, ".sites-runtime/release-evidence");
    assert.ok(!existsSync(path.join(evidence, "clued-production-pre-migration.dump")));
    assert.ok(!existsSync(path.join(evidence, "clued-production-pre-migration.dump.verified")));
    if (failure === "none") {
      assert.ok(existsSync(path.join(evidence, "clued-production-pre-migration.dump.enc")));
      const manifest = JSON.parse(readFileSync(path.join(evidence, "production-backup-manifest.json"), "utf8"));
      assert.equal(manifest.source_commit, "fixture-source");
      assert.ok(manifest.dump_bytes > 0);
    }
  }
}));

test("ICU downloads in all three workflows clean their own job package on installer failure", { skip: process.platform !== "linux" }, () => fixture(({ base, root }) => {
  const bin = path.join(base, "bin"); mkdirSync(bin);
  mockCommand(bin, "curl", 'printf fixture-package > "$2"');
  mockCommand(bin, "sudo", "exit 42");
  for (const name of ["clued-cloud-production-release.yml", "clued-currentness-post-deploy-attestation.yml", "clued-connection-authorization.yml"]) {
    const workflow = parse(readFileSync(new URL("../../../.github/workflows/" + name, import.meta.url), "utf8"));
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
    const install = steps.find(step => step.name === "Install embedded PostgreSQL ICU compatibility runtime");
    assert.ok(install, name);
    const child = spawnSync("bash", ["-c", install.run], { cwd: base, encoding: "utf8", env: { ...process.env, PATH: bin + ":/usr/bin:/bin", RUNNER_TEMP: root } });
    assert.equal(child.status, 42, child.stderr);
    assert.deepEqual(readdirSync(root), [], name + ": downloaded package survived");
  }
}));

test("the actual composite bootstrap works with Python and no Node on PATH", () => fixture(({ base, root, envFile }) => {
  const action = parse(readFileSync(new URL("../../../.github/actions/ci-temporary-storage/action.yml", import.meta.url), "utf8"));
  const python = process.platform === "win32" ? "python" : "python3";
  const executable = spawnSync(python, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(executable.status, 0, executable.stderr);
  let shell, argv, search;
  if (process.platform === "win32") {
    shell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    argv = ["-NoProfile", "-NonInteractive", "-Command", action.runs.steps[1].run];
    search = [path.dirname(executable.stdout.trim()), path.join(process.env.SystemRoot, "System32")].join(path.delimiter);
  } else {
    shell = "/bin/bash";
    argv = ["-c", action.runs.steps[0].run];
    search = path.join(base, "python-only-bin"); mkdirSync(search);
    symlinkSync(executable.stdout.trim(), path.join(search, "python3"));
  }
  const child = spawnSync(shell, argv, { encoding: "utf8", env: { ...process.env, PATH: search,
    RUNNER_TEMP: root, GITHUB_ENV: envFile, CI_TEMP_ISOLATE_PROMPTFOO: "false",
    GITHUB_ACTION_PATH: fileURLToPath(new URL("../../../.github/actions/ci-temporary-storage/", import.meta.url)),
  } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(readFileSync(envFile, "utf8"), /PYTHONPYCACHEPREFIX=/);
  assert.match(readFileSync(envFile, "utf8"), /WRANGLER_LOG_PATH=/);
  assert.deepEqual(readdirSync(root), []);
}));

test("backup cancellation removes plaintext scratch without a real database or deployment", { skip: process.platform !== "linux" }, async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ci-backup-cancel-test-"));
  const root = path.join(base, "job-temp"), bin = path.join(base, "bin"), marker = path.join(base, "encrypt-started");
  mkdirSync(root); mkdirSync(bin);
  const source = parse(readFileSync(new URL("../../../.github/workflows/clued-cloud-production-release.yml", import.meta.url), "utf8"));
  const script = source.jobs.release.steps.find(s => s.name === "Create and verify encrypted pre-migration backup").run;
  mockCommand(bin, "node", "printf '%s' 'postgresql://fixture:fixture@invalid.test/db'");
  mockCommand(bin, "docker", 'while [ "$#" -gt 0 ]; do if [ "$1" = -v ]; then shift; backup="${1%:/backup}"; fi; shift; done\nprintf "fixture-only backup data\\n" > "$backup/clued-production-pre-migration.dump"');
  mockCommand(bin, "openssl", 'touch "$MOCK_READY"\nsleep 30');
  const child = spawn("bash", ["-c", script], { cwd: base, detached: true, stdio: ["ignore", "ignore", "pipe"], env: {
    ...process.env, PATH: bin + ":/usr/bin:/bin", RUNNER_TEMP: root, MOCK_READY: marker,
    CLUED_ATTESTATION_DATABASE_URL: "postgresql://fixture:fixture@invalid.test/db", CLUED_PRODUCTION_BACKUP_KEY: "fixture-only-key", GITHUB_SHA: "fixture-source",
  } });
  let finished = false, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && !finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), "mock encrypt did not start: " + stderr);
    process.kill(-child.pid, "SIGTERM");
    const result = await exited;
    assert.notEqual(result.code, 0);
    assert.deepEqual(readdirSync(root), [], "plaintext survived cancellation: " + stderr);
  } finally {
    if (!finished) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited; }
    rmSync(base, { recursive: true, force: true });
  }
});
