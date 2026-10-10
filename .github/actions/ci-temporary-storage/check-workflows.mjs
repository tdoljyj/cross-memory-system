import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// These are the application's eight recurring installation/test consumers.
// Production deployment and repository-control workflows retain their own scope.
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(fileURLToPath(new URL("../../workflows", import.meta.url)));
  const findings = checkApplicationWorkflows(directory);
  if (findings.length) { console.error(findings.join("\n")); process.exitCode = 1; }
  else console.log(`CI temporary-storage coverage: ${APPLICATION_WORKFLOWS.length} application workflows passed`);
}
