import { readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Preserve the seven recurring application consumers as a compatibility subset;
// repository-wide checks below also cover control and production source.
export const APPLICATION_WORKFLOWS = [
  "clued-cloud-node22-install.yml",
  "clued-integration-runtime-nightly.yml",
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

// Task 04f9b91b: these exact steps export the trusted action from a local Git object
// into the workspace. They run only after the job's full candidate checkout.
const REQUIRED_TESTS_EXPORT = "7dda24823a69cd63043ef0a380c609fde16fb992930ee101096db5412f876faf";
const TRUSTED_ARCHIVES = {
  "clued-required-tests.yml": {
    "clued-cloud-tests": REQUIRED_TESTS_EXPORT,
    "ci-suites": REQUIRED_TESTS_EXPORT,
    "migration-verify": REQUIRED_TESTS_EXPORT,
    gitleaks: "0b1aaeb20af7dd104e7d2bebd8f0f519e87583b9e91b7ff603ed6a35bbf709b6",
    trivy: "1d272c7e2327fa6b3406e28421c63b8433cfe3f1b48bfcd8cbeaf154fbcf8726",
    "contract-placement": "6008bbce98a79d4e55cde4265071e227575deafb8bb2e1d50197c0e43ab75ed8",
  },
  "clued-required-tests-windows.yml": {
    "ci-suites-windows": "5f14d714189fc60ba4e359881ddeeff3c7d6c1e15858557d20d5ee1a8759f64b",
  },
};

function trustedArchiveIndex(name, id, steps) {
  const hash = TRUSTED_ARCHIVES[name]?.[id];
  if (!hash) return -1;
  const candidate = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@") &&
    condition(step.if ?? "true") === "true" && step.with?.path === "candidate" &&
    step.with["fetch-depth"] === 0 && step.with["persist-credentials"] === false);
  if (candidate === -1) return -1;
  return steps.findIndex((step, index) => index > candidate && stepFingerprint(step) === hash);
}

// These Source candidates classify six exact pre-bootstrap guards, not whole jobs.
// The scan-permission lifecycle DOES write its single no-clobber RUNNER_TEMP
// producer and consumes the original once permission. It is never read-only.
// Whole YAML, parsed definition, guard and builtin-only producer closure pins
// prevent coverage metadata alone from registering an exception. Later runtime
// still requires the ordinary bootstrap. Source acceptance is a separate gate.
const REGISTERED_PRE_BOOTSTRAP = [
  {
    "file": "clued-handover-disposable-idle.yml",
    "job": "disposable-idle",
    "lifecycle": "native617-read-guard-v1",
    "workflow_sha256": "133554a025b122737198289925920b31992191a96a5321242d3c78cf119acf66",
    "definition_sha256": "ed7a2f81f6c43de8b473a60f30a7a155c7c3197fec6c2a3a09c71d49c1b8ba66",
    "guardIndex": 1,
    "bootstrapIndex": 3,
    "guard_step_sha256": "273979e088d94cb400ee370a03d56520df0b6723c4e7f0a2284eb4e3fd77c903",
    "closure": {
      "scripts/ci/clued-handover-native-entry.mjs": "6f6366e3ac098421ca2b1300fc299c17c5cc4bf439bec83adeae9fec69925b7f",
      "config/clued-handover-native-entry-policy.json": "161217046e6df8267fd76ab80b898a62af615213e2d3ecb90292f8667a642dcf"
    },
    "lifecycle_effect": "read_only_qualification_guard_before_candidate_bootstrap",
    "conditional_checkout_implied_by_guard": false
  },
  {
    "file": "clued-handover-external-qualification.yml",
    "job": "qualify",
    "lifecycle": "native617-read-guard-v1",
    "workflow_sha256": "c42ab88ddb6e8f0774ec55cecf3507578870f8233d6ec11c09162212f3442d5f",
    "definition_sha256": "6167e3acdc666d97021e8dd068c9b1b02a14b87ad7a7ee4116f81a832af7ed30",
    "guardIndex": 1,
    "bootstrapIndex": 3,
    "guard_step_sha256": "273979e088d94cb400ee370a03d56520df0b6723c4e7f0a2284eb4e3fd77c903",
    "closure": {
      "scripts/ci/clued-handover-native-entry.mjs": "6f6366e3ac098421ca2b1300fc299c17c5cc4bf439bec83adeae9fec69925b7f",
      "config/clued-handover-native-entry-policy.json": "161217046e6df8267fd76ab80b898a62af615213e2d3ecb90292f8667a642dcf"
    },
    "lifecycle_effect": "read_only_qualification_guard_before_candidate_bootstrap",
    "conditional_checkout_implied_by_guard": false
  },
  {
    "file": "clued-native617-admission-dispatch.yml",
    "job": "admit",
    "lifecycle": "native617-read-guard-v1",
    "workflow_sha256": "03528c7c651114476d596e16944643108743681024bc32a54760f8ad93dbe460",
    "definition_sha256": "6feee13f778e83c15457e15d31c613bdd16d56c1c4d93f03a7b4368a55ca18d4",
    "guardIndex": 1,
    "bootstrapIndex": 3,
    "guard_step_sha256": "273979e088d94cb400ee370a03d56520df0b6723c4e7f0a2284eb4e3fd77c903",
    "closure": {
      "scripts/ci/clued-handover-native-entry.mjs": "6f6366e3ac098421ca2b1300fc299c17c5cc4bf439bec83adeae9fec69925b7f",
      "config/clued-handover-native-entry-policy.json": "161217046e6df8267fd76ab80b898a62af615213e2d3ecb90292f8667a642dcf"
    },
    "lifecycle_effect": "read_only_qualification_guard_before_candidate_bootstrap",
    "conditional_checkout_implied_by_guard": false
  },
  {
    "file": "contract-placement.yml",
    "job": "contract-placement",
    "lifecycle": "ordinary-qualified-subject-guard-v1",
    "workflow_sha256": "4898299bee3e804a19acfef51d15b582e5a52526a655a290cf09bb56c39de84b",
    "definition_sha256": "2b0a7742e800d3bdc444997cedb350974eccd9be12c10a8c5cd882b35191ed0d",
    "guardIndex": 2,
    "bootstrapIndex": 3,
    "guard_step_sha256": "e82d657ea857f6d873fcc2e8b706312d6998c9c5c7ca39e702115e41b7e504ad",
    "closure": {},
    "lifecycle_effect": "read_only_qualification_guard_before_candidate_bootstrap",
    "conditional_checkout_implied_by_guard": true
  },
  {
    "file": "gitleaks.yml",
    "job": "gitleaks-trusted-self-hosted",
    "lifecycle": "native-scan-permission-runner-temp-v1",
    "workflow_sha256": "116e6b201e30251b0f702ff4416dcfd015d2b311cbd2f000cdcd3e81e6d29966",
    "definition_sha256": "e96e5406c618bd6ac0a719f999c96cb02b85545c75cd62b9001a901f3486d491",
    "guardIndex": 1,
    "bootstrapIndex": 2,
    "guard_step_sha256": "2b75bae673d4a9d1d06f785c3fdc527686b68241f65a6873d80acd0330ff2232",
    "closure": {
      "scripts/ci/clued-scan-start.mjs": "02eea1acaecc39ec179ac4201246509152dbf7bb7119687fb7cf640fb86146e1"
    },
    "lifecycle_effect": "fixed_RUNNER_TEMP_clued_scan_start_source_CreateNew_plus_original_Native_once_HTTP_burn",
    "conditional_checkout_implied_by_guard": false
  },
  {
    "file": "trivy.yml",
    "job": "trivy-trusted-self-hosted",
    "lifecycle": "native-scan-permission-runner-temp-v1",
    "workflow_sha256": "ef85f4ad53e75d2105c1892600b83b8b70b198dc1518ff856ba53fb6c4053ccb",
    "definition_sha256": "9648c3561d8c5bc0835190f5dbb201f9dcc69d6dc6f6e2f04ab77b003fe17192",
    "guardIndex": 1,
    "bootstrapIndex": 2,
    "guard_step_sha256": "2b75bae673d4a9d1d06f785c3fdc527686b68241f65a6873d80acd0330ff2232",
    "closure": {
      "scripts/ci/clued-scan-start.mjs": "02eea1acaecc39ec179ac4201246509152dbf7bb7119687fb7cf640fb86146e1"
    },
    "lifecycle_effect": "fixed_RUNNER_TEMP_clued_scan_start_source_CreateNew_plus_original_Native_once_HTTP_burn",
    "conditional_checkout_implied_by_guard": false
  }
];
const canonicalDefinition = value => Array.isArray(value) ? value.map(canonicalDefinition) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalDefinition(value[key])])) : value;

function regularBoundedSource(root, relative) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Source root required");
  let target = path.resolve(root);
  if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new Error("Source root must be regular");
  const pieces = relative.split("/");
  if (pieces.some(piece => !piece || piece === "." || piece === "..")) throw new Error("Invalid fixed Source path");
  for (const [index, piece] of pieces.entries()) {
    target = path.join(target, piece);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || (index < pieces.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.size > 1048576)) {
      throw new Error("Producer Source must be bounded and regular");
    }
  }
  return readFileSync(target, "utf8");
}

function registeredPreBootstrap(document, name, id, classification, context) {
  if (!Object.hasOwn(classification, "pre_bootstrap_lifecycle")) return null;
  const row = REGISTERED_PRE_BOOTSTRAP.find(row => row.file === name && row.job === id &&
    row.lifecycle === classification.pre_bootstrap_lifecycle);
  if (!row || classification.mode !== "job-temp") return null;
  try {
    const actualSource = regularBoundedSource(context?.sourceRoot, `.github/workflows/${name}`);
    if (sourceFingerprint(actualSource) !== row.workflow_sha256 ||
        stepFingerprint(canonicalDefinition(document)) !== row.definition_sha256 ||
        stepFingerprint(document.jobs[id].steps[row.guardIndex]) !== row.guard_step_sha256 ||
        document.jobs[id].steps[row.bootstrapIndex]?.uses !== classification.action ||
        !ACTION.test(classification.action ?? "")) return null;
    // Parse the bytes we just read as well: a caller cannot pair a pinned raw
    // source with a different document, nor use metadata hashes as evidence.
    if (stepFingerprint(canonicalDefinition(parse(actualSource))) !== row.definition_sha256) return null;
    for (const [relative, expected] of Object.entries(row.closure)) {
      if (sourceFingerprint(regularBoundedSource(context.sourceRoot, relative)) !== expected) return null;
    }
    return row;
  } catch { return null; }
}

export function repositoryTemporaryStorageFindings(document, name, audit, context) {
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
    const archive = trustedArchiveIndex(name, id, steps);
    const lifecycle = registeredPreBootstrap(document, name, id, classification, context);
    if (Object.hasOwn(classification, "pre_bootstrap_lifecycle") && !lifecycle) {
      findings.push(`${label}: pre-bootstrap lifecycle Source or implementation closure is not registered`);
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
          // Only this exact registered placement guard proves the earlier
          // conditional checkout occurred before the unconditional bootstrap.
          const guardImpliesCheckout = lifecycle?.conditional_checkout_implied_by_guard === true &&
            index === lifecycle.bootstrapIndex && lifecycle.guardIndex < index;
          const available = checkoutSources(steps.slice(0, index)).some(s => s.path === prefix && s.if !== "false" &&
            (s.if === "true" || s.if === condition(step.if ?? "true") || guardImpliesCheckout));
          const exported = prefix === "trusted" && archive !== -1 && archive < index;
          if (!available && !exported) findings.push(`${label}: temporary bootstrap is not in an existing compatible checkout or trusted archive`);
          if (step.uses !== classification.action) findings.push(`${label}: temporary bootstrap changed its reviewed source checkout`);
        }
      }
      if (typeof step.run !== "string") continue;
      if (/\/(?:var\/)?tmp\//.test(step.run)) findings.push(`${label}: hard-coded shared temporary path in step ${index + 1}`);
      const setup = steps.slice(0, index).some(s => ACTION.test(s.uses ?? "") &&
        s.uses === classification.action && condition(s.if ?? "true") !== "false" &&
        (!Object.hasOwn(s, "if") || condition(s.if) === condition(step.if)));
      const registeredGuard = lifecycle && index === lifecycle.guardIndex && index < lifecycle.bootstrapIndex;
      if (classification.mode === "step-env" ? !independent : !setup && !independent && !registeredGuard && index !== archive) {
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
  const root = path.resolve(directory, "../..");
  for (const old of Object.keys(catalog.workflows ?? {})) {
    if (!files.includes(old)) findings.push(`${old}: reviewed workflow no longer exists`);
  }
  for (const name of files) {
    findings.push(...repositoryTemporaryStorageFindings(parse(readFileSync(path.join(directory, name), "utf8")), name, catalog.workflows?.[name], { sourceRoot: root }));
  }
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
