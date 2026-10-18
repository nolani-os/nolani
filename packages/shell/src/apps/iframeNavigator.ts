/**
 * iframeNavigator — tiny registry that lets the shell action-handler tell a
 * mounted IframeApp to deep-link its iframe to a new URL.
 *
 * Each IframeApp registers a navigator keyed by its appId on mount. The shell
 * `navigate_to` handler calls `navigateIframe(appId, url)`; if a navigator is
 * registered it sets the iframe's src (same-origin → only the path changes).
 *
 * Decoupled from actionBus on purpose: changing `iframe.src` is a parent-side
 * operation, not a postMessage into the embedded app (which is what the
 * iframe-bridge fallback handler does).
 *
 * V1 keys by appId only — single window per app is the norm. A second window
 * of the same app would overwrite the navigator; revisit with windowId-scoped
 * keys if multi-window-per-app becomes real.
 */
type NavFn = (url: string) => void;

const navigators = new Map<string, NavFn>();

/** Register a navigator for an appId. Returns an unsubscribe fn. */
export function registerIframeNavigator(appId: string, fn: NavFn): () => void {
  navigators.set(appId, fn);
  return () => {
    if (navigators.get(appId) === fn) navigators.delete(appId);
  };
}

/** Navigate the iframe for `appId` to `url`. Returns false if none registered. */
export function navigateIframe(appId: string, url: string): boolean {
  const fn = navigators.get(appId);
  if (!fn) return false;
  fn(url);
  return true;
}
