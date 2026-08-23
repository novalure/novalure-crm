export function createA11yBrowserContextOptions(profile) {
  return {
    colorScheme: "light",
    hasTouch: Boolean(profile.isMobile),
    isMobile: Boolean(profile.isMobile),
    reducedMotion: "reduce",
    serviceWorkers: "block",
    viewport: { height: profile.height, width: profile.width },
  };
}

const safeHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const allowedAuthWritePaths = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
]);

export function classifyA11yBrowserRequest({ allowAuthWrites, method, previewOrigin, requestUrl }) {
  const normalizedMethod = typeof method === "string" ? method.trim().toUpperCase() : "";
  if (safeHttpMethods.has(normalizedMethod)) {
    return Object.freeze({ allowed: true, category: "SAFE_HTTP_READ", method: normalizedMethod });
  }

  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return Object.freeze({ allowed: false, category: "INVALID_UNSAFE_REQUEST", method: normalizedMethod || "UNKNOWN" });
  }
  const exactAllowedAuthWrite =
    allowAuthWrites === true &&
    normalizedMethod === "POST" &&
    url.origin === previewOrigin &&
    allowedAuthWritePaths.has(url.pathname);
  if (exactAllowedAuthWrite) {
    return Object.freeze({ allowed: true, category: "EXPECTED_AUTH_WRITE", method: normalizedMethod });
  }
  return Object.freeze({
    allowed: false,
    category: url.origin === previewOrigin ? "PREVIEW_UNSAFE_HTTP_WRITE" : "CROSS_ORIGIN_UNSAFE_HTTP_WRITE",
    method: normalizedMethod || "UNKNOWN",
  });
}

export async function installA11yReadOnlyRequestGuard(
  context,
  { allowAuthWrites = false, onBlocked, previewOrigin },
) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const classification = classifyA11yBrowserRequest({
      allowAuthWrites,
      method: request.method(),
      previewOrigin,
      requestUrl: request.url(),
    });
    if (classification.allowed) {
      await route.continue();
      return;
    }
    onBlocked?.({ category: classification.category, method: classification.method });
    await route.abort("blockedbyclient");
  });
}
