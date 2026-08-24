#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);

const LEGACY_SOURCES = [
  { path: "memory/状态.md", recordType: "state", authority: "current" },
  { path: "memory/待办.md", recordType: "task", authority: "current" },
  { path: "memory/决策.md", recordType: "decision", authority: "current" },
  { path: "memory/归档.md", recordType: "archive_snapshot", authority: "history" },
  {
    path: "memory/contexts/projects/clued/日志.md",
    recordType: "event",
    authority: "legacy_evidence_only",
    projectId: "clued",
  },
];

const CLUED_PATTERN = /(?:\bclued\b|clued-cloud|project:clued|continuity kernel|memory crud|两级五视图|正式 worker)/i;
const OTHER_PROJECT_PATTERN = /(?:游戏原型|\bUE\b|山川夜语|剧情|工作室|Atlas|Maya)/i;
const RETRACTED_PATTERN = /(?:撤回|已否决|已推翻|superseded|回退|不再采用|错误操作)/i;
const BLOCKER_PATTERN = /(?:阻塞|阻断|blocked|无法继续|等待授权|待用户确认)/i;
const FAILURE_PATTERN = /(?:失败|故障|错误|fail(?:ed)?|异常|事故)/i;
const REASON_PATTERN = /(?:原因|理由|因为|依据|归因|裁决|为什么)/i;
const EVIDENCE_PATTERN = /(?:证据|验收|测试|校验|hash|sha256|commit|run\s*`?\d+)/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return value
    .replace(/^\s*(?:[-*+] |\d+[.)]\s+|>\s*)/, "")
    .replace(/^\s*\|?|\|?\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDate(text) {
  const match = text.match(/\b(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?\b/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function classifyScope(source, heading, text) {
  if (source.projectId) return { scope: "project", project_id: source.projectId };
  const combined = `${heading} ${text}`;
  if (CLUED_PATTERN.test(combined)) return { scope: "project", project_id: "clued" };
  return { scope: "global", project_id: null };
}

function classifyStatus(recordType, text) {
  if (recordType === "event") return "evidence_only";
  if (recordType === "archive_snapshot") return "archived";
  if (RETRACTED_PATTERN.test(text)) return "superseded";
  if (recordType === "task") {
    if (/^\s*[-*+]\s*\[[xX]\]/.test(text)) return "done";
    if (BLOCKER_PATTERN.test(text)) return "blocked";
    return "backlog";
  }
  if (recordType === "state") return "current";
  return "active";
}

function candidateRisk(source, scope, projectId, heading, text, validity) {
  const risks = [];
  const combined = `${heading} ${text}`;
  if (scope === "project" && !projectId) risks.push("missing_project_id");
  if (scope === "global" && OTHER_PROJECT_PATTERN.test(combined)) {
    risks.push("missing_project_id");
  }
  if (CLUED_PATTERN.test(combined) && OTHER_PROJECT_PATTERN.test(combined)) {
    risks.push("cross_project_semantics");
  }
  if (/\b(?:Clued|clued-cloud)\s*(?:=|改名|更名|别名)/i.test(combined)) {
    risks.push("project_alias_review");
  }
  if (
    source.recordType === "state" &&
    validity === "current" &&
    /(?:冲突|矛盾|不一致|相反)/i.test(combined)
  ) {
    risks.push("contradictory_current_state");
  }
  return risks;
}

function isContentLine(line) {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^```/.test(trimmed)) return false;
  if (/^>\s*(最后更新|状态|日期|输入|边界|说明)[:：]/.test(trimmed)) return false;
  if (/^\|?\s*:?-{3,}/.test(trimmed)) return false;
  return normalizeText(trimmed).length > 0;
}

function parseSource(source, markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let heading = "";
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading = normalizeText(headingMatch[1]);
      continue;
    }
    if (!isContentLine(line)) continue;

    const normalized = normalizeText(line);
    const scope = classifyScope(source, heading, normalized);
    const indicators = {
      reason: REASON_PATTERN.test(normalized),
      failure: FAILURE_PATTERN.test(normalized),
      blocker: BLOCKER_PATTERN.test(normalized),
      retracted: RETRACTED_PATTERN.test(normalized),
      evidence: EVIDENCE_PATTERN.test(normalized),
    };
    const validity = classifyStatus(source.recordType, line);
    const sourceKey = `${source.path}\n${index + 1}\n${heading}\n${normalized}`;
    const stableId = `legacy-${sha256(sourceKey).slice(0, 24)}`;
    const risks = candidateRisk(
      source,
      scope.scope,
      scope.project_id,
      heading,
      normalized,
      validity,
    );
    const manualReview = source.authority !== "legacy_evidence_only" && risks.length > 0;

    candidates.push({
      stable_id: stableId,
      record_type: source.recordType,
      scope: scope.scope,
      project_id: scope.project_id,
      validity,
      authority: source.authority,
      source_ref: `${source.path}#L${index + 1}`,
      source_heading: heading || null,
      source_line: index + 1,
      source_date: extractDate(`${heading} ${normalized}`),
      confidence: source.projectId || scope.project_id === "clued" ? "high" : "medium",
      content_sha256: sha256(normalized),
      preview: normalized.slice(0, 160),
      indicators,
      manual_review: manualReview,
      review_reasons: risks,
      duplicate_of: null,
      migration_disposition:
        source.authority === "legacy_evidence_only"
          ? "retain_legacy_only"
          : manualReview
            ? "manual_review"
            : "candidate",
    });
  }
  return { candidates, lineCount: lines.length };
}

function markDuplicates(candidates) {
  const canonicalByHash = new Map();
  for (const candidate of candidates) {
    const canonical = canonicalByHash.get(candidate.content_sha256);
    if (!canonical) {
      canonicalByHash.set(candidate.content_sha256, candidate.stable_id);
      continue;
    }
    candidate.duplicate_of = canonical;
    candidate.preview = null;
    candidate.manual_review = false;
    candidate.review_reasons = [];
    candidate.migration_disposition = "reference_only";
  }
}

function countBy(items, key) {
  return Object.fromEntries(
    [...items.reduce((counts, item) => {
      const value = item[key] ?? "null";
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

async function readSourceBytes(repoRoot, relativePath, sourceCommit) {
  if (!sourceCommit) return readFile(path.resolve(repoRoot, relativePath));
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("--source-commit must be a full 40-character lowercase Git commit.");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "show", `${sourceCommit}:${relativePath}`],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

export async function buildInventory({
  repoRoot = REPO_ROOT,
  databaseSnapshot = null,
  asOf,
  sourceCommit = null,
}) {
  if (!asOf || Number.isNaN(Date.parse(asOf))) {
    throw new Error("A valid --as-of timestamp is required for a reproducible dry-run.");
  }

  const sourceManifest = [];
  const candidates = [];
  for (const source of LEGACY_SOURCES) {
    const bytes = await readSourceBytes(repoRoot, source.path, sourceCommit);
    const markdown = bytes.toString("utf8");
    const parsed = parseSource(source, markdown);
    sourceManifest.push({
      path: source.path,
      bytes: bytes.length,
      lines: parsed.lineCount,
      sha256: sha256(bytes),
      authority: source.authority,
    });
    candidates.push(...parsed.candidates);
  }

  markDuplicates(candidates);
  const duplicates = candidates.filter((candidate) => candidate.duplicate_of !== null);
  const manualReview = candidates.filter((candidate) => candidate.manual_review);
  const indicators = Object.fromEntries(
    ["reason", "failure", "blocker", "retracted", "evidence"].map((name) => [
      name,
      candidates.filter((candidate) => candidate.indicators[name]).length,
    ]),
  );

  return {
    schema_version: 1,
    mode: "dry_run_read_only",
    generated_at: new Date(asOf).toISOString(),
    source_git_commit: sourceCommit,
    boundaries: {
      database_writes: 0,
      production_migrations: 0,
      feature_flag_changes: 0,
      deployments: 0,
      legacy_log_authority: "legacy_evidence_only",
    },
    source_manifest: sourceManifest,
    database_snapshot: databaseSnapshot,
    summary: {
      source_files: sourceManifest.length,
      candidates: candidates.length,
      unique_candidates: candidates.length - duplicates.length,
      duplicate_references: duplicates.length,
      manual_review: manualReview.length,
      by_migration_disposition: countBy(candidates, "migration_disposition"),
      by_record_type: countBy(candidates, "record_type"),
      by_scope: countBy(candidates, "scope"),
      by_validity: countBy(candidates, "validity"),
      preserved_indicators: indicators,
    },
    candidates,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (
      !["--repo-root", "--db-snapshot", "--output", "--as-of", "--source-commit"].includes(
        name,
      )
    ) {
      throw new Error(`Unknown argument: ${name}`);
    }
    options[name.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repo_root ?? REPO_ROOT);
  const databaseSnapshot = options.db_snapshot
    ? JSON.parse(await readFile(path.resolve(repoRoot, options.db_snapshot), "utf8"))
    : null;
  const inventory = await buildInventory({
    repoRoot,
    databaseSnapshot,
    asOf: options.as_of,
    sourceCommit: options.source_commit ?? null,
  });
  const output = `${JSON.stringify(inventory, null, 2)}\n`;
  if (options.output) {
    await writeFile(path.resolve(repoRoot, options.output), output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
