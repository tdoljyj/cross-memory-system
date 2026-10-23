/** Public build configuration only. Never accept a service-role or server secret. */
export function resolveSupabasePublicConfig(environment: Record<string, unknown>): { url: string; key: string } {
  const suppliedUrl = environment.VITE_CLUED_SUPABASE_URL;
  const suppliedKey = environment.VITE_CLUED_SUPABASE_PUBLISHABLE_KEY;
  if (suppliedUrl === undefined && suppliedKey === undefined) {
    return { url: "https://ccxsikzwxlolxqlosril.supabase.co", key: "sb_publishable_tVKKh7Ok4FhBhHtHyZfwBA_i2RJD2Fg" };
  }
  if (typeof suppliedUrl !== "string" || !suppliedUrl.trim() || typeof suppliedKey !== "string" || !suppliedKey.trim()) {
    throw new Error("BeamingFace 登录服务的公开地址和公开密钥必须一起完整配置。");
  }
  const url = suppliedUrl.trim();
  const key = suppliedKey.trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("BeamingFace 登录服务的公开地址无效。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/"
    || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("BeamingFace 登录服务公开配置无效；前端仅接受公开项目地址和 Publishable key。");
  }
  return { url: parsed.origin, key };
}
