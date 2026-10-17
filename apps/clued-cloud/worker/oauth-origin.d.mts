export interface OAuthOriginEnv {
  CLUED_OAUTH_ORIGIN?: string;
  CLUED_AUTHORIZATION_ISSUER_TOKEN?: string;
  OAUTH_KV?: KVNamespace;
  KOOYUMI_OAUTH_ORIGIN?: string;
  KOOYUMI_AUTHORIZATION_ISSUER_TOKEN?: string;
  KOOYUMI_OAUTH_KV?: KVNamespace;
}

export class OAuthOriginConfigurationError extends Error {
  readonly code: "kooyumi_oauth_configuration_invalid";
  constructor();
}

type SelectedOAuthEnv<T extends OAuthOriginEnv> =
  Omit<T, "CLUED_OAUTH_ORIGIN" | "CLUED_AUTHORIZATION_ISSUER_TOKEN" | "OAUTH_KV"> &
  Pick<OAuthOriginEnv, "CLUED_OAUTH_ORIGIN" | "CLUED_AUTHORIZATION_ISSUER_TOKEN" | "OAUTH_KV">;

export function selectOAuthOrigin<T extends OAuthOriginEnv>(request: Request, env: T): SelectedOAuthEnv<T>;
