/** The configured public origin survives internal reverse-proxy host rewriting. */
export function isWebExposeOriginAllowed(request: Request, trustedOrigin: string) {
  try { return request.headers.get("origin") === new URL(trustedOrigin).origin && request.headers.get("sec-fetch-site") !== "cross-site"; }
  catch { return false; }
}
