import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { validateAuthorizationRequest } from "./a03-contract.mjs";

const NAVIGATION_NEEDLE = "return t?.(n),window.location.href=n.href,e?.(n)";
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

export function pkceAssertionPath(storageDir) {
  return path.join(storageDir, "pkce-and-callback.redacted.json");
}

export async function captureRedactedPkceAssertion(rawAuthorizationUrl, outputPath, {
  now = () => new Date(),
} = {}) {
  const redacted = validateAuthorizationRequest(rawAuthorizationUrl.trim());
  const assertion = {
    contract: "clued-a03-pkce-redacted-v1",
    captured_at: now().toISOString(),
    ...redacted,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(assertion, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return assertion;
}

export function instrumentInspectorBundle(source, observerPath) {
  assert.match(observerPath, /^\/__a03\/pkce-assertion\/[a-f0-9]{64}$/);
  const occurrences = source.split(NAVIGATION_NEEDLE).length - 1;
  assert.equal(occurrences, 1, "Inspector 2.4.0 OAuth navigation hook drift");
  const capture = `return t?.(n),(()=>{let e=new XMLHttpRequest;e.open("POST",${JSON.stringify(observerPath)},!1),e.setRequestHeader("Content-Type","text/plain;charset=UTF-8"),e.send(n.href);if(e.status!==204)throw Error("A03 PKCE capture failed closed")})(),window.location.href=n.href,e?.(n)`;
  return source.replace(NAVIGATION_NEEDLE, capture);
}

export function instrumentInspectorHtml(source, observerPath) {
  assert.match(observerPath, /^\/__a03\/pkce-assertion\/[a-f0-9]{64}$/);
  const nonce = observerPath.slice(observerPath.lastIndexOf("/") + 1);
  const mainBundle = /(<script\b[^>]*\bsrc=")([^"?]*\/assets\/index-[^"?]+\.js)(")/g;
  const occurrences = [...source.matchAll(mainBundle)].length;
  assert.equal(occurrences, 1, "Inspector 2.4.0 HTML bundle reference drift");
  return source.replace(mainBundle, `$1$2?a03_pkce=${nonce}$3`);
}

function isInspectorMainBundle(requestUrl, contentType) {
  const pathname = new URL(requestUrl, "http://localhost").pathname;
  return pathname.startsWith("/assets/index-")
    && pathname.endsWith(".js")
    && contentType.includes("javascript");
}

function isInspectorHtml(requestUrl, contentType) {
  const pathname = new URL(requestUrl, "http://localhost").pathname;
  return (pathname === "/" || pathname === "/index.html") && contentType.includes("text/html");
}

function readLimitedBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error("request body exceeds A03 capture limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function forwardResponse(request, response, upstreamResponse, observerPath) {
  const contentType = String(upstreamResponse.headers["content-type"] ?? "");
  const transform = isInspectorMainBundle(request.url ?? "/", contentType)
    ? (source) => instrumentInspectorBundle(source, observerPath)
    : isInspectorHtml(request.url ?? "/", contentType)
      ? (source) => instrumentInspectorHtml(source, observerPath)
      : null;
  if (!transform) {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
    return;
  }

  const chunks = [];
  let bytes = 0;
  upstreamResponse.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BUNDLE_BYTES) {
      upstreamResponse.destroy(new Error("Inspector bundle exceeds A03 instrumentation limit"));
      return;
    }
    chunks.push(chunk);
  });
  upstreamResponse.on("end", () => {
    try {
      const instrumented = transform(Buffer.concat(chunks).toString("utf8"));
      const headers = { ...upstreamResponse.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      delete headers.etag;
      headers["cache-control"] = "no-store";
      headers["x-a03-pkce-capture"] = "redacted-only";
      response.writeHead(upstreamResponse.statusCode ?? 200, headers);
      response.end(instrumented);
    } catch {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("A03 Inspector instrumentation failed closed");
    }
  });
  upstreamResponse.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
}

export async function createA03InspectorProxy({
  listenHost = "localhost",
  listenPort,
  internalHost = "localhost",
  internalPort,
  storageDir,
  observerNonce = randomBytes(32).toString("hex"),
} = {}) {
  assert.ok(Number.isInteger(listenPort) && listenPort >= 0, "invalid A03 proxy port");
  assert.ok(Number.isInteger(internalPort) && internalPort > 0, "invalid Inspector internal port");
  assert.equal(typeof storageDir, "string", "A03 storage directory is required");
  const observerPath = `/__a03/pkce-assertion/${observerNonce}`;
  const assertionPath = pkceAssertionPath(storageDir);

  const server = http.createServer(async (request, response) => {
    if (request.url === observerPath) {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      try {
        const rawAuthorizationUrl = await readLimitedBody(request, MAX_ASSERTION_BYTES);
        await captureRedactedPkceAssertion(rawAuthorizationUrl, assertionPath);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } catch (error) {
        response.writeHead(error?.code === "EEXIST" ? 409 : 400, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("A03 PKCE assertion rejected");
      }
      return;
    }

    const headers = {
      ...request.headers,
      host: `${internalHost}:${internalPort}`,
      "accept-encoding": "identity",
    };
    const upstream = http.request({
      hostname: internalHost,
      port: internalPort,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      forwardResponse(request, response, upstreamResponse, observerPath);
    });
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("A03 Inspector upstream unavailable");
    });
    request.pipe(upstream);
  });

  server.listen(listenPort, listenHost);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    assertionPath,
    observerPath,
    port: address.port,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
