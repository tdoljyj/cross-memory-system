import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { POLLER_TRAILER, checkRepush, main, parseArgs } from "./pr-repush-preflight.mjs";

const NEW = "d6a771bf-400d-498f-a043-e9e3ac605f8b";
const OLD = "796078d6-6785-43b4-ac48-45c4d1ed14b0";
const SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const HEAD = "378da6e1bfba2a46cb62203766d1827b4b86974f";
const text = (claim, scope = SCOPE) => `Summary line.\n\nDetails.\n\nClued-Work-Claim: ${claim}\nClued-Work-Scope: ${scope}\n`;
const codes = r => r.problems.map(p => p.code).sort();

test("the poller trailer here is the resident poller's own, character for character", () => {
  const poller = fs.readFileSync(new URL("../../work/independent-ci-resident-v1/src/poller.mjs", import.meta.url), "utf8");
  const m = /^const TRAILER = (\/.+\/m);$/m.exec(poller);
  assert.ok(m, "poller.mjs no longer declares TRAILER on one line: update POLLER_TRAILER and this test together");
  assert.equal(String(POLLER_TRAILER), m[1]);
});

test("body and head commit both name the live claim and scope: OK", () => {
  const r = checkRepush({ prBody: text(NEW), commitMessage: text(NEW), claim: NEW, scope: SCOPE });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test("the PR body still names the old claim (the #992 case): refused with the body edit to make", () => {
  const r = checkRepush({ prBody: text(OLD), commitMessage: text(NEW), claim: NEW, scope: SCOPE });
  assert.deepEqual(codes(r), ["BODY_CLAIM_MISMATCH"]);
  assert.equal(r.problems[0].found, OLD);
  assert.match(r.problems[0].fix, new RegExp(`Clued-Work-Claim: ${NEW}`));
});

test("the head commit still names the old claim: refused even though the body wins, and told to check the new SHA", () => {
  const r = checkRepush({ prBody: text(NEW), commitMessage: text(OLD), claim: NEW, scope: SCOPE });
  assert.deepEqual(codes(r), ["COMMIT_CLAIM_MISMATCH"]);
  assert.match(r.problems[0].fix, /run this check again with the new SHA/);
});

test("both stale: both reported", () => {
  const r = checkRepush({ prBody: text(OLD), commitMessage: text(OLD), claim: NEW, scope: SCOPE });
  assert.deepEqual(codes(r), ["BODY_CLAIM_MISMATCH", "COMMIT_CLAIM_MISMATCH"]);
});

test("no trailer in the body: refused, because the resident never proposes such a PR", () => {
  const r = checkRepush({ prBody: "Summary only.\n", commitMessage: text(NEW), claim: NEW, scope: SCOPE });
  assert.deepEqual(codes(r), ["BODY_TRAILER_MISSING"]);
  assert.match(r.problems[0].fix, /never proposes/);
  assert.equal(checkRepush({ prBody: null, commitMessage: "", claim: NEW }).problems[0].code, "BODY_TRAILER_MISSING");
  assert.equal(checkRepush({ prBody: "\n", commitMessage: "", claim: NEW }).problems[0].code, "BODY_TRAILER_MISSING");
});

test("an upper-case claim in the body passes admission's parser but not the poller's: refused, saying so", () => {
  const r = checkRepush({ prBody: text(NEW.toUpperCase()), commitMessage: "", claim: NEW, scope: SCOPE });
  assert.deepEqual(codes(r), ["BODY_TRAILER_MISSING"]);
  assert.equal(r.problems[0].found, NEW);
  assert.match(r.problems[0].fix, /not lower case/);
});

test("a claim line the poller accepts but admission cannot read is refused, not a crash", () => {
  // escapes, not literal characters, so the cases stay visible in review
  for (const body of [`x\n\nClued-Work-Claim:\n${NEW}\n`, `x\n\nClued-Work-Claim:\u00a0${NEW}\n`, `x\n\nClued-Work-Claim: ${NEW}\u00a0\n`,
    `x\n\nClued-Work-Claim:\v${NEW}\n`]) {
    assert.ok(POLLER_TRAILER.test(body));
    const r = checkRepush({ prBody: body, commitMessage: text(OLD), claim: NEW, scope: SCOPE });
    assert.deepEqual(codes(r), ["BODY_TRAILER_UNPARSEABLE", "COMMIT_CLAIM_MISMATCH"]);
  }
});

test("CRLF bodies, and a first upper-case line followed by a lower-case one, are read as the runtime reads them", () => {
  assert.equal(checkRepush({ prBody: text(NEW).replace(/\n/g, "\r\n"), commitMessage: "", claim: NEW, scope: SCOPE }).ok, true);
  // admission takes the first line (upper case, OLD here); the poller only needs some lower-case line: a mismatch
  const mixed = `x\n\nClued-Work-Claim: ${OLD.toUpperCase()}\nClued-Work-Claim: ${NEW}\nClued-Work-Scope: ${SCOPE}\n`;
  assert.deepEqual(codes(checkRepush({ prBody: mixed, commitMessage: "", claim: NEW, scope: SCOPE })), ["BODY_CLAIM_MISMATCH"]);
});

test("no trailer in the head commit is fine: the body decides", () => {
  assert.equal(checkRepush({ prBody: text(NEW), commitMessage: "ci: something\n", claim: NEW, scope: SCOPE }).ok, true);
});

test("scope mismatches are reported where they are; a missing scope line and a missing --scope both mean global", () => {
  const other = "project:11111111-2222-3333-4444-555555555555";
  assert.deepEqual(codes(checkRepush({ prBody: text(NEW, other), commitMessage: text(NEW, other), claim: NEW, scope: SCOPE })),
    ["BODY_SCOPE_MISMATCH", "COMMIT_SCOPE_MISMATCH"]);
  const noScope = `x\n\nClued-Work-Claim: ${NEW}\n`;
  assert.deepEqual(codes(checkRepush({ prBody: noScope, commitMessage: "", claim: NEW, scope: SCOPE })), ["BODY_SCOPE_MISMATCH"]);
  assert.equal(checkRepush({ prBody: noScope, commitMessage: "", claim: NEW, scope: "global" }).ok, true);
  assert.equal(checkRepush({ prBody: noScope, commitMessage: noScope, claim: NEW }).ok, true);
  const r = checkRepush({ prBody: text(NEW, other), commitMessage: text(NEW, other), claim: NEW });
  assert.deepEqual(codes(r), ["BODY_SCOPE_MISMATCH", "COMMIT_SCOPE_MISMATCH"]);
  assert.match(r.problems.find(p => p.code === "BODY_SCOPE_MISMATCH").fix, /remove the Clued-Work-Scope line/);
});

test("arguments: every malformed or repeated one is refused, naming it", () => {
  const good = ["--repo", "o/r", "--pr", "992", "--head", HEAD, "--claim", NEW];
  assert.deepEqual(parseArgs(good), { args: { repo: "o/r", pr: 992, head: HEAD, claim: NEW, scope: "global" } });
  assert.equal(parseArgs([...good, "--scope", SCOPE]).args.scope, SCOPE);
  assert.equal(parseArgs(good.map(v => (v === "o/r" ? "tdoljyj/.github" : v))).args.repo, "tdoljyj/.github");
  const swap = (from, to) => good.map(v => (v === from ? to : v));
  const cases = [
    [[], /--repo is required/], [["--repo", "o/r"], /--pr is required/], [[...good, "--pr", "1"], /--pr given twice/],
    [[...good, "--extra", "x"], /unknown argument "--extra"/], [["--repo=o/r", "--pr"], /unknown argument "--repo=o\/r"/],
    [[...good, "--scope", "project:x"], /--scope/], [[...good, "--scope", "project:0597AA60-9b98-4da6-a4ab-63d7705b632f"], /--scope/],
    [swap(NEW, NEW.toUpperCase()), /--claim/], [swap(HEAD, HEAD.slice(0, 12)), /--head/], [swap("992", "0"), /--pr must/],
    [good.slice(0, -1), /--claim needs a value/], [swap("o/r", "o/.."), /--repo/], [swap("o/r", "-o/r"), /--repo/],
    [swap("o/r", "o/r/x"), /--repo/], [swap("o/r", "o/."), /--repo/], [swap("o/r", ".o/r"), /--repo/],
  ];
  for (const [argv, why] of cases) assert.match(parseArgs(argv).error ?? "", why, JSON.stringify(argv));
});

function capture() { const s = { text: "", write(t) { s.text += t; } }; return s; }
const ARGV = ["--repo", "o/r", "--pr", "992", "--head", HEAD, "--claim", NEW, "--scope", SCOPE];

test("main: exit 0 / 1 / 2 with injected readers, and the readers get the PR and head asked for", async () => {
  const seen = [];
  const ports = (body, msg) => ({
    readPrBody: async (repo, pr) => { seen.push([repo, pr]); return body; },
    readCommitMessage: async head => { seen.push([head]); return msg; },
  });
  let out = capture(), err = capture();
  assert.equal(await main(ARGV, ports(text(NEW), text(NEW)), out, err), 0);
  assert.equal(out.text, `OK: PR #992 body and head 378da6e1 name claim ${NEW}, scope ${SCOPE}\n`);
  assert.deepEqual(seen, [["o/r", 992], [HEAD]]);

  out = capture();
  assert.equal(await main(ARGV, ports(text(NEW), "ci: x\n"), out, err), 0);
  assert.match(out.text, /head 378da6e1 has no trailer, so the body decides/);

  out = capture();
  assert.equal(await main(ARGV, ports(text(OLD), text(NEW)), out, err), 1);
  assert.match(out.text, /BODY_CLAIM_MISMATCH \(pr-body\): found 796078d6/);

  out = capture(); err = capture();
  assert.equal(await main(["--pr", "1"], ports("", ""), out, err), 2);
  assert.match(err.text, /^--repo is required\nusage:/);

  err = capture();
  const failing = { readPrBody: async () => { throw new Error("gh pr failed (1): Could not resolve to a PullRequest"); }, readCommitMessage: async () => "" };
  assert.equal(await main(ARGV, failing, capture(), err), 2);
  assert.match(err.text, /^PREFLIGHT_READ_FAILED: gh pr failed \(1\): Could not resolve/);
});

test("main: anything unexpected is exit 2 PREFLIGHT_INTERNAL_ERROR, never exit 1 or a stack", async () => {
  const err = capture();
  const ports = { readPrBody: async () => text(NEW), readCommitMessage: async () => text(NEW) };
  const out = { write() { throw new Error("stdout closed"); } };
  assert.equal(await main(ARGV, ports, out, err), 2);
  assert.equal(err.text, "PREFLIGHT_INTERNAL_ERROR: stdout closed\n");
});

const TOOL = fileURLToPath(new URL("./pr-repush-preflight.mjs", import.meta.url));
const runNode = args => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });

test("CLI: run directly it checks (a usage error is exit 2), also through a junction or symlink; importing it runs nothing", () => {
  const direct = runNode([TOOL]);
  assert.equal(direct.status, 2, direct.stderr);
  assert.match(direct.stderr, /--repo is required/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repush-preflight-"));
  try {
    const link = path.join(dir, "ci");
    fs.symlinkSync(path.dirname(TOOL), link, process.platform === "win32" ? "junction" : "dir");
    const linked = runNode([path.join(link, "pr-repush-preflight.mjs")]);
    assert.equal(linked.status, 2, `through a link the check must still run (stderr: ${linked.stderr})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const imported = runNode(["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./pr-repush-preflight.mjs", import.meta.url).href)}); console.log("imported")`]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "imported\n");
  // an importer whose first argument is a path that does not exist still runs nothing
  const missing = path.join(os.tmpdir(), "repush-preflight-no-such-file.mjs");
  const importedWithArg = runNode(["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./pr-repush-preflight.mjs", import.meta.url).href)}); console.log("imported")`, missing]);
  assert.equal(importedWithArg.status, 0, importedWithArg.stderr);
  assert.equal(importedWithArg.stdout, "imported\n");
});
