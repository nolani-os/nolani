/**
 * Routes the app's `/api/...` requests to the device instead of the network.
 *
 * Spike seam: the shared app code calls `fetch("/api/claraos/knowledge/...")`;
 * intercepting here keeps that code untouched. The product version replaces
 * this with an explicit transport in `ideas/api.ts`.
 */
type LocalHandler = (method: string, path: string, query: URLSearchParams, body: unknown) => Promise<Response>;

const KNOWLEDGE = "/api/claraos/knowledge";

export function installFetchShim(knowledge: LocalHandler) {
  const network = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return network(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname.startsWith(KNOWLEDGE)) {
      let body: unknown;
      if (init?.body instanceof FormData) {
        body = init.body;  // uploads (attachments, import) keep their File objects
      } else if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
      }
      return knowledge(method, url.pathname.slice(KNOWLEDGE.length) || "/", url.searchParams, body);
    }
    // Any other server API (people directory, settings, assistant) does not exist offline.
    return new Response(JSON.stringify({ detail: "offline" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  };
}
