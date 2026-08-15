const DEFAULT_LOCAL_FALLBACK = "/";
const MAX_REDIRECT_LENGTH = 4_096;

export type LocalRedirectOptions = {
  blockedPathPrefixes?: readonly string[];
  fallback?: string;
  trustedOrigin: string;
};

export type FormRedirectAllowRule = Readonly<{
  hostname: string;
  pathPrefix: string;
}>;

export type FormRedirectOptions = {
  allowlist?: string | readonly FormRedirectAllowRule[] | null;
  configuredTarget?: string | null;
  fallback: string;
  returnTo?: string | null;
  trustedOrigin: string;
};

const rawControlCharacters = /[\u0000-\u001f\u007f]/;
const dangerousPercentEncoding = /%(?:25)*(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f)/i;

function getOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hasUnsafeRepresentation(value: string) {
  if (!value || value.length > MAX_REDIRECT_LENGTH || value !== value.trim()) return true;
  if (rawControlCharacters.test(value) || value.includes("\\")) return true;
  if (dangerousPercentEncoding.test(value)) return true;

  let decoded = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (rawControlCharacters.test(decoded) || decoded.includes("\\")) return true;
    if (decoded.startsWith("//") || dangerousPercentEncoding.test(decoded)) return true;

    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return false;
      decoded = next;
    } catch {
      return true;
    }
  }

  // Extremely deep encoding is not a legitimate redirect requirement. Reject
  // it instead of guessing how many decoding layers a downstream component
  // might apply.
  return true;
}

function isBlockedPath(pathname: string, blockedPathPrefixes: readonly string[]) {
  return blockedPathPrefixes.some((prefix) => {
    const normalized = prefix === "/" ? "/" : prefix.replace(/\/+$/, "");
    return pathname === normalized || pathname.startsWith(`${normalized}/`);
  });
}

function resolveLocalCandidate(
  value: string,
  trustedOrigin: string,
  blockedPathPrefixes: readonly string[],
) {
  if (hasUnsafeRepresentation(value)) return null;

  try {
    const url = new URL(value, trustedOrigin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.origin !== trustedOrigin) return null;
    if (
      !url.pathname.startsWith("/") ||
      url.pathname.startsWith("//") ||
      isBlockedPath(url.pathname, blockedPathPrefixes)
    ) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * Resolves an untrusted local redirect against one fixed origin and returns a
 * path-only value. Callers must construct absolute redirect responses from the
 * same trusted origin rather than from the request Host header.
 */
export function resolveSafeLocalRedirect(
  value: string | null | undefined,
  options: LocalRedirectOptions,
) {
  const trustedOrigin = getOrigin(options.trustedOrigin);
  if (!trustedOrigin) return DEFAULT_LOCAL_FALLBACK;

  const blockedPathPrefixes = options.blockedPathPrefixes ?? [];
  const candidate = resolveLocalCandidate(value ?? "", trustedOrigin, blockedPathPrefixes);
  if (candidate) return candidate;

  const fallback = resolveLocalCandidate(
    options.fallback ?? DEFAULT_LOCAL_FALLBACK,
    trustedOrigin,
    blockedPathPrefixes,
  );
  return fallback ?? DEFAULT_LOCAL_FALLBACK;
}

function normalizeAllowRule(value: string): FormRedirectAllowRule | null {
  if (hasUnsafeRepresentation(value) || value.includes("*")) return null;

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.search || url.hash || !url.hostname || url.hostname.startsWith(".")) return null;

    const pathPrefix = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    return Object.freeze({ hostname: url.hostname.toLowerCase(), pathPrefix });
  } catch {
    return null;
  }
}

/**
 * Parses a comma/whitespace separated exact-host allowlist. Entries may be
 * `example.test`, `example.test/thanks`, or `https://example.test/thanks`.
 * Wildcards, credentials, ports, query strings, fragments and non-HTTPS
 * schemes are intentionally unsupported.
 */
export function parseFormRedirectAllowlist(value: string | null | undefined) {
  const rules = (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeAllowRule)
    .filter((rule): rule is FormRedirectAllowRule => Boolean(rule));

  const unique = new Map(rules.map((rule) => [`${rule.hostname}${rule.pathPrefix}`, rule]));
  return Object.freeze([...unique.values()]);
}

function pathMatchesPrefix(pathname: string, prefix: string) {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function resolveAllowedExternalRedirect(
  value: string,
  allowlist: readonly FormRedirectAllowRule[],
) {
  if (!allowlist.length || hasUnsafeRepresentation(value)) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;

    const hostname = url.hostname.toLowerCase();
    const allowed = allowlist.some(
      (rule) => rule.hostname === hostname && pathMatchesPrefix(url.pathname, rule.pathPrefix),
    );
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Selects a form redirect. Same-origin destinations remain path-only; an
 * external destination is returned only when it is HTTPS and matches an exact
 * normalized allowlist entry (plus its optional path prefix).
 */
export function resolveSafeFormRedirect(options: FormRedirectOptions) {
  const trustedOrigin = getOrigin(options.trustedOrigin);
  if (!trustedOrigin) return DEFAULT_LOCAL_FALLBACK;

  const configuredTarget = options.configuredTarget ?? "";
  if (configuredTarget) {
    const localTarget = resolveLocalCandidate(configuredTarget, trustedOrigin, []);
    if (localTarget) return localTarget;

    const allowlist = typeof options.allowlist === "string" || options.allowlist == null
      ? parseFormRedirectAllowlist(options.allowlist)
      : options.allowlist;
    const externalTarget = resolveAllowedExternalRedirect(configuredTarget, allowlist);
    if (externalTarget) return externalTarget;

    return resolveSafeLocalRedirect(null, {
      fallback: options.fallback,
      trustedOrigin,
    });
  }

  return resolveSafeLocalRedirect(options.returnTo, {
    fallback: options.fallback,
    trustedOrigin,
  });
}
