const id = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const stagingPath = new RegExp(`^(${id})/knowledge-staging-(${id})/(\\d{13})-(${id})\\.(pdf|docx|txt|md|csv|json|png|jpg|jpeg|webp)$`, "u");
const scopedHeaders = new Set(["x-vercel-trusted-oidc-idp-token", "x-vercel-skip-toolbar"]);
const header = (headers, name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
function validStagingPath(value, uploadApi) {
  const match = typeof value === "string" ? stagingPath.exec(value) : undefined;
  return Boolean(match && uploadApi.workspaceIds.includes(match[1]) && uploadApi.actorIds.includes(match[2]) &&
    Number(match[3]) > Date.now() && Number(match[3]) <= Date.now() + 5 * 60_000);
}
function providerPath(url, request, uploadApi) {
  if (!uploadApi || url.origin !== uploadApi.origin || url.pathname !== uploadApi.pathname || url.username || url.password || url.hash ||
    !["PUT", "OPTIONS"].includes(request.method) || url.searchParams.size !== 1 || !url.searchParams.has("pathname")) return undefined;
  const value = url.searchParams.get("pathname");
  if (!validStagingPath(value, uploadApi)) return undefined;
  if (request.method === "OPTIONS") {
    if (header(request.headers, "access-control-request-method") !== "PUT") return undefined;
  } else if (header(request.headers, "x-vercel-blob-store-id") !== uploadApi.storeId.replace(/^store_/u, "") ||
    !String(header(request.headers, "authorization")).startsWith(`Bearer vercel_blob_client_${uploadApi.storeId.replace(/^store_/u, "")}_`)) return undefined;
  return value;
}

/** Interception applies to each redirect hop. Only the app receives protection
 * headers. Provider uploads require an actual page-local prepare grant and the
 * exact SDK endpoint, method, store and synthetic workspace/actor scope. */
export async function installHostedOriginRouting(page, { origin, protectionToken, allowedUploadOrigins, uploadApi, onBlocked, onFailure, onAuthorizedProviderRequest = () => {} }) {
  if (uploadApi && (uploadApi.origin !== "https://vercel.com" || uploadApi.pathname !== "/api/blob/" || !/^store_[A-Za-z0-9-]+$/u.test(uploadApi.storeId ?? "") ||
    !Array.isArray(uploadApi.workspaceIds) || !Array.isArray(uploadApi.actorIds))) throw new Error("HOSTED_PROVIDER_API_BINDING_INVALID");
  const session = await page.context().newCDPSession(page), grants = new Set(), waiters = new Set();
  // A fast browser preflight can precede Node's response-body read. Wait for the
  // matching authorization, bounded to three seconds; no temporary allow exists.
  const waitForGrant = pathname => grants.has(pathname) ? Promise.resolve(true) : new Promise(resolve => {
    const waiter = { pathname, resolve: granted => { clearTimeout(timer); waiters.delete(waiter); resolve(granted); } };
    const timer = setTimeout(() => waiter.resolve(false), 3_000);
    waiters.add(waiter);
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (!uploadApi || url.origin !== origin || url.pathname !== "/api/knowledge-center/documents" || response.request().method() !== "POST" || response.status() !== 200) return;
    try { if (response.request().postDataJSON()?.action !== "prepare") return; } catch { return; }
    void response.json().then(body => {
      if (page.isClosed() || body?.transport !== "private-blob" || !validStagingPath(body.pathname, uploadApi)) return;
      grants.add(body.pathname);
      for (const waiter of [...waiters]) if (waiter.pathname === body.pathname) waiter.resolve(true);
    }).catch(() => {});
  });
  page.on("close", () => { grants.clear(); for (const waiter of [...waiters]) waiter.resolve(false); });
  session.on("Fetch.requestPaused", async event => {
    let url;
    try {
      url = new URL(event.request.url);
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        const location = event.responseHeaders?.find(row => row.name.toLowerCase() === "location")?.value;
        if (event.responseStatusCode >= 300 && event.responseStatusCode < 400 && location) {
          const destination = new URL(location, url);
          if (destination.origin !== url.origin) {
            onBlocked({ method: event.request.method, origin: destination.origin, reason: "cross-origin redirect" });
            return await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
          }
        }
        return await session.send("Fetch.continueResponse", { requestId: event.requestId });
      }
      if (["data:", "blob:"].includes(url.protocol)) return await session.send("Fetch.continueRequest", { requestId: event.requestId });
      const provider = providerPath(url, event.request, uploadApi);
      const storageRead = allowedUploadOrigins.includes(url.origin) && ["GET", "HEAD"].includes(event.request.method);
      if (url.origin !== origin && !storageRead && !provider) {
        onBlocked({ method: event.request.method, origin: url.origin });
        return await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      }
      if (provider && !await waitForGrant(provider)) {
        onBlocked({ method: event.request.method, origin: url.origin, reason: "page-local upload grant unavailable" });
        return await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      }
      const headers = Object.entries(event.request.headers).filter(([name]) => !scopedHeaders.has(name.toLowerCase()))
        .map(([name, value]) => ({ name, value: String(value) }));
      if (url.origin === origin) headers.push(
        { name: "x-vercel-trusted-oidc-idp-token", value: protectionToken },
        { name: "x-vercel-skip-toolbar", value: "1" },
      );
      if (provider) onAuthorizedProviderRequest({ method: event.request.method, origin: url.origin, endpoint: url.pathname,
        sourceStoreId: uploadApi.storeId, pageLocalPrepareGrant: true });
      return await session.send("Fetch.continueRequest", { requestId: event.requestId, headers });
    } catch {
      onFailure({ method: event.request.method, origin: url?.origin || "invalid", code: "HOSTED_PER_HOP_REQUEST_FAILED" });
      return await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {});
    }
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
}
