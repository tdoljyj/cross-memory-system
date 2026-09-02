import assert from "node:assert/strict";
import test from "node:test";
import {
  AllowedRootPolicy,
  HttpEgressPolicy,
  assertCapabilityDeclared,
  verifyProcessLaunch,
} from "../../kernel/runtime/runner-boundaries.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const safeResolution = (overrides = {}) => ({
  root_file_id: "root-1",
  volume_id: "volume-1",
  parent_file_id: "parent-1",
  final_file_id: null,
  target_exists: false,
  network_share: false,
  policy_version: "policy-1",
  components: [
    { file_id: "parent-1", no_follow: true, link_count: 1 },
    { file_id: "target-new", no_follow: true, link_count: 1 },
  ],
  ...overrides,
});

test("V06-FS-01 Allowed Root uses normalized handle identities and rejects traversal/special links", () => {
  const policy = new AllowedRootPolicy({
    platform: "windows",
    normalized_root: "C:/safe",
    root_file_id: "root-1",
    volume_id: "volume-1",
    case_sensitive: false,
    unicode_form: "NFC",
    network_share_allowed: false,
    policy_version: "policy-1",
  });
  const preview = policy.preview({
    relativePath: "Reports/Result.txt",
    resolution: safeResolution(),
    operation: "write",
  });
  assert.equal(preview.identity.canonical_path, "reports/result.txt");
  assert.equal(policy.authorizeCommit(preview, {
    relativePath: "reports/result.txt",
    resolution: safeResolution(),
  }).authorized, true);
  for (const path of ["../escape.txt", "C:\\escape.txt", "\\\\server\\share\\x", "CON.txt", "file.txt:ads"]) {
    assert.throws(() => policy.preview({
      relativePath: path,
      resolution: safeResolution(),
      operation: "write",
    }));
  }
  assert.throws(() => policy.preview({
    relativePath: "Reports/Result.txt",
    resolution: safeResolution({
      components: [
        { file_id: "parent-1", no_follow: true, link_count: 1 },
        { file_id: "target-new", no_follow: true, link_count: 1, reparse: true },
      ],
    }),
    operation: "write",
  }), { code: "HANDLE_RESOLUTION_UNSAFE" });
});

test("V06-FS-02 dry-run identity drift and default overwrite both fail closed", () => {
  const policy = new AllowedRootPolicy({
    platform: "posix",
    normalized_root: "/safe",
    root_file_id: "root-1",
    volume_id: "volume-1",
    case_sensitive: true,
    unicode_form: "NFC",
    policy_version: "policy-1",
  });
  const preview = policy.preview({
    relativePath: "reports/result.txt",
    resolution: safeResolution(),
    operation: "write",
  });
  assert.throws(() => policy.authorizeCommit(preview, {
    relativePath: "reports/result.txt",
    resolution: safeResolution({ parent_file_id: "parent-replaced" }),
  }), { code: "DRY_RUN_IDENTITY_DRIFT" });
  assert.throws(() => policy.preview({
    relativePath: "reports/result.txt",
    resolution: safeResolution({ target_exists: true, final_file_id: "existing" }),
    operation: "write",
  }), { code: "NO_OVERWRITE_CONFLICT" });
});

const egress = () => new HttpEgressPolicy({
  policy_version: "egress-1",
  resolver_id: "resolver-1",
  allowed_origins: ["https://api.example.test:443", "https://cdn.example.test:443"],
  allowed_methods: ["GET", "POST"],
  connection_max_age: 30,
  system_proxy_disabled: true,
});
const dns = (addresses = ["93.184.216.34"], overrides = {}) => ({
  resolver_id: "resolver-1",
  policy_version: "egress-1",
  addresses,
  verified_at: 100,
  chain_min_ttl: 20,
  ...overrides,
});

test("V06-HTTP-01 SSRF, mixed DNS sets, rebinding, mapped IPv6 and expired pins reject", () => {
  const policy = egress();
  const decision = policy.authorizeRequest({
    url: "https://api.example.test/v1",
    method: "GET",
    dns: dns(),
    now: 101,
  });
  assert.equal(policy.authorizeConnect(decision, {
    address: "93.184.216.34",
    now: 102,
    policyVersion: "egress-1",
  }).connect_by_verified_ip, true);
  for (const addresses of [
    ["127.0.0.1"],
    ["10.0.0.1"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["::ffff:127.0.0.1"],
    ["93.184.216.34", "192.168.1.1"],
  ]) {
    assert.throws(() => policy.authorizeRequest({
      url: "https://api.example.test/v1",
      method: "GET",
      dns: dns(addresses),
      now: 101,
    }), { code: "DNS_SET_REJECTED" });
  }
  assert.throws(() => policy.authorizeConnect(decision, {
    address: "93.184.216.35",
    now: 102,
    policyVersion: "egress-1",
  }), { code: "PINNED_CONNECT_REJECTED" });
  assert.throws(() => policy.authorizeConnect(decision, {
    address: "93.184.216.34",
    now: 120,
    policyVersion: "egress-1",
  }), { code: "PINNED_CONNECT_REJECTED" });
});

test("V06-HTTP-02 redirect revalidates target and strips body, authorization and secret inheritance", () => {
  const policy = egress();
  const first = policy.authorizeRequest({
    url: "https://api.example.test/v1",
    method: "POST",
    dns: dns(),
    now: 101,
    secretAudience: "https://api.example.test:443/v1",
  });
  const redirected = policy.authorizeRedirect(first, {
    url: "https://cdn.example.test/object",
    method: "GET",
    dns: dns(["93.184.216.35"]),
    now: 102,
  });
  assert.equal(redirected.authorization_forwarded, false);
  assert.equal(redirected.secret_forwarded, false);
  assert.equal(redirected.body_replay_allowed, false);
  assert.equal(redirected.kernel_reauthorization_required, true);
  assert.throws(() => policy.authorizeRedirect(first, {
    url: "https://metadata.invalid/latest",
    method: "GET",
    dns: dns(["169.254.169.254"]),
    now: 102,
  }));
});

const processManifest = () => ({
  absolute_path: "C:\\runner-stage\\tool.exe",
  file_id: "exe-1",
  sha256: digest("a"),
  publisher: "publisher-test",
  shell: false,
  allowed_environment_keys: ["LANG"],
  dependencies: [
    { path: "C:\\runner-stage\\lib.dll", file_id: "dll-1", sha256: digest("b"), publisher: "publisher-test" },
  ],
});
const observedProcess = () => ({
  absolute_path: "C:\\runner-stage\\tool.exe",
  file_id: "exe-1",
  sha256: digest("a"),
  publisher: "publisher-test",
  post_launch_image_sha256: digest("a"),
  post_launch_file_id: "exe-1",
  argv: ["C:\\runner-stage\\tool.exe", "--fixed"],
  environment: { LANG: "C" },
  used_shell: false,
  current_directory_lookup: false,
  reparse_in_chain: false,
  staging_acl_runner_only: true,
  share_delete_allowed: false,
  loaded_dependencies: [
    { path: "C:\\runner-stage\\lib.dll", file_id: "dll-1", sha256: digest("b"), publisher: "publisher-test", user_writable: false, reparse: false },
  ],
});

test("V06-PROC-01 complete binary closure passes; same-path replacement and loader injection reject", () => {
  assert.equal(verifyProcessLaunch(processManifest(), observedProcess()).authorized, true);
  const replaced = observedProcess();
  replaced.loaded_dependencies[0].sha256 = digest("c");
  assert.throws(() => verifyProcessLaunch(processManifest(), replaced), {
    code: "PROCESS_DEPENDENCY_CLOSURE_MISMATCH",
  });
  const injected = observedProcess();
  injected.environment.PATH = "C:\\attacker";
  assert.throws(() => verifyProcessLaunch(processManifest(), injected), {
    code: "PROCESS_ENVIRONMENT_INJECTION",
  });
  const mainChanged = observedProcess();
  mainChanged.post_launch_file_id = "exe-replaced";
  assert.throws(() => verifyProcessLaunch(processManifest(), mainChanged), {
    code: "PROCESS_MAIN_IDENTITY_REJECTED",
  });
});

test("V06-CAP-01 undeclared optional desktop, pack, shell and private network capabilities fail closed", () => {
  const manifest = {
    capabilities: [{ capability_id: "file.restricted", version: "1", enabled: true }],
  };
  assert.equal(assertCapabilityDeclared(manifest, "file.restricted", "1"), true);
  for (const capability of ["desktop.uia", "pack.selenium", "process.shell", "network.private"]) {
    assert.throws(() => assertCapabilityDeclared(manifest, capability, "1"), {
      code: "CAPABILITY_NOT_DECLARED",
    });
  }
});
