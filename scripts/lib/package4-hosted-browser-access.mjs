/** Target validation belongs to package4-hosted-target. CDP interception applies
 * to every redirect hop, unlike Playwright route.continue header overrides.
 * CDP Fetch.continueRequest explicitly does not carry overrides across redirects.
 * The normal browser handles response cookies, redirects and upload streams. */
export async function installHostedOriginRouting(page, { origin, protectionToken, allowedUploadOrigins, onBlocked, onFailure }) {
  const session = await page.context().newCDPSession(page), previousOrigins = new Map();
  session.on("Fetch.requestPaused", async event => {
    let url;
    try {
      url = new URL(event.request.url);
      if (["data:", "blob:"].includes(url.protocol)) return session.send("Fetch.continueRequest", { requestId: event.requestId });
      const previous = event.redirectedRequestId ? previousOrigins.get(event.redirectedRequestId) : undefined;
      previousOrigins.set(event.requestId, url.origin);
      if (event.redirectedRequestId) previousOrigins.delete(event.redirectedRequestId);
      if ((event.redirectedRequestId && previous !== url.origin) || (url.origin !== origin && !allowedUploadOrigins.includes(url.origin))) {
        onBlocked({ method: event.request.method, origin: url.origin, ...(event.redirectedRequestId ? { reason: "cross-origin redirect" } : {}) });
        return session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      }
      const headers = Object.entries(event.request.headers).filter(([name]) => name.toLowerCase() !== "x-vercel-trusted-oidc-idp-token")
        .map(([name, value]) => ({ name, value: String(value) }));
      if (url.origin === origin) headers.push({ name: "x-vercel-trusted-oidc-idp-token", value: protectionToken });
      return await session.send("Fetch.continueRequest", { requestId: event.requestId, headers });
    } catch {
      onFailure({ method: event.request.method, origin: url?.origin || "invalid", code: "HOSTED_PER_HOP_REQUEST_FAILED" });
      return session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {});
    }
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}
