/** workerd does not implement redirect:error. Never follow a Location (which
 * could forward credentials); reject every redirect before consuming its body.
 * Shared by OAuth, refresh and the cloud bridge into provider-neutral adapters.
 */
export function createStorageFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: "manual" });
    if (response.redirected || (response.status >= 300 && response.status < 400))
      throw new Error("storage_redirect_rejected");
    return response;
  };
}
