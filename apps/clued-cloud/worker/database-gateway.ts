/** The database gateway proves the serving Worker; RPCs still authenticate their Binding or issuer. */
export interface DatabaseGatewayEnv {
  CLUED_DB_GATEWAY_TOKEN?: string;
}

export function databaseGatewayToken(env: DatabaseGatewayEnv): string | null {
  return env.CLUED_DB_GATEWAY_TOKEN?.trim() || null;
}
