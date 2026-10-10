import { readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Preserve the eight recurring application consumers as a compatibility subset;
// repository-wide checks below also cover control and production source.
export const APPLICATION_WORKFLOWS = [
  "clued-cloud-quality-gate.yml",
  "clued-cloud-node22-install.yml",
  "clued-integration-runtime-nightly.yml",
  "clued-connection-authorization.yml",
  "clued-g4-database.yml",
  "information-flow-e2e.yml",
  "public-mcp-protocol.yml",
  "public-mcp-behavior.yml",
];

const require = createRequire(new URL("../../../apps/clued-cloud/package.json", import.meta.url));
const { parse } = require("yaml");
const TEMP_COMMAND = /(?:\bnpm\s+(?:ci|install|run)\b|\bnpx(?:\s|$)|\bnode\s+--test\b)/;

export function temporaryStorageFindings(document, name) {
  const findings = [];
  for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
    const steps = job.steps ?? [];
    const first = steps.findIndex((step) => typeof step.run === "string" && TEMP_COMMAND.test(step.run));
    if (first === -1) continue;
    for (let index = first; index < steps.length; index++) {
      const consumer = steps[index];
      if (typeof consumer.run !== "string" || !TEMP_COMMAND.test(consumer.run)) continue;
      const configured = steps.slice(0, index).some((step) => {
        const sameCondition = !Object.hasOwn(step, "if") || step.if === consumer.if;
        return sameCondition && (step.uses === "./.github/actions/ci-temporary-storage" ||
          (typeof step.run === "string" && /TMPDIR=/.test(step.run) && /TMP=/.test(step.run) && /TEMP=/.test(step.run) && /RUNNER_TEMP/.test(step.run) && /GITHUB_ENV/.test(step.run)));
      });
      if (!configured) findings.push(`${name}/${jobName}: temporary storage must be configured before consumer step ${index + 1}, with a compatible condition`);
    }
    if (String(job.env?.PROMPTFOO_CONFIG_DIR ?? "").startsWith("/tmp/")) findings.push(`${name}/${jobName}: promptfoo state must not use the shared system temporary directory`);
    for (const step of steps.slice(first)) {
      if (["TMPDIR", "TMP", "TEMP"].some((key) => Object.hasOwn(step.env ?? {}, key))) {
        findings.push(`${name}/${jobName}: a consumer must not override the configured temporary environment`);
      }
    }
    if (name === "public-mcp-behavior.yml" && !steps.slice(0, first).some((step) => !step.if && step.uses === "./.github/actions/ci-temporary-storage" && String(step.with?.["isolate-promptfoo"]) === "true")) {
      findings.push(`${name}/${jobName}: promptfoo isolation must be enabled`);
    }
  }
  return findings;
}

export function checkApplicationWorkflows(directory) {
  const present = new Set(readdirSync(directory));
  return APPLICATION_WORKFLOWS.flatMap((name) => {
    if (!present.has(name)) return [`${name}: expected application workflow is missing`];
    return temporaryStorageFindings(parse(readFileSync(path.join(directory, name), "utf8")), name);
  });
}

export const PLATFORM_TEMP_ENVIRONMENT = Object.freeze({
  TMPDIR: "${{ runner.temp }}", TMP: "${{ runner.temp }}", TEMP: "${{ runner.temp }}",
  PYTHONPYCACHEPREFIX: "${{ runner.temp }}/clued-pycache",
  WRANGLER_LOG_PATH: "${{ runner.temp }}/clued-wrangler-logs",
});
const ACTION = /^(?:\.\/(?:[a-zA-Z0-9_-]+\/)?\.github\/actions\/ci-temporary-storage)$/;
const VENDOR_ACTION = /^actions\/(?:checkout|setup-node|setup-python|cache|upload-artifact)@/;
const GOVERNED_KEYS = Object.keys(PLATFORM_TEMP_ENVIRONMENT);
const SHARED_TEMP_ROOT = /^(?:\/(?:var\/)?tmp(?:\/|$)|[A-Za-z]:[\\/](?:Windows[\\/])?(?:Temp|tmp)(?:[\\/]|$))/i;
const condition = (value) => String(value).replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
const inlineBound = (step) => GOVERNED_KEYS.every((key) => step.env?.[key] === PLATFORM_TEMP_ENVIRONMENT[key]);

// Pin the source that a bootstrap loads, including conditional checkouts. A
// directory named trusted does not itself establish a trusted source.
export function checkoutSources(steps) {
  return steps.filter(s => s.uses?.startsWith("actions/checkout@")).map(s => ({
    uses: s.uses, if: condition(s.if ?? "true"),
    path: s.with?.path ?? "", ref: s.with?.ref ?? null, repository: s.with?.repository ?? null,
  }));
}

export function sourceFingerprint(source) {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
}

export function stepFingerprint(steps) {
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}

export function repositoryTemporaryStorageFindings(document, name, audit) {
  const findings = [];
  if (!audit || typeof audit.jobs !== "object") return [`${name}: workflow has no reviewed temporary-data classification`];
  const jobs = document.jobs ?? {};
  for (const old of Object.keys(audit.jobs)) {
    if (!Object.hasOwn(jobs, old)) findings.push(`${name}/${old}: reviewed job no longer exists`);
  }
  for (const [id, job] of Object.entries(jobs)) {
    const classification = audit.jobs[id];
    const label = `${name}/${id}`;
    if (!classification) { findings.push(`${label}: new job needs temporary-data classification`); continue; }
    if (job.uses) {
      findings.push(`${label}: reusable workflow needs an explicit source and lifecycle review`);
      continue;
    }
    const steps = job.steps ?? [];
    if (job.container || Object.keys(job.services ?? {}).length) findings.push(`${label}: container ownership and temporary mounts need explicit review`);
    const workingDirectories = [document.defaults?.run?.["working-directory"], job.defaults?.run?.["working-directory"], ...steps.map(s => s["working-directory"])];
    if (workingDirectories.some(value => SHARED_TEMP_ROOT.test(String(value ?? "")))) findings.push(`${label}: shared temporary working directory`);
    if (classification.mode === "no-temp-writes") {
      if (name !== "clued-ci-runner-heartbeat.yml" || !["windows-route", "linux-route"].includes(id) ||
          stepFingerprint(steps) !== classification.step_sha256) {
        findings.push(`${label}: read-only route probe changed; its no-write review is invalid`);
      }
      continue;
    }
    if (!["job-temp", "step-env"].includes(classification.mode)) {
      findings.push(`${label}: unknown temporary-data lifecycle`); continue;
    }
    if (classification.mode === "job-temp" && JSON.stringify(checkoutSources(steps)) !== JSON.stringify(classification.checkout_sources)) {
      findings.push(`${label}: reviewed checkout source or condition changed`);
    }
    if (classification.mode === "step-env" && checkoutSources(steps).length) {
      findings.push(`${label}: no-checkout control must not load repository code`);
    }
    for (const [key, value] of Object.entries({ ...document.env, ...job.env })) {
      const governed = GOVERNED_KEYS.find(k => k === key.toUpperCase());
      if (governed && (key !== governed || value !== PLATFORM_TEMP_ENVIRONMENT[governed])) findings.push(`${label}: overridden job temporary environment: ${key}`);
      if (key.toUpperCase() === "WRANGLER_LOG_SANITIZE" && String(value).toLowerCase() === "false") findings.push(`${label}: Wrangler diagnostic sanitization must not be disabled`);
    }
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (Object.values(step.env ?? {}).some(value => SHARED_TEMP_ROOT.test(String(value)))) findings.push(`${label}: shared temporary path in step environment ${index + 1}`);
      const injected = Object.entries(step.env ?? {}).filter(([key]) => GOVERNED_KEYS.includes(key.toUpperCase()));
      const independent = inlineBound(step) && injected.every(([key]) => GOVERNED_KEYS.includes(key));
      if (injected.length && !independent) findings.push(`${label}: partial or overridden temporary environment in step ${index + 1}`);
      if (Object.entries(step.env ?? {}).some(([key, value]) => key.toUpperCase() === "WRANGLER_LOG_SANITIZE" && String(value).toLowerCase() === "false")) {
        findings.push(`${label}: Wrangler diagnostic sanitization must not be disabled`);
      }
      if (step.uses) {
        if (!VENDOR_ACTION.test(step.uses) && !ACTION.test(step.uses)) findings.push(`${label}: unknown action temporary lifecycle: ${step.uses}`);
        if (ACTION.test(step.uses)) {
          const prefix = step.uses.slice(2, -".github/actions/ci-temporary-storage".length).replace(/\/$/, "");
          const available = checkoutSources(steps.slice(0, index)).some(s => s.path === prefix && s.if !== "false" &&
            (s.if === "true" || s.if === condition(step.if ?? "true")));
          if (!available) findings.push(`${label}: temporary bootstrap is not in an existing compatible checkout`);
          if (step.uses !== classification.action) findings.push(`${label}: temporary bootstrap changed its reviewed source checkout`);
        }
      }
      if (typeof step.run !== "string") continue;
      if (/\/(?:var\/)?tmp\//.test(step.run)) findings.push(`${label}: hard-coded shared temporary path in step ${index + 1}`);
      const setup = steps.slice(0, index).some(s => ACTION.test(s.uses ?? "") &&
        s.uses === classification.action && condition(s.if ?? "true") !== "false" &&
        (!Object.hasOwn(s, "if") || condition(s.if) === condition(step.if)));
      if (classification.mode === "step-env" ? !independent : !setup && !independent) {
        findings.push(`${label}: temporary storage is not bound before runtime step ${index + 1}`);
      }
    }
    const actualArtifacts = steps.filter(s => s.uses?.startsWith("actions/upload-artifact@")).map(s => s.with?.path ?? "");
    if (JSON.stringify(actualArtifacts) !== JSON.stringify(classification.retained_artifacts ?? [])) {
      findings.push(`${label}: retained artifact staging changed and needs review`);
    }
    const cachePaths = steps.filter(s => s.uses?.startsWith("actions/cache@")).map(s => s.with?.path ?? "");
    if (JSON.stringify(cachePaths) !== JSON.stringify(classification.persistent_action_caches ?? [])) {
      findings.push(`${label}: persistent cache staging changed and needs review`);
    }
    for (const [key, value] of Object.entries({ ...document.env, ...job.env })) {
      if (SHARED_TEMP_ROOT.test(String(value))) findings.push(`${label}: shared temporary path in ${key}`);
    }
  }
  return findings;
}

export function checkRepositoryWorkflows(directory, catalog = JSON.parse(readFileSync(new URL("coverage.json", import.meta.url), "utf8"))) {
  if (catalog.schema !== "clued.ci-temporary-storage-coverage/1") return ["temporary-data audit schema is invalid"];
  const files = readdirSync(directory).filter(name => /\.ya?ml$/.test(name));
  const findings = [];
  for (const old of Object.keys(catalog.workflows ?? {})) {
    if (!files.includes(old)) findings.push(`${old}: reviewed workflow no longer exists`);
  }
  for (const name of files) {
    findings.push(...repositoryTemporaryStorageFindings(parse(readFileSync(path.join(directory, name), "utf8")), name, catalog.workflows?.[name]));
  }
  const root = path.resolve(directory, "../..");
  const actionRoot = path.join(root, ".github/actions");
  const discover = (folder) => readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) { findings.push(`local action source must not be a symlink: ${target}`); return []; }
    if (entry.isDirectory()) return discover(target);
    return /^action\.ya?ml$/.test(entry.name) ? [target] : [];
  });
  const actions = discover(actionRoot);
  for (const target of actions) {
    const relative = path.relative(root, target).split(path.sep).join("/");
    if (!catalog.local_actions?.[relative]) findings.push(`${relative}: local action has no temporary lifecycle review`);
  }
  for (const [relative, audit] of Object.entries(catalog.local_actions ?? {})) {
    if (!actions.some(target => path.relative(root, target).split(path.sep).join("/") === relative)) {
      findings.push(`${relative}: reviewed local action no longer exists`); continue;
    }
    for (const source of [relative, ...(audit.producer_sources ?? [])]) {
      const target = path.resolve(root, source);
      if (!source.startsWith(".github/actions/") || path.relative(root, target).startsWith("..") || path.isAbsolute(source)) {
        findings.push(`${relative}: invalid reviewed producer source: ${source}`); continue;
      }
      try {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || sourceFingerprint(readFileSync(target, "utf8")) !== audit.source_sha256?.[source]) {
          findings.push(`${relative}: local action or producer source changed and needs review: ${source}`);
        }
      } catch {
        findings.push(`${relative}: reviewed producer source is missing: ${source}`);
      }
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(fileURLToPath(new URL("../../workflows", import.meta.url)));
  const findings = checkRepositoryWorkflows(directory);
  if (findings.length) { console.error(findings.join("\n")); process.exitCode = 1; }
  else console.log(`CI temporary-storage coverage: all ${readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).length} repository workflows passed`);
}
