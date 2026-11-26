import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import { execFileSync } from "node:child_process";
import { resolveSupabasePublicConfig } from "./app/supabase-public-config";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

function sourceCommitForBuild(): string | null {
  const supplied = process.env.CLUED_BUILD_SHA ?? process.env.GITHUB_SHA ??
    process.env.CF_PAGES_COMMIT_SHA;
  if (supplied && !/^[0-9a-f]{40}$/.test(supplied)) return null;
  try {
    const current = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty || !/^[0-9a-f]{40}$/.test(current) || (supplied && supplied !== current)) return null;
    return current;
  } catch {
    // Source archives do not contain .git; their trusted build environment
    // must supply the exact source commit or production stays unattested.
    return supplied ?? null;
  }
}

const localBindingConfig = {
  main: "./worker/index.ts",
  // Production keeps the current compatibility date. Local preview can opt
  // into the newest date supported by its bundled workerd binary.
  compatibility_date: process.env.CLUED_LOCAL_COMPAT_DATE ?? "2026-08-23",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    binding: "ASSETS",
  },
  // Wake durable projection jobs after a transient Builder/transport failure.
  // The database owns coalescing, bounded retries, and the STALE fence.
  triggers: {
    crons: ["*/10 * * * *"],
  },
  images: {
    binding: "IMAGES",
  },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ mode }) => {
  // Reject incomplete pairs or private keys before any client bundle is emitted.
  resolveSupabasePublicConfig(loadEnv(mode, process.cwd(), "VITE_CLUED_"));
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    define: { __CLUED_BUILD_SHA__: JSON.stringify(sourceCommitForBuild()) },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      // StorageNormalUse §4.5: this Worker never bundles pdf.js; PDFs are parsed by
      // the extractor Worker clued-storage-pdf (scripts/build-pdf-extractor.mjs).
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
