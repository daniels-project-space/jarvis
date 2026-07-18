"use client";

let viewerToken: string | null = null;

export function setViewerRequestToken(token: string | null) {
  viewerToken = token;
}

function isLocalApi(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Fetch a Jarvis route with the signed viewer capability as well as cookies. */
export function viewerFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (viewerToken && isLocalApi(input) && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${viewerToken}`);
  }
  return fetch(input, { ...init, headers });
}
