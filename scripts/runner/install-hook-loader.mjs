#!/usr/bin/env node
// One-time switch of a runner host to the hook loader (scripts/runner/README.md, "Installing the loader"). The same command on
// every host; the place comes from the platform (Linux /opt/clued-runner-hook, Windows C:\ProgramData\CluedRunnerHook), never a
// machine name. Run as root (Linux) or elevated (Windows): the hook's folder is read-only for the runner accounts.
//   node install-hook-loader.mjs --loader <clued-runner-hook-loader.mjs> --sha256 <hex> [--result <file>]   install (idempotent)
//   node install-hook-loader.mjs --rollback [--result <file>]                                             put .prev back
// Install: the loader's bytes must be the expected sha256, or nothing is touched. The installed clued-runner-job-started.mjs is
// kept as clued-runner-job-started.mjs.prev, then overwritten in place (owner, mode and ACL stay the file's; wrappers, settings,
// keys and services are not touched, no restart). Self-check: the file's sha256 is the expected one and it imports as the loader.
// A failed self-check puts .prev back. Already the loader: nothing is done. One JSON line says what happened.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HOOK_DIRS = { linux: "/opt/clued-runner-hook", win32: "C:\\ProgramData\\CluedRunnerHook" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The installed file imports as the loader (its version), without running it: import.meta.main is false under import().
function selfCheck(file, expected) {
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expected) return `the installed file is not the expected bytes (${sha256(bytes)})`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(m.LOADER_VERSION ?? "", typeof m.load);`],
    { encoding: "utf8", timeout: 30_000 });
  const [version, load] = String(child.stdout ?? "").trim().split(" ");
  return child.status === 0 && /^\d+\.\d+\.\d+$/.test(version ?? "") && load === "function" ? null
    : `the installed file does not import as the loader (${String(child.stderr || child.stdout).trim().slice(0, 200)})`;
}

export function install({ dir, loaderFile, expected, rollback = false }) {
  const target = path.join(dir, "clued-runner-job-started.mjs");
  const prev = `${target}.prev`;
  if (!fs.existsSync(target)) return { status: "REFUSED", why: `${target} does not exist: this host has no hook to replace` };
  if (rollback) {
    if (!fs.existsSync(prev)) return { status: "REFUSED", why: `${prev} does not exist` };
    fs.writeFileSync(target, fs.readFileSync(prev));
    return { status: "ROLLED_BACK", sha256: sha256(fs.readFileSync(target)) };
  }
  if (!/^[0-9a-f]{64}$/.test(expected ?? "")) return { status: "REFUSED", why: "--sha256 is not a sha256" };
  const loader = fs.readFileSync(loaderFile);
  if (sha256(loader) !== expected) return { status: "REFUSED", why: `${loaderFile} is not the expected loader (${sha256(loader)})` };
  const current = fs.readFileSync(target);
  if (sha256(current) === expected) {
    const why = selfCheck(target, expected);
    return why ? { status: "CHECK_FAILED", why } : { status: "ALREADY", sha256: expected };
  }
  fs.writeFileSync(prev, current);
  fs.writeFileSync(target, loader);
  const why = selfCheck(target, expected);
  if (!why) return { status: "INSTALLED", sha256: expected, prevSha256: sha256(current) };
  fs.writeFileSync(target, current);
  return { status: "ROLLED_BACK", why, sha256: sha256(fs.readFileSync(target)) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  let outcome;
  try {
    const dir = value("--dir") ?? HOOK_DIRS[process.platform];
    if (!dir) throw new Error(`no hook folder is known for ${process.platform}`);
    outcome = { dir, ...install({ dir, loaderFile: value("--loader"), expected: value("--sha256"), rollback: args.includes("--rollback") }) };
  } catch (error) {
    outcome = { status: "FAILED", why: error instanceof Error ? error.message : String(error) };
  }
  const line = JSON.stringify(outcome);
  console.log(line);
  if (value("--result")) fs.writeFileSync(value("--result"), `${line}\n`);
  process.exit(["INSTALLED", "ALREADY", "ROLLED_BACK"].includes(outcome.status) && !(outcome.status === "ROLLED_BACK" && outcome.why) ? 0 : 1);
}
