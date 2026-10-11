import { accessSync, appendFileSync, closeSync, constants, lstatSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// This action configures the existing job directory; it never sweeps /tmp,
// deletes an older job's files, changes npm's cache, or stops processes.
export function configureTemporaryStorage(env = process.env) {
  const raw = env.RUNNER_TEMP;
  const envFile = env.GITHUB_ENV;
  if (!raw || !envFile || /[\r\n\0]/.test(raw + envFile) || !path.isAbsolute(raw) || !path.isAbsolute(envFile)) {
    throw new Error("RUNNER_TEMP and GITHUB_ENV must be absolute, single-line paths");
  }
  if (lstatSync(raw).isSymbolicLink()) throw new Error("RUNNER_TEMP must not be a directory symlink");
  const root = realpathSync(raw);
  const info = statSync(root);
  const generic = [path.parse(root).root, os.homedir(), process.cwd(), env.GITHUB_WORKSPACE].filter(Boolean).map((p) => path.resolve(p));
  if (!info.isDirectory() || generic.includes(root) || root === "/tmp" || root === "/var/tmp") {
    throw new Error("RUNNER_TEMP must name the dedicated job directory, not a shared root");
  }
  if (process.getuid && info.uid !== process.getuid()) throw new Error("RUNNER_TEMP is not owned by the job account");
  accessSync(root, constants.W_OK | constants.X_OK);
  const probe = path.join(root, `.ci-temp-probe-${randomUUID()}`);
  try {
    const fd = openSync(probe, "wx", 0o600);
    closeSync(fd);
  } finally {
    try { unlinkSync(probe); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const values = {
    TMPDIR: root, TMP: root, TEMP: root,
    PYTHONPYCACHEPREFIX: path.join(root, "clued-pycache"),
    WRANGLER_LOG_PATH: path.join(root, "clued-wrangler-logs"),
  };
  if (env.CI_TEMP_ISOLATE_PROMPTFOO === "true") values.PROMPTFOO_CONFIG_DIR = path.join(root, "clued-promptfoo");
  else if (env.CI_TEMP_ISOLATE_PROMPTFOO && env.CI_TEMP_ISOLATE_PROMPTFOO !== "false") throw new Error("isolate-promptfoo must be true or false");
  appendFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), "utf8");
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = configureTemporaryStorage();
    console.log(`CI temporary storage: ${values.TMPDIR}`);
  } catch (error) {
    console.error(`CI temporary storage refused: ${error.message}`);
    process.exitCode = 1;
  }
}
