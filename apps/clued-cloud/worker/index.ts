/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  handleContinuityRequest,
  runProjectionRefreshScheduled,
  runStorageRefreshScheduled,
  runStorageRecoveryScheduled,
  runStorageUnattemptedReleaseScheduled,
  runStorageStagingScheduled,
  runStorageOnboardScheduled,
  runStorageJobQueue,
  runStorageCloudJob,
  type ContinuityEnv,
  type StorageJobQueueMessage,
} from "./continuity";

import { delegatedOAuthEnabled, handleDelegatedOAuth, type DelegatedOAuthEnv } from "./delegated-oauth";
import { createPdfExtractorCheckGate, PDF_EXTRACTOR_CHECK_PATH } from "./storage-read-pdf-client";
import { runStorageQueuedSweepScheduled } from "./storage-queued-dispatch";
import { runStorageAccessDigestBackfillScheduled } from "./storage-access-digest-backfill";
import { runStorageExternalRegistrationScheduled } from "./storage-external-registration";
import { routeStorageOrigin, routeWebOrigin } from "./web-origin-routing.mjs";
import { selectOAuthOrigin, OAuthOriginConfigurationError } from "./oauth-origin.mjs";

/** One per isolate: caches the last check result and allows one check in flight (StorageNormalUse §4.5). */
const pdfExtractorCheck = createPdfExtractorCheckGate();

interface Env extends ContinuityEnv, DelegatedOAuthEnv {
  CLUED_WEB_ORIGINS?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const legacyWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // StorageNormalUse §4.5: release-time proof that the PDF_EXTRACTOR binding
    // works (the extractor parses its fixed built-in check PDF outside the user
    // PDF slot; nothing is read from the request, query parameters are ignored;
    // results are cached per isolate, so the public route cannot flood it).
    if (url.pathname === PDF_EXTRACTOR_CHECK_PATH) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      const check = await pdfExtractorCheck(env.PDF_EXTRACTOR);
      return Response.json(check, { status: check.status === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } });
    }

    const continuityResponse = await handleContinuityRequest(request, env, ctx);
    if (continuityResponse) return continuityResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    if (url.pathname === "/storage/google/callback") {
      const protectedResponse = new Response(response.body, response);
      protectedResponse.headers.set("cache-control", "no-store");
      protectedResponse.headers.set("referrer-policy", "no-referrer");
      return protectedResponse;
    }
    return response;
  },
};

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const storageResponse = routeStorageOrigin(request, env);
    if (storageResponse) return storageResponse;
    try {
      env = selectOAuthOrigin(request, env);
    } catch (error) {
      if (!(error instanceof OAuthOriginConfigurationError)) throw error;
      return Response.json({ error: error.code }, { status: 503,
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    const webResponse = await routeWebOrigin(request, env, (next) => legacyWorker.fetch(next, env, ctx));
    if (webResponse) return webResponse;
    if (delegatedOAuthEnabled(env)) {
      return handleDelegatedOAuth(request, env, ctx as globalThis.ExecutionContext, (next) => legacyWorker.fetch(next, env, ctx));
    }
    return legacyWorker.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runProjectionRefreshScheduled(env));
    ctx.waitUntil(runStorageRefreshScheduled(env).then(result => {
      if (result.status === "unavailable" || result.status === "attention_required")
        console.warn(JSON.stringify({ event: "storage_refresh_attention_required", status: result.status }));
    }));
    ctx.waitUntil(runStorageRecoveryScheduled(env).then(result => {
      if (result.status === "unavailable" || result.status === "attention_required")
        console.warn(JSON.stringify({ event: "storage_recovery_attention_required", status: result.status }));
    }));
    ctx.waitUntil(runStorageUnattemptedReleaseScheduled(env).then(result => {
      if (result.status === "unavailable") console.warn(JSON.stringify({ event: "storage_unattempted_release_unavailable" }));
      else if (result.status === "ok" && result.released > 0)
        console.warn(JSON.stringify({ event: "storage_unattempted_released", released: result.released }));
    }));
    // BUG-20261008-001: a queued job whose one dispatch was lost or refused is
    // dispatched again with backoff, and settled after 2 hours instead of staying queued.
    ctx.waitUntil(runStorageQueuedSweepScheduled(env, { runJob: (_env, reference) => runStorageCloudJob(env, reference) }).then(result => {
      if (result.status === "unavailable") console.warn(JSON.stringify({ event: "storage_queued_sweep_unavailable" }));
      else if (result.status === "ok" && (result.settled > 0 || result.dispatched > 0 || result.root_busy > 0))
        console.warn(JSON.stringify({ event: "storage_queued_sweep", settled: result.settled, dispatched: result.dispatched, root_busy: result.root_busy }));
    }));
    // Storage step 2 (Task e2eb07d1): directories with neither digest get their
    // access digest when Drive still reports their registered version.
    ctx.waitUntil(runStorageAccessDigestBackfillScheduled(env).then(result => {
      if (result.status === "unavailable") console.warn(JSON.stringify({ event: "storage_access_digest_backfill_unavailable" }));
      else if (result.status === "ok" && (result.recorded > 0 || result.missing > 0 || result.skipped > 0))
        console.warn(JSON.stringify({ event: "storage_access_digest_backfill", recorded: result.recorded,
          missing: result.missing, skipped: result.skipped }));
    }));
    ctx.waitUntil(runStorageStagingScheduled(env).then(result => {
      if (result.status === "unavailable") console.warn(JSON.stringify({ event: "storage_staging_sweep_unavailable" }));
    }));
    ctx.waitUntil(runStorageExternalRegistrationScheduled(env).then(result => {
      if (result.status === "unavailable") console.warn(JSON.stringify({ event: "storage_external_registration_unavailable" }));
      else if (result.status === "ok" && (result.changed || result.skipped))
        console.warn(JSON.stringify({ event: "storage_external_registration", changed: result.changed, skipped: result.skipped }));
    }));
    ctx.waitUntil(runStorageOnboardScheduled(env).then(result => {
      if (result.status === "unavailable" && env.CLUED_STORAGE_ONBOARD_V1 === "true")
        console.warn(JSON.stringify({ event: "storage_onboard_sweep_unavailable" }));
    }));
  },
  async queue(batch: { readonly messages: readonly StorageJobQueueMessage[] }, env: Env) {
    await runStorageJobQueue(batch, env);
  },
};

export default worker;
