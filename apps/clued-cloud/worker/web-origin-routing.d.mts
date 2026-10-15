export function routeWebOrigin(
  request: Request,
  env: { CLUED_OAUTH_ORIGIN?: string; CLUED_WEB_ORIGINS?: string },
  nativeHandler: (request: Request) => Promise<Response>,
): Promise<Response | null>;

export function routeStorageOrigin(
  request: Request,
  env: {
    CLUED_OAUTH_ORIGIN?: string;
    KOOYUMI_OAUTH_ORIGIN?: string;
    CLUED_WEB_ORIGINS?: string;
    CLUED_STORAGE_GOOGLE_REDIRECT_URI?: string;
  },
): Response | null;
