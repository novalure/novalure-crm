"use client";

const csrfHeaderName = "x-novalure-csrf-token";
const csrfEndpoint = "/api/auth/csrf";
const unsafeMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input), window.location.href);
}

async function requestCsrfToken(method: string, pathname: string) {
  const params = new URLSearchParams({ method, path: pathname });
  const response = await fetch(`${csrfEndpoint}?${params.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
  });
  if (!response.ok) throw new Error("CSRF protection is unavailable");

  const payload = await response.json() as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== "string" || !payload.csrfToken) {
    throw new Error("CSRF protection returned an invalid token");
  }

  return payload.csrfToken;
}

/**
 * Browser-only wrapper for Novalure API calls. Every unsafe request receives
 * its own endpoint- and method-bound one-time token. Parallel requests and
 * multiple tabs therefore use independent nonces; an explicit application
 * retry calls this wrapper again and obtains a fresh token.
 */
export async function csrfFetch(input: RequestInfo | URL, init?: RequestInit) {
  const method = requestMethod(input, init);
  if (!unsafeMethods.has(method)) return fetch(input, init);

  const url = requestUrl(input);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("Unsafe API requests must remain on the current origin");
  }

  const token = await requestCsrfToken(method, url.pathname);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(csrfHeaderName, token);

  return fetch(input, {
    ...init,
    credentials: init?.credentials ?? (input instanceof Request ? input.credentials : "same-origin"),
    headers,
    method,
  });
}
