import { resolveSupabasePublicConfig } from "../app/supabase-public-config";

/** The database gateway proves the serving Worker; RPCs still authenticate their Binding or issuer. */
export interface DatabaseGatewayEnv {
  CLUED_DB_GATEWAY_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

const defaultSupabaseConfig = resolveSupabasePublicConfig({});

export function resolveSupabaseConfig(env: DatabaseGatewayEnv): { url: string; key: string } {
  return {
    url: env.SUPABASE_URL ?? defaultSupabaseConfig.url,
    key: env.SUPABASE_PUBLISHABLE_KEY ?? defaultSupabaseConfig.key,
  };
}

export function databaseGatewayToken(env: DatabaseGatewayEnv): string | null {
  return env.CLUED_DB_GATEWAY_TOKEN?.trim() || null;
}
