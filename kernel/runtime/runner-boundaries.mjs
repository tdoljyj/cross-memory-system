import { createHash } from "node:crypto";

export class RunnerBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "RunnerBoundaryError";
    this.code = code;
  }
}
const clone = (value) => structuredClone(value);
const sha = (value) => "sha256:" + createHash("sha256").update(
  typeof value === "string" ? value : JSON.stringify(value),
).digest("hex");
function reject(code) { throw new RunnerBoundaryError(code); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function stableDigest(value) { return sha(JSON.stringify(stable(value))); }

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function normalizeRelativePath(platform, input, caseSensitive, unicodeForm) {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) {
    reject("PATH_INVALID");
  }
  const normalizedUnicode = input.normalize(unicodeForm);
  if (platform === "windows") {
    if (/^(?:[a-z]:|[\\/]{2}|\\\\[?.]\\|globalroot|device\\)/i.test(normalizedUnicode)) {
      reject("ABSOLUTE_OR_DEVICE_PATH_FORBIDDEN");
    }
    const segments = normalizedUnicode.replaceAll("\\", "/").split("/");
    if (segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".." ||
      /[. ]$/.test(segment) || segment.includes(":") || segment.includes("~") ||
      WINDOWS_RESERVED.test(segment))) {
      reject("WINDOWS_PATH_AMBIGUOUS");
    }
    const joined = segments.join("/");
    return caseSensitive ? joined : joined.toLocaleLowerCase("en-US");
  }
  if (normalizedUnicode.startsWith("/")) reject("ABSOLUTE_OR_DEVICE_PATH_FORBIDDEN");
  const segments = normalizedUnicode.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    reject("PATH_TRAVERSAL_OR_AMBIGUITY");
  }
  return segments.join("/");
}

export class AllowedRootPolicy {
  constructor(profile) {
    if (!["windows", "posix"].includes(profile.platform) ||
        typeof profile.root_file_id !== "string" || typeof profile.volume_id !== "string" ||
        typeof profile.policy_version !== "string") reject("ALLOWED_ROOT_PROFILE_INVALID");
    this.profile = Object.freeze({
      platform: profile.platform,
      normalized_root: profile.normalized_root,
      root_file_id: profile.root_file_id,
      volume_id: profile.volume_id,
      case_sensitive: Boolean(profile.case_sensitive),
      unicode_form: profile.unicode_form || "NFC",
      network_share_allowed: Boolean(profile.network_share_allowed),
      policy_version: profile.policy_version,
    });
  }

  #validateResolution(relativePath, resolution, operation) {
    const canonical_path = normalizeRelativePath(
      this.profile.platform,
      relativePath,
      this.profile.case_sensitive,
      this.profile.unicode_form,
    );
    if (!resolution || resolution.root_file_id !== this.profile.root_file_id ||
        resolution.volume_id !== this.profile.volume_id ||
        resolution.policy_version !== this.profile.policy_version ||
        resolution.network_share === true && !this.profile.network_share_allowed ||
        !Array.isArray(resolution.components) ||
        resolution.components.length !== canonical_path.split("/").length) {
      reject("ALLOWED_ROOT_IDENTITY_MISMATCH");
    }
    for (const component of resolution.components) {
      if (!component.no_follow || component.reparse || component.symlink || component.mount_escape ||
          component.special_object || component.identity_ambiguous) {
        reject("HANDLE_RESOLUTION_UNSAFE");
      }
      if (["write", "replace", "delete", "move"].includes(operation) && component.link_count > 1) {
        reject("HARDLINK_IDENTITY_UNSAFE");
      }
    }
    return {
      canonical_path,
      root_file_id: resolution.root_file_id,
      volume_id: resolution.volume_id,
      parent_file_id: resolution.parent_file_id,
      final_file_id: resolution.final_file_id ?? null,
      target_exists: Boolean(resolution.target_exists),
      components: clone(resolution.components),
      policy_version: resolution.policy_version,
    };
  }

  preview({ relativePath, resolution, operation = "read", conflictPolicy = "fail" }) {
    if (!["read", "write", "replace", "delete", "move"].includes(operation)) reject("OPERATION_UNDECLARED");
    if (!["fail", "version", "rename", "replace"].includes(conflictPolicy)) reject("CONFLICT_POLICY_INVALID");
    if (operation !== "read" && resolution.target_exists && conflictPolicy === "fail") {
      reject("NO_OVERWRITE_CONFLICT");
    }
    const identity = this.#validateResolution(relativePath, resolution, operation);
    const preview = {
      operation,
      conflict_policy: conflictPolicy,
      identity,
      allowed_root_profile_digest: stableDigest(this.profile),
    };
    return Object.freeze({ ...preview, preview_digest: stableDigest(preview) });
  }

  authorizeCommit(preview, { relativePath, resolution }) {
    const current = this.#validateResolution(relativePath, resolution, preview.operation);
    const expected = preview.identity;
    if (stableDigest(current) !== stableDigest(expected) ||
        preview.allowed_root_profile_digest !== stableDigest(this.profile)) {
      reject("DRY_RUN_IDENTITY_DRIFT");
    }
    if (current.target_exists && preview.conflict_policy === "fail") reject("NO_OVERWRITE_CONFLICT");
    return Object.freeze({ authorized: true, preview_digest: preview.preview_digest, identity: current });
  }
}

function parseIpv4(value) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts;
}
function globallyRoutableIp(value) {
  const v4 = parseIpv4(value);
  if (v4) {
    const [a,b] = v4;
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 192 && b === 0) ||
        (a === 192 && b === 0 && v4[2] === 2) ||
        (a === 198 && (b === 18 || b === 19 || b === 51)) ||
        (a === 203 && b === 0 && v4[2] === 113)) return false;
    return true;
  }
  const lower = String(value).toLowerCase();
  if (lower.includes("%") || lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:") ||
      lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
      lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") ||
      lower.startsWith("feb") || lower.startsWith("ff")) return false;
  return /^[0-9a-f:]+$/.test(lower) && lower.includes(":");
}

export class HttpEgressPolicy {
  constructor(profile) {
    this.profile = Object.freeze({
      policy_version: profile.policy_version,
      resolver_id: profile.resolver_id,
      allowed_origins: [...profile.allowed_origins],
      allowed_methods: [...profile.allowed_methods],
      connection_max_age: profile.connection_max_age,
      system_proxy_disabled: profile.system_proxy_disabled === true,
    });
    if (!this.profile.system_proxy_disabled || !Number.isFinite(this.profile.connection_max_age)) {
      reject("HTTP_POLICY_INVALID");
    }
  }

  authorizeRequest({ url, method, dns, now, secretAudience = null }) {
    let parsed;
    try { parsed = new URL(url); } catch { reject("URL_INVALID"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.hostname.endsWith(".") || parsed.hostname.includes("%") ||
        !["", "443"].includes(parsed.port)) reject("URL_NORMALIZATION_REJECTED");
    const origin = "https://" + parsed.hostname.toLowerCase() + ":443";
    if (!this.profile.allowed_origins.includes(origin) || !this.profile.allowed_methods.includes(method)) {
      reject("HTTP_TARGET_NOT_ALLOWED");
    }
    if (secretAudience !== null && secretAudience !== origin + parsed.pathname) {
      reject("SECRET_AUDIENCE_MISMATCH");
    }
    if (!dns || dns.resolver_id !== this.profile.resolver_id ||
        dns.policy_version !== this.profile.policy_version ||
        !Array.isArray(dns.addresses) || dns.addresses.length === 0 ||
        !Number.isFinite(dns.verified_at) || !Number.isFinite(dns.chain_min_ttl) ||
        dns.addresses.some((address) => !globallyRoutableIp(address))) {
      reject("DNS_SET_REJECTED");
    }
    const expiresAt = dns.verified_at + Math.min(dns.chain_min_ttl, this.profile.connection_max_age);
    if (now >= expiresAt) reject("DNS_OR_CONNECTION_EXPIRED");
    const decision = {
      origin,
      path: parsed.pathname + parsed.search,
      method,
      verified_addresses: [...new Set(dns.addresses)].sort(),
      verified_at: dns.verified_at,
      expires_at: expiresAt,
      policy_version: this.profile.policy_version,
      resolver_id: this.profile.resolver_id,
      secret_audience: secretAudience,
    };
    return Object.freeze({ ...decision, decision_digest: stableDigest(decision) });
  }

  authorizeConnect(decision, { address, now, policyVersion }) {
    if (policyVersion !== this.profile.policy_version ||
        decision.policy_version !== this.profile.policy_version ||
        now >= decision.expires_at || !decision.verified_addresses.includes(address)) {
      reject("PINNED_CONNECT_REJECTED");
    }
    return Object.freeze({ connect_by_verified_ip: true, address, tls_server_name: new URL(decision.origin).hostname });
  }

  authorizeRedirect(previous, next) {
    const fresh = this.authorizeRequest(next);
    const changed = previous.origin !== fresh.origin ||
      previous.method !== fresh.method || previous.path !== fresh.path;
    return Object.freeze({
      decision: fresh,
      authorization_forwarded: false,
      secret_forwarded: false,
      body_replay_allowed: !changed && ["GET", "HEAD"].includes(fresh.method),
      kernel_reauthorization_required: changed,
    });
  }
}

export function verifyProcessLaunch(manifest, observed) {
  if (!manifest || !observed || manifest.shell === true || !Array.isArray(observed.argv) ||
      typeof manifest.absolute_path !== "string" ||
      !/^(?:[a-z]:[\\/]|\/)/i.test(manifest.absolute_path) ||
      observed.absolute_path !== manifest.absolute_path ||
      observed.file_id !== manifest.file_id ||
      observed.sha256 !== manifest.sha256 ||
      observed.publisher !== manifest.publisher ||
      observed.post_launch_image_sha256 !== manifest.sha256 ||
      observed.post_launch_file_id !== manifest.file_id) reject("PROCESS_MAIN_IDENTITY_REJECTED");

  const forbiddenEnvironment = /^(?:path|ld_|dyld_|pythonpath|comspec|pathext|prompt)$/i;
  for (const [key] of Object.entries(observed.environment || {})) {
    if (forbiddenEnvironment.test(key) || !manifest.allowed_environment_keys.includes(key)) {
      reject("PROCESS_ENVIRONMENT_INJECTION");
    }
  }
  if (observed.used_shell || observed.current_directory_lookup || observed.reparse_in_chain ||
      observed.staging_acl_runner_only !== true || observed.share_delete_allowed) {
    reject("PROCESS_LAUNCH_BOUNDARY_REJECTED");
  }

  const expected = [...manifest.dependencies].sort((a,b) => a.path.localeCompare(b.path));
  const actual = [...observed.loaded_dependencies].sort((a,b) => a.path.localeCompare(b.path));
  if (expected.length !== actual.length) reject("PROCESS_DEPENDENCY_CLOSURE_MISMATCH");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.path !== right.path || left.file_id !== right.file_id ||
        left.sha256 !== right.sha256 || left.publisher !== right.publisher ||
        right.user_writable || right.reparse) reject("PROCESS_DEPENDENCY_CLOSURE_MISMATCH");
  }
  return Object.freeze({
    authorized: true,
    manifest_digest: stableDigest(manifest),
    actual_dependency_closure_digest: stableDigest(actual),
    secret_in_argv_or_environment: false,
  });
}

export function assertCapabilityDeclared(manifest, capabilityId, version) {
  const exact = manifest.capabilities?.find((item) =>
    item.capability_id === capabilityId && item.version === version && item.enabled === true);
  if (!exact) reject("CAPABILITY_NOT_DECLARED");
  return true;
}
