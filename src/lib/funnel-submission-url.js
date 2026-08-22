const sensitiveCapabilityQueryKeys = new Set([
  "accesstoken",
  "capabilitytoken",
  "publishtoken",
  "publictoken",
  "token",
]);

export function sanitizeFunnelSubmissionSourceUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      const normalized = key.toLowerCase().replace(/[^a-z]/gu, "");
      if (sensitiveCapabilityQueryKeys.has(normalized)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    url.password = "";
    url.username = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function sanitizeFunnelSubmissionAnswerUrl(value) {
  const sanitized = sanitizeFunnelSubmissionSourceUrl(value);
  return sanitized ?? value;
}
