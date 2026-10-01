/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  handleContinuityRequest,
  runProjectionRefreshScheduled,
  runStorageRefreshScheduled,
  runStorageRecoveryScheduled,
  runStorageStagingScheduled,
  runStorageJobQueue,
  type ContinuityEnv,
  type StorageJobQueueMessage,
} from "./continuity";

import { delegatedOAuthEnabled, handleDelegatedOAuth, type DelegatedOAuthEnv } from "./delegated-oauth";
import { checkPdfExtractor, PDF_EXTRACTOR_CHECK_PATH } from "./storage-read-pdf-client";

interface Env extends ContinuityEnv, DelegatedOAuthEnv {
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
    // works (a fixed built-in PDF round trip; no input is read from the request).
    if (url.pathname === PDF_EXTRACTOR_CHECK_PATH) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      const check = await checkPdfExtractor(env.PDF_EXTRACTOR);
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
    ctx.waitUntil(runStorageStagingScheduled(env).then(result => {
      if (result.status === "unavailable") console.warn(JSON.stringify({ event: "storage_staging_sweep_unavailable" }));
    }));
  },
  async queue(batch: { readonly messages: readonly StorageJobQueueMessage[] }, env: Env) {
    await runStorageJobQueue(batch, env);
  },
};

export default worker;
