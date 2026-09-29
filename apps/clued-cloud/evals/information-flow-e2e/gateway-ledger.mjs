// Miniflare outboundService for the S6 harness Worker (plan section 2.4).
// Every global fetch() made by the Worker inside workerd arrives here. Only
// the loopback Supabase gateway origin is forwarded; anything else is
// recorded and answered with HTTP 599 without leaving the process. Each
// forwarded request is classified (auth_user, rpc:<name>, rest_table:<name>)
// and reported with its status. An armed fault hook forwards the request,
// reports the committed response and then never answers, so the orchestrator
// can kill the Worker host before the Worker responds (E2E-07).

export function pathClass(pathname) {
  if (pathname === '/auth/v1/user') return 'auth_user';
  const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(pathname);
  if (rpc) return `rpc:${rpc[1]}`;
  const table = /^\/rest\/v1\/([a-z0-9_]+)$/.exec(pathname);
  if (table) return `rest_table:${table[1]}`;
  if (pathname.startsWith('/auth/v1/')) return 'auth_other';
  return 'other';
}

export function createGatewayLedger({ gatewayOrigin, report }) {
  const allowed = new URL(gatewayOrigin).origin;
  let hook = null;
  const handler = async (request) => {
    const url = new URL(request.url);
    const entry = { origin: url.origin, path_class: pathClass(url.pathname), method: request.method };
    if (url.origin !== allowed) {
      report({ type: 'egress', allowed: false, host: url.host, ...entry, status: 599 });
      return new Response('ife2e: egress denied', { status: 599 });
    }
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    headers.delete('host');
    const upstream = await fetch(url, { method: request.method, headers, body, redirect: 'manual' });
    const bytes = await upstream.arrayBuffer();
    report({ type: 'egress', allowed: true, host: url.host, ...entry, status: upstream.status });
    if (hook && hook.path_class === entry.path_class) {
      const armed = hook;
      hook = null;
      report({ type: 'hook_hit', step: armed.step, path_class: entry.path_class, status: upstream.status,
        body: new TextDecoder().decode(bytes) });
      // The committed response is held; the orchestrator kills this process group.
      return await new Promise(() => {});
    }
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');
    return new Response(bytes, { status: upstream.status, headers: responseHeaders });
  };
  return {
    handler,
    arm(nextHook) { hook = nextHook; },
    disarm() { hook = null; },
  };
}
