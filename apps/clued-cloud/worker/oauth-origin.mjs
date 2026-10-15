const CONFIGURATION_ERROR = "kooyumi_oauth_configuration_invalid";

export class OAuthOriginConfigurationError extends Error {
  constructor() {
    super(CONFIGURATION_ERROR);
    this.name = "OAuthOriginConfigurationError";
    this.code = CONFIGURATION_ERROR;
  }
}

function parsedOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  try { return new URL(value); } catch { return null; }
}

function namespace(value) {
  return value !== null && typeof value === "object" &&
    ["get", "put", "delete", "list"].every(method => typeof value[method] === "function");
}

/** Select deployment-owned OAuth configuration, without moving an existing grant. */
export function selectOAuthOrigin(request, env) {
  const origin = new URL(request.url).origin;
  // A broken optional configuration must never take the existing issuer offline.
  // Configuring the same origin leaves the optional issuer disabled.
  if (origin === env.CLUED_OAUTH_ORIGIN) return env;
  const configured = env.KOOYUMI_OAUTH_ORIGIN;
  const candidate = parsedOrigin(configured);
  if (!candidate || origin !== candidate.origin) return env;

  const token = env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN;
  const storage = env.KOOYUMI_OAUTH_KV;
  if (candidate.protocol !== "https:" || candidate.origin !== configured ||
      candidate.origin === parsedOrigin(env.CLUED_OAUTH_ORIGIN)?.origin ||
      typeof token !== "string" || !token.trim() || token === env.CLUED_AUTHORIZATION_ISSUER_TOKEN ||
      !namespace(storage) || storage === env.OAUTH_KV) {
    throw new OAuthOriginConfigurationError();
  }
  return { ...env, CLUED_OAUTH_ORIGIN: origin, CLUED_AUTHORIZATION_ISSUER_TOKEN: token, OAUTH_KV: storage };
}
