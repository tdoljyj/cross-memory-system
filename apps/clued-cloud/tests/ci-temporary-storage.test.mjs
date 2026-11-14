import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureTemporaryStorage } from "../../../.github/actions/ci-temporary-storage/setup.mjs";
import { checkApplicationWorkflows, checkRepositoryWorkflows, checkoutSources, PLATFORM_TEMP_ENVIRONMENT, repositoryTemporaryStorageFindings, sourceFingerprint, stepFingerprint, temporaryStorageFindings } from "../../../.github/actions/ci-temporary-storage/check-workflows.mjs";
import { createRequire } from "node:module";
import { runBackupTool, createVerifiedBackup, backupFailureDiagnostic, sqlstateCollector, verifyArchiveScope } from "../scripts/verify-production-backup-scope.mjs";

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
  assert.match(check([checkout, setup, run], { services: { database: { image: "postgres" } } }).join("\n"), /container ownership/);
  assert.match(check([checkout, setup, run], { defaults: { run: { "working-directory": "/tmp/shared" } } }).join("\n"), /working directory/);
  assert.match(check([checkout, setup, { ...run, env: { REPORT_DIR: "/tmp/shared" } }]).join("\n"), /step environment/);
  assert.match(check([checkout, setup, { ...run, env: { REPORT_DIR: "C:\\Windows\\Temp\\shared" } }]).join("\n"), /step environment/);
  assert.match(check([checkout, setup, run], { defaults: { run: { "working-directory": "C:\\Temp\\shared" } } }).join("\n"), /working directory/);
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
  assert.match(repositoryTemporaryStorageFindings({ jobs: { "linux-route": { steps, container: "python:3.12" } } }, "clued-ci-runner-heartbeat.yml", audit).join("\n"), /container ownership/);
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
  assert.match(step.run, /node scripts\/verify-production-backup-scope\.mjs "\$backup_container" "\$backup_tmp"/);
  assert.match(step.run, /docker rm -f "\$backup_container"/);
  assert.match(step.run, /"\$scope_proof"/);
  assert.doesNotMatch(step.run, /--table=/);
});

function mockCommand(bin, name, source) {
  const file = path.join(bin, name);
  writeFileSync(file, "#!/bin/bash\nset -euo pipefail\n" + source + "\n");
  chmodSync(file, 0o700);
}

function mockBackupProducer(bin) {
  // These doubles exercise shell lifecycle only. Actual archive selection and
  // scope coverage are separately tested with real PostgreSQL client tools.
  mockCommand(bin, "node", `if [ "$1" = scripts/verify-production-backup-scope.mjs ]; then
  [ "$MOCK_FAILURE" != scope ] || exit 43
  printf '%s\\n' '{"verified":true,"scope":["public","clued_private","clued_watchdog","supabase_migrations.schema_migrations"],"inventory_sha256":"fixture-digest","table_data_entries":4}' > "$3/scope-proof.json"
elif [[ "${'$'}{2:-}" == *'new URL'* ]]; then
  printf '%s' 'postgresql://fixture:fixture@invalid.test/db'
else
  exec "$TEST_NODE_BINARY" "$@"
fi`);
  mockCommand(bin, "docker", `if [ "$1" = rm ]; then
  if [ "$MOCK_FAILURE" = producer-stop ]; then exit 44; fi
  if [ -n "${'$'}{MOCK_REMOVAL_MARKER:-}" ]; then touch "$MOCK_REMOVAL_MARKER"; fi
  exit 0
fi
if [ "$1" = container ] && [ "$2" = ls ]; then printf fixture-container; exit 0; fi
while [ "$#" -gt 0 ]; do if [ "$1" = -v ]; then shift; backup="${'$'}{1%:/backup}"; fi; shift; done
printf "fixture-only backup data\\n" > "$backup/clued-production-pre-migration.dump"
if [ "$MOCK_FAILURE" = container-start ]; then touch "$MOCK_READY"; sleep 30; fi`);
}

test("backup tool returns a complete TOC only after large and delayed stdout is drained", async () => {
  const output = await runBackupTool(process.execPath, ["-e",
    "process.stdout.write('x'.repeat(2*1024*1024),()=>setTimeout(()=>process.stdout.write('\\nfinal-toc-entry\\n',()=>process.exit(0)),20))"]);
  assert.equal(output.length, 2 * 1024 * 1024 + "\nfinal-toc-entry\n".length);
  assert.ok(output.endsWith("\nfinal-toc-entry\n"));
  await assert.rejects(runBackupTool(process.execPath, ["-e", "process.stdout.write('incomplete');process.exit(1)"]), /tool failed/);
});

test("both backup stdout readers preserve identifiers and function bodies across split UTF-8 bytes", () => {
  const helperUrl = new URL("../scripts/verify-production-backup-scope.mjs", import.meta.url);
  const helperSource = readFileSync(helperUrl, "utf8");
  const oldSource = helperSource.replace(/^\s*(?:this\.)?child\.stdout\.setEncoding\('utf8'\);\r?\n/gm, "");
  assert.notEqual(oldSource, helperSource);
  const variantDirectory = mkdtempSync(path.join(os.tmpdir(), "ci-backup-utf8-variant-"));
  const oldFile = path.join(variantDirectory,"old-helper.mjs");
  writeFileSync(oldFile,oldSource);
  const oldUrl = pathToFileURL(oldFile).href;
  // Isolate the fake producer in a child process. PassThrough preserves exact
  // write boundaries, so split codepoints cannot accidentally coalesce in an
  // OS pipe and conceal the regression. The existing test covers real pipes.
  const program = moduleUrl => `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { PassThrough, Writable } from 'node:stream';
    const helper = await import(${JSON.stringify(moduleUrl)});
    const expected = JSON.stringify({routine:'clued_private.原生辅助函数(integer)',definition:"SELECT '返回中文'; -- 原生函数体"});
    async function fragments(child, text) {
      const bytes=Buffer.from(text), cuts=[0,bytes.indexOf(Buffer.from('原'))+1,bytes.indexOf(Buffer.from('返'))+1,bytes.length];
      for(let i=1;i<cuts.length;i++) {
        child.stdout.write(bytes.subarray(cuts[i-1],cuts[i]));
        await new Promise(resolve=>setImmediate(resolve));
      }
    }
    function finish(child) {
      child.stdout.end(); child.stderr.end(); child.exitCode=0;
      queueMicrotask(()=>child.emit('close',0));
    }
    cp.spawn=command=>{
      const child=new EventEmitter();
      child.pid=1; child.exitCode=null; child.signalCode=null;
      child.stdout=new PassThrough(); child.stderr=new PassThrough();
      child.kill=()=>{finish(child);return true;};
      child.stdin=new Writable({write(chunk,encoding,done){
        const input=chunk.toString();
        const marker=/\\\\echo ([a-zA-Z0-9_]+)/.exec(input)?.[1];
        if(marker) void fragments(child,expected+'\\n'+marker+'\\n');
        if(input.includes('\\\\q')) finish(child);
        done();
      }});
      if(command==='fixture-unicode') setImmediate(async()=>{await fragments(child,expected);finish(child);});
      return child;
    };
    syncBuiltinESMExports();
    const output=await helper.runBackupTool('fixture-unicode',[]);
    const session=new helper.SnapshotSession('clued-production-backup-synthetic-utf8');
    const snapshot=await session.query('SELECT synthetic_unicode');
    await session.close();
    process.stdout.write(JSON.stringify({tool:output===expected,snapshot:snapshot===expected}));
  `;
  try { for (const [moduleUrl, expected] of [[oldUrl,{tool:false,snapshot:false}], [helperUrl.href,{tool:true,snapshot:true}]]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program(moduleUrl)], { encoding:"utf8", timeout:10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.deepEqual(JSON.parse(child.stdout), expected);
  } } finally { rmSync(variantDirectory,{recursive:true,force:true}); }
});

test("SQLSTATE collection accepts only bounded exact severity lines and never captures raw errors", () => {
  const collector=sqlstateCollector();
  collector.accept("ERROR:  42"); collector.accept("501\r\n");
  assert.equal(collector.value,"42501");
  for (const input of ["ERROR: TABLE\n","ERROR: 42501 private_object\n",
    "psql: error: postgresql://password_canary@host/body_canary 42501\n",
    "x".repeat(1024)+"ERROR: 42501\n","ERROR: 42501"]) {
    collector.reset(); collector.accept(input); assert.equal(collector.value,null);
  }
  collector.reset(); collector.accept("psql:<stdin>:3: ERROR:  42P01\n");
  assert.equal(collector.value,"42P01");
});

function archiveFixture() {
  const schemas=["public","clued_private","clued_watchdog","supabase_migrations"];
  const objects=schemas.map((schema,index)=>({catalog:2615,oid:10+index,schema,kind:"SCHEMA",name:schema,
    parent_oid:0,row_type_oid:0,required:true,extension_member:false}));
  objects.push({catalog:1259,oid:100,schema:"supabase_migrations",kind:"TABLE",name:"schema_migrations",
    parent_oid:0,row_type_oid:110,relation_kind:"r",required:true,extension_member:false},
    {catalog:1247,oid:110,schema:"supabase_migrations",kind:"TYPE",name:"schema_migrations",
      parent_oid:100,row_type_oid:111,required:false,extension_member:false},
    {catalog:1247,oid:111,schema:"supabase_migrations",kind:"TYPE",name:"_schema_migrations",
      parent_oid:110,row_type_oid:0,required:false,extension_member:false});
  const inventory={objects,data:[{oid:100,schema:"supabase_migrations",kind:"TABLE DATA"}]};
  const lines=schemas.map((schema,index)=>`${index+1}; 2615 ${10+index} SCHEMA - ${schema} postgres`);
  lines.push("20; 1259 100 TABLE supabase_migrations schema_migrations postgres",
    "21; 0 100 TABLE DATA supabase_migrations schema_migrations postgres");
  return {inventory,lines};
}
test("archive refusals identify the exact fixed predicate without publishing private TOC tags", () => {
  const {inventory,lines}=archiveFixture();
  assert.equal(verifyArchiveScope(inventory,lines.join("\n")).verified,true);
  const cases=[
    [lines.concat("private_tag_canary"),"TOC_LINE_INVALID"],
    [lines.concat("90; 0 0 UNREVIEWED_KIND private_tag_canary"),"TOC_KIND_UNREVIEWED"],
    [lines.concat("90; 1259 999 TABLE public private_tag_canary postgres"),"TOC_OBJECT_OUTSIDE_SNAPSHOT"],
    [lines.concat("90; 0 999 TABLE DATA public private_tag_canary postgres"),"TOC_DATA_UNEXPECTED"],
    [lines.concat("90; 0 0 COMMENT - DATABASE private_tag_canary postgres"),"TOC_METADATA_UNBOUND"],
    [lines.filter(line=>!line.includes("2615 10 ")),"TOC_OBJECT_MISSING"],
    [lines.filter(line=>!line.includes("TABLE DATA")),"TOC_DATA_MISSING"],
  ];
  for(const [toc,expected] of cases){
    assert.throws(()=>verifyArchiveScope(inventory,toc.join("\n")),error=>{
      assert.equal(error.name,"AssertionError");
      const diagnostic=backupFailureDiagnostic(error);
      assert.equal(diagnostic.reason_code,expected);
      assert.ok(!JSON.stringify(diagnostic).includes("private_tag_canary"));
      return true;
    });
  }
});

test("inline default evidence binds the exact table, column and complete expression", () => {
  const {inventory,lines}=archiveFixture();
  inventory.objects.push({catalog:1259,oid:200,schema:'public',kind:'TABLE',name:'default_probe',
    parent_oid:0,row_type_oid:0,relation_kind:'r',required:true,extension_member:false},
    {catalog:2604,oid:201,schema:'public',kind:'DEFAULT',name:'value',parent_oid:200,row_type_oid:0,
      required:true,extension_member:false,definition:'true'});
  lines.push('30; 1259 200 TABLE public default_probe postgres');
  const toc=lines.join('\n');
  const ddl=expression=>`CREATE TABLE public.default_probe (value boolean DEFAULT ${expression});`;
  assert.equal(verifyArchiveScope(inventory,toc,ddl('true')).verified,true);
  assert.equal(verifyArchiveScope(inventory,toc,ddl('true NOT NULL')).verified,true);
  assert.equal(verifyArchiveScope(inventory,toc,ddl('true').replace('CREATE TABLE','CREATE UNLOGGED TABLE')).verified,true);
  for(const columns of ['value boolean DEFAULT true, other integer',
    'other integer, value boolean DEFAULT true, last integer',
    'value boolean DEFAULT true, CHECK (value IS NOT NULL)']){
    assert.equal(verifyArchiveScope(inventory,toc,`CREATE TABLE public.default_probe (${columns});`).verified,true);
  }
  assert.throws(()=>verifyArchiveScope(inventory,toc),error=>backupFailureDiagnostic(error).reason_code==='TOC_DEFAULT_DEFINITION_REQUIRED');
  for(const sql of [ddl('false'),ddl('true NOT IN (true)'),ddl('true AND false'),
    'CREATE TABLE public.default_probe (value boolean);',
    '/* '+ddl('true')+' */',"SELECT '"+ddl('true')+"';",'SELECT $$'+ddl('true')+'$$;',
    ddl('true').replace('public.default_probe','clued_private.default_probe'),
    ddl('true').replace('value boolean','other boolean'),
    ddl('true').slice(0,-2),ddl('true').replace('DEFAULT true','CHECK (true)')]){
    assert.throws(()=>verifyArchiveScope(inventory,toc,sql),error=>backupFailureDiagnostic(error).reason_code==='TOC_DEFAULT_MISSING');
  }
  for(const expression of ["'literal, (default) \\'::text","E'escape\\\\path'::text",'ARRAY[1, 2]',
    "'中文'::text",'public.custom_default()', '(1 + 2)']){
    inventory.objects.at(-1).definition=expression;
    assert.equal(verifyArchiveScope(inventory,toc,ddl(expression)).verified,true);
  }
  const view=inventory.objects.find(o=>o.oid===200);view.kind='VIEW';view.relation_kind='v';
  const viewToc=toc.replace('TABLE public default_probe','VIEW public default_probe');
  assert.throws(()=>verifyArchiveScope(inventory,viewToc,ddl('true')),error=>backupFailureDiagnostic(error).reason_code==='TOC_OBJECT_MISSING');
});

test("backup preserves its primary refusal while separately reporting rollback and close failures", async () => {
  const primary=new Error("postgresql://password_canary@host_canary/private_object SELECT body_canary");
  const rollback=new Error("rollback_secret_canary"), closed=new Error("close_secret_canary");
  const session={query:async sql=>{if(sql.startsWith("BEGIN"))return "";
    if(sql==="ROLLBACK")throw rollback; throw primary;},close:async()=>{throw closed;}};
  // The former finally path demonstrably replaces this primary failure.
  const old=async()=>{let begun=false;try{await session.query("BEGIN");begun=true;await session.query("SELECT");}
    finally{if(begun)await session.query("ROLLBACK").catch(()=>{});await session.close();}};
  assert.equal(await old().catch(error=>error),closed);
  const reports=[];
  const actual=await createVerifiedBackup({session,runPg:async()=>assert.fail("No dump after snapshot refusal"),
    dumpPath:"unused",onDiagnostic:report=>reports.push(report)}).catch(error=>error);
  assert.equal(actual,primary);
  const original=backupFailureDiagnostic(actual);
  assert.equal(original.stage,"snapshot_export"); assert.equal(original.phase,"primary");
  assert.equal(original.reason_code,"INTERNAL_ERROR");
  assert.deepEqual(reports.filter(r=>r.event==="error").map(r=>[r.stage,r.phase]),
    [["snapshot_export","primary"],["rollback_cleanup","cleanup"],["session_close","cleanup"]]);
  const published=JSON.stringify([original,...reports]);
  for(const canary of ["postgresql://","password_canary","host_canary","private_object","body_canary",
    "rollback_secret_canary","close_secret_canary"])assert.ok(!published.includes(canary));
});

test("throwing or rejecting diagnostic observers cannot bypass guards, replace primary failure or prevent close", async () => {
  const primary=new Error("synthetic snapshot refusal"), observer=new Error("observer_private_canary");
  for(const mode of ["throw-primary-begin","throw-error","throw-success","throw-close-begin","reject-all"]){
    const queries=[];let closes=0,dumps=0;
    const session={query:async sql=>{queries.push(sql);if(sql.startsWith("BEGIN")||sql==="ROLLBACK")return "";throw primary;},
      close:async()=>{closes++;}};
    const onDiagnostic=record=>{
      if(mode==="reject-all")return Promise.reject(observer);
      if((mode==="throw-primary-begin"&&record.event==="begin"&&record.phase==="primary")||
        (mode==="throw-error"&&record.event==="error")||(mode==="throw-success"&&record.event==="success")||
        (mode==="throw-close-begin"&&record.event==="begin"&&record.stage==="session_close"))throw observer;
    };
    const outcome=await createVerifiedBackup({session,dumpPath:"unused",onDiagnostic,
      runPg:async()=>{dumps++;assert.fail("No dump is allowed after failed snapshot export");}}).catch(error=>error);
    await new Promise(resolve=>setImmediate(resolve)); // Observe Promise rejection handling, too.
    assert.equal(outcome,primary,mode);
    assert.equal(backupFailureDiagnostic(outcome).reason_code,"INTERNAL_ERROR");
    assert.deepEqual(queries,["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","SELECT pg_export_snapshot()","ROLLBACK"],mode);
    assert.equal(dumps,0,mode);assert.equal(closes,1,mode);
  }
});

test("snapshot shutdown has finite waits, shares its result and never treats force or exit alone as close proof", () => {
  const helperUrl=new URL("../scripts/verify-production-backup-scope.mjs",import.meta.url);
  const program=`
    import assert from 'node:assert/strict'; import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module'; import {EventEmitter} from 'node:events';
    import {PassThrough,Writable} from 'node:stream';
    const helper=await import(${JSON.stringify(helperUrl.href)});
    let scenario='never',child;
    cp.spawn=()=>{child=new EventEmitter();child.pid=1;child.exitCode=null;child.signalCode=null;
      child.stdout=new PassThrough();child.stderr=new PassThrough();child.signals=[];child.unref=()=>{};
      child.stdin=new Writable({write(chunk,encoding,done){done();}});
      child.stdin.on('finish',()=>{if(scenario==='normal')queueMicrotask(()=>child.emit('close',0,null));});
      child.kill=signal=>{child.signals.push(signal);if(scenario==='throw')throw new Error('private_kill_canary');
        if(scenario==='forced')queueMicrotask(()=>child.emit('close',0,null));return false;};return child;};
    syncBuiltinESMExports();
    const oldSession=new helper.SnapshotSession('clued-production-backup-synthetic-old',{graceMs:20,termMs:20,killMs:20});
    const oldChild=child;
    const oldClose=async()=>{await new Promise(resolve=>{const timer=setTimeout(()=>oldChild.kill('SIGTERM'),20);
      oldChild.once('close',()=>{clearTimeout(timer);resolve();});oldChild.stdin.end('\\\\q\\n');});};
    const pending=oldClose();
    assert.equal(await Promise.race([pending.then(()=>false),new Promise(r=>setTimeout(()=>r(true),80))]),true);
    oldChild.emit('close',0,null);await pending; // Do not leave the reference test pending.
    const verdicts=[];
    for(scenario of ['never','throw','forced','normal','delayed']){
      const session=new helper.SnapshotSession('clued-production-backup-synthetic-current',{graceMs:100,termMs:20,killMs:20});
      const active=child,started=performance.now();
      if(scenario==='delayed'){active.exitCode=0;active.emit('exit',0,null);setTimeout(()=>active.emit('close',0,null),40);}
      const first=session.close();assert.equal(session.close(),first);
      const result=await first.then(()=>null,error=>helper.backupFailureDiagnostic(error));
      assert.ok(performance.now()-started<500);
      if(scenario==='never'||scenario==='throw')assert.equal(result.reason_code,'SNAPSHOT_CLOSE_UNCONFIRMED');
      if(scenario==='forced'){assert.equal(result.reason_code,'SNAPSHOT_CLOSE_FORCED');assert.equal(result.exit_code,0);}
      if(scenario==='normal'||scenario==='delayed'){assert.equal(result,null);assert.deepEqual(active.signals,[]);}
      if(scenario==='delayed')assert.ok(performance.now()-started>=30);
      verdicts.push({scenario,reason:result?.reason_code??'graceful'});
    }
    process.stdout.write(JSON.stringify({old_wait:'pending',current:verdicts}));
  `;
  const child=spawnSync(process.execPath,["--input-type=module","-e",program],{encoding:"utf8",timeout:5000});
  assert.equal(child.status,0,child.stderr||child.error?.message);
  assert.equal(JSON.parse(child.stdout).old_wait,"pending");
  assert.ok(!child.stdout.includes("private_kill_canary"));
});

test("refused backup CLI exits nonzero with inherited pipes so owned producer cleanup can run", {skip:process.platform!=="linux"}, () => {
  const base=mkdtempSync(path.join(os.tmpdir(),"ci-backup-pipe-close-test-"));
  const bin=path.join(base,"bin"),scratch=path.join(base,"scratch");mkdirSync(bin);mkdirSync(scratch);
  const helper=fileURLToPath(new URL("../scripts/verify-production-backup-scope.mjs",import.meta.url));
  const source=readFileSync(helper,"utf8");
  const oldSource=source.replace(/  close\(\) \{\n    this\.closeResult \?\?= this\.closeBounded\(\);\n    return this\.closeResult;\n  \}/,
    `  async close(){if(!this.child.pid||this.child.exitCode!==null||this.child.signalCode!==null)return;
      await new Promise(resolve=>{const t=setTimeout(()=>this.child.kill('SIGTERM'),5000);
        this.child.once('close',()=>{clearTimeout(t);resolve();});this.child.stdin.end('\\\\q\\n');});}`);
  assert.notEqual(source,oldSource);
  const oldFile=path.join(base,"old-helper.mjs");writeFileSync(oldFile,oldSource);
  const driver=path.join(base,"docker-driver.mjs");
  writeFileSync(driver,`import fs from 'node:fs';import {spawn} from 'node:child_process';
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(process.env.MOCK_DESCENDANT,String(descendant.pid));
    process.stderr.write('FATAL: postgresql://password_canary@host_canary/private_object body_canary\\n');
    process.exit(0);`);
  mockCommand(bin,"docker",'exec "$TEST_NODE_BINARY" "$MOCK_DOCKER_DRIVER"');
  try {
    for(const [variant,file] of [["old",oldFile],["current",helper]]){
      const marker=path.join(base,variant+"-descendant");
      // The CLI runs as the real entry point (import.meta.main, which a faked argv does not set); only the timers are shortened.
      const preload=path.join(base,"shorter-timers.mjs");
      writeFileSync(preload,"const ordinary=setTimeout;globalThis.setTimeout=(f,n,...a)=>ordinary(f,n===60000?500:n===5000||n===2000?30:n,...a);\n");
      let actual;
      try {
        actual=spawnSync(process.execPath,["--import",pathToFileURL(preload).href,file,"clued-production-backup-synthetic-pipe",scratch],{encoding:"utf8",timeout:2000,env:{...process.env,
          PATH:bin+path.delimiter+process.env.PATH,TEST_NODE_BINARY:process.execPath,MOCK_DOCKER_DRIVER:driver,MOCK_DESCENDANT:marker}});
      } finally {
        if(existsSync(marker)){const pid=Number(readFileSync(marker,"utf8"));assert.ok(Number.isSafeInteger(pid)&&pid>1);
          try{process.kill(pid,"SIGKILL");}catch(error){if(error.code!=="ESRCH")throw error;}}
      }
      if(variant==="old")assert.equal(actual.error?.code,"ETIMEDOUT","Old CLI unexpectedly released its inherited pipes");
      else {
        assert.equal(actual.error,undefined);assert.equal(actual.status,1,actual.stderr);
        const reports=(actual.stdout+"\n"+actual.stderr).split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line));
        assert.ok(reports.some(r=>r.stage==="session_close"&&r.reason_code==="SNAPSHOT_CLOSE_UNCONFIRMED"&&r.observed_close===false));
        assert.ok(reports.some(r=>r.event==="refused"&&r.stage==="snapshot_begin"&&
          ["SNAPSHOT_QUERY_TIMEOUT","SNAPSHOT_IO_ERROR"].includes(r.reason_code)));
        for(const canary of ["postgresql://","password_canary","host_canary","private_object","body_canary"])
          assert.ok(!(actual.stdout+actual.stderr).includes(canary));
      }
    }
  } finally {rmSync(base,{recursive:true,force:true});}
});

test("backup cleanup retains verified evidence and refuses a producer it cannot stop (mocked tools)", { skip: process.platform !== "linux" }, () => fixture(({ base, root }) => {
  const source = parse(readFileSync(new URL("../../../.github/workflows/clued-cloud-production-release.yml", import.meta.url), "utf8"));
  const script = source.jobs.release.steps.find(s => s.name === "Create and verify encrypted pre-migration backup").run;
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  mockBackupProducer(bin);
  mockCommand(bin, "openssl", 'decrypt=false; input=""; output=""; while [ "$#" -gt 0 ]; do case "$1" in -d) decrypt=true;; -in) shift; input="$1";; -out) shift; output="$1";; esac; shift; done\nif [ "$MOCK_FAILURE" = encrypt ] && [ "$decrypt" = false ]; then exit 42; fi\ncp -- "$input" "$output"\nif [ "$MOCK_FAILURE" = verify ] && [ "$decrypt" = true ]; then printf corruption >> "$output"; fi');
  for (const failure of ["none", "scope", "encrypt", "verify", "producer-stop"]) {
    const cwd = path.join(base, "backup-" + failure);
    mkdirSync(cwd);
    const child = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: {
      ...process.env, PATH: bin + ":/usr/bin:/bin", RUNNER_TEMP: root,
      CLUED_ATTESTATION_DATABASE_URL: "postgresql://fixture:fixture@invalid.test/db", CLUED_PRODUCTION_BACKUP_KEY: "fixture-only-key",
      GITHUB_SHA: "fixture-source", MOCK_FAILURE: failure, TEST_NODE_BINARY: process.execPath,
    } });
    assert.equal(child.status === 0, failure === "none", child.stderr);
    if (failure === "producer-stop") {
      assert.match(child.stderr, /Could not prove this job's backup producer stopped/);
      const retained = readdirSync(root);
      assert.equal(retained.length, 1);
      assert.ok(existsSync(path.join(root, retained[0], "clued-production-pre-migration.dump")), "unproven cleanup was misreported");
    } else assert.deepEqual(readdirSync(root), [], failure + ": plaintext scratch survived");
    const evidence = path.join(cwd, ".sites-runtime/release-evidence");
    assert.ok(!existsSync(path.join(evidence, "clued-production-pre-migration.dump")));
    assert.ok(!existsSync(path.join(evidence, "clued-production-pre-migration.dump.verified")));
    if (failure === "none") {
      assert.ok(existsSync(path.join(evidence, "clued-production-pre-migration.dump.enc")));
      const manifest = JSON.parse(readFileSync(path.join(evidence, "production-backup-manifest.json"), "utf8"));
      assert.equal(manifest.source_commit, "fixture-source");
      assert.ok(manifest.dump_bytes > 0);
      assert.equal(manifest.scope_verification.verified, true);
    }
  }
}));

test("ICU downloads in both workflows clean their own job package on installer failure", { skip: process.platform !== "linux" }, () => fixture(({ base, root }) => {
  const bin = path.join(base, "bin"); mkdirSync(bin);
  mockCommand(bin, "curl", 'printf fixture-package > "$2"');
  mockCommand(bin, "sudo", "exit 42");
  for (const name of ["clued-cloud-production-release.yml", "clued-currentness-post-deploy-attestation.yml"]) {
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

for (const phase of ["container-start", "encrypt"]) test("backup cancellation during " + phase + " removes its producer and plaintext scratch", { skip: process.platform !== "linux" }, async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ci-backup-cancel-test-"));
  const root = path.join(base, "job-temp"), bin = path.join(base, "bin"), marker = path.join(base, "phase-started"), removed = path.join(base, "container-removed");
  mkdirSync(root); mkdirSync(bin);
  const source = parse(readFileSync(new URL("../../../.github/workflows/clued-cloud-production-release.yml", import.meta.url), "utf8"));
  const script = source.jobs.release.steps.find(s => s.name === "Create and verify encrypted pre-migration backup").run;
  mockBackupProducer(bin);
  mockCommand(bin, "openssl", 'touch "$MOCK_READY"\nsleep 30');
  const child = spawn("bash", ["-c", script], { cwd: base, detached: true, stdio: ["ignore", "ignore", "pipe"], env: {
    ...process.env, PATH: bin + ":/usr/bin:/bin", RUNNER_TEMP: root, MOCK_READY: marker,
    CLUED_ATTESTATION_DATABASE_URL: "postgresql://fixture:fixture@invalid.test/db", CLUED_PRODUCTION_BACKUP_KEY: "fixture-only-key", GITHUB_SHA: "fixture-source",
    MOCK_FAILURE: phase, MOCK_REMOVAL_MARKER: removed, TEST_NODE_BINARY: process.execPath,
  } });
  let finished = false, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && !finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), "mock cancellation phase did not start: " + stderr);
    process.kill(-child.pid, "SIGTERM");
    const result = await exited;
    assert.notEqual(result.code, 0);
    assert.ok(existsSync(removed), "owned producer survived cancellation: " + stderr);
    assert.deepEqual(readdirSync(root), [], "plaintext survived cancellation: " + stderr);
  } finally {
    if (!finished) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited; }
    rmSync(base, { recursive: true, force: true });
  }
});

// Source classification only: these tests never run guards, scanners or permissions.
const lifecycleSubjects = [
  ["clued-handover-disposable-idle.yml", "disposable-idle", 1, 3],
  ["clued-handover-external-qualification.yml", "qualify", 1, 3],
  ["clued-native617-admission-dispatch.yml", "admit", 1, 3],
  ["contract-placement.yml", "contract-placement", 2, 3],
  ["gitleaks.yml", "gitleaks-trusted-self-hosted", 1, 2],
  ["trivy.yml", "trivy-trusted-self-hosted", 1, 2],
];
const lifecycleClosure = ["scripts/ci/clued-handover-native-entry.mjs",
  "config/clued-handover-native-entry-policy.json", "scripts/ci/clued-scan-start.mjs"];
const lifecycleRepository = fileURLToPath(new URL("../../../", import.meta.url));
const lifecycleCoverage = JSON.parse(readFileSync(new URL("../../../.github/actions/ci-temporary-storage/coverage.json", import.meta.url), "utf8"));
function lifecycleFixture(name, run) {
  return fixture(({ base }) => {
    const sourceRoot = path.join(base, "source");
    for (const relative of [`.github/workflows/${name}`, ...lifecycleClosure]) {
      const target = path.join(sourceRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(lifecycleRepository, relative)));
    }
    const document = parse(readFileSync(path.join(sourceRoot, ".github/workflows", name), "utf8"));
    const audit = structuredClone(lifecycleCoverage.workflows[name]);
    const check = (doc = document, reviewed = audit, context = { sourceRoot }) =>
      repositoryTemporaryStorageFindings(doc, name, reviewed, context);
    return run({ sourceRoot, document, audit, check });
  });
}
for (const [name, id, guardIndex, bootstrapIndex] of lifecycleSubjects) {
  test(`exact pre-bootstrap lifecycle: ${name}/${id}; later runtime stays governed`, () => lifecycleFixture(name, ({ document, audit, check }) => {
    assert.equal(audit.jobs[id].mode, "job-temp");
    assert.deepEqual(check(), []);
    assert.ok(check(document, audit, {}).length, "Metadata alone cannot register a lifecycle");
    for (const forged of [true, false, null, {}, "read-only", "forged-lifecycle"]) {
      const changed = structuredClone(audit); changed.jobs[id].pre_bootstrap_lifecycle = forged;
      assert.match(check(document, changed).join("\n"), /lifecycle Source/);
    }
    const removed = structuredClone(audit); delete removed.jobs[id].pre_bootstrap_lifecycle;
    assert.match(check(document, removed).join("\n"), /not bound before runtime/);
    const mutations = [
      doc => { doc.jobs[id].steps[guardIndex].run += "\necho unexpected"; },
      doc => { doc.jobs[id].steps[guardIndex].if = "false"; },
      doc => { doc.jobs[id].steps[guardIndex]["continue-on-error"] = true; },
      doc => { doc.jobs[id]["runs-on"] = "unexpected-route"; },
      doc => { doc.jobs[id].permissions = { contents: "write" }; },
      doc => { doc.jobs[id].steps[0].with = { ...doc.jobs[id].steps[0].with, ref: "unreviewed" }; },
      doc => { doc.jobs[id].steps[0].if = "true"; },
      doc => { doc.jobs[id].env = { UNREVIEWED: "true" }; },
      doc => { doc.jobs[id].steps.splice(bootstrapIndex, 0, { run: "node unknown.mjs" }); },
      doc => { doc.jobs[id].steps.splice(guardIndex, 1); },
      doc => { doc.jobs[id].steps.splice(bootstrapIndex, 1); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(document); mutate(changed);
      assert.ok(check(changed).length, "Changed document cannot borrow frozen raw Source");
    }
    const later = structuredClone(document);
    later.jobs[id].steps.push({ run: "node unknown.mjs", if: "always()" });
    assert.ok(check(later).length, "Registration never exempts later runtime");
  }));
}

test("pre-bootstrap closure rejects raw Source/config/producer drift, oversize and missing files", () => {
  for (const [name] of lifecycleSubjects) lifecycleFixture(name, ({ sourceRoot, check }) => {
    const target = path.join(sourceRoot, ".github/workflows", name), original = readFileSync(target, "utf8");
    writeFileSync(target, original + "\n# changed Source bytes\n");
    assert.match(check().join("\n"), /lifecycle Source/);
    writeFileSync(target, original);
    const closure = name.startsWith("clued-") ? lifecycleClosure.slice(0, 2) :
      ["gitleaks.yml", "trivy.yml"].includes(name) ? lifecycleClosure.slice(2) : [];
    for (const relative of closure) {
      const producer = path.join(sourceRoot, relative), bytes = readFileSync(producer);
      writeFileSync(producer, Buffer.concat([bytes, Buffer.from("\n ")]));
      assert.match(check().join("\n"), /lifecycle Source/);
      writeFileSync(producer, Buffer.alloc(1048577, 32));
      assert.match(check().join("\n"), /lifecycle Source/);
      rmSync(producer); assert.match(check().join("\n"), /lifecycle Source/);
      writeFileSync(producer, bytes);
    }
    assert.deepEqual(check(), []);
  });
});

test("producer closure directory aliases cannot borrow an exact lifecycle", () => lifecycleFixture(
  "clued-handover-disposable-idle.yml", ({ sourceRoot, check }) => {
    const scripts = path.join(sourceRoot, "scripts"), saved = path.join(sourceRoot, "saved-scripts");
    mkdirSync(path.join(saved, "ci"), { recursive: true });
    const relative = "ci/clued-handover-native-entry.mjs";
    writeFileSync(path.join(saved, relative), readFileSync(path.join(scripts, relative)));
    rmSync(scripts, { recursive: true });
    symlinkSync(saved, scripts, process.platform === "win32" ? "junction" : "dir");
    assert.match(check().join("\n"), /lifecycle Source/);
  }));

test("scan permission lifecycle retains the real no-clobber RUNNER_TEMP write and original once producer", () => {
  for (const name of ["gitleaks.yml", "trivy.yml"]) lifecycleFixture(name, ({ document, audit, check }) => {
    const id = name === "gitleaks.yml" ? "gitleaks-trusted-self-hosted" : "trivy-trusted-self-hosted";
    assert.equal(audit.jobs[id].pre_bootstrap_lifecycle, "native-scan-permission-runner-temp-v1");
    assert.notEqual(audit.jobs[id].mode, "no-temp-writes");
    const guard = document.jobs[id].steps[1];
    assert.match(guard.run, /set -euC/);
    assert.match(guard.run, /> "\$RUNNER_TEMP\/clued-scan-start\.mjs"/);
    assert.match(guard.run, /sha256sum -c --quiet -/);
    assert.match(guard.run, /node "\$RUNNER_TEMP\/clued-scan-start\.mjs" --run/);
    for (const replacement of [guard.run.replace("set -euC", "set -eu"),
      guard.run.replaceAll("clued-scan-start.mjs", "other-purpose.mjs"),
      guard.run + "\ncurl https://unreviewed.invalid", guard.run.replace("sha256sum -c --quiet -", "true")]) {
      const changed = structuredClone(document); changed.jobs[id].steps[1].run = replacement;
      assert.match(check(changed).join("\n"), /lifecycle Source/);
    }
    assert.deepEqual(check(), []);
  });
});

test("conditional placement checkout is implied only by the exact successful subject guard", () => lifecycleFixture(
  "contract-placement.yml", ({ document, audit, check }) => {
    const id = "contract-placement", steps = document.jobs[id].steps;
    assert.notEqual(checkoutSources(steps)[0].if, "true");
    assert.equal(steps[3].if, undefined);
    assert.match(steps[2].run, /trustedPush/); assert.match(steps[2].run, /trustedPr/);
    assert.deepEqual(check(), []);
    for (const change of [doc => { doc.jobs[id].steps[2].run = "echo caller_says_qualified"; },
      doc => { doc.jobs[id].steps[2].env.CLUED_AUTOMATION_SELF_HOSTED = "true"; },
      doc => { doc.jobs[id].steps[0].if = "false"; }]) {
      const changed = structuredClone(document); change(changed);
      const reclassified = structuredClone(audit);
      reclassified.jobs[id].checkout_sources = checkoutSources(changed.jobs[id].steps);
      assert.match(check(changed, reclassified).join("\n"), /compatible checkout/);
    }
  }));
