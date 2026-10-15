const COMPATIBILITY_PAGES = new Set([
  "/bindings", "/oauth/account", "/oauth/projects", "/oauth/consent", "/oauth/connections",
  "/storage", "/storage/admin", "/storage/connections", "/storage/onboard", "/storage/google/callback",
  "/v1/continuity/bootstrap", "/clued-agent.md",
]);
const STORAGE_PAGES = new Set([
  "/storage", "/storage/admin", "/storage/connections", "/storage/onboard", "/storage/google/callback",
]);

function configuredOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? url.origin : null;
  } catch { return null; }
}

function storageOrigin(env) {
  const value = env.CLUED_STORAGE_GOOGLE_REDIRECT_URI;
  if (value === undefined || value === "") return configuredOrigin(env.CLUED_OAUTH_ORIGIN);
  if (typeof value !== "string") return null;
  try {
    const callback = new URL(value);
    return callback.protocol === "https:" && !callback.username && !callback.password &&
      !callback.search && !callback.hash && callback.pathname === "/storage/google/callback"
      ? callback.origin : null;
  } catch { return null; }
}

/** Keep browser sessions for Google authorization on its registered origin,
 * independently of the per-request MCP issuer selected afterwards. */
export function routeStorageOrigin(request, env) {
  const url = new URL(request.url);
  const controlled = [env.CLUED_OAUTH_ORIGIN, env.KOOYUMI_OAUTH_ORIGIN,
    ...(env.CLUED_WEB_ORIGINS ?? "").split(",").map(value => value.trim())]
    .map(configuredOrigin).filter(Boolean);
  if (!controlled.includes(url.origin)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/").toLowerCase().replace(/\/$/, "") || "/"; }
  catch { return null; }
  if (!STORAGE_PAGES.has(path)) return null;
  const targetOrigin = storageOrigin(env);
  if (!targetOrigin) return Response.json({ error: "storage_origin_configuration_invalid" }, {
    status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  if (url.origin === targetOrigin) return null;
  if (!["GET", "HEAD"].includes(request.method) || request.headers.has("Authorization")) return unavailable();
  const target = new URL(targetOrigin);
  target.pathname = url.pathname;
  target.search = url.search;
  return new Response(null, { status: 302, headers: {
    location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

/** Add a Native web origin without creating another OAuth issuer or MCP resource. */
export async function routeWebOrigin(request, env, nativeHandler) {
  const url = new URL(request.url);
  const canonical = configuredOrigin(env.CLUED_OAUTH_ORIGIN);
  const origins = (env.CLUED_WEB_ORIGINS ?? "").split(",").map(value => configuredOrigin(value.trim())).filter(Boolean);
  if (!canonical || url.origin === canonical || !origins.includes(url.origin)) return null;

  let path;
  try { path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/").toLowerCase().replace(/\/$/, "") || "/"; }
  catch { return unavailable(); }

  // Existing consent cookies and provider callbacks remain on their registered origin.
  // Only navigations redirect; never forward a POST body or a bearer token to another origin.
  if (COMPATIBILITY_PAGES.has(path) || path === "/.well-known" || path.startsWith("/.well-known/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return unavailable();
    const target = new URL(canonical);
    target.pathname = url.pathname;
    target.search = url.search;
    return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  if (path === "/mcp" || path.startsWith("/mcp/") || path === "/oauth" || path.startsWith("/oauth/")) return unavailable();
  return nativeHandler(request);
}

function unavailable() {
  return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}
