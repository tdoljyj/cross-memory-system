import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runNodeTests } from "../scripts/run-tests.mjs";

const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const fixtureSource = `
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
test('leave the same temporary build files as CI', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clued-continuity-route-'));
  writeFileSync(path.join(directory, 'continuity.mjs'), Buffer.alloc(1024 * 1024));
  const child = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'native-unpack'), 'native package')"]);
  if (child.status !== 0) throw new Error('fixture child failed');
  writeFileSync(process.env.TEST_TEMP_REPORT, JSON.stringify({ root: os.tmpdir(), tmp: process.env.TMP, temp: process.env.TEMP }));
  if (process.env.TEST_TEMP_FAIL) throw new Error('intentional fixture failure');
});
`;

for (const [name, flags, fail] of [
  ["successful suite", [], false],
  ["failed suite", [], true],
  ["database-style forced exit", ["--test-force-exit"], false],
]) {
  test(`${name} removes only its own temporary root and native child output`, async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "test-temp-fixture-"));
    try {
      const file = path.join(fixture, "leaks.test.mjs");
      const report = path.join(fixture, "report.json");
      const sibling = path.join(fixture, "keep.txt");
      writeFileSync(file, fixtureSource);
      writeFileSync(sibling, "must remain");
      const code = await runNodeTests(["--test", ...flags, file], {
        env: { ...process.env, TEST_TEMP_REPORT: report, ...(fail ? { TEST_TEMP_FAIL: "1" } : {}) },
        stdio: "ignore",
      });
      assert.equal(code, fail ? 1 : 0);
      const used = JSON.parse(readFileSync(report, "utf8"));
      assert.equal(used.root, used.tmp);
      assert.equal(used.root, used.temp);
      assert.ok(path.basename(used.root).startsWith("clued-test-run-"));
      assert.equal(existsSync(used.root), false);
      assert.equal(readFileSync(sibling, "utf8"), "must remain");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("spawn failure also removes the newly allocated root", async () => {
  const parent = os.tmpdir();
  const before = readdirSync(parent).filter((name) => name.startsWith("clued-test-run-")).sort();
  await assert.rejects(runNodeTests(["--test"], { cwd: path.join(parent, "nonexistent-test-cwd-01a124d7"), stdio: "ignore" }), /ENOENT/);
  assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith("clued-test-run-")).sort(), before);
});

test("SIGTERM cancellation removes the root and stops owned descendants", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "test-temp-cancel-"));
  let child;
  try {
    const file = path.join(fixture, "wait.test.mjs");
    const report = path.join(fixture, "report.json");
    writeFileSync(file, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import test from 'node:test';
test('wait for cancellation', async () => {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  writeFileSync(process.env.TEST_TEMP_REPORT, JSON.stringify({ root: os.tmpdir(), pid: descendant.pid }));
  await new Promise(() => {});
});
`);
    child = spawn(process.execPath, [runner, "--test", file], { stdio: "ignore", env: { ...process.env, TEST_TEMP_REPORT: report } });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
    const deadline = Date.now() + 5000;
    while (!existsSync(report) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(existsSync(report), "fixture must start before cancelling");
    const used = JSON.parse(readFileSync(report, "utf8"));
    child.kill("SIGTERM");
    assert.equal(await closed, 143);
    assert.equal(existsSync(used.root), false);
    // On Linux a killed process may briefly remain as a zombie until reaped.
    const processState = `/proc/${used.pid}/stat`;
    if (existsSync(processState)) assert.match(readFileSync(processState, "utf8"), /\) Z /);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    rmSync(fixture, { recursive: true, force: true });
  }
});
