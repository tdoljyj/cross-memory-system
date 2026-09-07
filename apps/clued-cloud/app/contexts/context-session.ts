/** Request lifetime only: no tokens, private packages or authorization in persistent storage. */
export class ContextSession {
  private generation = 0;
  private controller = new AbortController();
  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation += 1;
  }
  async request(path: string, token: string, input: Record<string, unknown>) {
    const generation = this.generation;
    const response = await fetch(path, {
      method: "POST", cache: "no-store", signal: this.controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    const body = await response.json() as Record<string, unknown>;
    if (generation !== this.generation) throw new DOMException("Context changed", "AbortError");
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "请求未完成，请检查连接与授权。");
    return body;
  }
}

export function localDraft(body: Record<string, unknown>) {
  return { status: "LOCAL_DRAFT", canonical: false, body };
}
