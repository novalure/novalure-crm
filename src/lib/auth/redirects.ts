const controlCharacters = /[\u0000-\u001f\u007f]/;
const encodedSeparator = /%(?:25)*(?:2f|5c)/i;

export function sanitizeLocalRedirect(value: string | null | undefined, fallback = "/") {
  if (!value) return fallback;
  const candidate = value.trim();
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    controlCharacters.test(candidate) ||
    encodedSeparator.test(candidate)
  ) return fallback;

  let decoded = candidate;
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return fallback;
  }

  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\") || controlCharacters.test(decoded)) {
    return fallback;
  }

  const parsed = new URL(decoded, "https://novalure.invalid");
  if (parsed.origin !== "https://novalure.invalid" || parsed.username || parsed.password) return fallback;
  if (parsed.pathname === "/login" || parsed.pathname.startsWith("/login/") || parsed.pathname.startsWith("/api/")) {
    return fallback;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
