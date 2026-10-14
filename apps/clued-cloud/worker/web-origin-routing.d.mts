export function routeWebOrigin(
  request: Request,
  env: { CLUED_OAUTH_ORIGIN?: string; CLUED_WEB_ORIGINS?: string },
  nativeHandler: (request: Request) => Promise<Response>,
): Promise<Response | null>;
