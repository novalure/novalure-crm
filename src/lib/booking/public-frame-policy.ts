/** Exact, serializable origins only; URL parsing alone accepts CSP delimiters in hosts. */
export function validatedBookingFrameOrigin(input: string, allowLocal = false): string | null {
  try {
    const url = new URL(input);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) || url.origin !== input || url.username || url.password ||
      url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) return null;
    return url.origin;
  } catch { return null; }
}

/** Invalid or injected entries fail closed instead of entering the CSP header. */
export function bookingFrameAncestors(origins: readonly string[], allowLocal = false): string {
  const checked = new Set<string>();
  for (const input of origins) {
    const origin = validatedBookingFrameOrigin(input, allowLocal);
    if (origin) checked.add(origin);
  }
  return `frame-ancestors 'self'${checked.size ? ` ${[...checked].sort().join(" ")}` : ""}`;
}
