// Every test invocation owns one temporary root. All test processes and their
// children inherit it, including dependencies that unpack native packages.
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A self-hosted machine can run several jobs at once. Node otherwise starts
// one test-file process per CPU in each job, starving workerd/IPC fixtures of
// their existing deadlines. Bound the default without skipping files, changing
// watchdogs, forcing exit, or overriding an explicit caller-selected limit.
export const DEFAULT_TEST_FILE_CONCURRENCY = 2;
export function boundedTestArgs(args) {
  // Both this CLI and select-tests use the canonical `--test ...` form.
  // Other invocations pass through: a later --test may be a script argument,
  // or a value of an option such as --eval, not a Node test-runner flag.
  if (args[0] !== "--test") return [...args];
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const explicit = options.some(arg => arg === "--test-concurrency" || arg.startsWith("--test-concurrency="));
  return !explicit
    ? [`--test-concurrency=${DEFAULT_TEST_FILE_CONCURRENCY}`, ...args]
    : [...args];
}

export async function runNodeTests(args, { cwd = process.cwd(), env = process.env, stdio = "inherit" } = {}) {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, "clued-test-run-"));
  let child;
  let timer;
  let receivedSignal;
  const grouped = process.platform !== "win32";
  const kill = (signal) => {
    if (!child?.pid) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const cancel = (signal) => {
    receivedSignal ??= signal;
    kill(signal);
    timer ??= setTimeout(() => kill("SIGKILL"), 5000);
    timer.unref();
  };
  const onTerm = () => cancel("SIGTERM");
  const onInt = () => cancel("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    const childEnv = { ...env, TMPDIR: directory, TMP: directory, TEMP: directory };
    // A wrapper invoked from a regression test starts an independent suite,
    // not another file inside Node's existing internal test-worker context.
    delete childEnv.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, boundedTestArgs(args), {
      cwd, stdio, detached: grouped,
      env: childEnv,
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Cancellation can leave descendants after the test runner exits.
    // The process group was created for this invocation alone.
    if (receivedSignal && grouped) kill("SIGKILL");
    const signal = receivedSignal ?? result.signal;
    return signal ? 128 + (os.constants.signals[signal] ?? 1) : (result.code ?? 1);
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    const actual = await realpath(directory);
    if (path.dirname(actual) !== parent || actual !== directory) {
      throw new Error("test temporary directory identity changed; refusing cleanup");
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// import.meta.main, not a comparison of process.argv[1] with import.meta.url:
// Node resolves links (a junction, a symlink) in the module URL but not in
// argv[1], so the comparison failed behind a link and the script ended with exit
// 0 without running a single test (defect 2102f7e1).
if (import.meta.main) {
  try {
    process.exitCode = await runNodeTests(process.argv.slice(2));
  } catch (error) {
    console.error(`run-tests: ${error.message}`);
    process.exitCode = 1;
  }
}
