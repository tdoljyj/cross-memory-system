// Keep the standalone Python packaging regressions in the normal unit-test gate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("ZIP packaging: Unicode names and Windows path regressions", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3",
    ["-B", "tests/test_storage_zip.py", "-v"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
    });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
