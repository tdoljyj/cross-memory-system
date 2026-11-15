// The database test merge-admission-clock-audit-transport-db.test.mjs pins the sha256 of three worker files, but it runs only in the
// frozen clued-g4-database.yml (paths do not list them), so a stale pin sat red unseen (#1106 changed continuity.ts; #1110 re-pinned).
// This unit test runs in the required clued-cloud-tests on every change: it reads the pins out of that file (single source) and
// fails, naming the file, when a pinned worker file changed without the pin.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN_TEST = "merge-admission-clock-audit-transport-db.test.mjs";
const source = readFileSync(path.join(cloud, "tests", PIN_TEST), "utf8");
const sha256 = (file) => crypto.createHash("sha256").update(readFileSync(path.join(cloud, file), "utf8")).digest("hex");

// file -> pattern capturing its pin in the database test
const PINNED = {
  "worker/continuity.ts": /workerSource=await fs\.readFile\(path\.join\(cloud,'worker\/continuity\.ts'\),'utf8'\)[\s\S]*?assert\.equal\(hash\(workerSource\),'([0-9a-f]{64})'\)/,
  "worker/permission-guidance.ts": /hash\(await fs\.readFile\(path\.join\(cloud,'worker\/permission-guidance\.ts'\),'utf8'\)\),'([0-9a-f]{64})'/,
  "worker/result-sanitization.ts": /hash\(await fs\.readFile\(path\.join\(cloud,'worker\/result-sanitization\.ts'\),'utf8'\)\),'([0-9a-f]{64})'/,
};

for (const [file, pattern] of Object.entries(PINNED)) {
  test(`${file} matches its pin in ${PIN_TEST}`, () => {
    const pin = pattern.exec(source)?.[1];
    assert.ok(pin, `cannot read the pin of ${file} from ${PIN_TEST}; update this test with the pin's new form`);
    assert.equal(sha256(file), pin,
      `${file} changed without changing its pin: update the sha256 in apps/clued-cloud/tests/${PIN_TEST} (and its comment)`);
  });
}
