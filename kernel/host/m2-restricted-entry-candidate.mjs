import { createHash } from "node:crypto";
import { AllowedRootPolicy } from "../runtime/runner-boundaries.mjs";

const BASE = "/srv/clued-m2/probe";
const ROLES = Object.freeze({
  A: Object.freeze({ principal: "m2-a", input: `${BASE}/a-input`, output: `${BASE}/a-work` }),
  R: Object.freeze({ principal: "m2-r", input: `${BASE}/r-input`, output: `${BASE}/r-output` }),
});
const TOOL_NAMES = Object.freeze(["m2_read_input", "m2_write_output", "m2_run_empty_probe"]);
const MAX_BYTES = 65536;
const digest = (s) => createHash("sha256").update(s).digest("hex");
const deny = (code, uncertain = false) => Object.freeze({
  status: "deny", error_code: code, qualification: "NOT_ISSUED",
  ...(uncertain ? { execution_state: "UNKNOWN" } : {}),
});
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

/** Candidate only. No OS launcher, network, credentials or default VM transport.
 * The injected transport is Host-owned, never taken from tool arguments.
 * withFile must hold verified handles / a serialization boundary through callback
 * and prevent late side effects after abort. A JS check cannot provide that alone.
 */
export function createM2RestrictedEntryCandidate({
  trustedRole = "A", trustedRoots, frozenInputs = {}, transport = null,
  leaseMs = 60000, timeoutMs = 1000,
} = {}) {
  if (typeof trustedRole !== "string" || !Object.hasOwn(ROLES, trustedRole) ||
      !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 60000 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error("HOST_PROFILE_INVALID");
  }
  const role = ROLES[trustedRole];
  const manifest = Object.freeze({ ...frozenInputs });
  const configured = transport !== null;
  const policies = {};
  if (configured) {
    if (!["withFile", "runEmptyProbe", "stopAndConfirm"].every(k => typeof transport[k] === "function")) {
      throw new Error("TRANSPORT_CONTRACT_INVALID");
    }
    for (const kind of ["input", "output"]) {
      const p = trustedRoots?.[kind];
      if (!p || typeof p.normalized_root !== "string" || p.normalized_root.length === 0) {
        throw new Error("HOST_PROFILE_INVALID");
      }
      if (!p || p.platform !== "posix" || p.normalized_root !== role[kind] ||
          p.case_sensitive !== true || p.network_share_allowed !== false ||
          !p.root_file_id || !p.volume_id || !p.policy_version) throw new Error("HOST_ROOT_INVALID");
      policies[kind] = new AllowedRootPolicy(structuredClone(p));
    }
    if (!Object.keys(manifest).length || Object.values(manifest).some(h => !/^[a-f0-9]{64}$/.test(h))) {
      throw new Error("FROZEN_INPUT_MANIFEST_REQUIRED");
    }
  }
  const started = performance.now();
  const seen = new Set();
  const active = new Set();
  let revoked = false;
  let busy = false;
  const revoke = () => {
    revoked = true;
    for (const controller of active) controller.abort();
  };
  const expired = () => performance.now() - started >= leaseMs;
  const tools = Object.freeze(TOOL_NAMES.map(name => Object.freeze({
    name, description: "M2 empty-probe candidate; OS and complete Agent tool qualification NOT_ISSUED",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: name === TOOL_NAMES[0] ? ["request_id", "path"] :
        name === TOOL_NAMES[1] ? ["request_id", "path", "content"] : ["request_id"],
      properties: Object.fromEntries((name === TOOL_NAMES[0] ? ["request_id", "path"] :
        name === TOOL_NAMES[1] ? ["request_id", "path", "content"] : ["request_id"])
        .map(k => [k, { type: "string", maxLength: k === "content" ? MAX_BYTES : 256 }])),
    },
  })));

  async function callTool(name, args) {
    if (!TOOL_NAMES.includes(name)) return deny("TOOL_NOT_ALLOWED");
    const keys = name === TOOL_NAMES[0] ? ["request_id", "path"] :
      name === TOOL_NAMES[1] ? ["request_id", "path", "content"] : ["request_id"];
    if (!exactKeys(args, keys) || keys.some(k => typeof args[k] !== "string") ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(args.request_id)) return deny("REQUEST_INVALID");
    args = Object.freeze({ ...args });
    if (revoked || expired()) { revoke(); return deny("ENTRY_REVOKED_OR_EXPIRED"); }
    if (seen.has(args.request_id)) return deny("REPLAY_REJECTED");
    // Burn IDs before async dispatch, including failed operations. Restart-safe
    // single-use semantics require a durable executor ledger before deployment.
    if (seen.size >= 256) { revoke(); return deny("ENTRY_REQUEST_LIMIT"); }
    seen.add(args.request_id);
    if (!configured) return deny("NOT_CONFIGURED");
    if (busy) return deny("ENTRY_BUSY");
    if (name !== TOOL_NAMES[2] && (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(args.path) ||
        args.path.split("/").some(p => p === "." || p === "..") || args.path.length > 256)) {
      return deny("PATH_INVALID");
    }
    if (name === TOOL_NAMES[0] && !Object.hasOwn(manifest, args.path)) return deny("INPUT_NOT_FROZEN");
    if (name === TOOL_NAMES[1] && Buffer.byteLength(args.content) > MAX_BYTES) return deny("CONTENT_TOO_LARGE");
    busy = true;
    const controller = new AbortController();
    active.add(controller);
    const callDeadline = Math.min(started + leaseMs, performance.now() + timeoutMs);
    let timer;
    let stopTimer;
    const check = () => {
      if (performance.now() >= callDeadline) revoke();
      if (controller.signal.aborted || revoked || expired()) throw new Error("ENTRY_INVALIDATED");
    };
    const dispatch = async () => {
      check();
      const binding = Object.freeze({ principal: role.principal, input_root: role.input, output_root: role.output });
      if (name === TOOL_NAMES[2]) {
        const result = await transport.runEmptyProbe(binding, controller.signal);
        check();
        // Fixed public verdict only; no raw guest stdout or caller command.
        if (result !== "EMPTY_MARKER_OK") throw new Error("PROBE_FAILED");
        return { status: "candidate_ok", qualification: "NOT_ISSUED", result };
      }
      const kind = name === TOOL_NAMES[0] ? "input" : "output";
      const policy = policies[kind];
      return transport.withFile(Object.freeze({ ...binding, root: role[kind],
        path: args.path, operation: kind === "input" ? "read" : "create" }), async handle => {
        check();
        const preview = policy.preview({ relativePath: args.path, resolution: handle.resolution,
          operation: kind === "input" ? "read" : "write", conflictPolicy: "fail" });
        const resolution = await handle.recheck();
        check();
        // authorizeCommit rejects existing targets even for reads: use preview
        // validation again for read, and compare the complete bound identity.
        if (kind === "input") {
          const current = policy.preview({ relativePath: args.path, resolution, operation: "read" });
          if (current.preview_digest !== preview.preview_digest) throw new Error("INPUT_IDENTITY_DRIFT");
          const content = await handle.read(MAX_BYTES, controller.signal);
          check();
          if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES || digest(content) !== manifest[args.path]) {
            throw new Error("FROZEN_INPUT_MISMATCH");
          }
          return { status: "candidate_ok", qualification: "NOT_ISSUED", content };
        }
        policy.authorizeCommit(preview, { relativePath: args.path, resolution });
        check();
        await handle.create(args.content, controller.signal);
        check();
        return { status: "candidate_ok", qualification: "NOT_ISSUED", sha256: digest(args.content) };
      }, controller.signal);
    };
    try {
      const interrupted = new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("ENTRY_INTERRUPTED")), { once: true });
        timer = setTimeout(() => { revoke(); }, Math.max(1, callDeadline - performance.now()));
      });
      const result = await Promise.race([dispatch(), interrupted]);
      // A synchronous transport can prevent timer callbacks while promise
      // microtasks still resolve. Recheck time after all transport/wrapper work.
      check();
      return result;
    } catch {
      // No exception text (paths, guest output or secrets) crosses the surface.
      if (performance.now() >= callDeadline) revoke();
      if (controller.signal.aborted) {
        const stopDeadline = performance.now() + 100;
        const stopped = await Promise.race([
          Promise.resolve().then(() => transport.stopAndConfirm(controller.signal))
            .then(value => value === true && performance.now() < stopDeadline).catch(() => false),
          new Promise(resolve => { stopTimer = setTimeout(() => resolve(false), 100); }),
        ]);
        const timely = stopped === true && performance.now() < stopDeadline;
        return deny(timely ? "ENTRY_INTERRUPTED" : "EXECUTION_STOP_UNCONFIRMED", !timely);
      }
      revoke();
      return deny("OPERATION_REJECTED", true);
    } finally {
      clearTimeout(timer); clearTimeout(stopTimer);
      active.delete(controller); busy = false;
    }
  }
  return Object.freeze({
    listTools: () => structuredClone(tools), callTool, revoke,
    status: () => Object.freeze({ transport: configured ? "INJECTED_CANDIDATE_ONLY" : "NOT_CONFIGURED",
      qualification: "NOT_ISSUED", revoked: revoked || expired() }),
  });
}
